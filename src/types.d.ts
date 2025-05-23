export enum StreamType {
    VIDEO = 'v',
    AUDIO = 'a',
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

export interface DatabaseConnector {

    /**
     * Retrieve media metadata for the given file ID
     * @param fileId Unique identifier for the media file
     */
    getMetadata(fileId: string): Promise<MediaMetadata>;

    /**
     * Save media metadata for the given file ID
     * @param fileId Unique identifier for the media file
     * @param metadata The media metadata to save
     */
    saveMetadata(fileId: string, metadata: MediaMetadata): Promise<MediaMetadata>;

    /**
     * Check if metadata exists for the given file ID
     * @param fileId Unique identifier for the media file
     */
    metadataExists(fileId: string): Promise<{ exists: boolean, fileId: string }>;
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

export interface HLSManagerOptions {
    hwAccel?: boolean;
    cacheDirectory: string;
    database?: DatabaseConnector;
    maxSegmentBatchSize?: number;
    videoQualities?: VideoQualityEnum[];
    audioQualities?: AudioQualityEnum[];
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

export enum TranscodeType {
    DIRECT_PLAY = 'DIRECT_PLAY',
    DIRECT_STREAM = 'DIRECT_STREAM',
    TRANSCODING = 'TRANSCODING'
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

export interface StreamMetrics {
    segmentsProcessed: number;
    segmentsFailed: number;
    averageProcessingTime: number;
    hardwareAccelUsed: boolean;
    fallbacksToSoftware: number;
    totalJobsStarted: number;
    totalJobsCompleted: number;
}

export interface StreamMetricsEvent {
    streamId: string;
    fileId: string;
    type: StreamType;
    quality: string;
    streamIndex: number;
    
    metrics: StreamMetrics;
    
    isUsingHardwareAcceleration: boolean;
    currentAccelerationMethod: string;
    originalAccelerationMethod: string | null;
    hasFallenBackToSoftware: boolean;
    
    totalSegments: number;
    segmentsCompleted: number;
    segmentsPending: number;
    segmentsFailed: number;
    segmentsUnstarted: number;
    
    currentJobsActive: number;
    averageSegmentDuration: number;
    estimatedTimeRemaining: number | null;
    
    streamCreatedAt: number;
    lastActivityAt: number;
    metricsGeneratedAt: number;
}

/**
 * HLSController is the sole entry point for the HLS package.
 * It is responsible for managing the HLS transcoding process.
 * It handles the initialization of the HLS manager, manages client sessions,
 * and provides methods for generating playlists and segments.
 */
export declare class HLSController {
    /**
     * Constructor for HLSController
     * @param options HLSManagerOptions
     */
    constructor(options: HLSManagerOptions);

    /**
     * Initialize the HLS manager
     * This will initialize the transcodeService and detect hardware acceleration
     */
    initialize (): Promise<void>;

    /**
     * Get the master playlist for a media source
     * @param filePath The file path of the media source
     * @param clientId The client ID of the user requesting the stream
     */
    getMasterPlaylist (filePath: string, clientId: string): Promise<string>;

    /**
     * Get the playlist for a media source with the given stream type and quality
     * @param filePath The file path of the media source
     * @param clientId The client ID of the user requesting the stream
     * @param type The stream type
     * @param quality The stream quality
     * @param streamIndex The stream index
     */
    getIndexPlaylist (filePath: string, clientId: string, type: StreamType, quality: string, streamIndex: number): Promise<string>;

    /**
     * Get the segment stream for a media source with the given stream type and quality
     * @param filePath The file path of the media source
     * @param clientId The client ID of the user requesting the stream
     * @param type The stream type
     * @param quality The stream quality
     * @param streamIndex The stream index
     * @param segmentNumber The segment number to get
     */
    getSegmentStream (filePath: string, clientId: string, type: StreamType, quality: string, streamIndex: number, segmentNumber: number): Promise<NodeJS.ReadableStream>;

    /**
     * Extract subtitle from a media source and convert to WebVTT
     * @param filePath The file path of the media source
     * @param streamIndex The subtitle stream index to extract
     * @returns TaskEither containing the VTT content as string
     */
    getVTTSubtitle (filePath: string, streamIndex: number): Promise<string>;

    /**
     * Extract subtitle from a media source and convert to WebVTT
     * @param filePath The file path of the media source
     * @param streamIndex The subtitle stream index to extract
     * @returns TaskEither containing the VTT content as stream
     */
    getVTTSubtitleStream (filePath: string, streamIndex: number): Promise<NodeJS.ReadableStream>;

    /**
     * Create a screenshot from a media source at a specific timestamp
     * @param filePath The file path of the media source
     * @param quality The quality of the screenshot
     * @param streamIndex The stream index to take the screenshot from
     * @param time The time to take the screenshot at
     */
    generateScreenshot (filePath: string, quality: string, streamIndex: number, time: number): Promise<NodeJS.ReadableStream>;

    /**
     * Get all convertible subtitle streams from media metadata
     * @param filePath The file path of the media source
     */
    getConvertibleSubtitles (filePath: string): Promise<SubtitleInfo[]>;

    /**
     * Sets up a listener for when the client session changes
     * @param callback The callback to call when the session changes
     */
    onSessionChange (callback: (session: ClientSession) => void): void;
    
    /**
     * Sets up a listener for when the stream metrics change
     * @param callback The callback to call when the metrics change
     */
    onStreamMetrics (callback: (metrics: StreamMetricsEvent) => void): void;
    
    /**
     * Create metadata for a media source
     * @param filePath The file path of the media source
     */
    createMetadata (filePath: string): Promise<void>;
}
