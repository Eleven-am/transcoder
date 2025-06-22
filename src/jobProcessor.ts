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

import * as os from 'os';

import { createBadRequestError, TaskEither } from '@eleven-am/fp';

import { TranscodeJob, TranscodeStatus } from './types';
import { ExtendedEventEmitter } from './utils';

interface JobProcessorEvents {
    'job:started': TranscodeJob;
    'job:completed': TranscodeJob;
    'job:failed': { job: TranscodeJob, error: Error };
    'queue:full': { size: number, maxSize: number };
    'concurrency:changed': { current: number, max: number };
}

interface JobQueueItem {
    job: TranscodeJob;
    resolve: () => void;
    reject: (error: Error) => void;
}

/**
 * JobProcessor - Manages transcoding job execution with concurrency control
 *
 * This class provides a queue-based system for managing FFmpeg transcoding jobs,
 * ensuring system resources aren't overwhelmed by limiting concurrent executions.
 */
export class JobProcessor extends ExtendedEventEmitter<JobProcessorEvents> {
    private readonly queue: JobQueueItem[] = [];

    private activeJobs: number = 0;

    private disposed: boolean = false;

    constructor (
        private maxConcurrentJobs: number = Math.max(1, os.cpus().length - 1),
        private readonly maxQueueSize: number = 1000,
    ) {
        super();
    }

    /**
     * Submit a job for processing
     * @param job The transcode job to process
     * @returns A promise that resolves when the job completes
     */
    public submitJob (job: TranscodeJob): TaskEither<void> {
        if (this.disposed) {
            return TaskEither.error(createBadRequestError('JobProcessor has been disposed'));
        }

        if (this.queue.length >= this.maxQueueSize) {
            this.emit('queue:full', { size: this.queue.length,
                maxSize: this.maxQueueSize });

            return TaskEither.error(createBadRequestError('Job queue is full'));
        }

        return TaskEither.tryCatch(
            () => new Promise<void>((resolve, reject) => {
                this.queue.push({ job,
                    resolve,
                    reject });
                this.processNextJob();
            }),
            'Failed to submit job',
        );
    }

    /**
     * Get current queue status
     */
    public getStatus (): {
        queueLength: number;
        activeJobs: number;
        maxConcurrentJobs: number;
        isProcessing: boolean;
    } {
        return {
            queueLength: this.queue.length,
            activeJobs: this.activeJobs,
            maxConcurrentJobs: this.maxConcurrentJobs,
            isProcessing: this.activeJobs > 0,
        };
    }

    /**
     * Update the maximum number of concurrent jobs
     * @param newMax New maximum concurrent jobs
     */
    public setMaxConcurrentJobs (newMax: number): void {
        const oldMax = this.maxConcurrentJobs;

        this.maxConcurrentJobs = Math.max(1, newMax);

        if (this.maxConcurrentJobs > oldMax) {
            // Process more jobs if we increased the limit
            for (let i = oldMax; i < this.maxConcurrentJobs && i < this.queue.length; i++) {
                this.processNextJob();
            }
        }

        this.emit('concurrency:changed', { current: this.activeJobs,
            max: this.maxConcurrentJobs });
    }

    /**
     * Clear all pending jobs from the queue
     */
    public clearQueue (): void {
        const clearedJobs = this.queue.splice(0);

        clearedJobs.forEach(({ reject }) => {
            reject(new Error('Queue cleared'));
        });
    }

    /**
     * Dispose of the job processor
     */
    public dispose (): void {
        this.disposed = true;
        this.clearQueue();
    }

    /**
     * Process the next job in the queue if possible
     */
    private processNextJob (): void {
        if (this.disposed || this.activeJobs >= this.maxConcurrentJobs || this.queue.length === 0) {
            return;
        }

        const item = this.queue.shift();

        if (!item) {
            return;
        }

        this.activeJobs++;
        this.executeJob(item);
    }

    /**
     * Execute a single job
     */
    private executeJob (item: JobQueueItem): void {
        const { job, resolve, reject } = item;

        this.emit('job:started', job);
        job.status = TranscodeStatus.PROCESSING;

        const startTime = Date.now();

        // Set up event handlers for the FFmpeg process
        const onEnd = () => {
            cleanup();
            job.status = TranscodeStatus.PROCESSED;
            this.emit('job:completed', job);
            resolve();
            this.jobCompleted();
        };

        const onError = (error: Error) => {
            cleanup();
            job.status = TranscodeStatus.ERROR;
            this.emit('job:failed', { job,
                error });
            reject(error);
            this.jobCompleted();
        };

        const cleanup = () => {
            job.process.removeListener('end', onEnd);
            job.process.removeListener('error', onError);
        };

        // Attach handlers and run the command
        job.process.once('end', onEnd);
        job.process.once('error', onError);

        try {
            job.process.run();
        } catch (error) {
            onError(error as Error);
        }
    }

    /**
     * Handle job completion and process next job
     */
    private jobCompleted (): void {
        this.activeJobs--;
        this.processNextJob();
    }

    /**
     * Get system load for dynamic concurrency adjustment
     * @returns System load percentage (0-100)
     */
    private getSystemLoad (): number {
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;

        cpus.forEach((cpu) => {
            for (const type in cpu.times) {
                totalTick += cpu.times[type as keyof typeof cpu.times];
            }
            totalIdle += cpu.times.idle;
        });

        const idle = totalIdle / cpus.length;
        const total = totalTick / cpus.length;
        const usage = 100 - ~~(100 * idle / total);

        return Math.min(100, Math.max(0, usage));
    }

    /**
     * Dynamically adjust concurrency based on system load
     * Call this periodically if you want automatic adjustment
     */
    public adjustConcurrencyBasedOnLoad (): void {
        const load = this.getSystemLoad();
        const cpuCount = os.cpus().length;

        let targetConcurrency: number;

        if (load > 80) {
            targetConcurrency = Math.max(1, Math.floor(cpuCount * 0.25));
        } else if (load > 60) {
            targetConcurrency = Math.max(1, Math.floor(cpuCount * 0.5));
        } else if (load > 40) {
            targetConcurrency = Math.max(1, Math.floor(cpuCount * 0.75));
        } else {
            targetConcurrency = Math.max(1, cpuCount - 1);
        }

        if (targetConcurrency !== this.maxConcurrentJobs) {
            this.setMaxConcurrentJobs(targetConcurrency);
        }
    }
}
