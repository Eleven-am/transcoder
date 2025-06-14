import { Deferred } from '@eleven-am/fp';

import { SegmentCoordinator, SegmentInfo, SegmentStatus } from './interfaces';

/**
 * Internal segment state with promise for coordination
 */
interface SegmentState {
    status: SegmentStatus;
    promise: Deferred<void>;
    nodeId: string;
    startedAt: number;
    completedAt?: number;
    error?: string;
}

/**
 * Local implementation of SegmentCoordinator using in-memory promises
 * This maintains the same promise-based coordination as the original implementation
 */
export class LocalSegmentCoordinator implements SegmentCoordinator {
    private readonly segments: Map<string, SegmentState>;

    private readonly nodeId: string;

    constructor (nodeId: string = `local-${process.pid}-${Date.now()}`) {
        this.segments = new Map();
        this.nodeId = nodeId;
    }

    async waitForSegment (segmentId: string, timeout: number): Promise<void> {
        const segment = this.getOrCreateSegment(segmentId);

        if (segment.status === SegmentStatus.COMPLETED) {
            return;
        }

        if (segment.status === SegmentStatus.FAILED) {
            throw new Error(segment.error || 'Segment processing failed');
        }

        // Wait for the promise with timeout
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(`Timeout waiting for segment ${segmentId}`));
            }, timeout);

            segment.promise.promise()
                .then(() => {
                    clearTimeout(timeoutId);
                    resolve();
                })
                .catch((error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                });
        });
    }

    async markSegmentProcessing (segmentId: string, nodeId: string): Promise<void> {
        const segment = this.getOrCreateSegment(segmentId);

        segment.status = SegmentStatus.PROCESSING;
        segment.nodeId = nodeId;
        segment.startedAt = Date.now();
    }

    async markSegmentComplete (segmentId: string): Promise<void> {
        const segment = this.getOrCreateSegment(segmentId);

        segment.status = SegmentStatus.COMPLETED;
        segment.completedAt = Date.now();

        // Resolve the promise if it exists and is still pending
        if (segment.promise.state() === 'pending') {
            segment.promise.resolve();
        }
    }

    async markSegmentFailed (segmentId: string, error: string): Promise<void> {
        const segment = this.getOrCreateSegment(segmentId);

        segment.status = SegmentStatus.FAILED;
        segment.error = error;
        segment.completedAt = Date.now();

        // Reject the promise if it exists and is still pending
        if (segment.promise.state() === 'pending') {
            segment.promise.reject(new Error(error));
        }
    }

    async isSegmentProcessing (segmentId: string): Promise<boolean> {
        const segment = this.segments.get(segmentId);


        return segment?.status === SegmentStatus.PROCESSING || false;
    }

    async isSegmentComplete (segmentId: string): Promise<boolean> {
        const segment = this.segments.get(segmentId);


        return segment?.status === SegmentStatus.COMPLETED || false;
    }

    async getSegmentStatus (segmentId: string): Promise<SegmentStatus> {
        const segment = this.segments.get(segmentId);


        return segment?.status || SegmentStatus.PENDING;
    }

    async cleanup (streamId: string): Promise<void> {
        // Clean up all segments for this stream
        const keysToDelete: string[] = [];

        for (const [segmentId, segment] of this.segments.entries()) {
            if (segmentId.startsWith(streamId)) {
                // Reject any pending promises
                if (segment.promise.state() === 'pending') {
                    segment.promise.reject(new Error('Stream disposed'));
                }
                keysToDelete.push(segmentId);
            }
        }

        keysToDelete.forEach((key) => this.segments.delete(key));
    }

    /**
	 * Get information about a segment (useful for debugging/monitoring)
	 */
    getSegmentInfo (segmentId: string): SegmentInfo | null {
        const segment = this.segments.get(segmentId);

        if (!segment) {
            return null;
        }

        return {
            status: segment.status,
            nodeId: segment.nodeId,
            startedAt: segment.startedAt,
            completedAt: segment.completedAt,
            error: segment.error,
        };
    }

    /**
	 * Get all segments (useful for debugging)
	 */
    getAllSegments (): Map<string, SegmentInfo> {
        const result = new Map<string, SegmentInfo>();

        for (const [segmentId, segment] of this.segments.entries()) {
            result.set(segmentId, {
                status: segment.status,
                nodeId: segment.nodeId,
                startedAt: segment.startedAt,
                completedAt: segment.completedAt,
                error: segment.error,
            });
        }

        return result;
    }

    /**
	 * Get segment state or create new one if it doesn't exist
	 */
    private getOrCreateSegment (segmentId: string): SegmentState {
        let segment = this.segments.get(segmentId);

        if (!segment) {
            segment = {
                status: SegmentStatus.PENDING,
                promise: Deferred.create<void>(),
                nodeId: this.nodeId,
                startedAt: Date.now(),
            };
            this.segments.set(segmentId, segment);
        }

        return segment;
    }
}
