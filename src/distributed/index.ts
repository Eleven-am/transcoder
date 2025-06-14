import Redis from 'ioredis';

import { LocalJobQueue } from './localJobQueue';
import { LocalSegmentCoordinator } from './localSegmentCoordinator';
import { RedisJobQueue } from './redisJobQueue';
import { RedisSegmentCoordinator } from './redisSegmentCoordinator';

// Export all interfaces
export * from './interfaces';


/**
 * Redis connection configuration options
 */
export interface RedisConfig {

    /**
	 * Redis server host (default: 'localhost')
	 */
    host?: string;

    /**
	 * Redis server port (default: 6379)
	 */
    port?: number;

    /**
	 * Redis connection URL (overrides host/port if provided)
	 */
    url?: string;

    /**
	 * Redis database number (default: 0)
	 */
    db?: number;

    /**
	 * Redis password for authentication
	 */
    password?: string;

    /**
	 * Optional node identifier (defaults to auto-generated)
	 */
    nodeId?: string;

    /**
	 * Optional prefix for Redis keys (defaults to 'hls')
	 */
    keyPrefix?: string;

    /**
	 * Additional Redis connection options
	 */
    redisOptions?: {
        retryDelayOnFailover?: number;
        enableReadyCheck?: boolean;
        maxRetriesPerRequest?: number | null;
        connectTimeout?: number;
        lazyConnect?: boolean;
        keepAlive?: number;
        family?: number;
    };
}

/**
 * Factory function to create a Redis backend with flexible configuration
 * This provides a simple way for users to set up distributed processing
 *
 * @param config Redis configuration options
 * @returns Object containing Redis instances and distributed components
 */
export function createRedisBackend (config: RedisConfig = {}) {
    const {
        host = 'localhost',
        port = 6379,
        url,
        db = 0,
        password,
        nodeId,
        keyPrefix = 'hls',
        redisOptions = {},
    } = config;

    // Default Redis options
    const defaultRedisOptions = {
        retryDelayOnFailover: 100,
        enableReadyCheck: false,
        maxRetriesPerRequest: null,
        ...redisOptions,
    };

    // Create Redis connection
    let redis: Redis;

    if (url) {
        // Use URL if provided
        redis = new Redis(url, {
            db,
            password,
            ...defaultRedisOptions,
        });
    } else {
        // Use host/port configuration
        redis = new Redis({
            host,
            port,
            db,
            password,
            ...defaultRedisOptions,
        });
    }

    // Generate node ID if not provided
    const actualNodeId = nodeId || `node-${process.pid}-${Date.now()}`;

    // Create distributed components
    const segmentCoordinator = new RedisSegmentCoordinator(redis, actualNodeId, `${keyPrefix}:segment`);
    const jobQueue = new RedisJobQueue(redis, actualNodeId, `${keyPrefix}:transcode`);

    return {
        redis,
        nodeId: actualNodeId,
        segmentCoordinator,
        jobQueue,

        /**
		 * Clean up Redis connections and resources
		 */
        async dispose () {
            await segmentCoordinator.dispose();
            await jobQueue.dispose();
            await redis.quit();
        },
    };
}

/**
 * Factory function to create local backend for single-node processing
 * This provides the same interface as Redis backend but runs locally
 *
 * @param nodeId Optional node identifier (defaults to auto-generated)
 * @returns Object containing local implementations
 */
export function createLocalBackend (nodeId?: string) {
    // Generate node ID if not provided
    const actualNodeId = nodeId || `local-${process.pid}-${Date.now()}`;

    // Create local components
    const segmentCoordinator = new LocalSegmentCoordinator(actualNodeId);
    const jobQueue = new LocalJobQueue(actualNodeId);

    return {
        nodeId: actualNodeId,
        segmentCoordinator,
        jobQueue,

        /**
		 * Clean up local resources
		 */
        async dispose () {
            // Local implementations don't need special cleanup
            // but provide same interface for consistency
        },
    };
}

/**
 * Type representing either a Redis or local backend
 */
export type Backend = ReturnType<typeof createRedisBackend> | ReturnType<typeof createLocalBackend>;

/**
 * Configuration options for distributed HLS processing
 */
export interface DistributedConfig {

    /**
	 * Backend to use for coordination and job queuing
	 */
    backend: Backend;

    /**
	 * Optional custom node ID
	 */
    nodeId?: string;
}

/**
 * Utility function to check if a backend is Redis-based
 */
export function isRedisBackend (backend: Backend): backend is ReturnType<typeof createRedisBackend> {
    return 'redis' in backend;
}

/**
 * Utility function to check if a backend is local
 */
export function isLocalBackend (backend: Backend): backend is ReturnType<typeof createLocalBackend> {
    return !('redis' in backend);
}
