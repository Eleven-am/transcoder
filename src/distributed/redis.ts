/**
 * Redis implementations of distributed interfaces.
 * Requires redis client to be provided during construction.
 *
 * Example usage:
 * ```typescript
 * import { createClient } from 'redis';
 * const redis = createClient({ url: 'redis://localhost:6379' });
 * await redis.connect();
 *
 * const stateStore = new RedisStateStore(redis, 'myapp:');
 * ```
 */

import { createClient, RedisClientType } from 'redis';

import { TranscodeJob } from '../types';
import { EventBus, JobQueue, Lock, LockManager, RedisDistributedBackendOptions, StateStore } from './interfaces';

/**
 * Redis implementation of StateStore
 */
export class RedisStateStore implements StateStore {
    constructor (
        private readonly client: RedisClientType,
        private readonly keyPrefix: string = '',
    ) {}

    async get<T> (key: string): Promise<T | null> {
        const value = await this.client.get(this.key(key));

        if (!value) {
            return null;
        }

        try {
            return JSON.parse(value) as T;
        } catch {
            // If not JSON, return as string
            return value as unknown as T;
        }
    }

    async set<T> (key: string, value: T, ttl?: number): Promise<void> {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);

        if (ttl) {
            await this.client.setEx(this.key(key), Math.ceil(ttl / 1000), serialized);
        } else {
            await this.client.set(this.key(key), serialized);
        }
    }

    async delete (key: string): Promise<void> {
        await this.client.del(this.key(key));
    }

    async increment (key: string, by: number = 1): Promise<number> {
        return await this.client.incrBy(this.key(key), by);
    }

    async getMany<T> (keys: string[]): Promise<Map<string, T | null>> {
        const result = new Map<string, T | null>();

        if (keys.length === 0) {
            return result;
        }

        const prefixedKeys = keys.map((k) => this.key(k));
        const values = await this.client.mGet(prefixedKeys);

        keys.forEach((key, index) => {
            const value = values[index];

            if (!value) {
                result.set(key, null);
            } else {
                try {
                    result.set(key, JSON.parse(value) as T);
                } catch {
                    result.set(key, value as unknown as T);
                }
            }
        });

        return result;
    }

    async keys (pattern: string): Promise<string[]> {
        const keys = await this.client.keys(this.key(pattern));
        // Remove prefix from returned keys

        return keys.map((k) => k.slice(this.keyPrefix.length));
    }

    private key (k: string): string {
        return this.keyPrefix + k;
    }
}

/**
 * Redis implementation of JobQueue using sorted sets for priority
 */
export class RedisJobQueue implements JobQueue {
    private readonly queueKey: string;

    private readonly processingKey: string;

    constructor (
        private readonly client: RedisClientType,
        queueName: string = 'transcode:queue',
    ) {
        this.queueKey = queueName;
        this.processingKey = `${queueName}:processing`;
    }

    async push (job: TranscodeJob): Promise<void> {
        // Use negative priority as score so higher priority jobs have lower scores (processed first)
        const score = -job.priority;
        const value = JSON.stringify(job);

        await this.client.zAdd(this.queueKey, { score,
            value });
    }

    async pop (timeout: number = 0): Promise<TranscodeJob | null> {
        const endTime = Date.now() + timeout;

        while (true) {
            // Atomically move highest priority job from queue to processing
            const result = await this.client.eval(`
                local job = redis.call('ZRANGE', KEYS[1], 0, 0)
                if #job > 0 then
                    redis.call('ZREM', KEYS[1], job[1])
                    redis.call('HSET', KEYS[2], job[1], '1')
                    return job[1]
                end
                return nil
            `, {
                keys: [this.queueKey, this.processingKey],
            }) as string | null;

            if (result) {
                return JSON.parse(result) as TranscodeJob;
            }

            // Check timeout
            if (timeout <= 0 || Date.now() >= endTime) {
                return null;
            }

            // Wait a bit before retrying
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    async requeue (job: TranscodeJob): Promise<void> {
        const value = JSON.stringify(job);

        // Remove from processing set
        await this.client.hDel(this.processingKey, value);

        // Add back to queue with slightly reduced priority
        const score = -job.priority + 0.1;

        await this.client.zAdd(this.queueKey, { score,
            value });
    }

    async size (): Promise<number> {
        return await this.client.zCard(this.queueKey);
    }

    /**
	 * Clean up stale processing jobs (e.g., from crashed nodes)
	 * Should be called periodically
	 */
    async cleanupStaleJobs (maxAge: number = 300000): Promise<void> {
        const jobs = await this.client.hGetAll(this.processingKey);
        const now = Date.now();

        for (const [jobStr, _] of Object.entries(jobs)) {
            try {
                const job = JSON.parse(jobStr) as TranscodeJob;

                if (now - job.createdAt > maxAge) {
                    await this.requeue(job);
                }
            } catch {
                // Invalid job, just remove it
                await this.client.hDel(this.processingKey, jobStr);
            }
        }
    }
}

/**
 * Redis lock implementation
 */
class RedisLock implements Lock {
    private released = false;

    private extendTimer?: NodeJS.Timeout;

    constructor (
        private readonly client: RedisClientType,
        private readonly resource: string,
        private readonly lockId: string,
        private ttl: number,
    ) {
        // Auto-extend lock before expiry
        this.scheduleExtension();
    }

    async release (): Promise<void> {
        if (this.released) {
            return;
        }

        this.released = true;
        if (this.extendTimer) {
            clearTimeout(this.extendTimer);
        }

        // Only delete if we still own the lock
        await this.client.eval(`
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
            else
                return 0
            end
        `, {
            keys: [this.resource],
            arguments: [this.lockId],
        });
    }

    async extend (ttl: number): Promise<void> {
        if (this.released) {
            throw new Error('Cannot extend released lock');
        }

        this.ttl = ttl;

        // Only extend if we still own the lock
        const result = await this.client.eval(`
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('PEXPIRE', KEYS[1], ARGV[2])
            else
                return 0
            end
        `, {
            keys: [this.resource],
            arguments: [this.lockId, ttl.toString()],
        });

        if (result === 0) {
            this.released = true;
            throw new Error('Lock no longer owned');
        }

        this.scheduleExtension();
    }

    async isValid (): Promise<boolean> {
        if (this.released) {
            return false;
        }

        const value = await this.client.get(this.resource);


        return value === this.lockId;
    }

    private scheduleExtension (): void {
        if (this.extendTimer) {
            clearTimeout(this.extendTimer);
        }

        // Auto-extend at 80% of TTL
        const extendAfter = this.ttl * 0.8;

        this.extendTimer = setTimeout(async () => {
            if (!this.released) {
                try {
                    await this.extend(this.ttl);
                } catch {
                    // Lock lost, mark as released
                    this.released = true;
                }
            }
        }, extendAfter);
    }
}

/**
 * Redis implementation of LockManager
 */
export class RedisLockManager implements LockManager {
    constructor (
        private readonly client: RedisClientType,
        private readonly keyPrefix: string = 'lock:',
    ) {}

    async acquire (resource: string, ttl: number): Promise<Lock> {
        const lockKey = this.key(resource);
        const lockId = this.generateLockId();

        // Retry until acquired
        while (true) {
            const acquired = await this.client.set(
                lockKey,
                lockId,
                { PX: ttl,
                    NX: true },
            );

            if (acquired) {
                return new RedisLock(this.client, lockKey, lockId, ttl);
            }

            // Wait before retrying
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }

    async tryAcquire (resource: string, ttl: number): Promise<Lock | null> {
        const lockKey = this.key(resource);
        const lockId = this.generateLockId();

        const acquired = await this.client.set(
            lockKey,
            lockId,
            { PX: ttl,
                NX: true },
        );

        if (acquired) {
            return new RedisLock(this.client, lockKey, lockId, ttl);
        }

        return null;
    }

    private key (resource: string): string {
        return this.keyPrefix + resource;
    }

    private generateLockId (): string {
        return `${process.pid}:${Date.now()}:${Math.random().toString(36)
            .slice(2)}`;
    }
}

/**
 * Redis implementation of EventBus using pub/sub
 */
export class RedisEventBus implements EventBus {
    private readonly subscriber: RedisClientType;

    private readonly subscriptions = new Map<string, (event: any) => void>();

    constructor (
        private readonly publisher: RedisClientType,
        subscriberClient: RedisClientType,
        private readonly channelPrefix: string = 'event:',
    ) {
        this.subscriber = subscriberClient;
    }

    async publish (channel: string, event: any): Promise<void> {
        const message = JSON.stringify({
            event,
            timestamp: Date.now(),
            node: process.pid,
        });

        await this.publisher.publish(this.channel(channel), message);
    }

    async subscribe (channel: string, handler: (event: any) => void): Promise<void> {
        const prefixedChannel = this.channel(channel);

        // Wrap handler to parse message
        const messageHandler = (message: string) => {
            try {
                const { event } = JSON.parse(message);

                handler(event);
            } catch (err) {
                console.error('Failed to parse event:', err);
            }
        };

        // Store for cleanup
        this.subscriptions.set(channel, handler);

        // Subscribe to Redis channel
        await this.subscriber.subscribe(prefixedChannel, messageHandler);
    }

    async unsubscribe (channel: string): Promise<void> {
        const prefixedChannel = this.channel(channel);

        await this.subscriber.unsubscribe(prefixedChannel);
        this.subscriptions.delete(channel);
    }

    async unsubscribeAll (): Promise<void> {
        const channels = Array.from(this.subscriptions.keys());

        for (const channel of channels) {
            await this.unsubscribe(channel);
        }
    }

    private channel (name: string): string {
        return this.channelPrefix + name;
    }
}

/**
 * Factory to create a complete Redis backend
 * Note: Requires two Redis clients for EventBus (publisher and subscriber)
 */
export function createRedisBackend (options: RedisDistributedBackendOptions) {
    let client: RedisClientType;

    if ('url' in options.config) {
        client = createClient({ url: options.config.url });
    } else {
        client = createClient({
            socket: {
                host: options.config.host,
                port: options.config.port,
            },
            password: options.config.password,
            database: options.config.database,
        });
    }

    const subscriberClient = client.duplicate();

    void Promise.all([client.connect(), subscriberClient.connect()]);

    return {
        stateStore: new RedisStateStore(client, options.options?.keyPrefix),
        jobQueue: new RedisJobQueue(client, options.options?.queueName),
        lockManager: new RedisLockManager(client, options.options?.lockPrefix),
        eventBus: new RedisEventBus(client, subscriberClient, options.options?.channelPrefix),
    };
}

