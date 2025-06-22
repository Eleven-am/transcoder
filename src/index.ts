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

// Main controller
export { HLSController } from './hlsController';

// Core processors
export { JobProcessor } from './jobProcessor';

// Database interface for custom implementations
export { DatabaseConnector } from './databaseConnector';

// All type exports
export {
    // Enums
    TranscodeStatus,
    StreamType,
    HardwareAccelerationMethod,
    VideoQualityEnum,
    AudioQualityEnum,
    TranscodeType,
    
    // Types
    CodecType,
    StreamMetricsEventHandler,
    
    // Core interfaces
    Stream,
    FFMPEGOptions,
    HardwareAccelerationConfig,
    Chapter,
    VideoInfo,
    AudioInfo,
    SubtitleInfo,
    MediaMetadata,
    
    // Configuration interfaces
    HLSManagerOptions,
    StreamConfig,
    
    // Metrics interfaces
    StreamMetrics,
    StreamMetricsEvent,
    
    // Quality interfaces
    VideoQuality,
    AudioQuality,
    
    // Session and job interfaces
    ClientSession,
    TranscodeJob,
    SegmentStream,
} from './types';

// Distributed processing exports
export {
    // Interfaces
    SegmentProcessingData,
    SegmentProcessingResult,
    ISegmentProcessor,
    SegmentClaim,
    DistributedConfig,
    
    // Implementations
    LocalSegmentProcessor,
    DistributedSegmentProcessor,
    RedisSegmentClaimManager,
    SegmentProcessorFactory,
} from './distributed';

// Re-export the default ffmpeg instance for advanced users
export { default as ffmpeg } from './ffmpeg';