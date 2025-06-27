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

import * as fs from 'fs';
import * as os from 'os';

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
export class DistributedSegmentProcessor implements ISegmentProcessor {
	private readonly claimManager: RedisSegmentClaimManager;

	private readonly localProcessor: LocalSegmentProcessor;

	private readonly workerId: string;

	private readonly claimRenewalInterval: number;

	private readonly segmentTimeout: number;

	private readonly fallbackToLocal: boolean;

	private readonly fileWaitTimeout: number;

	private disposed = false;

	private activeRenewals = new Map<string, NodeJS.Timeout>();

	constructor (
        private readonly redis: RedisClientType,
        config: DistributedConfig = {},
	) {
		this.workerId = config.workerId || process.env.HOSTNAME || os.hostname();
		this.claimRenewalInterval = config.claimRenewalInterval || 20000;
		this.segmentTimeout = config.segmentTimeout || 30000;
		this.fallbackToLocal = config.fallbackToLocal !== false;
		this.fileWaitTimeout = config.fileWaitTimeout || 10000;

		this.claimManager = new RedisSegmentClaimManager(
			redis,
			this.workerId,
			config.claimTTL || 60000,
			config.completedSegmentTTL,
		);

		this.localProcessor = new LocalSegmentProcessor(this.workerId);
	}

	async processSegment (data: SegmentProcessingData): Promise<SegmentProcessingResult> {
		let claim: SegmentClaim | null = null;
		let renewalTimer: NodeJS.Timeout | null = null;

		try {
			if (await this.segmentExists(data.outputPath)) {
				return {
					success: true,
					segmentIndex: data.segmentIndex,
					outputPath: data.outputPath,
					cached: true,
				};
			}

			const isCompleted = await this.claimManager.isSegmentCompleted(
				data.fileId,
				data.streamType,
				data.quality,
				data.streamIndex,
				data.segmentIndex,
			);

			if (isCompleted) {
				const fileAppeared = await this.waitForFile(data.outputPath, this.fileWaitTimeout);

				return {
					success: fileAppeared,
					segmentIndex: data.segmentIndex,
					outputPath: data.outputPath,
					cached: true,
					error: fileAppeared ? undefined : new Error('Segment marked complete but file not found'),
				};
			}

			claim = await this.claimManager.claimSegment(
				data.fileId,
				data.streamType,
				data.quality,
				data.streamIndex,
				data.segmentIndex,
			);

			if (!claim.acquired) {
				return await this.waitForSegmentCompletion(data);
			}

			renewalTimer = setInterval(async () => {
				try {
					const extended = await claim!.extend();

					if (!extended) {
						console.warn(`Failed to extend claim for segment ${data.segmentIndex}`);
					}
				} catch (error) {
					console.error(`Error extending claim for segment ${data.segmentIndex}:`, error);
				}
			}, this.claimRenewalInterval);

			this.activeRenewals.set(claim.segmentKey, renewalTimer);

			const result = await this.localProcessor.processSegment(data);

			if (result.success) {
				await this.claimManager.markSegmentCompleted(
					data.fileId,
					data.streamType,
					data.quality,
					data.streamIndex,
					data.segmentIndex,
				);

				await this.claimManager.publishSegmentComplete(
					data.fileId,
					data.streamType,
					data.quality,
					data.streamIndex,
					data.segmentIndex,
				);
			}

			return result;
		} catch (error) {
			if (this.fallbackToLocal && this.isRedisError(error)) {
				console.warn('Redis error, falling back to local processing:', error);

				return await this.localProcessor.processSegment(data);
			}

			return {
				success: false,
				segmentIndex: data.segmentIndex,
				outputPath: data.outputPath,
				error: error as Error,
			};
		} finally {
			// Clean up
			if (renewalTimer) {
				clearInterval(renewalTimer);
				if (claim?.segmentKey) {
					this.activeRenewals.delete(claim.segmentKey);
				}
			}

			if (claim?.acquired) {
				try {
					await claim?.release();
				} catch (err) {
					console.error('CRITICAL: Failed to release claim during cleanup:', {
						segmentKey: claim?.segmentKey,
						workerId: this.workerId,
						error: err,
					});
				}
			}
		}
	}

	async isHealthy (): Promise<boolean> {
		if (this.disposed) {
			return false;
		}

		try {
			await this.redis.ping();

			return true;
		} catch {
			return this.fallbackToLocal;
		}
	}

	getMode (): 'local' | 'distributed' {
		return 'distributed';
	}

	async dispose (): Promise<void> {
		this.disposed = true;

		for (const timer of this.activeRenewals.values()) {
			clearInterval(timer);
		}
		this.activeRenewals.clear();

		await this.claimManager.dispose();

		await this.localProcessor.dispose();
	}

	private async waitForSegmentCompletion (data: SegmentProcessingData): Promise<SegmentProcessingResult> {
		const startTime = Date.now();
		let unsubscribe: (() => Promise<void>) | null = null;
		let checkInterval: NodeJS.Timeout | null = null;
		let segmentCompleted = false;

		const cleanup = async () => {
			if (checkInterval) {
				clearInterval(checkInterval);
			}
			if (unsubscribe) {
				try {
					await unsubscribe();
				} catch (err) {
					console.error('Error during unsubscribe in cleanup:', err);
				}
			}
		};

		try {
			unsubscribe = await this.claimManager.subscribeToSegmentComplete(
				data.fileId,
				data.streamType,
				data.quality,
				data.streamIndex,
				data.segmentIndex,
				() => {
					segmentCompleted = true;
				},
			);

			const checkPromise = new Promise<boolean>((resolve) => {
				const checkFile = async () => {
					if (segmentCompleted || await this.segmentExists(data.outputPath)) {
						clearInterval(checkInterval!);
						resolve(true);
					}
				};

				checkFile();

				checkInterval = setInterval(checkFile, 1000);
			});

			const timeoutPromise = new Promise<boolean>((resolve) => {
				setTimeout(() => resolve(false), this.segmentTimeout);
			});

			const completed = await Promise.race([checkPromise, timeoutPromise]);

			await cleanup();

			if (completed) {
				return {
					success: true,
					segmentIndex: data.segmentIndex,
					outputPath: data.outputPath,
					cached: true,
					processingTime: Date.now() - startTime,
				};
			}

			return {
				success: false,
				segmentIndex: data.segmentIndex,
				outputPath: data.outputPath,
				error: new Error(`Timeout waiting for segment ${data.segmentIndex} after ${this.segmentTimeout}ms`),
				processingTime: Date.now() - startTime,
			};
		} catch (error) {
			await cleanup();

			return {
				success: false,
				segmentIndex: data.segmentIndex,
				outputPath: data.outputPath,
				error: error as Error,
				processingTime: Date.now() - startTime,
			};
		}
	}

	private async waitForFile (filePath: string, timeout: number): Promise<boolean> {
		const startTime = Date.now();

		while (Date.now() - startTime < timeout) {
			if (await this.segmentExists(filePath)) {
				return true;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		return false;
	}

	private async segmentExists (filePath: string): Promise<boolean> {
		try {
			await fs.promises.access(filePath);

			return true;
		} catch {
			return false;
		}
	}

	private isRedisError (error: unknown): boolean {
		const nodeError = error as NodeJS.ErrnoException;

		if (nodeError?.code === 'ECONNREFUSED' || nodeError?.code === 'ETIMEDOUT') {
			return true;
		}

		if (error instanceof Error) {
			const message = error.message.toLowerCase();


			return message.includes('redis') || message.includes('connection');
		}

		return false;
	}
}
