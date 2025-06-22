/*
 * @eleven-am/transcoder
 * Copyright (C) 2025 Roy OSSAI
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { EventEmitter } from 'events';

import { createInternalError, TaskEither } from '@eleven-am/fp';
import { RedisClientType } from 'redis';

import { DistributedSegmentProcessor } from './distributedSegmentProcessor';
import { ISegmentProcessor, SegmentProcessingData, SegmentProcessingResult } from './interfaces';

export interface WorkStealingConfig {
	workerId: string;
	stealThreshold: number; // milliseconds before considering a segment stuck
	stealCheckInterval: number; // how often to check for stuck segments
	maxStealsPerCheck: number; // max segments to steal per check
}

/**
 * Extends distributed processing with work stealing capability
 * Monitors for stuck segments and steals them from unresponsive workers
 */
export class WorkStealingProcessor extends EventEmitter implements ISegmentProcessor {
	private readonly baseProcessor: DistributedSegmentProcessor;

	private stealCheckTimer: NodeJS.Timeout | null = null;

	private readonly config: Required<WorkStealingConfig>;

	private isDisposed = false;

	private readonly activeStealAttempts = new Set<string>();
	
	// Circuit breaker properties
	private consecutiveFailures = 0;
	private readonly maxFailures = 3;
	private readonly failureBackoff = 30000; // 30 seconds

	constructor (
		redis: RedisClientType,
		config: Partial<WorkStealingConfig> = {},
	) {
		super();

		this.config = {
			workerId: config.workerId || `worker-${process.pid}`,
			stealThreshold: config.stealThreshold || 60000, // 1 minute
			stealCheckInterval: config.stealCheckInterval || 30000, // 30 seconds
			maxStealsPerCheck: config.maxStealsPerCheck || 3,
		};

		this.baseProcessor = new DistributedSegmentProcessor(redis, {
			workerId: this.config.workerId,
		});

		this.startWorkStealingMonitor();
	}

	/**
	 * Process a segment with work stealing support
	 */
	async processSegment (data: SegmentProcessingData): Promise<SegmentProcessingResult> {
		return this.baseProcessor.processSegment(data);
	}

	/**
	 * Check if healthy with work stealing capability
	 */
	async isHealthy (): Promise<boolean> {
		return this.baseProcessor.isHealthy();
	}

	/**
	 * Get processing mode
	 */
	getMode (): string {
		return 'distributed-work-stealing';
	}

	/**
	 * Start monitoring for stuck segments
	 */
	private startWorkStealingMonitor (): void {
		if (this.stealCheckTimer) {
			return;
		}

		this.stealCheckTimer = setInterval(async () => {
			if (!this.isDisposed) {
				await this.checkAndStealWork();
			}
		}, this.config.stealCheckInterval);

		// Don't block process termination
		if (this.stealCheckTimer.unref) {
			this.stealCheckTimer.unref();
		}
	}

	// Pure helper functions for work stealing
	private limitSegmentsToSteal = (segments: SegmentProcessingData[]): SegmentProcessingData[] =>
		segments.slice(0, this.config.maxStealsPerCheck);

	private emitDetectionEvent = (stuckCount: number, stealingCount: number) => {
		this.emit('work:stealing:detected', {
			workerId: this.config.workerId,
			stuckCount,
			stealingCount,
		});
	};

	private countResults = (results: PromiseSettledResult<void>[]) => ({
		successful: results.filter((r) => r.status === 'fulfilled').length,
		failed: results.filter((r) => r.status === 'rejected').length,
	});

	private emitCompletionEvent = (successful: number, failed: number) => {
		if (successful > 0 || failed > 0) {
			this.emit('work:stealing:complete', {
				workerId: this.config.workerId,
				successful,
				failed,
			});
		}
	};

	private handleFailure = (error: Error) => {
		this.consecutiveFailures++;
		console.error(`Work stealing check failed (${this.consecutiveFailures}/${this.maxFailures}): ${error}`);
		this.emit('work:stealing:error', {
			workerId: this.config.workerId,
			error,
		});
	};

	private shouldTripCircuitBreaker = (): boolean => 
		this.consecutiveFailures >= this.maxFailures;

	private tripCircuitBreaker = () => {
		console.error(`Circuit breaker tripped for work stealing. Pausing for ${this.failureBackoff}ms.`);
		if (this.stealCheckTimer) {
			clearInterval(this.stealCheckTimer);
			this.stealCheckTimer = null;
		}

		// Schedule restart after backoff period
		setTimeout(() => {
			if (!this.isDisposed) {
				this.consecutiveFailures = 0;
				this.startWorkStealingMonitor();
			}
		}, this.failureBackoff);
	};

	private resetFailureCount = () => {
		this.consecutiveFailures = 0;
	};

	private findStuckSegmentsTask = (): TaskEither<SegmentProcessingData[]> =>
		TaskEither.tryCatch(
			() => this.findStuckSegments(),
			'Failed to find stuck segments',
		);

	private attemptStealSegmentTask = (segment: SegmentProcessingData): TaskEither<void> =>
		TaskEither.tryCatch(
			() => this.attemptStealSegment(segment),
			'Failed to steal segment',
		);

	private attemptStealSegments = (segments: SegmentProcessingData[]): TaskEither<PromiseSettledResult<void>[]> =>
		TaskEither.tryCatch(
			() => Promise.allSettled(segments.map((segment) => this.attemptStealSegment(segment))),
			'Failed to steal segments',
		);

	/**
	 * Check for stuck segments and attempt to steal them
	 */
	private async checkAndStealWork (): Promise<void> {
		await this.findStuckSegmentsTask()
			.filter(
				(segments) => segments.length > 0,
				() => createInternalError('No stuck segments found'),
			)
			.map(this.limitSegmentsToSteal)
			.ioSync((segmentsToSteal) => {
				const stuckCount = segmentsToSteal.length;
				const stealingCount = Math.min(stuckCount, this.config.maxStealsPerCheck);
				this.emitDetectionEvent(stuckCount, stealingCount);
			})
			.chain(this.attemptStealSegments)
			.map(this.countResults)
			.ioSync(({ successful, failed }) => {
				this.emitCompletionEvent(successful, failed);
				this.resetFailureCount();
			})
			.orElse((error) => {
				this.handleFailure(error.error || error);
				if (this.shouldTripCircuitBreaker()) {
					this.tripCircuitBreaker();
				}
				return TaskEither.of({ successful: 0, failed: 0 });
			})
			.toPromise();
	}

	// Pure helper functions for finding stuck segments
	private calculateClaimAge = (segment: any, now: number): number => 
		now - segment.claimTime;

	private isSegmentStuck = (segment: any, now: number): boolean => 
		this.calculateClaimAge(segment, now) > this.config.stealThreshold;

	private isNotBeingStolen = (segment: any): boolean => 
		!this.activeStealAttempts.has(this.getSegmentKey(segment));

	private parseSegmentData = (segment: any): (SegmentProcessingData & { originalSegment: any }) | null => {
		const claimManager = this.baseProcessor.getClaimManager();
		const parsedKey = claimManager.parseSegmentKey(segment.segmentKey);
		
		if (parsedKey) {
			return {
				fileId: parsedKey.fileId,
				sourceFilePath: '', // Will be filled by processor
				streamType: parsedKey.streamType,
				quality: parsedKey.quality,
				streamIndex: parsedKey.streamIndex,
				segmentIndex: parsedKey.segmentIndex,
				segmentStart: 0, // Will be filled by processor
				segmentDuration: 0, // Will be filled by processor
				totalSegments: 0, // Will be filled by processor
				ffmpegOptions: {
					inputOptions: [],
					outputOptions: [],
				},
				outputPath: segment.outputPath,
				// Store the original segment for stealing
				originalSegment: segment,
			};
		}
		return null;
	};

	private filterStuckSegments = (segments: any[], now: number): SegmentProcessingData[] => {
		const stuckSegments: SegmentProcessingData[] = [];
		
		for (const segment of segments) {
			if (this.isSegmentStuck(segment, now) && this.isNotBeingStolen(segment)) {
				const parsedData = this.parseSegmentData(segment);
				if (parsedData) {
					stuckSegments.push(parsedData);
				}
			}
		}
		
		return stuckSegments;
	};

	private getClaimedSegmentsTask = (): TaskEither<any[]> =>
		TaskEither.tryCatch(
			() => this.baseProcessor.getClaimedSegments(),
			'Failed to get claimed segments',
		);

	/**
	 * Find segments that appear to be stuck
	 */
	private async findStuckSegments (): Promise<SegmentProcessingData[]> {
		return this.getClaimedSegmentsTask()
			.map((segments) => this.filterStuckSegments(segments, Date.now()))
			.orElse(() => {
				console.error('Failed to find stuck segments');
				return TaskEither.of([]);
			})
			.toPromise();
	}

	// Pure helper functions for segment stealing
	private markSegmentAsBeingStolen = (segmentKey: string) => {
		this.activeStealAttempts.add(segmentKey);
	};

	private unmarkSegmentAsBeingStolen = (segmentKey: string) => {
		this.activeStealAttempts.delete(segmentKey);
	};

	private getOriginalSegmentKey = (segment: SegmentProcessingData & { originalSegment?: any }): string => 
		segment.originalSegment?.segmentKey || this.getSegmentKey(segment);

	private emitWorkStolenEvent = (segment: SegmentProcessingData & { originalSegment?: any }) => {
		this.emit('work:stolen', {
			workerId: this.config.workerId,
			segmentNumber: segment.segmentIndex,
			originalWorker: segment.originalSegment?.workerId || 'unknown',
		});
	};

	private forceClaimSegmentTask = (segmentKey: string, outputPath: string): TaskEither<boolean> =>
		TaskEither.tryCatch(
			() => this.baseProcessor.forceClaimSegment(segmentKey, this.config.workerId, outputPath),
			'Failed to force claim segment',
		);

	private processSegmentTask = (segment: SegmentProcessingData): TaskEither<SegmentProcessingResult> =>
		TaskEither.tryCatch(
			() => this.processSegment(segment),
			'Failed to process stolen segment',
		);

	/**
	 * Attempt to steal a specific segment
	 */
	private async attemptStealSegment (segment: SegmentProcessingData & { originalSegment?: any }): Promise<void> {
		const segmentKey = this.getSegmentKey(segment);
		const originalSegmentKey = this.getOriginalSegmentKey(segment);

		// Mark as being stolen
		this.markSegmentAsBeingStolen(segmentKey);

		await this.forceClaimSegmentTask(originalSegmentKey, segment.outputPath)
			.filter(
				(claimed) => claimed,
				() => createInternalError('Failed to claim segment'),
			)
			.ioSync(() => this.emitWorkStolenEvent(segment))
			.chain(() => this.processSegmentTask(segment))
			.ioSync(() => this.unmarkSegmentAsBeingStolen(segmentKey))
			.orElse((error) => {
				console.error(`Failed to steal segment ${segment.segmentIndex}: ${error}`);
				this.unmarkSegmentAsBeingStolen(segmentKey);
				return TaskEither.error(error);
			})
			.toPromise();
	}

	/**
	 * Get unique key for a segment
	 */
	private getSegmentKey (segment: SegmentProcessingData | { segmentKey: string }): string {
		if ('segmentKey' in segment) {
			return segment.segmentKey;
		}
		return `${segment.fileId}:${segment.streamType}:${segment.quality}:${segment.streamIndex}:${segment.segmentIndex}`;
	}

	/**
	 * Dispose and clean up
	 */
	async dispose (): Promise<void> {
		this.isDisposed = true;

		if (this.stealCheckTimer) {
			clearInterval(this.stealCheckTimer);
			this.stealCheckTimer = null;
		}

		this.activeStealAttempts.clear();

		await this.baseProcessor.dispose();
	}

	/**
	 * Get work stealing metrics
	 */
	getMetrics (): {
		mode: string;
		workerId: string;
		activeStealAttempts: number;
		stealThreshold: number;
		checkInterval: number;
		} {
		return {
			mode: this.getMode(),
			workerId: this.config.workerId,
			activeStealAttempts: this.activeStealAttempts.size,
			stealThreshold: this.config.stealThreshold,
			checkInterval: this.config.stealCheckInterval,
		};
	}
}