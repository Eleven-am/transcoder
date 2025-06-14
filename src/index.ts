export { HLSController } from './hlsController';
export { default as ffmpeg } from './ffmpeg';
export { TranscodeType, StreamType, VideoQualityEnum, AudioQualityEnum } from './types';

// Export distributed functionality
export {
    createRedisBackend,
    createLocalBackend,
    isRedisBackend,
    isLocalBackend,
    type Backend,
    type DistributedConfig,
    type RedisConfig,
    type SegmentCoordinator,
    type TranscodeJobQueue,
    type DistributedTranscodeJob,
    SegmentStatus,
} from './distributed';
