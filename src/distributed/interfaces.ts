/**
 * Core interfaces for distributed operation of the HLS transcoding system.
 * These interfaces allow the system to work in both single-node (in-memory)
 * and multi-node (distributed) configurations.
 */

import { TranscodeJob } from '../types';

/**
 * StateStore provides distributed key-value storage for shared state
 * across multiple nodes. Used for client sessions, stream metadata, etc.
 */
export interface StateStore {

    /**
	 * Retrieve a value by key
	 * @param key The key to retrieve
	 * @returns The value or null if not found
	 */
    get<T>(key: string): Promise<T | null>;

    /**
	 * Store a value with optional TTL
	 * @param key The key to store
	 * @param value The value to store
	 * @param ttl Time to live in milliseconds (optional)
	 */
    set<T>(key: string, value: T, ttl?: number): Promise<void>;

    /**
	 * Delete a key
	 * @param key The key to delete
	 */
    delete(key: string): Promise<void>;

    /**
	 * Atomically increment a numeric value
	 * @param key The key to increment
	 * @param by Amount to increment by (default: 1)
	 * @returns The new value after increment
	 */
    increment(key: string, by?: number): Promise<number>;

    /**
	 * Get multiple keys at once
	 * @param keys Array of keys to retrieve
	 * @returns Map of key to value (null if key doesn't exist)
	 */
    getMany<T>(keys: string[]): Promise<Map<string, T | null>>;

    /**
	 * List keys matching a pattern
	 * @param pattern Pattern to match (e.g., "client:*")
	 * @returns Array of matching keys
	 */
    keys(pattern: string): Promise<string[]>;
}

/**
 * JobQueue provides distributed work queue functionality for
 * coordinating transcode jobs across multiple nodes.
 */
export interface JobQueue {

    /**
	 * Add a job to the queue
	 * @param job The transcode job to queue
	 */
    push(job: TranscodeJob): Promise<void>;

    /**
	 * Retrieve the next job from the queue
	 * @param timeout How long to wait for a job in milliseconds
	 * @returns The next job or null if timeout reached
	 */
    pop(timeout?: number): Promise<TranscodeJob | null>;

    /**
	 * Return a job to the queue (e.g., on failure)
	 * @param job The job to requeue
	 */
    requeue(job: TranscodeJob): Promise<void>;

    /**
	 * Get the current queue size
	 * @returns Number of jobs in queue
	 */
    size(): Promise<number>;
}

/**
 * Lock represents an acquired distributed lock
 */
export interface Lock {

    /**
	 * Release the lock
	 */
    release(): Promise<void>;

    /**
	 * Extend the lock TTL
	 * @param ttl New TTL in milliseconds
	 */
    extend(ttl: number): Promise<void>;

    /**
	 * Check if the lock is still valid
	 * @returns True if lock is still held
	 */
    isValid(): Promise<boolean>;
}

/**
 * LockManager provides distributed locking to ensure
 * only one node processes a resource at a time.
 */
export interface LockManager {

    /**
	 * Acquire an exclusive lock on a resource
	 * @param resource Resource identifier (e.g., "segment:fileId:v:0:720p:5")
	 * @param ttl Lock timeout in milliseconds
	 * @returns The acquired lock
	 * @throws Error if unable to acquire lock
	 */
    acquire(resource: string, ttl: number): Promise<Lock>;

    /**
	 * Try to acquire a lock without blocking
	 * @param resource Resource identifier
	 * @param ttl Lock timeout in milliseconds
	 * @returns The lock if acquired, null otherwise
	 */
    tryAcquire(resource: string, ttl: number): Promise<Lock | null>;
}

/**
 * EventBus provides pub/sub messaging across nodes for
 * coordinating events like client updates, stream lifecycle, etc.
 */
export interface EventBus {

    /**
	 * Publish an event to all subscribe nodes
	 * @param channel Channel name (e.g., "client:activity")
	 * @param event Event data
	 */
    publish(channel: string, event: any): Promise<void>;

    /**
	 * Subscribe to events on a channel
	 * @param channel Channel name
	 * @param handler Function to handle received events
	 */
    subscribe(channel: string, handler: (event: any) => void): Promise<void>;

    /**
	 * Unsubscribe from a channel
	 * @param channel Channel name
	 */
    unsubscribe(channel: string): Promise<void>;

    /**
	 * Unsubscribe from all channels
	 */
    unsubscribeAll(): Promise<void>;
}

/**
 * Configuration for distributed backends
 */
export interface DistributedConfig {
    stateStore?: StateStore;
    jobQueue?: JobQueue;
    lockManager?: LockManager;
    eventBus?: EventBus;
}
