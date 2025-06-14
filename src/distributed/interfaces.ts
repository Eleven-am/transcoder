import { StreamType } from '../types';

/**
 * Serializable transcode job that can be queued and processed by any node
 */
export interface DistributedTranscodeJob {
    id: string;
    priority: number;
    createdAt: number;

    // Source file information
    filePath: string;
    fileId: string;
    streamType: StreamType;
    streamIndex: number;
    quality: string;
    segmentIndex: number;

    // FFmpeg parameters (all serializable)
    inputOptions: string[];
    outputOptions: string[];
    videoFilters?: string;
    outputPath: string;

    // Segment range being processed
    segmentRange: {
        start: number;
        end: number;
    };
}

/**
 * Coordinates segment processing state across local and distributed environments
 */
export interface SegmentCoordinator {

    /**
	 * Wait for a specific segment to complete processing
	 * @param segmentId Unique identifier for the segment
	 * @param timeout Maximum time to wait in milliseconds
	 * @returns Promise that resolves when segment is complete
	 */
    waitForSegment(segmentId: string, timeout: number): Promise<void>;

    /**
	 * Mark a segment as currently being processed
	 * @param segmentId Unique identifier for the segment
	 * @param nodeId ID of the node processing the segment
	 */
    markSegmentProcessing(segmentId: string, nodeId: string): Promise<void>;

    /**
	 * Mark a segment as completed
	 * @param segmentId Unique identifier for the segment
	 */
    markSegmentComplete(segmentId: string): Promise<void>;

    /**
	 * Mark a segment as failed
	 * @param segmentId Unique identifier for the segment
	 * @param error Error message
	 */
    markSegmentFailed(segmentId: string, error: string): Promise<void>;

    /**
	 * Check if a segment is currently being processed
	 * @param segmentId Unique identifier for the segment
	 * @returns Promise resolving to true if segment is being processed
	 */
    isSegmentProcessing(segmentId: string): Promise<boolean>;

    /**
	 * Check if a segment has completed processing
	 * @param segmentId Unique identifier for the segment
	 * @returns Promise resolving to true if segment is complete
	 */
    isSegmentComplete(segmentId: string): Promise<boolean>;

    /**
	 * Get the processing status of a segment
	 * @param segmentId Unique identifier for the segment
	 * @returns Promise resolving to segment status
	 */
    getSegmentStatus(segmentId: string): Promise<SegmentStatus>;

    /**
	 * Clean up resources for a stream
	 * @param streamId Unique identifier for the stream
	 */
    cleanup(streamId: string): Promise<void>;
}

/**
 * Queue for distributing transcode jobs across nodes
 */
export interface TranscodeJobQueue {

    /**
	 * Add a job to the queue
	 * @param job The transcode job to queue
	 */
    push(job: DistributedTranscodeJob): Promise<void>;

    /**
	 * Get the next job from the queue
	 * @param nodeId ID of the node requesting the job
	 * @returns Promise resolving to the next job or null if queue is empty
	 */
    pop(nodeId: string): Promise<DistributedTranscodeJob | null>;

    /**
	 * Mark a job as completed
	 * @param jobId The ID of the completed job
	 */
    complete(jobId: string): Promise<void>;

    /**
	 * Mark a job as failed and optionally requeue it
	 * @param jobId The ID of the failed job
	 * @param error Error message
	 * @param requeue Whether to requeue the job for retry
	 */
    fail(jobId: string, error: string, requeue?: boolean): Promise<void>;

    /**
	 * Get the current queue size
	 * @returns Promise resolving to the number of jobs in queue
	 */
    size(): Promise<number>;

    /**
	 * Get jobs currently being processed
	 * @returns Promise resolving to array of job IDs being processed
	 */
    getProcessing(): Promise<string[]>;
}

/**
 * Status of a segment in the processing pipeline
 */
export enum SegmentStatus {
    PENDING = 'pending',
    PROCESSING = 'processing',
    COMPLETED = 'completed',
    FAILED = 'failed'
}

/**
 * Information about a segment's processing state
 */
export interface SegmentInfo {
    status: SegmentStatus;
    nodeId?: string;
    startedAt?: number;
    completedAt?: number;
    error?: string;
}
