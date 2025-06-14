/**
 * In-memory implementations of distributed interfaces.
 * These provide single-node operation without external dependencies.
 */

import { EventEmitter } from 'events';

import { TranscodeJob } from '../types';
import { EventBus, Lock, LockManager, JobQueue, StateStore } from './interfaces';

/**
 * In-memory implementation of StateStore
 */
export class InMemoryStateStore implements StateStore {
    private readonly store = new Map<string, { value: any, expires?: number }>();

    private cleanupInterval: NodeJS.Timeout;

    constructor () {
        // Clean up expired entries every minute
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    }

    async get<T> (key: string): Promise<T | null> {
        const entry = this.store.get(key);

        if (!entry) {
            return null;
        }

        if (entry.expires && entry.expires < Date.now()) {
            this.store.delete(key);

            return null;
        }

        return entry.value as T;
    }

    async set<T> (key: string, value: T, ttl?: number): Promise<void> {
        const entry: { value: any, expires?: number } = { value };

        if (ttl) {
            entry.expires = Date.now() + ttl;
        }

        this.store.set(key, entry);
    }

    async delete (key: string): Promise<void> {
        this.store.delete(key);
    }

    async increment (key: string, by: number = 1): Promise<number> {
        const current = await this.get<number>(key) || 0;
        const newValue = current + by;

        await this.set(key, newValue);

        return newValue;
    }

    async getMany<T> (keys: string[]): Promise<Map<string, T | null>> {
        const result = new Map<string, T | null>();

        for (const key of keys) {
            result.set(key, await this.get<T>(key));
        }

        return result;
    }

    async keys (pattern: string): Promise<string[]> {
        const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
        const matches: string[] = [];

        for (const [key, entry] of this.store.entries()) {
            if (entry.expires && entry.expires < Date.now()) {
                this.store.delete(key);
                continue;
            }

            if (regex.test(key)) {
                matches.push(key);
            }
        }

        return matches;
    }

    private cleanup (): void {
        const now = Date.now();

        for (const [key, entry] of this.store.entries()) {
            if (entry.expires && entry.expires < now) {
                this.store.delete(key);
            }
        }
    }

    dispose (): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.store.clear();
    }
}

/**
 * In-memory implementation of JobQueue
 */
export class InMemoryJobQueue implements JobQueue {
    private readonly queue: TranscodeJob[] = [];

    private readonly waiters: Array<(job: TranscodeJob | null) => void> = [];

    async push (job: TranscodeJob): Promise<void> {
        // Insert job in priority order (higher priority first)
        const index = this.queue.findIndex((j) => j.priority < job.priority);

        if (index === -1) {
            this.queue.push(job);
        } else {
            this.queue.splice(index, 0, job);
        }

        // Notify any waiting consumers
        const waiter = this.waiters.shift();

        if (waiter) {
            const nextJob = this.queue.shift();

            waiter(nextJob || null);
        }
    }

    async pop (timeout: number = 0): Promise<TranscodeJob | null> {
        // If job available, return immediately
        const job = this.queue.shift();

        if (job) {
            return job;
        }

        // If no timeout, return null
        if (timeout <= 0) {
            return null;
        }

        // Wait for a job with timeout
        return new Promise<TranscodeJob | null>((resolve) => {
            const timer = setTimeout(() => {
                const index = this.waiters.indexOf(resolve);

                if (index > -1) {
                    this.waiters.splice(index, 1);
                }
                resolve(null);
            }, timeout);

            const wrappedResolve = (job: TranscodeJob | null) => {
                clearTimeout(timer);
                resolve(job);
            };

            this.waiters.push(wrappedResolve);
        });
    }

    async requeue (job: TranscodeJob): Promise<void> {
        // Requeue at front for immediate retry
        this.queue.unshift(job);

        // Notify any waiting consumers
        const waiter = this.waiters.shift();

        if (waiter) {
            const nextJob = this.queue.shift();

            waiter(nextJob || null);
        }
    }

    async size (): Promise<number> {
        return this.queue.length;
    }

    dispose (): void {
        // Notify all waiters that queue is closing
        for (const waiter of this.waiters) {
            waiter(null);
        }
        this.waiters.length = 0;
        this.queue.length = 0;
    }
}

/**
 * In-memory lock implementation
 */
class InMemoryLock implements Lock {
    private released = false;

    private timer: NodeJS.Timeout;

    constructor (
        private readonly lockManager: InMemoryLockManager,
        private readonly resource: string,
        ttl: number,
    ) {
        this.timer = setTimeout(() => this.release(), ttl);
    }

    async release (): Promise<void> {
        if (this.released) {
            return;
        }

        this.released = true;
        clearTimeout(this.timer);
        this.lockManager.releaseLock(this.resource);
    }

    async extend (ttl: number): Promise<void> {
        if (this.released) {
            throw new Error('Cannot extend released lock');
        }

        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.release(), ttl);
    }

    async isValid (): Promise<boolean> {
        return !this.released;
    }
}

/**
 * In-memory implementation of LockManager
 */
export class InMemoryLockManager implements LockManager {
    private readonly locks = new Map<string, InMemoryLock>();

    async acquire (resource: string, ttl: number): Promise<Lock> {
        // Spin until lock acquired
        while (this.locks.has(resource)) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const lock = new InMemoryLock(this, resource, ttl);

        this.locks.set(resource, lock);

        return lock;
    }

    async tryAcquire (resource: string, ttl: number): Promise<Lock | null> {
        if (this.locks.has(resource)) {
            return null;
        }

        const lock = new InMemoryLock(this, resource, ttl);

        this.locks.set(resource, lock);

        return lock;
    }

    releaseLock (resource: string): void {
        this.locks.delete(resource);
    }

    dispose (): void {
        // Release all locks
        for (const [resource, lock] of this.locks.entries()) {
            lock.release();
        }
        this.locks.clear();
    }
}

/**
 * In-memory implementation of EventBus
 */
export class InMemoryEventBus implements EventBus {
    private readonly emitter = new EventEmitter();

    private readonly subscriptions = new Map<string, (event: any) => void>();

    async publish (channel: string, event: any): Promise<void> {
        this.emitter.emit(channel, event);
    }

    async subscribe (channel: string, handler: (event: any) => void): Promise<void> {
        // Store subscription for cleanup
        this.subscriptions.set(channel, handler);
        this.emitter.on(channel, handler);
    }

    async unsubscribe (channel: string): Promise<void> {
        const handler = this.subscriptions.get(channel);

        if (handler) {
            this.emitter.off(channel, handler);
            this.subscriptions.delete(channel);
        }
    }

    async unsubscribeAll (): Promise<void> {
        for (const [channel, handler] of this.subscriptions.entries()) {
            this.emitter.off(channel, handler);
        }
        this.subscriptions.clear();
    }

    dispose (): void {
        this.emitter.removeAllListeners();
        this.subscriptions.clear();
    }
}

/**
 * Factory to create a complete in-memory backend
 */
export function createInMemoryBackend () {
    return {
        stateStore: new InMemoryStateStore(),
        jobQueue: new InMemoryJobQueue(),
        lockManager: new InMemoryLockManager(),
        eventBus: new InMemoryEventBus(),
    };
}
