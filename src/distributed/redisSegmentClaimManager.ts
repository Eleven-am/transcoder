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

import { RedisClientType } from 'redis';
import { createInternalError, TaskEither } from '@eleven-am/fp';

import { SegmentClaim } from './interfaces';

/**
 * Manages distributed segment claims using Redis
 * Ensures only one worker processes each segment at a time
 */
export class RedisSegmentClaimManager {
	private readonly lockPrefix = 'transcoder:segment:lock:';

	private readonly statusPrefix = 'transcoder:segment:status:';

	private readonly completedPrefix = 'transcoder:segment:completed:';

	private readonly completedSegmentTTL: number;

	constructor (
        private readonly redis: RedisClientType,
        private readonly workerId: string,
        private readonly defaultTTL: number = 60000, // 60 seconds
        completedSegmentTTL?: number,
	) {
		// Default to 7 days if not specified
		this.completedSegmentTTL = completedSegmentTTL || 7 * 24 * 60 * 60 * 1000;
	}

	/**
     * Try to claim a segment for processing
     */
	async claimSegment (
		fileId: string,
		streamType: string,
		quality: string,
		streamIndex: number,
		segmentIndex: number,
		outputPath?: string,
	): Promise<SegmentClaim> {
		const segmentKey = this.getSegmentKey(fileId, streamType, quality, streamIndex, segmentIndex);
		const lockKey = `${this.lockPrefix}${segmentKey}`;
		const now = Date.now();
		const expiresAt = now + this.defaultTTL;

		// Try to acquire lock atomically
		const acquired = await this.redis.set(
			lockKey,
			JSON.stringify({ 
				workerId: this.workerId,
				claimedAt: now,
				expiresAt,
				outputPath: outputPath || '',
			}),
			{ NX: true,
				PX: this.defaultTTL },
		);

		if (!acquired) {
			return this.createFailedClaim(segmentKey);
		}

		// Mark segment as processing
		await this.redis.set(
			`${this.statusPrefix}${segmentKey}`,
			'processing',
			{ PX: this.defaultTTL * 2 }, // Status lives longer than lock
		);

		return this.createSuccessfulClaim(segmentKey, lockKey, expiresAt);
	}

	/**
     * Check if a segment is already completed
     */
	async isSegmentCompleted (
		fileId: string,
		streamType: string,
		quality: string,
		streamIndex: number,
		segmentIndex: number,
	): Promise<boolean> {
		const segmentKey = this.getSegmentKey(fileId, streamType, quality, streamIndex, segmentIndex);
		const completed = await this.redis.get(`${this.completedPrefix}${segmentKey}`);


		return completed === 'true';
	}

	/**
     * Mark a segment as completed
     */
	async markSegmentCompleted (
		fileId: string,
		streamType: string,
		quality: string,
		streamIndex: number,
		segmentIndex: number,
	): Promise<void> {
		const segmentKey = this.getSegmentKey(fileId, streamType, quality, streamIndex, segmentIndex);

		// Set completed status with configurable TTL
		await this.redis.set(
			`${this.completedPrefix}${segmentKey}`,
			'true',
			{ PX: this.completedSegmentTTL },
		);

		// Update status
		await this.redis.set(
			`${this.statusPrefix}${segmentKey}`,
			'completed',
			{ PX: this.completedSegmentTTL },
		);
	}

	/**
     * Get the status of a segment
     */
	async getSegmentStatus (
		fileId: string,
		streamType: string,
		quality: string,
		streamIndex: number,
		segmentIndex: number,
	): Promise<string | null> {
		const segmentKey = this.getSegmentKey(fileId, streamType, quality, streamIndex, segmentIndex);


		return await this.redis.get(`${this.statusPrefix}${segmentKey}`);
	}

	/**
     * Publish segment completion event
     */
	async publishSegmentComplete (
		fileId: string,
		streamType: string,
		quality: string,
		streamIndex: number,
		segmentIndex: number,
	): Promise<void> {
		const segmentKey = this.getSegmentKey(fileId, streamType, quality, streamIndex, segmentIndex);
		const channel = `transcoder:segment:complete:${segmentKey}`;

		await this.redis.publish(channel, 'completed');
	}

	// Pure helper functions for subscriptions
	private createCompletionChannel = (segmentKey: string): string => 
		`transcoder:segment:complete:${segmentKey}`;

	private handleCompletionMessage = (message: string, callback: () => void): void => {
		if (message === 'completed') {
			callback();
		}
	};

	private createUnsubscribeFunction = (subscriber: RedisClientType, channel: string): () => Promise<void> => 
		async () => {
			await TaskEither.of(subscriber.isOpen)
				.filter(
					(isOpen) => isOpen,
					() => createInternalError('Subscriber not open'),
				)
				.chain(() => TaskEither.tryCatch(
					() => subscriber.unsubscribe(channel),
					'Failed to unsubscribe',
				))
				.chain(() => TaskEither.tryCatch(
					() => subscriber.disconnect(),
					'Failed to disconnect',
				))
				.orElse((error) => {
					console.error('Error during Redis subscriber cleanup:', error);
					if (subscriber.isOpen) {
						return TaskEither.tryCatch(
							() => subscriber.disconnect(),
							'Failed to disconnect on cleanup',
						);
					}
					return TaskEither.of(undefined);
				})
				.toPromise();
		};

	private connectSubscriber = (subscriber: RedisClientType): TaskEither<RedisClientType> =>
		TaskEither.tryCatch(
			() => subscriber.connect().then(() => subscriber),
			'Failed to connect subscriber',
		);

	private subscribeToChannel = (subscriber: RedisClientType, channel: string, callback: () => void): TaskEither<void> =>
		TaskEither.tryCatch(
			() => subscriber.subscribe(channel, (message) => this.handleCompletionMessage(message, callback)),
			'Failed to subscribe to channel',
		);

	private disconnectSubscriber = (subscriber: RedisClientType): TaskEither<void> =>
		TaskEither.of(subscriber.isOpen)
			.filter(
				(isOpen) => isOpen,
				() => createInternalError('Subscriber not open'),
			)
			.chain(() => TaskEither.tryCatch(
				() => subscriber.disconnect(),
				'Failed to disconnect',
			));

	/**
     * Subscribe to segment completion events
     */
	async subscribeToSegmentComplete (
		fileId: string,
		streamType: string,
		quality: string,
		streamIndex: number,
		segmentIndex: number,
		callback: () => void,
	): Promise<() => Promise<void>> {
		const segmentKey = this.getSegmentKey(fileId, streamType, quality, streamIndex, segmentIndex);
		const channel = this.createCompletionChannel(segmentKey);
		const subscriber = this.redis.duplicate();

		return this.connectSubscriber(subscriber)
			.chain(() => this.subscribeToChannel(subscriber, channel, callback))
			.map(() => this.createUnsubscribeFunction(subscriber, channel))
			.orElse((error) => {
				// Ensure we disconnect on any failure to prevent leaks
				return this.disconnectSubscriber(subscriber)
					.chain(() => TaskEither.error(error));
			})
			.toPromise();
	}

	private getSegmentKey (
		fileId: string,
		streamType: string,
		quality: string,
		streamIndex: number,
		segmentIndex: number,
	): string {
		return `${fileId}:${streamType}:${quality}:${streamIndex}:${segmentIndex}`;
	}

	private createFailedClaim (segmentKey: string): SegmentClaim {
		return {
			acquired: false,
			segmentKey,
			workerId: this.workerId,
			expiresAt: 0,
			extend: async () => false,
			release: async () => {},
		};
	}

	private createSuccessfulClaim (
		segmentKey: string,
		lockKey: string,
		expiresAt: number,
	): SegmentClaim {
		return {
			acquired: true,
			segmentKey,
			workerId: this.workerId,
			expiresAt,
			extend: async () => {
				// Extend lock using Lua script for atomicity
				const script = `
                    local lock = redis.call('get', KEYS[1])
                    if lock then
                        local data = cjson.decode(lock)
                        if data.workerId == ARGV[1] then
                            local newExpiry = tonumber(ARGV[2])
                            data.expiresAt = newExpiry
                            redis.call('set', KEYS[1], cjson.encode(data), 'PX', ARGV[3])
                            return 1
                        end
                    end
                    return 0
                `;

				const newExpiresAt = Date.now() + this.defaultTTL;
				const result = await this.redis.eval(script, {
					keys: [lockKey],
					arguments: [this.workerId, newExpiresAt.toString(), this.defaultTTL.toString()],
				}) as number;

				return result === 1;
			},
			release: async () => {
				// Release lock only if we own it
				const script = `
                    local lock = redis.call('get', KEYS[1])
                    if lock then
                        local data = cjson.decode(lock)
                        if data.workerId == ARGV[1] then
                            return redis.call('del', KEYS[1])
                        end
                    end
                    return 0
                `;

				await this.redis.eval(script, {
					keys: [lockKey],
					arguments: [this.workerId],
				});
			},
		};
	}

	// Pure helper functions for getting claimed segments
	private scanForLockKeys = async (): Promise<string[]> => {
		const lockKeys: string[] = [];
		let cursor = '0';
		
		do {
			const reply = await this.redis.scan(cursor, {
				MATCH: `${this.lockPrefix}*`,
				COUNT: 100, // Process in batches of 100
			});
			cursor = reply.cursor;
			lockKeys.push(...reply.keys);
		} while (cursor !== '0');

		return lockKeys;
	};

	private scanForLockKeysTask = (): TaskEither<string[]> =>
		TaskEither.tryCatch(
			() => this.scanForLockKeys(),
			'Failed to scan for lock keys',
		);

	private getLockValues = (lockKeys: string[]): TaskEither<(string | null)[]> =>
		TaskEither.tryCatch(
			() => this.redis.mGet(lockKeys),
			'Failed to get lock values',
		);

	private parseLockValue = (lockValue: string | null, lockKey: string): {
		segmentKey: string;
		workerId: string;
		claimTime: number;
		expiresAt: number;
		outputPath: string;
	} | null => {
		if (!lockValue) return null;
		
		try {
			const data = JSON.parse(lockValue);
			const segmentKey = lockKey.replace(this.lockPrefix, '');

			return {
				segmentKey,
				workerId: data.workerId,
				claimTime: data.claimedAt,
				expiresAt: data.expiresAt,
				outputPath: data.outputPath || '',
			};
		} catch {
			return null;
		}
	};

	private processClaims = (lockKeys: string[], lockValues: (string | null)[]): Array<{
		segmentKey: string;
		workerId: string;
		claimTime: number;
		expiresAt: number;
		outputPath: string;
	}> => {
		const claimedSegments: Array<{
			segmentKey: string;
			workerId: string;
			claimTime: number;
			expiresAt: number;
			outputPath: string;
		}> = [];

		for (let i = 0; i < lockKeys.length; i++) {
			const parsed = this.parseLockValue(lockValues[i], lockKeys[i]);
			if (parsed) {
				claimedSegments.push(parsed);
			}
		}

		return claimedSegments;
	};

	/**
	 * Get all currently claimed segments with their metadata
	 * Used for work stealing detection
	 */
	async getClaimedSegments (): Promise<Array<{
		segmentKey: string;
		workerId: string;
		claimTime: number;
		expiresAt: number;
		outputPath: string;
	}>> {
		return this.scanForLockKeysTask()
			.filter(
				(keys) => keys.length > 0,
				() => createInternalError('No lock keys found'),
			)
			.chain((lockKeys) => 
				this.getLockValues(lockKeys)
					.map((lockValues) => this.processClaims(lockKeys, lockValues)),
			)
			.orElse((error) => {
				console.error('Failed to get claimed segments:', error);
				return TaskEither.of([]);
			})
			.toPromise();
	}

	// Pure helper functions for force claiming
	private buildForceClaimScript = (): string => `
		local lockKey = KEYS[1]
		local completedKey = KEYS[2]
		local newWorkerId = ARGV[1]
		local now = tonumber(ARGV[2])
		local expiresAt = tonumber(ARGV[3])
		local ttl = ARGV[4]

		-- 1. Do not steal if already completed
		if redis.call('get', completedKey) then
			return 0
		end

		local lockValue = redis.call('get', lockKey)
		if not lockValue then
			return 0 -- Lock was released, not stuck
		end

		local data = cjson.decode(lockValue)

		-- 2. Do not steal if already stolen by another worker
		if data.forced and data.workerId ~= newWorkerId then
			return 0
		end

		-- 3. Do not steal if the lock has not expired (i.e., not stuck)
		if tonumber(data.expiresAt) > now then
			return 0
		end

		-- 4. Atomically steal the lock
		local newLockData = {
			workerId = newWorkerId,
			claimedAt = now,
			expiresAt = expiresAt,
			forced = true,
			originalWorkerId = data.workerId,
			outputPath = data.outputPath or ARGV[5] or ''
		}
		redis.call('set', lockKey, cjson.encode(newLockData), 'PX', ttl)
		return 1
	`;

	private buildLockKey = (segmentKey: string): string => 
		this.lockPrefix + segmentKey;

	private buildCompletedKey = (segmentKey: string): string => 
		this.completedPrefix + segmentKey;

	private executeForceClaimScript = (
		lockKey: string, 
		completedKey: string, 
		newWorkerId: string, 
		now: number, 
		expiresAt: number, 
		outputPath: string,
	): TaskEither<boolean> =>
		TaskEither.tryCatch(
			() => this.redis.eval(this.buildForceClaimScript(), {
				keys: [lockKey, completedKey],
				arguments: [
					newWorkerId, 
					now.toString(), 
					expiresAt.toString(), 
					this.defaultTTL.toString(), 
					outputPath,
				],
			}),
			'Failed to execute force claim script',
		)
			.map((result) => result === 1);

	/**
	 * Force claim a segment, overriding existing claims
	 * Used for work stealing when a worker is unresponsive
	 */
	async forceClaimSegment (
		segmentKey: string,
		newWorkerId: string,
		outputPath?: string,
	): Promise<boolean> {
		const lockKey = this.buildLockKey(segmentKey);
		const completedKey = this.buildCompletedKey(segmentKey);
		const now = Date.now();
		const expiresAt = now + this.defaultTTL;

		return this.executeForceClaimScript(
			lockKey,
			completedKey,
			newWorkerId,
			now,
			expiresAt,
			outputPath || '',
		)
			.orElse((error) => {
				console.error(`Failed to force claim segment ${segmentKey}:`, error);
				return TaskEither.of(false);
			})
			.toPromise();
	}

	/**
	 * Parse a segment key to extract its components
	 */
	public parseSegmentKey (segmentKey: string): { 
		fileId: string; 
		streamType: string; 
		quality: string; 
		streamIndex: number; 
		segmentIndex: number;
	} | null {
		const parts = segmentKey.split(':');
		if (parts.length < 5) {
			return null;
		}
		
		const [fileId, streamType, quality, streamIndex, segmentIndex] = parts;
		return {
			fileId,
			streamType,
			quality,
			streamIndex: parseInt(streamIndex, 10),
			segmentIndex: parseInt(segmentIndex, 10),
		};
	}
}
