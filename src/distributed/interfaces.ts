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

// Interfaces for distributed transcoding system

/**
 * Data required for processing a single segment
 */
export interface SegmentProcessingData {
    fileId: string;
    sourceFilePath: string;
    streamType: string;
    quality: string;
    streamIndex: number;
    segmentIndex: number;
    segmentStart: number;
    segmentDuration: number;
    totalSegments: number;
    ffmpegOptions: {
        inputOptions: string[];
        outputOptions: string[];
        videoFilters?: string;
    };
    outputPath: string;
}

/**
 * Result of segment processing
 */
export interface SegmentProcessingResult {
    success: boolean;
    segmentIndex: number;
    outputPath: string;
    processingTime?: number;
    cached?: boolean;
    error?: Error;
}

/**
 * Interface for segment processors
 */
export interface ISegmentProcessor {

    /**
     * Process a single segment
     */
    processSegment(data: SegmentProcessingData): Promise<SegmentProcessingResult>;

    /**
     * Check if processor is healthy and ready
     */
    isHealthy(): Promise<boolean>;

    /**
     * Get current processing mode
     */
    getMode(): 'local' | 'distributed';

    /**
     * Cleanup resources
     */
    dispose(): Promise<void>;
}

/**
 * Segment claim for distributed processing
 */
export interface SegmentClaim {
    acquired: boolean;
    segmentKey: string;
    workerId: string;
    expiresAt: number;
    extend: () => Promise<boolean>;
    release: () => Promise<void>;
}

/**
 * Configuration for distributed processing
 */
export interface DistributedConfig {
    redisUrl?: string;
    workerId?: string;
    claimTTL?: number; // milliseconds
    claimRenewalInterval?: number; // milliseconds
    segmentTimeout?: number; // milliseconds
    fallbackToLocal?: boolean;
    completedSegmentTTL?: number; // milliseconds - how long to keep completed segment records in Redis
    fileWaitTimeout?: number; // milliseconds - how long to wait for files to appear on shared storage
}
