import * as path from 'node:path';
import { Readable } from 'stream';

import { createNotFoundError, Result, sortBy, TaskEither } from '@eleven-am/fp';

import { DistributedTranscodeJob, SegmentCoordinator, SegmentStatus } from './distributed';
import ffmpeg from './ffmpeg';
import { HardwareAccelerationDetector } from './hardwareAccelerationDetector';
import { MediaSource } from './mediaSource';
import { MetadataService } from './metadataService';
import { QualityService } from './qualityService';
import {
    AudioQuality,
    AudioQualityEnum,
    CodecType,
    FFMPEGOptions,
    HardwareAccelerationConfig,
    MediaMetadata,
    SegmentStream,
    StreamConfig,
    StreamMetrics,
    StreamMetricsEvent,
    StreamType,
    SubtitleInfo,
    VideoQuality,
    VideoQualityEnum,
} from './types';
import { ExtendedEventEmitter } from './utils';


interface Segment {
    index: number;
    start: number;
    duration: number;
}

interface StreamEventMap {
    'transcode:complete': DistributedTranscodeJob;
    'transcode:queued': DistributedTranscodeJob;
    'transcode:error': { job: DistributedTranscodeJob, error: Error };
    'transcode:start': DistributedTranscodeJob;
    'transcode:fallback': { job: DistributedTranscodeJob, from: string, to: string };
    'stream:metrics': StreamMetricsEvent;
    'dispose': { id: string };
}

interface DetailedVideoQuality extends VideoQuality {
    width: number;
    height: number;
}

export class Stream extends ExtendedEventEmitter<StreamEventMap> {
    private static readonly DEFAULT_CONFIG: StreamConfig = {
        disposeTimeout: 30 * 60 * 1000,
        maxEncoderDistance: 60,
        segmentTimeout: 60_000,
        enableHardwareAccelFallback: true,
        retryFailedSegments: true,
        metricsInterval: 30_000,
        maxRetries: 3,
    };

    private readonly nodeId: string;

    private readonly videoQuality: VideoQuality | null;

    private readonly audioQuality: AudioQuality | null;

    private readonly segments: Map<number, Segment>;

    private readonly config: StreamConfig;

    private readonly metrics: StreamMetrics;

    private readonly cachedHwOptions: Map<string, FFMPEGOptions>;

    private readonly segmentRetries: Map<number, number>;

    private timer: NodeJS.Timeout | null;

    private hasFallenBackToSoftware: boolean;

    private readonly streamCreatedAt: number;

    private lastActivityAt: number;

    private metricsTimer: NodeJS.Timeout | null;

    private constructor (
        private readonly quality: string,
        private readonly type: StreamType,
        private readonly source: MediaSource,
        private readonly streamIndex: number,
        private readonly metadata: MediaMetadata,
        private readonly maxSegmentBatchSize: number,
        private readonly qualityService: QualityService,
        private readonly hwDetector: HardwareAccelerationDetector,
        private readonly optimisedAccel: HardwareAccelerationConfig | null,
        config: Partial<StreamConfig>,
        private readonly segmentCoordinator: SegmentCoordinator,
    ) {
        super();

        this.nodeId = `node-${process.pid}-${Date.now()}`;
        this.config = {
            ...Stream.DEFAULT_CONFIG,
            ...config,
        };

        const [aQ, vQ] = this.loadQuality();

        this.segments = this.buildSegments();
        this.videoQuality = vQ;
        this.audioQuality = aQ;
        this.timer = null;
        this.hasFallenBackToSoftware = false;
        this.streamCreatedAt = Date.now();
        this.lastActivityAt = this.streamCreatedAt;
        this.metricsTimer = null;
        this.cachedHwOptions = new Map();
        this.segmentRetries = new Map();
        this.metrics = {
            segmentsProcessed: 0,
            segmentsFailed: 0,
            averageProcessingTime: 0,
            hardwareAccelUsed: Boolean(optimisedAccel),
            fallbacksToSoftware: 0,
            totalJobsStarted: 0,
            totalJobsCompleted: 0,
        };
    }

    /**
	 * Create a new stream
	 * @param quality - The quality of the stream
	 * @param type - The type of the stream (audio or video)
	 * @param streamIndex - The index of the stream
	 * @param source - The media source
	 * @param maxSegmentBatchSize - The maximum number of segments to process at once
	 * @param qualityService - The quality service
	 * @param metadataService - The metadata service
	 * @param hwDetector - The hardware acceleration detector
	 * @param hwAccel - The hardware acceleration configuration
	 * @param config - The stream configuration
	 * @param segmentCoordinator - The segment coordinator for distributed coordination
	 */
    static create (
        quality: string,
        type: StreamType,
        streamIndex: number,
        source: MediaSource,
        maxSegmentBatchSize: number,
        qualityService: QualityService,
        metadataService: MetadataService,
        hwDetector: HardwareAccelerationDetector,
        hwAccel: HardwareAccelerationConfig | null,
        config: Partial<StreamConfig>,
        segmentCoordinator: SegmentCoordinator,
    ): TaskEither<Stream> {
        return TaskEither
            .fromBind({
                metadata: metadataService.getMetadata(source),
                optimisedAccel: metadataService.detectOptimalCodecConfig(source, hwAccel),
            })
            .map(({ metadata, optimisedAccel }) => new Stream(
                quality,
                type,
                source,
                streamIndex,
                metadata,
                maxSegmentBatchSize,
                qualityService,
                hwDetector,
                optimisedAccel,
                config,
                segmentCoordinator,
            ))
            .chain((stream) => stream.initialise());
    }

    /**
	 * Get the stream ID
	 * @param fileId - The file ID
	 * @param type - The type of the stream (audio or video)
	 * @param quality - The quality of the stream
	 * @param streamIndex - The index of the stream
	 */
    static getStreamId (fileId: string, type: StreamType, quality: string, streamIndex: number): string {
        return `${fileId}:${type}:${streamIndex}:${quality}`;
    }

    /**
	 * Extract subtitle from a media source and convert to WebVTT
	 * @param mediaSource - The media source
	 * @param streamIndex - The index of the subtitle stream
	 */
    static getVTTSubtitle (mediaSource: MediaSource, streamIndex: number): Promise<NodeJS.ReadableStream> {
        return this.runFFMPEGCommand(
            [
                '-map',
                `0:s:${streamIndex}`,
                '-c:s',
                'webvtt',
                '-f',
                'webvtt',
            ],
            mediaSource.getFilePath(),
        );
    }

    /**
	 * Get all convertible subtitle streams from media metadata
	 * @param metadata - The media metadata
	 */
    static getConvertibleSubtitles (metadata: MediaMetadata): SubtitleInfo[] {
        return metadata.subtitles.filter((stream) => this.canConvertToVtt(stream));
    }

    /**
	 * Check if a subtitle stream can be converted to VTT
	 * @param subtitleStream - The subtitle stream
	 */
    private static canConvertToVtt (subtitleStream: SubtitleInfo): boolean {
        const supportedCodecs = [
            'subrip',
            'webvtt',
            'mov_text',
            'ass',
            'ssa',
            'text',
        ];

        const supportedExtensions = [
            'srt',
            'vtt',
            'ass',
            'ssa',
        ];

        return supportedCodecs.includes(subtitleStream.codec) ||
                   (subtitleStream.extension !== null && supportedExtensions.includes(subtitleStream.extension));
    }

    /**
	 * Run FFMPEG command
	 * @param outputOptions - The output options to feed to the Ffmpeg
	 * @param inputPath - The input path to the file to perform the command on
	 */
    private static runFFMPEGCommand (outputOptions: string[], inputPath: string) {
        return new Promise<Readable>((resolve, reject) => {
            const stream = ffmpeg(inputPath)
                .outputOptions(outputOptions)
                .on('error', reject)
                .pipe();

            resolve(stream);
        });
    }

    /**
	 * Create a screenshot from a media source at a specific timestamp
	 * @param timestamp - The timestamp of the screenshot to be created
	 */
    generateScreenshot (timestamp: number): Promise<NodeJS.ReadableStream> {
        const command = ffmpeg(this.source.getFilePath());
        const videoProfile = this.buildVideoQuality(this.videoQuality?.value ?? VideoQualityEnum.ORIGINAL);

        if (timestamp > 0) {
            command.inputOptions(['-ss', timestamp.toFixed(6)]);
        }

        command.outputOptions([
            '-map',
            `0:v:${this.streamIndex}`,
            '-vframes',
            '1',
            '-f',
            'image2pipe',
            '-vcodec',
            'mjpeg',
            '-an',
            '-sn',
            '-pix_fmt',
            'yuvj420p',
        ]);

        command.videoFilters(`scale=${videoProfile.width}:${videoProfile.height}`);

        return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
            const stream = command
                .on('error', reject)
                .pipe();

            resolve(stream);
        });
    }

    /**
	 * Get the file ID
	 */
    getFileId (): string {
        return this.metadata.id;
    }

    /**
	 * Builds the transcode command for the stream using distributed coordination
	 * @param segmentIndex - The index of the segment
	 * @param priority - The priority of the segment
	 */
    buildTranscodeCommand (segmentIndex: number, priority: number): TaskEither<void> {
        this.debounceDispose();

        const segmentId = this.getSegmentId(segmentIndex);

        return TaskEither
            .fromBind({
                exists: this.source.segmentExist(this.type, this.streamIndex, this.quality, segmentIndex),
                segmentStatus: TaskEither.tryCatch(() => this.segmentCoordinator.getSegmentStatus(segmentId)),
                isProcessing: TaskEither.tryCatch(() => this.segmentCoordinator.isSegmentProcessing(segmentId)),
            })
            .matchTask([
                {
                    predicate: ({ exists }) => exists,
                    run: () => TaskEither.of(undefined),
                },
                {
                    predicate: ({ segmentStatus }) => segmentStatus === SegmentStatus.COMPLETED,
                    run: () => TaskEither.of(undefined),
                },
                {
                    predicate: ({ isProcessing }) => isProcessing,
                    run: () => TaskEither.tryCatch(() => this.segmentCoordinator.waitForSegment(segmentId, this.config.segmentTimeout)),
                },
                {
                    predicate: () => this.type === StreamType.AUDIO,
                    run: () => this.buildAudioTranscodeJob(segmentIndex, priority),
                },
                {
                    predicate: () => this.type === StreamType.VIDEO,
                    run: () => this.buildVideoTranscodeJob(segmentIndex, priority),
                },
            ]);
    }

    /**
	 * Get the segment stream for a specific segment
	 * @param segmentIndex - The index of the segment
	 * @param priority - The priority of the segment
	 */
    getSegmentStream (segmentIndex: number, priority: number): TaskEither<SegmentStream> {
        this.debounceDispose();

        return this.buildTranscodeCommand(segmentIndex, priority)
            .chain(() => this.source.getSegmentStream(this.type, this.streamIndex, this.quality, segmentIndex));
    }

    /**
	 * Get the stream ID
	 */
    getStreamId (): string {
        return Stream.getStreamId(this.metadata.id, this.type, this.quality, this.streamIndex);
    }

    /**
	 * Creates a new playlist for the stream
	 */
    getPlaylist (): string {
        this.debounceDispose();

        const segments = Array.from(this.segments.values());
        const sortedSegments = sortBy(segments, 'index', 'asc');

        const indices = [
            '#EXTM3U',
            '#EXT-X-VERSION:6',
            '#EXT-X-PLAYLIST-TYPE:EVENT',
            '#EXT-X-START:TIME-OFFSET=0',
            '#EXT-X-TARGETDURATION:4',
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-INDEPENDENT-SEGMENTS',
            ...sortedSegments.map((segment) => [
                `#EXTINF:${segment.duration.toFixed(6)}`,
                `segment-${segment.index}.ts`,
            ]).flat(),
            '#EXT-X-ENDLIST',
        ];

        return indices.join('\n');
    }

    /**
	 * Builds the video quality for the stream
	 * @param quality - The video quality to build
	 * @param index - The index of the video stream
	 */
    buildVideoQuality (quality: VideoQualityEnum, index?: number): DetailedVideoQuality {
        const videoInfo = this.metadata.videos[index ?? this.streamIndex];
        const profile = this.qualityService.buildValidVideoQuality(quality, videoInfo);

        const targetWidth = Math.round((profile.height / videoInfo.height) * videoInfo.width);
        const targetHeight = profile.height;

        const width = this.closestMultiple(targetWidth, 2);
        const height = this.closestMultiple(targetHeight, 2);

        return {
            ...profile,
            width,
            height,
        };
    }

    /**
	 * Builds the audio quality for the stream
	 * @param quality - The audio quality to build
	 * @param index - The index of the audio stream
	 */
    buildAudioQuality (quality: AudioQualityEnum, index?: number): AudioQuality {
        const audioInfo = this.metadata.audios[index ?? this.streamIndex];

        return this.qualityService.buildValidAudioQuality(quality, audioInfo);
    }

    /**
	 * Dispose of the stream
	 */
    dispose (): Promise<Result<void>> {
        this.cachedHwOptions.clear();
        this.segmentRetries.clear();

        if (this.timer) {
            clearTimeout(this.timer);
        }
        if (this.metricsTimer) {
            clearInterval(this.metricsTimer);
        }

        // Clean up distributed state
        void this.segmentCoordinator.cleanup(this.getStreamId()).catch((error) => {
            console.warn(`Failed to cleanup segment coordinator for stream ${this.getStreamId()}:`, error);
        });

        this.emit('dispose', { id: this.getStreamId() });

        return this.source.deleteTempFiles()
            .map(() => {
                this.segments.clear();
                this.timer = null;
                this.metricsTimer = null;
                this.removeAllListeners();
            })
            .toResult();
    }

    /**
	 * Get segment ID for distributed coordination
	 */
    private getSegmentId (segmentIndex: number): string {
        return `${this.getStreamId()}:${segmentIndex}`;
    }

    /**
	 * Build audio transcode job for distributed processing
	 * @param segmentIndex - The index of the segment
	 * @param priority - The priority of the segment
	 */
    private buildAudioTranscodeJob (segmentIndex: number, priority: number): TaskEither<void> {
        const segment = this.segments.get(segmentIndex);

        if (!segment) {
            return TaskEither.error(createNotFoundError(`Segment ${segmentIndex} not found`));
        }

        const segmentId = this.getSegmentId(segmentIndex);

        // Mark segment as processing
        return TaskEither.tryCatch(() => this.segmentCoordinator.markSegmentProcessing(segmentId, this.nodeId))
            .chain(() => this.source.getStreamDirectory(this.type, this.streamIndex, this.quality))
            .map((outputDir) => {
                const outputOptions = this.audioQuality?.value === AudioQualityEnum.ORIGINAL
                    ? [
                        '-map',
                        `0:a:${this.streamIndex}`,
                        '-c:a',
                        'copy',
                        '-vn',
                    ]
                    : [
                        '-map',
                        `0:a:${this.streamIndex}`,
                        '-c:a',
                        'aac',
                        '-ac',
                        '2',
                        '-b:a',
                        '128k',
                        '-vn',
                    ];

                const job: DistributedTranscodeJob = {
                    id: `job-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
                    priority,
                    createdAt: Date.now(),
                    filePath: this.source.getFilePath(),
                    fileId: this.metadata.id,
                    streamType: this.type,
                    streamIndex: this.streamIndex,
                    quality: this.quality,
                    segmentIndex,
                    inputOptions: ['-nostats', '-hide_banner', '-loglevel', 'warning'],
                    outputOptions,
                    outputPath: path.join(outputDir, `segment-${segmentIndex}.ts`),
                    segmentRange: {
                        start: segment.start,
                        end: segment.start + segment.duration,
                    },
                };

                this.emit('transcode:queued', job);
                this.metrics.totalJobsStarted++;
            });
    }

    /**
	 * Build video transcode job for distributed processing
	 * @param segmentIndex - The index of the segment
	 * @param priority - The priority of the segment
	 */
    private buildVideoTranscodeJob (segmentIndex: number, priority: number): TaskEither<void> {
        const segment = this.segments.get(segmentIndex);
        const video = this.metadata.videos[this.streamIndex];

        if (!segment || !video) {
            return TaskEither.error(createNotFoundError(`Segment ${segmentIndex} or video stream not found`));
        }

        const segmentId = this.getSegmentId(segmentIndex);

        // Mark segment as processing
        return TaskEither.tryCatch(() => this.segmentCoordinator.markSegmentProcessing(segmentId, this.nodeId))
            .chain(() => this.source.getStreamDirectory(this.type, this.streamIndex, this.quality))
            .map((outputDir) => {
                let inputOptions = ['-nostats', '-hide_banner', '-loglevel', 'warning'];
                let outputOptions: string[];
                let videoFilters: string | undefined;

                if (this.videoQuality?.value === VideoQualityEnum.ORIGINAL) {
                    outputOptions = [
                        '-map',
                        `0:v:${this.streamIndex}`,
                        '-c:v',
                        'copy',
                        '-an',
                    ];
                } else {
                    const detailedQuality = this.buildVideoQuality(this.videoQuality!.value);
                    const codec: CodecType = video.codec.includes('hevc') || video.codec.includes('h265')
                        ? 'h265'
                        : 'h264';

                    const hwOptions = this.getCachedHardwareOptions(
                        detailedQuality.width,
                        detailedQuality.height,
                        codec,
                    );

                    inputOptions = [...inputOptions, ...hwOptions.inputOptions];
                    videoFilters = hwOptions.videoFilters;
                    outputOptions = [
                        '-map',
                        `0:v:${this.streamIndex}`,
                        '-bufsize',
                        `${detailedQuality.maxBitrate * 5}`,
                        '-b:v',
                        `${detailedQuality.averageBitrate}`,
                        '-maxrate',
                        `${detailedQuality.maxBitrate}`,
                        '-forced-idr',
                        '1',
                        ...hwOptions.outputOptions,
                        '-an',
                    ];
                }

                const job: DistributedTranscodeJob = {
                    id: `job-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
                    priority,
                    createdAt: Date.now(),
                    filePath: this.source.getFilePath(),
                    fileId: this.metadata.id,
                    streamType: this.type,
                    streamIndex: this.streamIndex,
                    quality: this.quality,
                    segmentIndex,
                    inputOptions,
                    outputOptions,
                    videoFilters,
                    outputPath: path.join(outputDir, `segment-${segmentIndex}.ts`),
                    segmentRange: {
                        start: segment.start,
                        end: segment.start + segment.duration,
                    },
                };

                this.emit('transcode:queued', job);
                this.metrics.totalJobsStarted++;
            });
    }

    /**
	 * Generate and emit comprehensive stream metrics
	 */
    private emitMetrics (): void {
        this.lastActivityAt = Date.now();

        const metricsEvent: StreamMetricsEvent = {
            streamId: this.getStreamId(),
            fileId: this.metadata.id,
            type: this.type,
            quality: this.quality,
            streamIndex: this.streamIndex,

            metrics: { ...this.metrics },

            isUsingHardwareAcceleration: this.isUsingHardwareAcceleration(),
            currentAccelerationMethod: this.getCurrentAccelerationMethod(),
            originalAccelerationMethod: this.optimisedAccel?.method || null,
            hasFallenBackToSoftware: this.hasFallenBackToSoftware,

            totalSegments: this.segments.size,
            segmentsCompleted: 0,
            segmentsPending: 0,
            segmentsFailed: 0,
            segmentsUnstarted: this.segments.size,

            currentJobsActive: 0,
            averageSegmentDuration: this.metadata.duration / this.segments.size,
            estimatedTimeRemaining: null,

            streamCreatedAt: this.streamCreatedAt,
            lastActivityAt: this.lastActivityAt,
            metricsGeneratedAt: Date.now(),
        };

        this.emit('stream:metrics', metricsEvent);
    }

    /**
	 * Initialize the stream
	 */
    private initialise (): TaskEither<Stream> {
        this.emitMetrics();
        this.startPeriodicMetrics();

        return TaskEither.of(this);
    }

    /**
	 * Start a timer to periodically emit metrics
	 */
    private startPeriodicMetrics (): void {
        if (this.config.metricsInterval <= 0) {
            return;
        }

        const interval = Math.max(5000, this.config.metricsInterval);

        this.metricsTimer = setInterval(() => this.emitMetrics(), interval);
    }

    /**
	 * Get cached hardware acceleration options
	 * Uses optimisedAccel unless we've fallen back to software
	 * @param width - Video width
	 * @param height - Video height
	 * @param codec - Codec type
	 */
    private getCachedHardwareOptions (width: number, height: number, codec: CodecType): FFMPEGOptions {
        const hwConfigToUse = this.hasFallenBackToSoftware ? null : this.optimisedAccel;
        const key = `${width}x${height}-${codec}-${hwConfigToUse?.method || 'software'}`;

        if (!this.cachedHwOptions.has(key)) {
            const options = this.hwDetector.applyHardwareConfig(
                hwConfigToUse,
                width,
                height,
                codec,
            );

            this.cachedHwOptions.set(key, options);
        }

        return this.cachedHwOptions.get(key)!;
    }

    /**
	 * Build the segments for this stream
	 */
    private buildSegments (): Map<number, Segment> {
        return this.metadata.keyframes.reduce((segments, startTime, index) => {
            const endTime = index < this.metadata.keyframes.length - 1
                ? this.metadata.keyframes[index + 1]
                : this.metadata.duration;

            segments.set(index, {
                index,
                start: startTime,
                duration: endTime - startTime,
            });

            return segments;
        }, new Map<number, Segment>());
    }

    /**
	 * Calculate the closest multiple of x to n
	 */
    private closestMultiple (n: number, x: number): number {
        if (x > n) {
            return x;
        }

        n += x / 2;
        n -= (n % x);

        return n;
    }

    /**
	 * Load the quality of the stream
	 */
    private loadQuality (): [AudioQuality | null, VideoQuality | null] {
        if (this.type === StreamType.AUDIO) {
            return [this.qualityService.parseAudioQuality(this.quality), null] as const;
        } else if (this.type === StreamType.VIDEO) {
            return [null, this.qualityService.parseVideoQuality(this.quality)] as const;
        }

        return [null, null] as const;
    }

    /**
	 * Debounce the dispose method
	 */
    private debounceDispose (): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }

        this.timer = setTimeout(() => this.dispose(), this.config.disposeTimeout);
    }

    /**
	 * Check if hardware acceleration is being used
	 */
    private isUsingHardwareAcceleration (): boolean {
        return Boolean(this.optimisedAccel) && !this.hasFallenBackToSoftware;
    }

    /**
	 * Get the current acceleration method
	 */
    private getCurrentAccelerationMethod (): string {
        if (this.hasFallenBackToSoftware) {
            return 'software';
        }

        return this.optimisedAccel?.method || 'software';
    }
}
