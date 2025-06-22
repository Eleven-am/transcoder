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

import { createClient, RedisClientType } from 'redis';

import { DistributedSegmentProcessor } from './distributedSegmentProcessor';
import { DistributedConfig, ISegmentProcessor } from './interfaces';
import { LocalSegmentProcessor } from './localSegmentProcessor';

/**
 * Factory for creating segment processors
 * Automatically detects environment and creates appropriate processor
 */
export class SegmentProcessorFactory {
	private static instance: ISegmentProcessor | null = null;

	private static initializationPromise: Promise<ISegmentProcessor> | null = null;

	private static redisClient: RedisClientType | null = null;

	/**
     * Create or return existing segment processor
     * @param config Optional configuration for distributed mode
     */
	static async create (config?: DistributedConfig): Promise<ISegmentProcessor> {
		// Return existing healthy instance if available
		if (this.instance) {
			const isHealthy = await this.instance.isHealthy();

			if (isHealthy) {
				return this.instance;
			}
			// If not healthy, fall through to re-initialize
			return this.initialize(config);
		}

		// Initialize if no instance exists
		return this.initialize(config);
	}

	private static async initialize (config?: DistributedConfig): Promise<ISegmentProcessor> {
		// If initialization is already in progress, return the pending promise
		if (this.initializationPromise) {
			return this.initializationPromise;
		}

		// Start initialization and store the promise
		this.initializationPromise = (async () => {
			try {
				// Clean up previous unhealthy instance if it exists
				if (this.instance) {
					await this.instance.dispose();
					this.instance = null;
				}

				// Determine mode based on environment
				const redisUrl = config?.redisUrl || process.env.REDIS_URL;

				if (redisUrl) {
					try {
						console.log('Redis URL detected, attempting to initialize distributed mode...');

						// Create Redis client if needed or if previous one is not open
						if (!this.redisClient || !this.redisClient.isOpen) {
							this.redisClient = createClient({ url: redisUrl });
							await this.redisClient.connect();
						}

						// Test Redis connection
						await this.redisClient.ping();

						console.log('Redis connection successful, using distributed mode');
						this.instance = new DistributedSegmentProcessor(this.redisClient, config);
					} catch (error) {
						console.error('Failed to connect to Redis:', error);

						// Clean up failed connection
						if (this.redisClient) {
							await this.redisClient.disconnect().catch((err) => {
								console.warn('Error during Redis client disconnect:', err);
							});
							this.redisClient = null;
						}

						// Fall back to local mode
						console.log('Falling back to local mode');
						this.instance = new LocalSegmentProcessor(config?.workerId);
					}
				} else {
					console.log('No Redis URL configured, using local mode');
					this.instance = new LocalSegmentProcessor(config?.workerId);
				}

				return this.instance;
			} finally {
				// Clear the initialization promise after completion
				this.initializationPromise = null;
			}
		})();

		return this.initializationPromise;
	}

	/**
     * Force recreation of the processor
     * Useful for testing or configuration changes
     */
	static async reset (): Promise<void> {
		// Wait for any pending initialization to complete
		if (this.initializationPromise) {
			await this.initializationPromise.catch((err) => {
				console.warn('Error during pending initialization in reset:', err);
			});
			this.initializationPromise = null;
		}

		if (this.instance) {
			await this.instance.dispose();
			this.instance = null;
		}

		if (this.redisClient) {
			await this.redisClient.disconnect().catch((err) => {
				console.warn('Error during Redis client disconnect in reset:', err);
			});
			this.redisClient = null;
		}
	}

	/**
     * Get current processor mode
     */
	static async getMode (): Promise<'local' | 'distributed' | 'not-initialized'> {
		if (!this.instance) {
			return 'not-initialized';
		}

		const healthy = await this.instance.isHealthy();

		if (!healthy) {
			return 'not-initialized';
		}

		return this.instance.getMode();
	}
}
