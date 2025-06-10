/**
 * Main entry point for distributed functionality.
 * Exports interfaces and implementations for distributed operation.
 */

import { createInMemoryBackend } from './inMemory';
import { DistributedConfig, EventBus, JobQueue, StateStore } from './interfaces';

// Export all interfaces
export {
    StateStore,
    JobQueue,
    Lock,
    LockManager,
    EventBus,
    DistributedConfig,
    RedisDistributedBackendOptions,
} from './interfaces';

// Export in-memory implementations
export {
    InMemoryStateStore,
    InMemoryJobQueue,
    InMemoryLockManager,
    InMemoryEventBus,
    createInMemoryBackend,
} from './inMemory';

// Type guards to check if distributed components are provided
export function hasDistributedConfig (config: any): config is { distributed: DistributedConfig } {
    return config && typeof config.distributed === 'object';
}

export function hasStateStore (config: DistributedConfig): config is DistributedConfig & { stateStore: StateStore } {
    return config.stateStore !== undefined;
}

export function hasJobQueue (config: DistributedConfig): config is DistributedConfig & { jobQueue: JobQueue } {
    return config.jobQueue !== undefined;
}

export function hasLockManager (config: DistributedConfig): config is DistributedConfig & { lockManager: LockManager } {
    return config.lockManager !== undefined;
}

export function hasEventBus (config: DistributedConfig): config is DistributedConfig & { eventBus: EventBus } {
    return config.eventBus !== undefined;
}

/**
 * Create a backend configuration with defaults for any missing components
 */
export function createBackendConfig (distributed?: DistributedConfig): Required<DistributedConfig> {
    const inMemory = createInMemoryBackend();

    return {
        stateStore: distributed?.stateStore || inMemory.stateStore,
        jobQueue: distributed?.jobQueue || inMemory.jobQueue,
        lockManager: distributed?.lockManager || inMemory.lockManager,
        eventBus: distributed?.eventBus || inMemory.eventBus,
    };
}
