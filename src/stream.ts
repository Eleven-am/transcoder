import path from 'path';

import { createBadRequestError, createInternalError, Either, Result, sortBy, TaskEither } from '@eleven-am/fp';

import { defer, Deferred } from './deferred';
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

type ArgsBuilder = (segments: string) => FFMPEGOptions;

interface DetailedVideoQuality extends VideoQuality {
    width: number;
    height: number;
}

export class Stream extends ExtendedEventEmitter<StreamEventMap> {
    private static readonly DISPOSE_TIMEOUT = 30 * 60 * 1000;

    private readonly videoQuality: VideoQuality | null;

    private readonly audioQuality: AudioQuality | null;

    private readonly segments: Map<number, Segment>;

    private readonly jobRange: JobRange[];

    private timer: NodeJS.Timeout | null;

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
    ) {
        super();

        const [aQ, vQ] = this.loadQuality();

        this.segments = this.buildSegments();
        this.videoQuality = vQ;
        this.audioQuality = aQ;
        this.jobRange = [];
        this.timer = null;
    }

    /**
     * Create a new stream
     * @param quality The quality of the stream
     * @param type The type of the stream
     * @param streamIndex The index of the stream
     * @param source The source of the stream
     * @param maxSegmentBatchSize The maximum number of segments to process at once
     * @param qualityService The quality service
     * @param metadataService The metadata service
     * @param hwDetector The hardware acceleration detector
     * @param hwAccel The hardware acceleration configuration
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
            ))
            .chain((stream) => stream.initialise());
    }

    /**
     * Get the stream ID
     * @param fileId The file ID
     * @param type The type of the stream
     * @param quality The quality of the stream
     * @param streamIndex The index of the stream
     */
    static getStreamId (fileId: string, type: StreamType, quality: string, streamIndex: number): string {
        return `${fileId}:${type}:${streamIndex}:${quality}`;
    }

    /**
     * Extract subtitle from a media source and convert to WebVTT
     * @param mediaSource Media source containing the subtitle
     * @param streamIndex The subtitle stream index to extract
     * @returns TaskEither containing the VTT content as string
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
     * @param metadata Media metadata containing subtitle streams
     * @returns Array of subtitle streams that can be converted to VTT
     */
    static getConvertibleSubtitles (metadata: MediaMetadata): SubtitleInfo[] {
        return metadata.subtitles.filter((stream) => this.canConvertToVtt(stream));
    }

    /**
     * Check if a subtitle stream can be converted to VTT
     * @param subtitleStream The subtitle stream to check
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
     *
     * @param outputOptions
     * @param inputPath
     * @private
     */
    private static runFFMPEGCommand (outputOptions: string[], inputPath: string) {
        return ffmpeg(inputPath).outputOptions(outputOptions)
            .pipe();
    }

    /**
     * Create a screenshot from a media source at a specific timestamp
     * @param timestamp The timestamp to take the screenshot at
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
     * Builds the transcode command for the stream
     * @param segmentIndex The segment index to build the command for
     * @param priority The priority of the task
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
                    predicate: ({ isScheduled, distance, segment }) => isScheduled && distance <= 60 &&
                        segment.value?.state() !== 'rejected',
                    run: ({ segment }) => TaskEither
                        .tryTimed(
                            () => segment.value!.promise(),
                            60_000,
                        )
                        .mapError(() => createInternalError(`Timed out waiting for segment ${segment.index}`)),
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
     * @param segmentIndex The index of the segment to get
     * @param priority The priority of the task
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
     * @param quality The quality to build
     * @param index The index of the video stream
     */
    buildVideoQuality (quality: VideoQualityEnum, index?: number): DetailedVideoQuality {
        const videoInfo = this.metadata.videos[index ?? this.streamIndex];
        const profile = this.qualityService.buildValidVideoQuality(quality, videoInfo);

        const height = profile.height;
        let width = Math.round((height / videoInfo.height) * videoInfo.width);

        width = this.closestMultiple(width, 2);

        return {
            ...profile,
            width,
            height,
        };
    }

    /**
     * Builds the audio quality for the stream
     * @param quality The quality to build
     * @param index The index of the audio stream
     */
    buildAudioQuality (quality: AudioQualityEnum, index?: number): AudioQuality {
        const audioInfo = this.metadata.audios[index ?? this.streamIndex];


        return this.qualityService.buildValidAudioQuality(quality, audioInfo);
    }

    /**
     * Dispose of the stream
     * @private
     */
    dispose (): Promise<Result<void>> {
        this.emit('dispose', { id: this.getStreamId() });

        return this.source.deleteTempFiles()
            .map(() => {
                this.segments.clear();
                this.timer = null;
            })
            .toResult();
    }

    /**
     * Initialize the stream
     */
    private initialise (): TaskEither<Stream> {
        return this.checkSegmentsStatus().map(() => this);
    }

    /**
     * Get the segment for this stream
     * @param segment The segment to get
     * @param priority The priority of the task
     * @private
     */
    private buildAudioTranscodeOptions (segment: Segment, priority: number): TaskEither<void> {
        const argsBuilder: ArgsBuilder = () => {
            if (this.audioQuality?.value === AudioQualityEnum.ORIGINAL) {
                return {
                    videoFilters: undefined,
                    inputOptions: [],
                    outputOptions: [
                        '-map',
                        `0:a:${this.streamIndex}`,
                        '-c:a',
                        'copy',
                        '-vn',
                    ],
                };
            }

            return {
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
            };
        };

        return this.buildFFMPEGCommand(segment, argsBuilder, priority);
    }

    /**
     * Build the FFMPEG command for video transcoding
     * @param segment The segment to start processing from
     * @param priority The priority of the task
     * @private
     */
    private buildVideoTranscodeOptions (segment: Segment, priority: number): TaskEither<void> {
        const video = this.metadata.videos[this.streamIndex];
        const videoQuality = this.videoQuality;

        const argsBuilderFactory = (video: VideoInfo, videoQuality: VideoQuality): ArgsBuilder => (segments) => {
            if (videoQuality.value === VideoQualityEnum.ORIGINAL) {
                return {
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
                };
            }

            const detailedQuality = this.buildVideoQuality(videoQuality.value);
            const codec: CodecType = video.codec.includes('hevc') || video.codec.includes('h265')
                ? 'h265'
                : 'h264';

            const options = this.hwDetector.applyHardwareConfig(
                this.optimisedAccel,
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

            return {
                videoFilters: options.videoFilters,
                inputOptions: options.inputOptions,
                outputOptions,
            };
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
     * @private
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
     * @private
     */
    private checkSegmentsStatus (): TaskEither<void> {
        return TaskEither
            .of(Array.from(this.segments.values()))
            .chainItems((segment) => this.checkSegmentFileStatus(segment))
            .map(() => undefined);
    }

    /**
     * Check if the segment file exists
     * @param segment The segment to check
     * @private
     */
    private checkSegmentFileStatus (segment: Segment): TaskEither<void> {
        return this.source.segmentExist(this.type, this.streamIndex, this.quality, segment.index)
            .filter(
                (exists) => exists,
                () => createBadRequestError(`Segment ${segment.index} does not yet exist`),
            )
            .map(() => {
                segment.value = defer<void>().resolve();
            });
    }

    /**
     * Get the segments to process
     * @param segment The segment to start processing from
     * @private
     */
    private getSegments (segment: Segment): Segment[] {
        const segments = sortBy(Array.from(this.segments.values()), 'index', 'asc');
        const startIndex = segments.findIndex((s) => segment.index === s.index);

        if (startIndex === -1) {
            return [];
        }

        let endIndex = Math.min(startIndex + this.maxSegmentBatchSize, segments.length);

        for (let i = startIndex; i < endIndex; i++) {
            const currentSegment = segments[i];

            if (currentSegment.value?.state() === 'pending' ||
                currentSegment.value?.state() === 'fulfilled') {
                endIndex = i;
                break;
            }

            if (currentSegment.value?.state() === 'rejected') {
                currentSegment.value.reset();
            }
        }

        return segments.slice(startIndex, endIndex);
    }

    /**
     * Generate FFMPEG transcoding arguments for processing segments
     * @param builder Function to build codec-specific options
     * @param segments The segments to process
     */
    private getTranscodeArgs (builder: ArgsBuilder, segments: Segment[]): FFMPEGOptions {
        if (segments.length === 0) {
            throw new Error(`No segments to process for stream ${this.type} ${this.streamIndex} ${this.quality}`);
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

        const transcodeArgs = builder(segmentTimestamps);

        options.outputOptions.push(
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
        );

        return {
            inputOptions: [
                ...options.inputOptions,
                ...transcodeArgs.inputOptions,
            ],
            outputOptions: [
                ...options.outputOptions,
                ...transcodeArgs.outputOptions,
            ],
            videoFilters: transcodeArgs.videoFilters,
        };
    }

    /**
     * Build the FFMPEG command for transcoding
     * @param initialSegment The segment to start processing from
     * @param builder Function to build codec-specific options
     * @param priority The priority of the task
     */
    private buildFFMPEGCommand (initialSegment: Segment, builder: ArgsBuilder, priority: number): TaskEither<void> {
        let lastIndex = initialSegment.index;
        const segments = this.getSegments(initialSegment);
        const task = Either.tryCatch(() => this.getTranscodeArgs(builder, segments))
            .toTaskEither();

        const buildCommand = (outputDir: string, options: FFMPEGOptions) => {
            const { inputOptions, outputOptions, videoFilters } = options;

            segments.forEach((segment) => segment.value = defer<void>());
            const command = ffmpeg(this.source.getFilePath())
                .inputOptions(inputOptions)
                .outputOptions(outputOptions);

            const jobRange: JobRange = {
                start: initialSegment.start,
                status: JobRangeStatus.PROCESSING,
                end: segments[segments.length - 1].duration,
            };

            const job: TranscodeJob = {
                id: `job-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
                priority,
                process: command,
                createdAt: Date.now(),
                start: initialSegment.start,
                status: TranscodeStatus.QUEUED,
            };

            const disposeHandler = () => {
                command.kill('SIGINT');
                this.off('dispose', disposeHandler);
            };

            if (videoFilters) {
                command.videoFilters(videoFilters);
            }

            command.output(path.join(outputDir, 'segment-%d.ts'));

            command.on('start', () => {
                job.status = TranscodeStatus.PROCESSING;
                this.emit('transcode:start', job);
            });

            command.on('progress', (progress) => {
                const segmentIndex = progress.segment;

                lastIndex = segmentIndex;
                const segment = this.segments.get(segmentIndex);
                const nextSegment = this.segments.get(segmentIndex + 1);

                if (nextSegment && nextSegment.value?.state() === 'fulfilled') {
                    // command.kill('SIGINT');
                }

                if (segment) {
                    // eslint-disable-next-line no-unused-expressions,@typescript-eslint/no-unused-expressions
                    segment.value ? segment.value.resolve() : segment.value = defer<void>().resolve();
                }
            });

            command.on('end', () => {
                job.status = TranscodeStatus.PROCESSED;
                jobRange.status = JobRangeStatus.PROCESSED;
                this.emit('transcode:complete', job);
                this.off('dispose', disposeHandler);
            });

            command.on('error', (err) => {
                const unprocessedSegments = segments.filter((segment) => segment.index > lastIndex && segment.value!.state() === 'pending');

                unprocessedSegments.forEach((segment) => segment.value!.reject(err));

                job.status = TranscodeStatus.ERROR;
                jobRange.status = JobRangeStatus.ERROR;
                this.emit('transcode:error', {
                    job,
                    error: err,
                });
                this.off('dispose', disposeHandler);
            });

            this.on('dispose', disposeHandler);
            this.emit('transcode:queued', job);
            this.jobRange.push(jobRange);
        };

        return TaskEither
            .fromBind({
                outputDir: this.source.getStreamDirectory(this.type, this.streamIndex, this.quality),
                options: task,
            })
            .map(({ outputDir, options }) => buildCommand(outputDir, options))
            .orElse(() => TaskEither.of(undefined))
            .fromPromise(() => initialSegment.value!.promise());
    }

    /**
     * calculate the closest multiple of x to n
     * @param n
     * @param x
     * @private
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
     * @private
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
     * @private
     */
    private debounceDispose (): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }

        this.timer = setTimeout(() => {
            this.dispose();
        }, Stream.DISPOSE_TIMEOUT);
    }

    /**
     * Calculate distance from current encoders to a segment
     * @param segmentIndex The segment to calculate distance to
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
     * @param segmentIndex The segment index to check
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
}
