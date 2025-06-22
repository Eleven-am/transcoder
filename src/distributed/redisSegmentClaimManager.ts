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
	): Promise<SegmentClaim> {
		const segmentKey = this.getSegmentKey(fileId, streamType, quality, streamIndex, segmentIndex);
		const lockKey = `${this.lockPrefix}${segmentKey}`;
		const expiresAt = Date.now() + this.defaultTTL;

		// Try to acquire lock atomically
		const acquired = await this.redis.set(
			lockKey,
			JSON.stringify({ workerId: this.workerId,
				expiresAt }),
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
		const channel = `transcoder:segment:complete:${segmentKey}`;

		const subscriber = this.redis.duplicate();

		try {
			await subscriber.connect();

			await subscriber.subscribe(channel, (message) => {
				if (message === 'completed') {
					callback();
				}
			});
		} catch (error) {
			// Ensure we disconnect on any failure to prevent leaks
			if (subscriber.isOpen) {
				await subscriber.disconnect();
			}
			throw error;
		}

		// Return unsubscribe function
		return async () => {
			try {
				if (subscriber.isOpen) {
					await subscriber.unsubscribe(channel);
					await subscriber.disconnect();
				}
			} catch (err) {
				console.error('Error during Redis subscriber cleanup:', err);
				// Still try to disconnect even if unsubscribe failed
				if (subscriber.isOpen) {
					await subscriber.disconnect().catch(() => {});
				}
			}
		};
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
}
