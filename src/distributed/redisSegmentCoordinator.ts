import Redis from 'ioredis';

import { SegmentCoordinator, SegmentStatus, SegmentInfo } from './interfaces';

/**
 * Redis implementation of SegmentCoordinator for distributed segment coordination
 * Uses Redis pub/sub for real-time notifications and Redis keys for state storage
 */
export class RedisSegmentCoordinator implements SegmentCoordinator {
    private readonly redis: Redis;

    private readonly subscriber: Redis;

    private readonly nodeId: string;

    private readonly listeners: Map<string, ((segmentId: string) => void)[]>;

    private readonly keyPrefix: string;

    constructor (
        redis: Redis,
        nodeId: string = `node-${process.pid}-${Date.now()}`,
        keyPrefix: string = 'hls:segment',
    ) {
        this.redis = redis;
        this.subscriber = redis.duplicate();
        this.nodeId = nodeId;
        this.listeners = new Map();
        this.keyPrefix = keyPrefix;

        // Set up pub/sub for segment completion notifications
        this.setupSubscriber();
    }

    async waitForSegment (segmentId: string, timeout: number): Promise<void> {
        // First check if segment is already complete
        const status = await this.getSegmentStatus(segmentId);

        if (status === SegmentStatus.COMPLETED) {
            return;
        }

        if (status === SegmentStatus.FAILED) {
            const info = await this.getSegmentInfo(segmentId);

            throw new Error(info?.error || 'Segment processing failed');
        }

        // Wait for completion notification via pub/sub
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.removeListener(segmentId, onComplete);
                reject(new Error(`Timeout waiting for segment ${segmentId}`));
            }, timeout);

            const onComplete = (completedSegmentId: string) => {
                if (completedSegmentId === segmentId) {
                    clearTimeout(timeoutId);
                    this.removeListener(segmentId, onComplete);
                    resolve();
                }
            };

            this.addListener(segmentId, onComplete);
        });
    }

    async markSegmentProcessing (segmentId: string, nodeId: string): Promise<void> {
        const key = this.getSegmentKey(segmentId);
        const info: SegmentInfo = {
            status: SegmentStatus.PROCESSING,
            nodeId,
            startedAt: Date.now(),
        };

        await this.redis.hset(key, info);
        await this.redis.expire(key, 3600); // 1 hour TTL
    }

    async markSegmentComplete (segmentId: string): Promise<void> {
        const key = this.getSegmentKey(segmentId);
        const existing = await this.getSegmentInfo(segmentId);

        const info: SegmentInfo = {
            ...existing,
            status: SegmentStatus.COMPLETED,
            completedAt: Date.now(),
        };

        await this.redis.hset(key, info);
        await this.redis.expire(key, 3600); // 1 hour TTL

        // Notify all waiting nodes
        await this.redis.publish(this.getNotificationChannel('complete'), segmentId);
    }

    async markSegmentFailed (segmentId: string, error: string): Promise<void> {
        const key = this.getSegmentKey(segmentId);
        const existing = await this.getSegmentInfo(segmentId);

        const info: SegmentInfo = {
            ...existing,
            status: SegmentStatus.FAILED,
            completedAt: Date.now(),
            error,
        };

        await this.redis.hset(key, info);
        await this.redis.expire(key, 3600); // 1 hour TTL

        // Notify all waiting nodes
        await this.redis.publish(this.getNotificationChannel('failed'), segmentId);
    }

    async isSegmentProcessing (segmentId: string): Promise<boolean> {
        const status = await this.getSegmentStatus(segmentId);


        return status === SegmentStatus.PROCESSING;
    }

    async isSegmentComplete (segmentId: string): Promise<boolean> {
        const status = await this.getSegmentStatus(segmentId);


        return status === SegmentStatus.COMPLETED;
    }

    async getSegmentStatus (segmentId: string): Promise<SegmentStatus> {
        const key = this.getSegmentKey(segmentId);
        const status = await this.redis.hget(key, 'status');

        if (!status) {
            return SegmentStatus.PENDING;
        }

        return status as SegmentStatus;
    }

    async cleanup (streamId: string): Promise<void> {
        // Find all segment keys for this stream
        const pattern = this.getSegmentKey(`${streamId}:*`);
        const keys = await this.redis.keys(pattern);

        if (keys.length > 0) {
            await this.redis.del(...keys);
        }

        // Clean up any listeners for this stream
        const listenersToRemove: string[] = [];

        for (const segmentId of this.listeners.keys()) {
            if (segmentId.startsWith(streamId)) {
                listenersToRemove.push(segmentId);
            }
        }

        listenersToRemove.forEach((segmentId) => {
            this.listeners.delete(segmentId);
        });
    }

    /**
	 * Get detailed information about a segment
	 */
    private async getSegmentInfo (segmentId: string): Promise<SegmentInfo | null> {
        const key = this.getSegmentKey(segmentId);
        const data = await this.redis.hgetall(key);

        if (!data || Object.keys(data).length === 0) {
            return null;
        }

        return {
            status: (data.status as SegmentStatus) || SegmentStatus.PENDING,
            nodeId: data.nodeId,
            startedAt: data.startedAt ? parseInt(data.startedAt, 10) : undefined,
            completedAt: data.completedAt ? parseInt(data.completedAt, 10) : undefined,
            error: data.error,
        };
    }

    /**
	 * Set up Redis subscriber for segment notifications
	 */
    private setupSubscriber (): void {
        this.subscriber.subscribe(
            this.getNotificationChannel('complete'),
            this.getNotificationChannel('failed'),
        );

        this.subscriber.on('message', (channel: string, segmentId: string) => {
            const listeners = this.listeners.get(segmentId);

            if (listeners) {
                listeners.forEach((listener) => {
                    try {
                        listener(segmentId);
                    } catch (error) {
                        console.error('Error in segment completion listener:', error);
                    }
                });
            }
        });
    }

    /**
	 * Add a listener for segment completion
	 */
    private addListener (segmentId: string, listener: (segmentId: string) => void): void {
        if (!this.listeners.has(segmentId)) {
            this.listeners.set(segmentId, []);
        }
        this.listeners.get(segmentId)!.push(listener);
    }

    /**
	 * Remove a listener for segment completion
	 */
    private removeListener (segmentId: string, listener: (segmentId: string) => void): void {
        const listeners = this.listeners.get(segmentId);

        if (listeners) {
            const index = listeners.indexOf(listener);

            if (index > -1) {
                listeners.splice(index, 1);
            }
            if (listeners.length === 0) {
                this.listeners.delete(segmentId);
            }
        }
    }

    /**
	 * Generate Redis key for segment data
	 */
    private getSegmentKey (segmentId: string): string {
        return `${this.keyPrefix}:${segmentId}`;
    }

    /**
	 * Generate Redis channel for notifications
	 */
    private getNotificationChannel (type: 'complete' | 'failed'): string {
        return `${this.keyPrefix}:${type}`;
    }

    /**
	 * Get statistics about segments (useful for monitoring)
	 */
    async getStats (): Promise<{
        processing: number;
        completed: number;
        failed: number;
        nodeId: string;
    }> {
        const pattern = this.getSegmentKey('*');
        const keys = await this.redis.keys(pattern);

        let processing = 0;
        let completed = 0;
        let failed = 0;

        // This could be optimized with a pipeline for better performance
        for (const key of keys) {
            const status = await this.redis.hget(key, 'status');

            switch (status) {
                case SegmentStatus.PROCESSING:
                    processing++;
                    break;
                case SegmentStatus.COMPLETED:
                    completed++;
                    break;
                case SegmentStatus.FAILED:
                    failed++;
                    break;
            }
        }

        return {
            processing,
            completed,
            failed,
            nodeId: this.nodeId,
        };
    }

    /**
	 * Clean up Redis connections
	 */
    async dispose (): Promise<void> {
        await this.subscriber.disconnect();
        // Note: Don't disconnect the main redis connection as it might be shared
    }
}
