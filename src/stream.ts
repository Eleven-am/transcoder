import * as path from 'path';

import { createBadRequestError, createNotFoundError, Deferred, Either, Result, sortBy, TaskEither } from '@eleven-am/fp';

import ffmpeg, { FfmpegCommand } from './ffmpeg';
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
    StreamConfig,
    StreamMetrics,
    StreamMetricsEvent,
    StreamType,
    SubtitleInfo,
    TranscodeJob,
    TranscodeStatus,
    VideoInfo,
    VideoQuality,
    VideoQualityEnum,
} from './types';
import { ExtendedEventEmitter } from './utils';

interface Segment {
    index: number;
    start: number;
    duration: number;
    value: Deferred<void> | null;
}

interface StreamEventMap {
    'transcode:complete': TranscodeJob;
    'transcode:queued': TranscodeJob;
    'transcode:error': { job: TranscodeJob, error: Error };
    'transcode:start': TranscodeJob;
    'transcode:fallback': { job: TranscodeJob, from: string, to: string };
    'stream:metrics': StreamMetricsEvent;
    'dispose': { id: string };
}

enum JobRangeStatus {
    PROCESSING,
    PROCESSED,
    ERROR,
}

interface JobRange {
    start: number;
    end: number;
    status: JobRangeStatus;
}

type ArgsBuilder = (segments: string) => Either<FFMPEGOptions>;

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

    private readonly videoQuality: VideoQuality | null;

    private readonly audioQuality: AudioQuality | null;

    private readonly segments: Map<number, Segment>;

    private readonly jobRange: JobRange[];

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
    ) {
        super();

        this.config = { ...Stream.DEFAULT_CONFIG,
            ...config };
        const [aQ, vQ] = this.loadQuality();

        this.segments = this.buildSegments();
        this.videoQuality = vQ;
        this.audioQuality = aQ;
        this.jobRange = [];
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
    static getVTTSubtitle (mediaSource: MediaSource, streamIndex: number): NodeJS.ReadableStream {
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
        return ffmpeg(inputPath).outputOptions(outputOptions)
            .pipe();
    }

    /**
     * Create a screenshot from a media source at a specific timestamp
     * @param timestamp - The timestamp of the screenshot to be created
     */
    generateScreenshot (timestamp: number): NodeJS.ReadableStream {
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

        return command.pipe();
    }

    /**
     * Get the file ID
     */
    getFileId (): string {
        return this.metadata.id;
    }

    /**
     * Get stream configuration
     */
    getConfig (): StreamConfig {
        return { ...this.config };
    }

    /**
     * Manually trigger metrics emission
     */
    emitCurrentMetrics (): void {
        this.emitMetrics();
    }

    /**
     * Builds the transcode command for the stream
     * @param segmentIndex - The index of the segment
     * @param priority - The priority of the segment
     */
    buildTranscodeCommand (segmentIndex: number, priority: number): TaskEither<void> {
        this.debounceDispose();

        return TaskEither
            .fromBind({
                distance: TaskEither.of(this.getMinEncoderDistance(segmentIndex)),
                exists: this.source.segmentExist(this.type, this.streamIndex, this.quality, segmentIndex),
                segment: TaskEither.fromNullable(this.segments.get(segmentIndex)),
                isScheduled: TaskEither.of(this.isSegmentScheduled(segmentIndex)),
            })
            .matchTask([
                {
                    predicate: ({ exists }) => exists,
                    run: () => TaskEither.of(undefined),
                },
                {
                    predicate: ({ isScheduled, distance, segment }) => isScheduled &&
                        distance <= this.config.maxEncoderDistance &&
                        segment.value?.state() !== 'rejected',
                    run: ({ segment }) => TaskEither
                        .fromResult(() => segment.value!.promise())
                        .timed(this.config.segmentTimeout, `Timed out waiting for segment ${segment.index}`),
                },
                {
                    predicate: () => this.type === StreamType.AUDIO,
                    run: ({ segment }) => this.buildAudioTranscodeOptions(segment, priority),
                },
                {
                    predicate: () => this.type === StreamType.VIDEO,
                    run: ({ segment }) => this.buildVideoTranscodeOptions(segment, priority),
                },
            ]);
    }

    /**
     * Get the segment stream for a specific segment
     * @param segmentIndex - The index of the segment
     * @param priority - The priority of the segment
     */
    getSegmentStream (segmentIndex: number, priority: number): TaskEither<NodeJS.ReadableStream> {
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
        this.segments.forEach((segment) => {
            if (segment.value?.state() === 'pending') {
                segment.value.reject(new Error('Stream disposed'));
            }
        });

        this.cachedHwOptions.clear();
        this.segmentRetries.clear();


        this.jobRange.forEach((range) => {
            if (range.status === JobRangeStatus.PROCESSING) {
                range.status = JobRangeStatus.ERROR;
            }
        });

        if (this.timer) {
            clearTimeout(this.timer);
        }
        if (this.metricsTimer) {
            clearInterval(this.metricsTimer);
        }

        this.emit('dispose', { id: this.getStreamId() });

        return this.source.deleteTempFiles()
            .map(() => {
                this.segments.clear();
                this.jobRange.length = 0;
                this.timer = null;
                this.metricsTimer = null;
                this.removeAllListeners();
            })
            .toResult();
    }

    /**
     * Generate and emit comprehensive stream metrics
     */
    private emitMetrics (): void {
        this.lastActivityAt = Date.now();

        const segmentStates = this.calculateSegmentStates();

        const avgSegmentDuration = this.metadata.duration / this.segments.size;
        const remainingSegments = segmentStates.unstarted + segmentStates.pending;
        const estimatedTimeRemaining = remainingSegments > 0 && this.metrics.averageProcessingTime > 0
            ? remainingSegments * this.metrics.averageProcessingTime
            : null;

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
            segmentsCompleted: segmentStates.completed,
            segmentsPending: segmentStates.pending,
            segmentsFailed: segmentStates.failed,
            segmentsUnstarted: segmentStates.unstarted,

            currentJobsActive: this.jobRange.filter((range) => range.status === JobRangeStatus.PROCESSING).length,
            averageSegmentDuration: avgSegmentDuration,
            estimatedTimeRemaining,

            streamCreatedAt: this.streamCreatedAt,
            lastActivityAt: this.lastActivityAt,
            metricsGeneratedAt: Date.now(),
        };

        this.emit('stream:metrics', metricsEvent);
    }

    /**
     * Calculate current segment states
     */
    private calculateSegmentStates (): {
        completed: number;
        pending: number;
        failed: number;
        unstarted: number;
    } {
        let completed = 0;
        let pending = 0;
        let failed = 0;
        let unstarted = 0;

        this.segments.forEach((segment) => {
            const state = segment.value?.state();

            if (state === 'fulfilled') {
                completed++;
            } else if (state === 'pending') {
                pending++;
            } else if (state === 'rejected') {
                failed++;
            } else {
                unstarted++;
            }
        });

        return { completed,
            pending,
            failed,
            unstarted };
    }

    /**
     * Initialize the stream
     */
    private initialise (): TaskEither<Stream> {
        return this.checkSegmentsStatus()
            .map(() => {
                this.emitMetrics();
                this.startPeriodicMetrics();

                return this;
            });
    }

    /**
     * 📊 RECOMMENDATION 1: Start periodic metrics emission for dashboards
     */
    private startPeriodicMetrics (): void {
        if (this.config.metricsInterval <= 0) {
            return;
        }

        const interval = Math.max(5000, this.config.metricsInterval);

        this.metricsTimer = setInterval(() => this.emitMetrics(), interval);
    }

    /**
     * Get dynamic batch size based on hardware acceleration
     */
    private getDynamicBatchSize (): number {
        const baseSize = this.maxSegmentBatchSize;

        if (this.isUsingHardwareAcceleration()) {
            return Math.min(baseSize * 2, 200);
        }

        return Math.min(baseSize, 50);
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
            console.log(hwConfigToUse);
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
     * Check if an error is related to hardware acceleration
     * @param err - The error to check
     */
    private isHardwareAccelerationError (err: Error): boolean {
        const message = err.message.toLowerCase();

        return [
            'device creation failed',
            'hardware device setup failed',
            'nvenc',
            'vaapi',
            'qsv',
            'videotoolbox',
            'cuda',
            'hardware acceleration',
        ].some((str) => message.includes(str));
    }

    /**
     * Fallback to software encoding while preserving the original optimized config
     */
    private fallbackToSoftwareEncoding (): void {
        if (this.optimisedAccel && this.config.enableHardwareAccelFallback && !this.hasFallenBackToSoftware) {
            this.hasFallenBackToSoftware = true;
            this.cachedHwOptions.clear();
            this.metrics.fallbacksToSoftware++;
            this.metrics.hardwareAccelUsed = false;
        }
    }

    /**
     * Get the segment for this stream (Audio)
     * @param segment - The segment to process
     * @param priority - The priority of the segment
     */
    private buildAudioTranscodeOptions (segment: Segment, priority: number): TaskEither<void> {
        const argsBuilder: ArgsBuilder = () => {
            if (this.audioQuality?.value === AudioQualityEnum.ORIGINAL) {
                return Either.of({
                    videoFilters: undefined,
                    inputOptions: [],
                    outputOptions: [
                        '-map',
                        `0:a:${this.streamIndex}`,
                        '-c:a',
                        'copy',
                        '-vn',
                    ],
                });
            }

            return Either.of({
                videoFilters: undefined,
                inputOptions: [],
                outputOptions: [
                    '-map',
                    `0:a:${this.streamIndex}`,
                    '-c:a',
                    'aac',
                    '-ac',
                    '2',
                    '-b:a',
                    '128k',
                    '-vn',
                ],
            });
        };

        return this.buildFFMPEGCommand(segment, argsBuilder, priority);
    }

    /**
     * Build the FFMPEG command for video transcoding
     * @param segment - The segment to process
     * @param priority - The priority of the segment
     */
    private buildVideoTranscodeOptions (segment: Segment, priority: number): TaskEither<void> {
        const video = this.metadata.videos[this.streamIndex];
        const videoQuality = this.videoQuality;

        const argsBuilderFactory = (video: VideoInfo, videoQuality: VideoQuality): ArgsBuilder => (segments) => {
            if (videoQuality.value === VideoQualityEnum.ORIGINAL) {
                return Either.of({
                    inputOptions: [],
                    outputOptions: [
                        '-map',
                        `0:v:${this.streamIndex}`,
                        '-c:v',
                        'copy',
                        '-force_key_frames',
                        segments,
                        '-strict',
                        '-2',
                    ],
                    videoFilters: undefined,
                });
            }

            const detailedQuality = this.buildVideoQuality(videoQuality.value);
            const codec: CodecType = video.codec.includes('hevc') || video.codec.includes('h265')
                ? 'h265'
                : 'h264';

            const options = this.getCachedHardwareOptions(
                detailedQuality.width,
                detailedQuality.height,
                codec,
            );

            const outputOptions = [
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
                ...options.outputOptions,
                '-force_key_frames',
                segments,
                '-strict',
                '-2',
            ];

            return Either.of({
                videoFilters: options.videoFilters,
                inputOptions: options.inputOptions,
                outputOptions,
            });
        };

        return TaskEither
            .fromBind({
                video: TaskEither.fromNullable(video),
                quality: TaskEither.fromNullable(videoQuality),
            })
            .map(({ video, quality }) => argsBuilderFactory(video, quality))
            .chain((argsBuilder) => this.buildFFMPEGCommand(segment, argsBuilder, priority));
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
                value: null,
                start: startTime,
                duration: endTime - startTime,
            });

            return segments;
        }, new Map<number, Segment>());
    }

    /**
     * Check the status of the segments
     */
    private checkSegmentsStatus (): TaskEither<void> {
        return TaskEither
            .of(Array.from(this.segments.values()))
            .chainItems((segment) => this.checkSegmentFileStatus(segment))
            .map(() => undefined);
    }

    /**
     * Check if the segment file exists
     * @param segment - The segment to check
     */
    private checkSegmentFileStatus (segment: Segment): TaskEither<void> {
        return this.source.segmentExist(this.type, this.streamIndex, this.quality, segment.index)
            .filter(
                (exists) => exists,
                () => createBadRequestError(`Segment ${segment.index} does not yet exist`),
            )
            .map(() => {
                segment.value = Deferred.create<void>().resolve();
            });
    }

    /**
     * Intelligently filter and prepare segments for processing
     * Only processes segments that actually need work, respects ongoing jobs
     * @param initialSegment - The segment to start processing from
     */
    private filterAndPrepareSegments (initialSegment: Segment): Segment[] {
        const allSegments = sortBy(Array.from(this.segments.values()), 'index', 'asc');
        const startIndex = allSegments.findIndex((s) => s.index === initialSegment.index);

        if (startIndex === -1) {
            return [];
        }

        const segmentsToProcess: Segment[] = [];
        const dynamicBatchSize = this.getDynamicBatchSize();
        const endIndex = Math.min(startIndex + dynamicBatchSize, allSegments.length);

        for (let i = startIndex; i < endIndex; i++) {
            const segment = allSegments[i];
            const state = segment.value?.state();

            if (state === 'pending') {
                break;
            }

            if (state === 'fulfilled') {
                break;
            }

            if (!segment.value || state === 'rejected') {
                if (state === 'rejected') {
                    segment.value!.reset();
                }

                segment.value = Deferred.create();
                segmentsToProcess.push(segment);
            }
        }

        return segmentsToProcess;
    }

    /**
     * Generate FFMPEG transcoding arguments for processing segments
     */
    private getTranscodeArgs (builder: ArgsBuilder, segments: Segment[]): Either<FFMPEGOptions> {
        if (segments.length === 0) {
            return Either.error(createNotFoundError(`No segments to process for stream ${this.type} ${this.streamIndex} ${this.quality}`));
        }

        const startSegment = segments[0];
        const lastSegment = segments[segments.length - 1];

        let startTime = 0;
        let startKeyframeIndex = startSegment.index;
        let keyframeStartTime = 0;

        if (startSegment.index !== 0) {
            startKeyframeIndex = startSegment.index - 1;
            const prevSegment = this.segments.get(startKeyframeIndex);

            if (prevSegment) {
                keyframeStartTime = prevSegment.start;

                if (this.type === StreamType.AUDIO) {
                    startTime = prevSegment.start;
                } else if (startSegment.index === this.segments.size - 1) {
                    startTime = (prevSegment.start + this.metadata.duration) / 2;
                } else {
                    startTime = (prevSegment.start + startSegment.start) / 2;
                }
            }
        }

        const nextSegmentIndex = lastSegment.index + 1;
        const nextSegment = this.segments.get(nextSegmentIndex);
        const endTime = nextSegment ? nextSegment.start : null;

        let timestamps = segments
            .filter((segment) => segment.index > startKeyframeIndex)
            .map((segment) => segment.start);

        if (timestamps.length === 0) {
            timestamps = [9999999];
        }

        const segmentTimestamps = timestamps
            .map((time) => time.toFixed(6))
            .join(',');

        const relativeTimestamps = timestamps
            .map((time) => (time - keyframeStartTime).toFixed(6))
            .join(',');

        const options: FFMPEGOptions = {
            inputOptions: ['-nostats', '-hide_banner', '-loglevel', 'warning'],
            outputOptions: [],
            videoFilters: undefined,
        };

        if (startTime > 0) {
            if (this.type === StreamType.VIDEO) {
                options.inputOptions.push('-noaccurate_seek');
            }

            options.inputOptions.push('-ss', startTime.toFixed(6));
        }

        if (endTime !== null) {
            const adjustedEndTime = endTime + (startTime - keyframeStartTime);

            options.inputOptions.push('-to', adjustedEndTime.toFixed(6));
        }

        options.inputOptions.push('-fflags', '+genpts');

        return builder(segmentTimestamps)
            .map((transcodeArgs) => ({
                inputOptions: [
                    ...options.inputOptions,
                    ...transcodeArgs.inputOptions,
                ],
                outputOptions: [
                    ...options.outputOptions,
                    ...transcodeArgs.outputOptions,
                    '-start_at_zero',
                    '-copyts',
                    '-muxdelay',
                    '0',
                    '-f',
                    'segment',
                    '-segment_time_delta',
                    '0.05',
                    '-segment_format',
                    'mpegts',
                    '-segment_times',
                    relativeTimestamps,
                    '-segment_list_type',
                    'flat',
                    '-segment_list',
                    'pipe:1',
                    '-segment_start_number',
                    startKeyframeIndex.toString(),
                ],
                videoFilters: transcodeArgs.videoFilters,
            }));
    }

    /**
     * Build the FFMPEG command for transcoding
     */
    private buildFFMPEGCommand (initialSegment: Segment, builder: ArgsBuilder, priority: number): TaskEither<void> {
        const segmentsToProcess = this.filterAndPrepareSegments(initialSegment);

        if (segmentsToProcess.length === 0) {
            return TaskEither.fromResult(() => initialSegment.value!.promise());
        }

        return this.getTranscodeArgs(builder, segmentsToProcess)
            .toTaskEither()
            .chain((options) => this.source.getStreamDirectory(this.type, this.streamIndex, this.quality)
                .map((outputDir) => ({
                    options,
                    outputDir,
                })))
            .chain(({ options, outputDir }) => this.executeTranscodeCommand(
                initialSegment,
                segmentsToProcess,
                options,
                outputDir,
                priority,
            ))
            .chain(() => TaskEither.fromResult(() => initialSegment.value!.promise()));
    }

    /**
     * Execute the actual Ffmpeg transcoding command
     */
    private executeTranscodeCommand (
        initialSegment: Segment,
        segments: Segment[],
        options: FFMPEGOptions,
        outputDir: string,
        priority: number,
    ): TaskEither<void> {
        return TaskEither.tryCatch(
            () => this.setupAndRunCommand(initialSegment, segments, options, outputDir, priority),
            'Failed to execute transcode command',
        );
    }

    /**
     * Setup and run the Ffmpeg command with proper event handling
     */
    private setupAndRunCommand (
        initialSegment: Segment,
        segments: Segment[],
        options: FFMPEGOptions,
        outputDir: string,
        priority: number,
    ): Promise<void> {
        console.log(options);

        return new Promise((resolve, reject) => {
            const command = this.createFfmpegCommand(options, outputDir);
            const job = this.createTranscodeJob(initialSegment, priority, command);
            const jobRange = this.createJobRange(initialSegment, segments);

            this.setupCommandEventHandlers(command, job, jobRange, segments, resolve, reject);

            this.emit('transcode:queued', job);
            this.jobRange.push(jobRange);
            this.metrics.totalJobsStarted++;
        });
    }

    /**
     * Create the Ffmpeg command with options
     */
    private createFfmpegCommand (options: FFMPEGOptions, outputDir: string): FfmpegCommand {
        const { inputOptions, outputOptions, videoFilters } = options;

        const command = ffmpeg(this.source.getFilePath())
            .inputOptions(inputOptions)
            .outputOptions(outputOptions)
            .on('start', console.log)
            .output(path.join(outputDir, 'segment-%d.ts'));

        if (videoFilters) {
            command.videoFilters(videoFilters);
        }

        return command;
    }

    /**
     * Create a transcode job
     */
    private createTranscodeJob (initialSegment: Segment, priority: number, command: FfmpegCommand): TranscodeJob {
        return {
            id: `job-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
            priority,
            process: command,
            createdAt: Date.now(),
            start: initialSegment.start,
            status: TranscodeStatus.QUEUED,
        };
    }

    /**
     * Create a job range
     */
    private createJobRange (initialSegment: Segment, segments: Segment[]): JobRange {
        return {
            start: initialSegment.start,
            status: JobRangeStatus.PROCESSING,
            end: segments[segments.length - 1].duration,
        };
    }

    /**
     * Set up comprehensive event handlers for the Ffmpeg command
     * @param command - The Ffmpeg command
     * @param job - The transcode job
     * @param jobRange - The job range
     * @param segments - The segments being processed
     * @param resolve - Resolve function
     * @param reject - Reject function
     */
    private setupCommandEventHandlers (
        command: FfmpegCommand,
        job: TranscodeJob,
        jobRange: JobRange,
        segments: Segment[],
        resolve: () => void,
        reject: (error: Error) => void,
    ): void {
        let lastIndex = segments[0].index;
        const startTime = Date.now();

        const disposeHandler = () => {
            command.kill('SIGINT');
            this.off('dispose', disposeHandler);
            reject(new Error('Stream disposed during transcoding'));
        };

        command.on('start', () => {
            job.status = TranscodeStatus.PROCESSING;
            this.emit('transcode:start', job);
            this.emitMetrics();
        });

        command.on('progress', (progress) => {
            lastIndex = progress.segment;
            this.handleSegmentProgress(progress.segment, segments);
            // Note: Could emit metrics here but might be too frequent
            // this.emitMetrics(); Uncomment for real-time segment updates
        });

        command.on('end', () => {
            const processingTime = Date.now() - startTime;

            this.updateMetricsOnSuccess(segments.length, processingTime);

            job.status = TranscodeStatus.PROCESSED;
            jobRange.status = JobRangeStatus.PROCESSED;
            this.emit('transcode:complete', job);
            this.emitMetrics();
            this.off('dispose', disposeHandler);
            resolve();
        });

        command.on('error', (err: Error) => {
            console.log(`Transcode error: ${err.message}`);
            this.handleTranscodeError(err, job, jobRange, segments, lastIndex, disposeHandler);

            if (this.shouldRetryWithFallback(err, segments[0].index)) {
                this.retryWithFallback(segments[0], job, resolve, reject);
            } else {
                this.emitMetrics();
                reject(err);
            }
        });

        this.on('dispose', disposeHandler);
    }

    /**
     * Handle segment progress updates
     * @param segmentIndex - The index of the segment
     * @param segments - The segments being processed
     */
    private handleSegmentProgress (segmentIndex: number, segments: Segment[]): void {
        const segment = this.segments.get(segmentIndex);
        const nextSegment = this.segments.get(segmentIndex + 1);

        if (nextSegment && nextSegment.value?.state() === 'fulfilled') {
            // Optionally kill command early for efficiency
            // command.kill('SIGINT');
        }

        if (segment) {
            segment.value = segment.value?.resolve() ?? Deferred.create<void>().resolve();
            this.metrics.segmentsProcessed++;
        }
    }

    /**
     * Handle transcoding errors with potential hardware acceleration fallback
     * @param err - The error that occurred
     * @param job - The job that was processing
     * @param jobRange - The job range that was processing
     * @param segments - The segments that were being processed
     * @param lastIndex - The last index processed
     * @param disposeHandler - The dispose handler to call
     */
    private handleTranscodeError (
        err: Error,
        job: TranscodeJob,
        jobRange: JobRange,
        segments: Segment[],
        lastIndex: number,
        disposeHandler: () => void,
    ): void {
        try {
            const unprocessedSegments = segments.filter((segment) => segment.index > lastIndex && segment.value?.state() === 'pending');

            let rejectedCount = 0;

            for (const segment of unprocessedSegments) {
                try {
                    if (segment.value && segment.value.state() === 'pending') {
                        // segment.value.reject(new Error(err.message));
                        rejectedCount++;
                    }
                } catch (segmentError) {
                    console.warn(`Failed to reject segment ${segment.index}:`, segmentError);
                }
            }

            this.metrics.segmentsFailed += rejectedCount;

            job.status = TranscodeStatus.ERROR;
            jobRange.status = JobRangeStatus.ERROR;

            this.emit('transcode:error', {
                job,
                error: err,
            });

            this.off('dispose', disposeHandler);
        } catch (handlingError) {
            console.error('Error in handleTranscodeError:', handlingError);
            job.status = TranscodeStatus.ERROR;
            jobRange.status = JobRangeStatus.ERROR;
        }
    }

    /**
     * Check if we should retry with fallback
     * @param err - The error to check
     * @param segmentIndex - The index of the segment
     */
    private shouldRetryWithFallback (err: Error, segmentIndex: number): boolean {
        if (!this.config.enableHardwareAccelFallback || !this.optimisedAccel || this.hasFallenBackToSoftware) {
            return false;
        }

        if (!this.isHardwareAccelerationError(err)) {
            return false;
        }

        const retryCount = this.segmentRetries.get(segmentIndex) || 0;

        return retryCount < this.config.maxRetries;
    }

    /**
     * Retry transcoding with software fallback
     * @param segment - The segment to retry
     * @param originalJob - The original job
     * @param resolve - Resolve function
     * @param reject - Reject function
     */
    private retryWithFallback (
        segment: Segment,
        originalJob: TranscodeJob,
        resolve: () => void,
        reject: (error: Error) => void,
    ): void {
        const previousMethod = this.optimisedAccel?.method || 'unknown';

        this.fallbackToSoftwareEncoding();

        const retryCount = (this.segmentRetries.get(segment.index) || 0) + 1;

        this.segmentRetries.set(segment.index, retryCount);

        this.emit('transcode:fallback', {
            job: originalJob,
            from: previousMethod,
            to: 'software',
        });

        this.emitMetrics();

        const retryAction = this.type === StreamType.AUDIO
            ? this.buildAudioTranscodeOptions(segment, originalJob.priority)
            : this.buildVideoTranscodeOptions(segment, originalJob.priority);

        return void retryAction
            .ioSync(() => resolve())
            .ioErrorSync(({ error }) => reject(error))
            .toResult();
    }

    /**
     * Update metrics on successful completion
     * @param segmentCount - Number of segments processed
     * @param processingTime - Time taken to process segments
     */
    private updateMetricsOnSuccess (segmentCount: number, processingTime: number): void {
        this.metrics.totalJobsCompleted++;

        const totalJobs = this.metrics.totalJobsCompleted;

        this.metrics.averageProcessingTime =
            (this.metrics.averageProcessingTime * (totalJobs - 1) + processingTime) / totalJobs;
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
     * Calculate distance from current encoders to a segment
     * @param segmentIndex - The index of the segment
     */
    private getMinEncoderDistance (segmentIndex: number): number {
        const segment = this.segments.get(segmentIndex);

        if (!segment) {
            return Infinity;
        }

        const targetTime = segment.start;

        const distances = this.jobRange
            .filter((range) => range.status === JobRangeStatus.PROCESSING &&
                range.start <= targetTime &&
                targetTime <= range.start + range.end)
            .map((range) => targetTime - range.start);

        if (distances.length === 0) {
            return Infinity;
        }

        return Math.min(...distances);
    }

    /**
     * Check if a segment is already scheduled for processing
     * @param segmentIndex - The index of the segment
     */
    private isSegmentScheduled (segmentIndex: number): boolean {
        const segment = this.segments.get(segmentIndex);

        if (!segment) {
            return false;
        }

        return this.jobRange.some((range) => range.status === JobRangeStatus.PROCESSING &&
            segment.start >= range.start &&
            segment.start <= (range.start + range.end));
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
