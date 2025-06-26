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
import * as fs from 'fs';
import * as os from 'os';

import { createInternalError, TaskEither } from '@eleven-am/fp';
import { RedisClientType } from 'redis';

import {
	DistributedConfig,
	ISegmentProcessor,
	SegmentClaim,
	SegmentProcessingData,
	SegmentProcessingResult,
} from './interfaces';
import { LocalSegmentProcessor } from './localSegmentProcessor';
import { RedisSegmentClaimManager } from './redisSegmentClaimManager';

/**
 * Distributed segment processor - coordinate segment processing across multiple nodes
 * Falls back to local processing if Redis is unavailable
 */
export class DistributedSegmentProcessor extends EventEmitter implements ISegmentProcessor {
	private readonly claimManager: RedisSegmentClaimManager;

	private readonly localProcessor: LocalSegmentProcessor;

	private readonly workerId: string;

	private readonly claimRenewalInterval: number;

	private readonly segmentTimeout: number;

	private readonly fallbackToLocal: boolean;

	private readonly fileWaitTimeout: number;

	private disposed = false;

	private readonly MAX_ACTIVE_RENEWALS = 1000;

	private activeRenewals = new Map<string, NodeJS.Timeout>();

	constructor (
        private readonly redis: RedisClientType,
        config: DistributedConfig = {},
	) {
		super();
		this.workerId = config.workerId || process.env.HOSTNAME || os.hostname();
		this.claimRenewalInterval = config.claimRenewalInterval || 20000;
		this.segmentTimeout = config.segmentTimeout || 30000;
		this.fallbackToLocal = config.fallbackToLocal !== false;
		this.fileWaitTimeout = config.fileWaitTimeout || 10000; // Default 10 seconds

		this.claimManager = new RedisSegmentClaimManager(
			redis,
			this.workerId,
			config.claimTTL || 60000,
			config.completedSegmentTTL,
		);

		this.localProcessor = new LocalSegmentProcessor(this.workerId);
	}

	async processSegment (data: SegmentProcessingData): Promise<SegmentProcessingResult> {
		let renewalTimer: NodeJS.Timeout | null = null;
		let claim: SegmentClaim | null = null;

		return this.checkSegmentExistsOnDisk(data.outputPath)
			.matchTask([
				{
					predicate: (exists) => exists,
					run: () => TaskEither.of(this.createCachedResult(data)),
				},
				{
					predicate: () => true,
					run: () => this.checkRedisCompletionStatus(data)
						.matchTask([
							{
								predicate: (isCompleted) => isCompleted,
								run: () => this.waitForFileTask(data.outputPath, this.fileWaitTimeout)
									.map(fileAppeared =>
										fileAppeared
											? this.createCachedResult(data)
											: this.createFileNotFoundResult(data),
									),
							},
							{
								predicate: () => true,
								run: () => this.claimSegmentTask(data)
									.ioSync(c => { claim = c; })
									.matchTask([
										{
											predicate: (c) => !c.acquired,
											run: () => this.waitForSegmentCompletionTask(data),
										},
										{
											predicate: (c) => c.acquired,
											run: (c) => this.setupClaimRenewal(c, data.segmentIndex)
												.ioSync(timer => { renewalTimer = timer; })
												.chain(() => this.processSegmentLocally(data))
												.chain(result => this.handleSuccessfulProcessing(data, result)),
										},
									]),
							},
						]),
				},
			])
			.orElse((error) => this.handleRedisErrorWithFallback(error, data))
			.io(() => this.cleanupClaimAndTimer(claim, renewalTimer))
			.toPromise();
	}

	async isHealthy (): Promise<boolean> {
		return this.checkRedisConnection()
			.map(redisAvailable => this.determineHealthStatus(this.disposed, redisAvailable))
			.orElse(() => TaskEither.of(this.determineHealthStatus(this.disposed, false)))
			.toPromise();
	}

	getMode (): 'local' | 'distributed' {
		return 'distributed';
	}

	async dispose (): Promise<void> {
		this.disposed = true;

		// Clear all renewal timers
		this.clearAllRenewals();

		// Dispose local processor
		await this.localProcessor.dispose();
	}

	/**
	 * Get all currently claimed segments
	 * Public method for work stealing processor
	 */
	async getClaimedSegments (): Promise<Array<{
		segmentKey: string;
		workerId: string;
		claimTime: number;
		expiresAt: number;
		outputPath: string;
	}>> {
		return this.claimManager.getClaimedSegments();
	}

	/**
	 * Force claim a segment
	 * Public method for work stealing processor
	 */
	async forceClaimSegment (
		segmentKey: string,
		workerId: string,
		outputPath?: string,
	): Promise<boolean> {
		return this.claimManager.forceClaimSegment(segmentKey, workerId, outputPath);
	}

	// Pure helper functions for segment processing
	private createCachedResult = (data: SegmentProcessingData): SegmentProcessingResult => ({
		success: true,
		segmentIndex: data.segmentIndex,
		outputPath: data.outputPath,
		cached: true,
	});

	private createFileNotFoundResult = (data: SegmentProcessingData): SegmentProcessingResult => ({
		success: false,
		segmentIndex: data.segmentIndex,
		outputPath: data.outputPath,
		cached: true,
		error: new Error('Segment marked complete but file not found'),
	});

	private checkSegmentExistsOnDisk = (outputPath: string): TaskEither<boolean> =>
		TaskEither.tryCatch(
			() => this.segmentExists(outputPath),
			'Failed to check segment existence',
		);

	private checkRedisCompletionStatus = (data: SegmentProcessingData): TaskEither<boolean> =>
		TaskEither.tryCatch(
			() => this.claimManager.isSegmentCompleted(
				data.fileId,
				data.streamType,
				data.quality,
				data.streamIndex,
				data.segmentIndex,
			),
			'Failed to check completion status',
		);

	private waitForFileTask = (outputPath: string, timeout: number): TaskEither<boolean> =>
		TaskEither.tryCatch(
			() => this.waitForFile(outputPath, timeout),
			'Failed to wait for file',
		);

	private claimSegmentTask = (data: SegmentProcessingData): TaskEither<SegmentClaim> =>
		TaskEither.tryCatch(
			() => this.claimManager.claimSegment(
				data.fileId,
				data.streamType,
				data.quality,
				data.streamIndex,
				data.segmentIndex,
				data.outputPath,
			),
			'Failed to claim segment',
		);

	private setupClaimRenewal = (claim: SegmentClaim, segmentIndex: number): TaskEither<NodeJS.Timeout> =>
		TaskEither.of(null).map(() => {
			const timer = setInterval(async () => {
				try {
					const extended = await claim.extend();
					if (!extended) {
						console.warn(`Failed to extend claim for segment ${segmentIndex}`);
					}
				} catch (error) {
					console.error(`Error extending claim for segment ${segmentIndex}:`, error);
				}
			}, this.claimRenewalInterval);
			
			// Add creation timestamp for age-based eviction
			(timer as any).createdAt = Date.now();

			// Implement LRU eviction if at capacity
			if (this.activeRenewals.size >= this.MAX_ACTIVE_RENEWALS) {
				this.evictOldestRenewal();
			}
			this.activeRenewals.set(claim.segmentKey, timer);
			return timer;
		});

	private processSegmentLocally = (data: SegmentProcessingData): TaskEither<SegmentProcessingResult> =>
		TaskEither.tryCatch(
			() => this.localProcessor.processSegment(data),
			'Failed to process segment locally',
		);

	private markSegmentComplete = (data: SegmentProcessingData): TaskEither<void> =>
		TaskEither.tryCatch(
			() => this.claimManager.markSegmentCompleted(
				data.fileId,
				data.streamType,
				data.quality,
				data.streamIndex,
				data.segmentIndex,
			),
			'Failed to mark segment complete',
		);

	private publishSegmentComplete = (data: SegmentProcessingData): TaskEither<void> =>
		TaskEither.tryCatch(
			() => this.claimManager.publishSegmentComplete(
				data.fileId,
				data.streamType,
				data.quality,
				data.streamIndex,
				data.segmentIndex,
			),
			'Failed to publish completion',
		);

	private handleSuccessfulProcessing = (data: SegmentProcessingData, result: SegmentProcessingResult): TaskEither<SegmentProcessingResult> =>
		result.success
			? this.markSegmentComplete(data)
				.chain(() => this.publishSegmentComplete(data))
				.map(() => result)
			: TaskEither.of(result);

	private waitForSegmentCompletionTask = (data: SegmentProcessingData): TaskEither<SegmentProcessingResult> =>
		TaskEither.tryCatch(
			() => this.waitForSegmentCompletion(data),
			'Failed to wait for segment completion',
		);

	// Pure helper function to clean up claim and renewal timer
	private cleanupClaimAndTimer = (claim: SegmentClaim | null, renewalTimer: NodeJS.Timeout | null): TaskEither<void> => {
		const cleanupTimer = () => {
			if (renewalTimer) {
				clearInterval(renewalTimer);
				if (claim?.segmentKey) {
					this.cleanupRenewal(claim.segmentKey);
				}
			}
		};

		const releaseClaim = async () => {
			if (claim?.acquired) {
				try {
					await claim.release();
				} catch (err) {
					console.error('CRITICAL: Failed to release claim during cleanup:', {
						segmentKey: claim.segmentKey,
						workerId: this.workerId,
						error: err,
					});
					// Emit critical error for monitoring
					this.emit('critical:error', {
						type: 'claim_release_failed',
						segmentKey: claim.segmentKey,
						workerId: this.workerId,
						error: err,
					});
					// Do not re-throw - the claim will expire via TTL
				}
			}
		};

		return TaskEither.of(undefined)
			.ioSync(cleanupTimer)
			.io(() => TaskEither.tryCatch(
				() => releaseClaim(),
				'Failed to release claim',
			).orElse(() => TaskEither.of(undefined)));
	};

	// Pure helper function to handle Redis errors with fallback
	private handleRedisErrorWithFallback = (error: any, data: SegmentProcessingData): TaskEither<SegmentProcessingResult> => {
		const errorObj = error.error || error;
		if (this.fallbackToLocal && this.isRedisError(errorObj)) {
			console.warn('Redis error, falling back to local processing:', errorObj);
			return TaskEither.tryCatch(
				() => this.localProcessor.processSegment(data),
				'Local processing failed',
			);
		}
		return TaskEither.of({
			success: false,
			segmentIndex: data.segmentIndex,
			outputPath: data.outputPath,
			error: new Error(errorObj.message || 'Unknown error'),
		});
	};

	private checkRedisConnection = (): TaskEither<boolean> =>
		TaskEither.tryCatch(
			() => this.redis.ping().then(() => true),
			'Redis connection failed',
		);

	private determineHealthStatus = (disposed: boolean, redisAvailable: boolean): boolean => {
		if (disposed) return false;
		return redisAvailable || this.fallbackToLocal;
	};

	// Helper functions for waitForSegmentCompletion
	private createCompletionState = () => ({
		startTime: Date.now(),
		unsubscribe: null as (() => Promise<void>) | null,
		checkInterval: null as NodeJS.Timeout | null,
		segmentCompleted: false,
	});

	private cleanupSubscriptions = (state: { unsubscribe: (() => Promise<void>) | null; checkInterval: NodeJS.Timeout | null }): TaskEither<void> => {
		const clearTimer = () => {
			if (state.checkInterval) {
				clearInterval(state.checkInterval);
			}
		};

		const unsubscribe = async () => {
			if (state.unsubscribe) {
				try {
					await state.unsubscribe();
				} catch (err) {
					console.error('Error during unsubscribe in cleanup:', err);
				}
			}
		};

		return TaskEither.of(undefined)
			.ioSync(clearTimer)
			.io(() => TaskEither.tryCatch(
				() => unsubscribe(),
				'Failed to unsubscribe',
			).orElse(() => TaskEither.of(undefined)));
	};

	private subscribeToCompletion = (data: SegmentProcessingData, state: { segmentCompleted: boolean; checkInterval: NodeJS.Timeout | null }): TaskEither<() => Promise<void>> =>
		TaskEither.tryCatch(
			() => this.claimManager.subscribeToSegmentComplete(
				data.fileId,
				data.streamType,
				data.quality,
				data.streamIndex,
				data.segmentIndex,
				() => { state.segmentCompleted = true; },
			),
			'Failed to subscribe to completion',
		);

	private createPeriodicFileCheck = (data: SegmentProcessingData, state: { segmentCompleted: boolean; checkInterval: NodeJS.Timeout | null }): Promise<boolean> =>
		new Promise<boolean>((resolve) => {
			const checkFile = async () => {
				if (state.segmentCompleted || await this.segmentExists(data.outputPath)) {
					if (state.checkInterval) {
						clearInterval(state.checkInterval);
					}
					resolve(true);
				}
			};

			// Check immediately
			checkFile();
			// Then check periodically
			state.checkInterval = setInterval(checkFile, 1000);
		});

	private createTimeoutPromise = (timeout: number): Promise<boolean> =>
		new Promise<boolean>((resolve) => {
			setTimeout(() => resolve(false), timeout);
		});

	private createSuccessResult = (data: SegmentProcessingData, startTime: number): SegmentProcessingResult => ({
		success: true,
		segmentIndex: data.segmentIndex,
		outputPath: data.outputPath,
		cached: true,
		processingTime: Date.now() - startTime,
	});

	private createTimeoutResult = (data: SegmentProcessingData, startTime: number): SegmentProcessingResult => ({
		success: false,
		segmentIndex: data.segmentIndex,
		outputPath: data.outputPath,
		error: new Error(`Timeout waiting for segment ${data.segmentIndex} after ${this.segmentTimeout}ms`),
		processingTime: Date.now() - startTime,
	});

	private createErrorResult = (data: SegmentProcessingData, error: Error, startTime: number): SegmentProcessingResult => ({
		success: false,
		segmentIndex: data.segmentIndex,
		outputPath: data.outputPath,
		error,
		processingTime: Date.now() - startTime,
	});

	private async waitForSegmentCompletion (data: SegmentProcessingData): Promise<SegmentProcessingResult> {
		const state = this.createCompletionState();

		try {
			// Subscribe to completion events
			state.unsubscribe = await this.subscribeToCompletion (data, state).toPromise ();

			// Set up periodic file check
			const checkPromise = this.createPeriodicFileCheck(data, state);

			// Wait for either completion or timeout
			const timeoutPromise = this.createTimeoutPromise(this.segmentTimeout);

			const completed = await Promise.race([checkPromise, timeoutPromise]);

			await this.cleanupSubscriptions(state).toPromise();

			if (completed) {
				return this.createSuccessResult(data, state.startTime);
			}

			return this.createTimeoutResult(data, state.startTime);
		} catch (error) {
			await this.cleanupSubscriptions(state).toPromise();

			return this.createErrorResult(data, error as Error, state.startTime);
		}
	}

	private delay = (ms: number): TaskEither<void> =>
		TaskEither.tryCatch(
			() => new Promise<void>((resolve) => setTimeout(resolve, ms)),
			'Delay failed',
		);

	private checkFileWithRetry = (filePath: string, startTime: number, timeout: number): TaskEither<boolean> =>
		TaskEither.of(Date.now() - startTime)
			.chain(elapsed =>
				elapsed < timeout
					? TaskEither.of(elapsed)
					: TaskEither.error(createInternalError('Timeout waiting for file')),
			)
			.chain(() => this.checkSegmentExistsOnDisk(filePath))
			.matchTask([
				{
					predicate: exists => exists,
					run: () => TaskEither.of(true),
				},
				{
					predicate: () => true,
					run: () => this.delay(100)
						.chain(() => this.checkFileWithRetry(filePath, startTime, timeout)),
				},
			])
			.orElse(() => TaskEither.of(false));

	private async waitForFile (filePath: string, timeout: number): Promise<boolean> {
		const startTime = Date.now();
		return this.checkFileWithRetry(filePath, startTime, timeout).toPromise();
	}

	private checkFileAccess = (filePath: string): TaskEither<boolean> =>
		TaskEither.tryCatch(
			() => fs.promises.access(filePath).then(() => true),
			'File access failed',
		)
			.orElse(() => TaskEither.of(false));

	private async segmentExists (filePath: string): Promise<boolean> {
		return this.checkFileAccess(filePath)
			.orElse(() => TaskEither.of(false))
			.toPromise();
	}

	private isRedisError (error: unknown): boolean {
		// Type guard for Node.js system errors
		const nodeError = error as NodeJS.ErrnoException;

		if (nodeError?.code === 'ECONNREFUSED' || nodeError?.code === 'ETIMEDOUT') {
			return true;
		}

		// Check error message for Redis-related errors
		if (error instanceof Error) {
			const message = error.message.toLowerCase();


			return message.includes('redis') || message.includes('connection');
		}

		return false;
	}

	/**
	 * Get the claim manager instance
	 * Public method for work stealing processor
	 */
	getClaimManager (): RedisSegmentClaimManager {
		return this.claimManager;
	}

	// Memory management helper methods
	private evictOldestRenewal = (): void => {
		// Evict renewals that have been active for too long (likely stuck)
		const now = Date.now();
		const maxAge = this.segmentTimeout * 2; // 2x segment timeout
		
		for (const [key, timer] of this.activeRenewals.entries()) {
			// Store creation time in the timer object
			if ((timer as any).createdAt && now - (timer as any).createdAt > maxAge) {
				this.cleanupRenewal(key);
				return;
			}
		}
		
		// Fallback to FIFO if no old renewals found
		const firstKey = this.activeRenewals.keys().next().value;
		if (firstKey) {
			this.cleanupRenewal(firstKey);
		}
	};

	private cleanupRenewal = (segmentKey: string): void => {
		const timer = this.activeRenewals.get(segmentKey);
		if (timer) {
			clearInterval(timer);
			this.activeRenewals.delete(segmentKey);
		}
	};

	private clearAllRenewals = (): void => {
		for (const timer of this.activeRenewals.values()) {
			clearInterval(timer);
		}
		this.activeRenewals.clear();
	};
}
