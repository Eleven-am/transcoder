import { createBadRequestError, TaskEither } from '@eleven-am/fp';

import { ClientTracker } from './clientTracker';
import { createBackendConfig, EventBus, LockManager, StateStore } from './distributed';
import { FileDatabase } from './fileDatabase';
import { FileStorage } from './fileStorage';
import { HardwareAccelerationDetector } from './hardwareAccelerationDetector';
import { MediaSource } from './mediaSource';
import { MetadataService } from './metadataService';
import { QualityService } from './qualityService';
import { Stream } from './stream';
import {
    AudioQualityEnum,
    ClientSession,
    HardwareAccelerationConfig,
    HLSManagerOptions,
    SegmentStream,
    StreamConfig,
    StreamMetricsEventHandler,
    StreamType,
    SubtitleInfo,
    TranscodeType,
    VideoQualityEnum,
} from './types';
import { streamToString } from './utils';

export class HLSController {
    readonly streamConfig: Partial<StreamConfig>;

    #hwConfig: HardwareAccelerationConfig | null = null;

    #streamMetricsEventHandler: StreamMetricsEventHandler | null = null;

    readonly #hwDetector: HardwareAccelerationDetector;

    readonly #metadataService: MetadataService;

    readonly #qualityService: QualityService;

    readonly #streams: Map<string, Stream>;

    readonly #clientTracker: ClientTracker;

    readonly #maxSegmentBatchSize: number;

    readonly #fileStorage: FileStorage;

    readonly #hwAccelEnabled: boolean;

    readonly #stateStore: StateStore;

    readonly #lockManager: LockManager;

    readonly #eventBus: EventBus;

    readonly #nodeId: string;

    private distributedSyncInterval: NodeJS.Timeout | null = null;

    constructor (options: HLSManagerOptions) {
        this.#nodeId = `controller-${process.pid}-${Date.now()}`;
        this.#streams = new Map<string, Stream>();

        this.#hwAccelEnabled = options.hwAccel || false;
        this.#maxSegmentBatchSize = options.maxSegmentBatchSize || 100;
        this.streamConfig = options.config || {};

        // Create distributed backend (falls back to in-memory if not provided)
        const backend = createBackendConfig(options.distributed);

        this.#stateStore = backend.stateStore;
        this.#lockManager = backend.lockManager;
        this.#eventBus = backend.eventBus;

        this.#hwDetector = new HardwareAccelerationDetector();
        this.#fileStorage = new FileStorage(options.cacheDirectory);
        const database = options.database || new FileDatabase(this.#fileStorage);

        this.#qualityService = new QualityService(options.videoQualities, options.audioQualities);
        this.#metadataService = new MetadataService(
            this.#qualityService,
            database,
            options.distributed?.lockManager,
        );

        this.#clientTracker = new ClientTracker(
            this.#qualityService,
            options.inactivityCheckFrequency,
            options.unusedStreamDebounceDelay,
            options.inactivityThreshold,
            options.maxConcurrentJobs,
            options.distributed?.stateStore,
            options.distributed?.jobQueue,
            options.distributed?.eventBus,
        );
    }

    /**
     * Initialize the HLS manager
     * This will initialize the transcodeService and detect hardware acceleration
     */
    initialize (): Promise<void> {
        this.#hookUpClientTracker();
        this.#initializeDistributedSync();

        return this.#hwDetector.detectHardwareAcceleration()
            .filter(
                () => this.#hwAccelEnabled,
                () => createBadRequestError('Hardware acceleration is not supported on this system'),
            )
            .map((hwConfig) => {
                this.#hwConfig = hwConfig;
            })
            .toPromise();
    }

    /**
     * Get the master playlist for a media source
     * @param filePath The file path of the media source
     * @param clientId The client ID of the user requesting the stream
     */
    getMasterPlaylist (filePath: string, clientId: string): Promise<string> {
        const source = this.#buildMediaSource(filePath);

        return this.#metadataService.getMasterPlaylist(source)
            .ioSync((masterPlaylist) => {
                void this.#prepareSegments(filePath, clientId, StreamType.VIDEO, masterPlaylist.video.quality, masterPlaylist.video.index, 0);
                void this.#prepareSegments(filePath, clientId, StreamType.AUDIO, masterPlaylist.audio.quality, masterPlaylist.audio.index, 0);
            })
            .map(({ master }) => master)
            .toPromise();
    }

    /**
     * Get the playlist for a media source with the given stream type and quality
     * @param filePath The file path of the media source
     * @param clientId The client ID of the user requesting the stream
     * @param type The stream type
     * @param quality The stream quality
     * @param streamIndex The stream index
     */
    getIndexPlaylist (filePath: string, clientId: string, type: StreamType, quality: string, streamIndex: number): Promise<string> {
        return this.#getStreamAndPriority(filePath, clientId, type, quality, streamIndex, 0)
            .ioSync(({ stream }) => this.#clientTracker.registerClientActivity({
                clientId,
                filePath,
                segment: 0,
                audioIndex: type === StreamType.AUDIO ? streamIndex : undefined,
                videoIndex: type === StreamType.VIDEO ? streamIndex : undefined,
                videoQuality: type === StreamType.VIDEO ? quality : undefined,
                audioQuality: type === StreamType.AUDIO ? quality : undefined,
                fileId: stream.getFileId(),
            }))
            .ioSync(() => void this.#prepareSegments(filePath, clientId, type, quality, streamIndex, 0))
            .map(({ stream }) => stream.getPlaylist())
            .toPromise();
    }

    /**
     * Get the segment stream for a media source with the given stream type and quality
     * @param filePath The file path of the media source
     * @param clientId The client ID of the user requesting the stream
     * @param type The stream type
     * @param quality The stream quality
     * @param streamIndex The stream index
     * @param segmentNumber The segment number to get
     */
    getSegmentStream (filePath: string, clientId: string, type: StreamType, quality: string, streamIndex: number, segmentNumber: number): Promise<SegmentStream> {
        return this.#getStreamAndPriority(filePath, clientId, type, quality, streamIndex, segmentNumber)
            .ioSync(({ stream }) => this.#clientTracker.registerClientActivity({
                clientId,
                filePath,
                segment: segmentNumber,
                audioIndex: type === StreamType.AUDIO ? streamIndex : undefined,
                videoIndex: type === StreamType.VIDEO ? streamIndex : undefined,
                videoQuality: type === StreamType.VIDEO ? quality : undefined,
                audioQuality: type === StreamType.AUDIO ? quality : undefined,
                fileId: stream.getFileId(),
            }))
            .chain(({ stream, priority }) => stream.getSegmentStream(segmentNumber, priority))
            .toPromise();
    }

    /**
     * Extract subtitle from a media source and convert to WebVTT
     * @param filePath The file path of the media source
     * @param streamIndex The subtitle stream index to extract
     * @returns TaskEither containing the VTT content as string
     */
    getVTTSubtitle (filePath: string, streamIndex: number): Promise<string> {
        return TaskEither
            .tryCatch(() => this.getVTTSubtitleStream(filePath, streamIndex))
            .chain(streamToString)
            .toPromise();
    }

    /**
     * Extract subtitle from a media source and convert to WebVTT
     * @param filePath The file path of the media source
     * @param streamIndex The subtitle stream index to extract
     * @returns TaskEither containing the VTT content as stream
     */
    getVTTSubtitleStream (filePath: string, streamIndex: number): Promise<NodeJS.ReadableStream> {
        const mediaSource = this.#buildMediaSource(filePath);

        return Stream.getVTTSubtitle(mediaSource, streamIndex);
    }

    /**
     * Create a screenshot from a media source at a specific timestamp
     * @param filePath The file path of the media source
     * @param quality The quality of the screenshot
     * @param streamIndex The stream index to take the screenshot from
     * @param time The time to take the screenshot at
     */
    generateScreenshot (filePath: string, quality: string, streamIndex: number, time: number): Promise<NodeJS.ReadableStream> {
        return this.#getOrCreateStream(filePath, StreamType.VIDEO, quality, streamIndex)
            .fromPromise((stream) => stream.generateScreenshot(time))
            .toPromise();
    }

    /**
     * Get all convertible subtitle streams from media metadata
     * @param filePath The file path of the media source
     */
    getConvertibleSubtitles (filePath: string): Promise<SubtitleInfo[]> {
        const mediaSource = this.#buildMediaSource(filePath);

        return this.#metadataService.getMetadata(mediaSource)
            .map((metadata) => Stream.getConvertibleSubtitles(metadata))
            .toPromise();
    }

    /**
     * Sets up a listener for when the client session changes
     * @param callback The callback to call when the session changes
     */
    onSessionChange (callback: (session: ClientSession) => void): void {
        this.#clientTracker.on('session:updated', (data) => {
            try {
                const streamId = Stream.getStreamId(data.fileId, StreamType.VIDEO, data.videoQuality, data.videoIndex);
                const stream = this.#streams.get(streamId);

                if (!stream) {
                    return;
                }

                const videoQuality = stream.buildVideoQuality(data.videoQuality, data.videoIndex);
                const audioQuality = stream.buildAudioQuality(data.audioQuality, data.audioIndex);

                const transcodeNumber = (videoQuality.value !== VideoQualityEnum.ORIGINAL ? 0 : 1) +
                    (audioQuality.value !== AudioQualityEnum.ORIGINAL ? 0 : 1);

                const status = transcodeNumber === 2
                    ? TranscodeType.DIRECT_PLAY :
                    transcodeNumber === 1
                        ? TranscodeType.DIRECT_STREAM :
                        TranscodeType.TRANSCODING;

                const session: ClientSession = {
                    status,
                    filePath: data.filePath,
                    clientId: data.clientId,
                    audioIndex: data.audioIndex,
                    videoIndex: data.videoIndex,
                    audioProfile: audioQuality,
                    videoProfile: videoQuality,
                };

                return callback(session);
            } catch (error) {
                // no-op
            }
        });
    }

    /**
     * Sets up a listener for when the stream metrics change
     * @param callback The callback to call when the metrics change
     */
    onStreamMetrics (callback: StreamMetricsEventHandler): void {
        this.#streamMetricsEventHandler = callback;
    }

    /**
     * Create metadata for a media source
     * @param filePath The file path of the media source
     */
    createMetadata (filePath: string): Promise<void> {
        const source = this.#buildMediaSource(filePath);

        return this.#metadataService.createMetadata(source).toPromise();
    }

    /**
     * Dispose of the controller and clean up resources
     */
    dispose (): void {
        if (this.distributedSyncInterval) {
            clearInterval(this.distributedSyncInterval);
            this.distributedSyncInterval = null;
        }

        // Dispose all streams
        for (const stream of this.#streams.values()) {
            void stream.dispose();
        }
        this.#streams.clear();

        // Dispose client tracker
        this.#clientTracker.dispose();

        // Clean up distributed state
        void this.#cleanupDistributedState();
    }

    /**
     * Initialize distributed synchronization
     * @private
     */
    #initializeDistributedSync (): void {
        void this.#subscribeToDistributedEvents();

        this.distributedSyncInterval = setInterval(() => {
            void this.#syncWithDistributedStreams();
        }, 30_000);

        void this.#syncWithDistributedStreams();
    }

    /**
     * Subscribe to distributed events
     * @private
     */
    async #subscribeToDistributedEvents (): Promise<void> {
        await this.#eventBus.subscribe('stream:created', (event) => {
            if (event.nodeId !== this.#nodeId) {
                void this.#cacheRemoteStreamInfo(event);
            }
        });

        await this.#eventBus.subscribe('stream:disposed', (event) => {
            if (event.nodeId !== this.#nodeId) {
                this.#streams.delete(event.streamId);
            }
        });

        // Subscribe to metrics events if handler is set
        await this.#eventBus.subscribe('stream:metrics', (event) => {
            if (this.#streamMetricsEventHandler) {
                this.#streamMetricsEventHandler(event);
            }
        });
    }

    /**
     * Cache information about remote streams
     * @private
     */
    #cacheRemoteStreamInfo (event: any): TaskEither<void> {
        const streamKey = `stream:info:${event.streamId}`;

        return TaskEither
            .tryCatch(
                () => this.#stateStore.set(streamKey, {
                    streamId: event.streamId,
                    nodeId: event.nodeId,
                    type: event.type,
                    quality: event.quality,
                    streamIndex: event.streamIndex,
                    fileId: event.fileId,
                    createdAt: event.createdAt,
                }, 300_000),
                'Failed to cache stream info',
            )
            .map(() => undefined);
    }

    /**
     * Sync with distributed stream information
     * @private
     */
    #syncWithDistributedStreams (): TaskEither<void> {
        return TaskEither
            .tryCatch(
                () => this.#stateStore.keys('stream:info:*'),
                'Failed to get stream keys',
            )
            .chain((keys) => TaskEither
                .tryCatch(
                    () => this.#stateStore.getMany<any>(keys),
                    'Failed to get stream info',
                ))
            .map((streamsMap) => {
                // Update local knowledge of distributed streams
                for (const [key, streamInfo] of streamsMap.entries()) {
                    if (streamInfo && streamInfo.nodeId !== this.#nodeId) {
                        // Track that this stream exists on another node
                        // This helps with load balancing decisions
                    }
                }
            });
    }

    /**
     * Cleanup distributed state on disposal
     * @private
     */
    async #cleanupDistributedState (): Promise<void> {
        try {
            // Clean up any stream info created by this node
            const streamKeys = await this.#stateStore.keys('stream:info:*');

            for (const key of streamKeys) {
                const streamInfo = await this.#stateStore.get<any>(key);

                if (streamInfo && streamInfo.nodeId === this.#nodeId) {
                    await this.#stateStore.delete(key);
                }
            }
        } catch (error) {
            console.error('Failed to cleanup distributed state:', error);
        }
    }

    /**
     * Set up client tracker event listeners
     * @private
     */
    #hookUpClientTracker (): void {
        this.#clientTracker.on('system:overloaded', ({ load }) => {
            console.warn(`System overloaded (${load}%). Throttling transcoding operations.`);
        });

        this.#clientTracker.on('system:stable', ({ load }) => {
            console.info(`System load stabilized (${load}%).`);
        });

        this.#clientTracker.on('stream:abandoned', async ({ streamId }) => {
            const stream = this.#streams.get(streamId);

            if (stream) {
                await stream.dispose();
            }
        });
    }

    /**
     * Hook up the stream to the transcode service
     * @param stream The stream to hook up
     * @private
     */
    #hookUpStream (stream: Stream): void {
        stream.on('transcode:queued', (job) => {
            this.#clientTracker.handleTranscodeJob(job);
        });

        stream.on('dispose', ({ id }) => {
            this.#streams.delete(id);

            // Publish stream disposal to distributed system
            void this.#eventBus.publish('stream:disposed', {
                nodeId: this.#nodeId,
                streamId: id,
                timestamp: Date.now(),
            });
        });

        stream.on('stream:metrics', (event) => {
            if (this.#streamMetricsEventHandler) {
                this.#streamMetricsEventHandler(event);
            }
        });
    }

    /**
     * Get or create a stream
     * @param filePath The file path of the media source
     * @param type The stream type
     * @param quality The stream quality
     * @param streamIndex The stream index
     * @private
     */
    #getOrCreateStream (filePath: string, type: StreamType, quality: string, streamIndex: number): TaskEither<Stream> {
        const source = this.#buildMediaSource(filePath);

        const createStream = () => Stream
            .create(
                quality,
                type,
                streamIndex,
                source,
                this.#maxSegmentBatchSize,
                this.#qualityService,
                this.#metadataService,
                this.#hwDetector,
                this.#hwConfig,
                this.streamConfig,
                this.#stateStore,
                this.#lockManager,
                this.#eventBus,
            )
            .ioSync((stream) => this.#hookUpStream(stream))
            .ioSync((stream) => {
                this.#streams.set(stream.getStreamId(), stream);

                // Publish stream creation to distributed system
                void this.#eventBus.publish('stream:created', {
                    nodeId: this.#nodeId,
                    streamId: stream.getStreamId(),
                    type,
                    quality,
                    streamIndex,
                    fileId: stream.getFileId(),
                    createdAt: Date.now(),
                });
            });

        return source.getFileId()
            .chain((fileId) => {
                const streamId = Stream.getStreamId(fileId, type, quality, streamIndex);
                const localStream = this.#streams.get(streamId);

                if (localStream) {
                    return TaskEither.of(localStream);
                }

                // Check if stream exists on another node
                return this.#checkDistributedStreamExists(streamId)
                    .matchTask([
                        {
                            predicate: (exists) => exists,
                            run: () => createStream(),
                        },
                        {
                            predicate: () => true,
                            run: () => createStream(),
                        },
                    ]);
            });
    }

    /**
     * Check if a stream exists on another node
     * @private
     */
    #checkDistributedStreamExists (streamId: string): TaskEither<boolean> {
        const streamKey = `stream:info:${streamId}`;

        return TaskEither
            .tryCatch(
                () => this.#stateStore.get<any>(streamKey),
                'Failed to check distributed stream',
            )
            .map((streamInfo) => streamInfo !== null);
    }

    /**
     * Get the stream and priority for a media source
     * @param filePath The file path of the media source
     * @param clientId The client ID of the user requesting the stream
     * @param type The stream type
     * @param quality The stream quality
     * @param streamIndex The stream index
     * @param segmentNumber The segment number to get
     * @private
     */
    #getStreamAndPriority (filePath: string, clientId: string, type: StreamType, quality: string, streamIndex: number, segmentNumber: number): TaskEither<{
        stream: Stream;
        priority: number;
    }> {
        return TaskEither
            .fromBind({
                stream: this.#getOrCreateStream(filePath, type, quality, streamIndex),
                priority: this.#clientTracker.getPriority(clientId, type, quality, segmentNumber),
            });
    }

    /**
     * Build a media source from the file path
     * @param filePath The file path of the media source
     * @private
     */
    #buildMediaSource (filePath: string): MediaSource {
        return new MediaSource(filePath, this.#fileStorage);
    }

    /**
     * Prepare segments for a media source
     * @param filePath The file path of the media source
     * @param clientId The client ID of the user requesting the stream
     * @param type The stream type
     * @param quality The stream quality
     * @param streamIndex The stream index
     * @param segmentNumber The segment number to prepare
     * @private
     */
    #prepareSegments (filePath: string, clientId: string, type: StreamType, quality: string, streamIndex: number, segmentNumber: number) {
        return this.#getStreamAndPriority(filePath, clientId, type, quality, streamIndex, segmentNumber)
            .chain(({ stream, priority }) => stream.buildTranscodeCommand(segmentNumber, priority))
            .toResult();
    }
}
