import { DatabaseConnector } from './databaseConnector';
import { FfmpegCommand } from './ffmpeg';

export interface Stream {
    codec_name: string;
    profile?: string;
    level?: number;
    bits_per_raw_sample?: string;
}

export enum TranscodeStatus {
    QUEUED,
    PROCESSING,
    PROCESSED,
    ERROR,
}

export enum StreamType {
    VIDEO = 'v',
    AUDIO = 'a',
}

export type CodecType = 'h264' | 'h265';

export enum HardwareAccelerationMethod {
    NONE = 'none',
    CUDA = 'cuda',
    VIDEOTOOLBOX = 'videotoolbox',
    QSV = 'qsv',
    VAAPI = 'vaapi',
}

export interface FFMPEGOptions {
    inputOptions: string[];
    outputOptions: string[];
    videoFilters: string | undefined;
}

export interface HardwareAccelerationConfig {
    method: HardwareAccelerationMethod;
    inputOptions: string[];
    outputOptions: Record<string, string[]>;
    videoFilters: Record<string, string>;
    deviceInfo?: string;
}

export interface Chapter {
    startTime: number;
    endTime: number;
    name: string;
    type: 'content' | 'recap' | 'intro' | 'credits' | 'preview';
}

export interface VideoInfo {
    index: number;
    codec: string;
    mimeCodec: string | null;
    title: string | null;
    language: string | null;
    width: number;
    height: number;
    bitrate: number;
    isDefault: boolean;
}

export interface AudioInfo {
    index: number;
    codec: string;
    mimeCodec: string | null;
    title: string | null;
    language: string | null;
    bitrate: number;
    isDefault: boolean;
    isForced: boolean;
    channels: number;
}

export interface SubtitleInfo {
    index: number | null;
    codec: string;
    extension: string | null;
    title: string | null;
    language: string | null;
    isDefault: boolean;
    isForced: boolean;
    isHearingImpaired: boolean;
    isExternal: boolean;
    path?: string;
    link?: string;
}

export interface MediaMetadata {
    id: string;
    path: string;
    extension: string;
    mimeCodec: string | null;
    duration: number;
    container: string | null;
    videos: VideoInfo[];
    audios: AudioInfo[];
    subtitles: SubtitleInfo[];
    fonts: string[];
    keyframes: number[];
    chapters: Chapter[];
    extractionTimestamp: Date;
}

export interface HLSManagerOptions {
    hwAccel?: boolean;
    cacheDirectory: string;
    database?: DatabaseConnector;
    maxSegmentBatchSize?: number;
    videoQualities?: VideoQualityEnum[];
    audioQualities?: AudioQualityEnum[];
}

export enum VideoQualityEnum {
    P240 = '240p',
    P360 = '360p',
    P480 = '480p',
    P720 = '720p',
    P1080 = '1080p',
    P1440 = '1440p',
    P4K = '4k',
    P8K = '8k',
    ORIGINAL = 'original'
}

export enum AudioQualityEnum {
    AAC = 'aac',
    ORIGINAL = 'original'
}

export enum TranscodeType {
    DIRECT_PLAY = 'DIRECT_PLAY',
    DIRECT_STREAM = 'DIRECT_STREAM',
    TRANSCODING = 'TRANSCODING'
}

export interface VideoQuality {
    value: VideoQualityEnum;
    averageBitrate: number;
    maxBitrate: number;
    height: number;
}

export interface AudioQuality {
    value: AudioQualityEnum;
    averageBitrate: number;
    maxBitrate: number;
}

export interface ClientSession {
    filePath: string;
    clientId: string;
    audioIndex: number;
    videoIndex: number;
    status: TranscodeType;
    audioProfile: AudioQuality;
    videoProfile: VideoQuality;
}

export interface TranscodeJob {
    id: string;
    start: number;
    priority: number;
    createdAt: number;
    status: TranscodeStatus;
    process: FfmpegCommand;
}
