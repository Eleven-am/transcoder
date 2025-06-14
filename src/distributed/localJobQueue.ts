import { DistributedTranscodeJob, TranscodeJobQueue } from './interfaces';

/**
 * Local implementation of TranscodeJobQueue using in-memory arrays
 * Maintains the same priority-based queueing as the original implementation
 */
export class LocalJobQueue implements TranscodeJobQueue {
    private readonly pendingJobs: DistributedTranscodeJob[];

    private readonly processingJobs: Map<string, DistributedTranscodeJob>;

    private readonly completedJobs: Set<string>;

    private readonly failedJobs: Map<string, string>; // jobId -> error

    private readonly nodeId: string;

    constructor (nodeId: string = `local-${process.pid}-${Date.now()}`) {
        this.pendingJobs = [];
        this.processingJobs = new Map();
        this.completedJobs = new Set();
        this.failedJobs = new Map();
        this.nodeId = nodeId;
    }

    async push (job: DistributedTranscodeJob): Promise<void> {
        // Add job to pending queue
        this.pendingJobs.push(job);

        // Sort by priority (highest first)
        this.pendingJobs.sort((a, b) => b.priority - a.priority);
    }

    async pop (nodeId: string): Promise<DistributedTranscodeJob | null> {
        // Get the highest priority job
        const job = this.pendingJobs.shift();

        if (!job) {
            return null;
        }

        // Move to processing
        this.processingJobs.set(job.id, job);

        return job;
    }

    async complete (jobId: string): Promise<void> {
        // Remove from processing and add to completed
        this.processingJobs.delete(jobId);
        this.completedJobs.add(jobId);
    }

    async fail (jobId: string, error: string, requeue: boolean = false): Promise<void> {
        const job = this.processingJobs.get(jobId);

        // Remove from processing
        this.processingJobs.delete(jobId);

        if (requeue && job) {
            // Requeue the job (could implement retry limit here)
            await this.push(job);
        } else {
            // Mark as failed
            this.failedJobs.set(jobId, error);
        }
    }

    async size (): Promise<number> {
        return this.pendingJobs.length;
    }

    async getProcessing (): Promise<string[]> {
        return Array.from(this.processingJobs.keys());
    }

    /**
	 * Get all pending jobs (useful for debugging/monitoring)
	 */
    getPendingJobs (): DistributedTranscodeJob[] {
        return [...this.pendingJobs];
    }

    /**
	 * Get all processing jobs (useful for debugging/monitoring)
	 */
    getProcessingJobs (): DistributedTranscodeJob[] {
        return Array.from(this.processingJobs.values());
    }

    /**
	 * Get completed job IDs
	 */
    getCompletedJobs (): string[] {
        return Array.from(this.completedJobs);
    }

    /**
	 * Get failed jobs with their errors
	 */
    getFailedJobs (): Map<string, string> {
        return new Map(this.failedJobs);
    }

    /**
	 * Check if a job exists in any state
	 */
    hasJob (jobId: string): boolean {
        return this.pendingJobs.some((job) => job.id === jobId) ||
			this.processingJobs.has(jobId) ||
			this.completedJobs.has(jobId) ||
			this.failedJobs.has(jobId);
    }

    /**
	 * Get job status
	 */
    getJobStatus (jobId: string): 'pending' | 'processing' | 'completed' | 'failed' | 'not_found' {
        if (this.pendingJobs.some((job) => job.id === jobId)) {
            return 'pending';
        }
        if (this.processingJobs.has(jobId)) {
            return 'processing';
        }
        if (this.completedJobs.has(jobId)) {
            return 'completed';
        }
        if (this.failedJobs.has(jobId)) {
            return 'failed';
        }

        return 'not_found';
    }

    /**
	 * Get statistics about the queue
	 */
    getStats () {
        return {
            pending: this.pendingJobs.length,
            processing: this.processingJobs.size,
            completed: this.completedJobs.size,
            failed: this.failedJobs.size,
            nodeId: this.nodeId,
        };
    }

    /**
	 * Clear all jobs (useful for testing)
	 */
    clear (): void {
        this.pendingJobs.length = 0;
        this.processingJobs.clear();
        this.completedJobs.clear();
        this.failedJobs.clear();
    }

    /**
	 * Remove old completed/failed jobs to prevent memory leaks
	 */
    cleanup (maxAge: number = 3600000): void {
        // Default 1 hour
        const cutoff = Date.now() - maxAge;

        // Note: We don't have timestamps for completed/failed jobs in this simple implementation
        // In a production system, you'd want to track timestamps and clean up old entries

        // For now, just limit the size of completed/failed sets
        const maxEntries = 1000;

        if (this.completedJobs.size > maxEntries) {
            const toDelete = Array.from(this.completedJobs).slice(0, this.completedJobs.size - maxEntries);

            toDelete.forEach((jobId) => this.completedJobs.delete(jobId));
        }

        if (this.failedJobs.size > maxEntries) {
            const toDelete = Array.from(this.failedJobs.keys()).slice(0, this.failedJobs.size - maxEntries);

            toDelete.forEach((jobId) => this.failedJobs.delete(jobId));
        }
    }
}
