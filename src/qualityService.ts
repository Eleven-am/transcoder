import { AudioInfo, AudioQuality, AudioQualityEnum, VideoInfo, VideoQuality, VideoQualityEnum } from './types';

const vQualities = [
    VideoQualityEnum.P240,
    VideoQualityEnum.P360,
    VideoQualityEnum.P480,
    VideoQualityEnum.P720,
    VideoQualityEnum.P1080,
    VideoQualityEnum.P1440,
    VideoQualityEnum.P4K,
    VideoQualityEnum.P8K,
];

const aQualities = [
    AudioQualityEnum.AAC,
    AudioQualityEnum.ORIGINAL,
];

export class QualityService {
    private readonly videoQualityMap: Record<VideoQualityEnum, VideoQuality> = {
        [VideoQualityEnum.P240]: {
            value: VideoQualityEnum.P240,
            averageBitrate: 400_000,
            maxBitrate: 700_000,
            height: 240,
        },
        [VideoQualityEnum.P360]: {
            value: VideoQualityEnum.P360,
            averageBitrate: 800_000,
            maxBitrate: 1_400_000,
            height: 360,
        },
        [VideoQualityEnum.P480]: {
            value: VideoQualityEnum.P480,
            averageBitrate: 1_200_000,
            maxBitrate: 2_100_000,
            height: 480,
        },
        [VideoQualityEnum.P720]: {
            value: VideoQualityEnum.P720,
            averageBitrate: 2_400_000,
            maxBitrate: 4_000_000,
            height: 720,
        },
        [VideoQualityEnum.P1080]: {
            value: VideoQualityEnum.P1080,
            averageBitrate: 4_800_000,
            maxBitrate: 8_000_000,
            height: 1080,
        },
        [VideoQualityEnum.P1440]: {
            value: VideoQualityEnum.P1440,
            averageBitrate: 9_600_000,
            maxBitrate: 12_000_000,
            height: 1440,
        },
        [VideoQualityEnum.P4K]: {
            value: VideoQualityEnum.P4K,
            averageBitrate: 16_000_000,
            maxBitrate: 28_000_000,
            height: 2160,
        },
        [VideoQualityEnum.P8K]: {
            value: VideoQualityEnum.P8K,
            averageBitrate: 28_000_000,
            maxBitrate: 40_000_000,
            height: 4320,
        },
        [VideoQualityEnum.ORIGINAL]: { value: VideoQualityEnum.ORIGINAL,
            averageBitrate: -1,
            maxBitrate: -1,
            height: -1 },
    };

    private readonly audioQualityMap: Record<AudioQualityEnum, AudioQuality> = {
        [AudioQualityEnum.AAC]: { value: AudioQualityEnum.AAC,
            averageBitrate: 128_000,
            maxBitrate: 192_000 },
        [AudioQualityEnum.ORIGINAL]: { value: AudioQualityEnum.ORIGINAL,
            averageBitrate: -1,
            maxBitrate: -1 },
    };

    constructor (
        private readonly videoQualities = vQualities,
        private readonly audioQualities = aQualities,
    ) {}

    /**
     * Determine the appropriate quality for a video
     * @param video The video to determine quality for
     * @returns The appropriate quality level
     */
    determineVideoQuality (video: VideoInfo): VideoQuality {
        for (const qualityValue of this.videoQualities) {
            const quality = this.videoQualityMap[qualityValue];

            if (quality.height >= video.height) {
                return quality;
            }
        }

        return this.videoQualityMap[this.videoQualities[0]];
    }

    /**
     * Determine the appropriate audio quality for a video
     * @param audio The video to determine audio quality for
     * @returns The appropriate audio quality level
     */
    determineAudioQuality (audio: AudioInfo): AudioQuality {
        for (const qualityValue of this.audioQualities) {
            const quality = this.audioQualityMap[qualityValue];

            if (quality.averageBitrate >= audio.bitrate) {
                return quality;
            }
        }

        return this.audioQualityMap[this.audioQualities[0]];
    }

    /**
     * Parse a quality string into a Quality object
     * @param qualityStr The quality string to parse
     * @throws Error if the quality string is invalid
     */
    parseVideoQuality (qualityStr: string): VideoQuality {
        const quality = this.videoQualityMap[qualityStr as VideoQualityEnum];

        if (!quality) {
            throw new Error(`Invalid quality: ${qualityStr}`);
        }

        return quality;
    }

    /**
     * Parse a quality string into an AudioQuality object
     * @param qualityStr The quality string to parse
     * @throws Error if the quality string is invalid
     */
    parseAudioQuality (qualityStr: string): AudioQuality {
        const quality = this.audioQualityMap[qualityStr as AudioQualityEnum];

        if (!quality) {
            throw new Error(`Invalid quality: ${qualityStr}`);
        }

        return quality;
    }

    /**
     * Gets the available qualities for a video
     * @param video The video to get qualities for
     * @returns An array of available qualities for the video
     */
    getVideoQualities (video: VideoInfo): VideoQuality[] {
        const determinedQuality = this.determineVideoQuality(video);
        const result: VideoQuality[] = [];

        for (const qualityValue of this.videoQualities) {
            const quality = this.videoQualityMap[qualityValue];

            result.push(quality);
            if (quality.value === determinedQuality.value) {
                break;
            }
        }

        return result;
    }

    /**
     * Get the non-transcode video qualities
     */
    getNonTranscodeVideoQualities () {
        return this.videoQualityMap[VideoQualityEnum.ORIGINAL];
    }

    /**
     * Builds a valid audio quality object based on the provided quality and audio info
     * @param quality The desired audio quality
     * @param audioInfo The audio info object containing bitrate information
     */
    buildValidAudioQuality (quality: AudioQualityEnum, audioInfo: AudioInfo): AudioQuality {
        if (quality === AudioQualityEnum.ORIGINAL) {
            return {
                value: AudioQualityEnum.ORIGINAL,
                averageBitrate: audioInfo.bitrate * 1.2,
                maxBitrate: audioInfo.bitrate * 2,
            };
        }

        return this.parseAudioQuality(quality);
    }

    /**
     * Builds a valid video quality object based on the provided quality and video info
     * @param quality The desired video quality
     * @param videoInfo The video info object containing bitrate and height information
     */
    buildValidVideoQuality (quality: VideoQualityEnum, videoInfo: VideoInfo): VideoQuality {
        if (quality === VideoQualityEnum.ORIGINAL) {
            return {
                value: VideoQualityEnum.ORIGINAL,
                averageBitrate: videoInfo.bitrate * 1.2,
                maxBitrate: videoInfo.bitrate * 2,
                height: videoInfo.height,
            };
        }

        return this.parseVideoQuality(quality);
    }
}

