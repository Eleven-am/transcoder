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

import { createBadRequestError, TaskEither } from '@eleven-am/fp';

import { ClientTracker } from './clientTracker';
import { ISegmentProcessor, SegmentProcessorFactory } from './distributed';
import { FileDatabase } from './fileDatabase';
import { FileStorage } from './fileStorage';
import { HardwareAccelerationDetector } from './hardwareAccelerationDetector';
import { JobProcessor } from './jobProcessor';
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

	#segmentProcessor: ISegmentProcessor | null = null;

	readonly #hwDetector: HardwareAccelerationDetector;

	readonly #metadataService: MetadataService;

	readonly #qualityService: QualityService;

	readonly #streams: Map<string, Stream>;

	readonly #clientTracker: ClientTracker;

	readonly #maxSegmentBatchSize: number;

	readonly #fileStorage: FileStorage;

	readonly #hwAccelEnabled: boolean;

	readonly #jobProcessor: JobProcessor;

	readonly #distributedConfig: HLSManagerOptions['distributed'];

	#loadAdjustmentInterval: NodeJS.Timeout | null = null;

	constructor (options: HLSManagerOptions) {
		this.#streams = new Map<string, Stream>();

		this.#hwAccelEnabled = options.hwAccel || false;
		this.#maxSegmentBatchSize = options.maxSegmentBatchSize || 100;
		this.streamConfig = options.config || {};
		this.#distributedConfig = options.distributed;

		this.#hwDetector = new HardwareAccelerationDetector();
		this.#fileStorage = new FileStorage(options.cacheDirectory);
		const database = options.database || new FileDatabase(this.#fileStorage);

		this.#qualityService = new QualityService(options.videoQualities, options.audioQualities);
		this.#metadataService = new MetadataService(
			this.#qualityService,
			database,
		);

		this.#clientTracker = new ClientTracker(
			this.#qualityService,
			undefined, // inactivityCheckFrequency
			undefined, // unusedStreamDebounceDelay
			undefined, // inactivityThreshold
		);

		this.#jobProcessor = new JobProcessor();
	}

	/**
     * Initialize the HLS manager
     * This will initialize the transcodeService and detect hardware acceleration
     */
	async initialize (): Promise<void> {
		this.#hookUpClientTracker();
		this.#hookUpJobProcessor();

		// Initialize segment processor
		if (this.#distributedConfig?.enabled !== false) {
			this.#segmentProcessor = await SegmentProcessorFactory.create({
				redisUrl: this.#distributedConfig?.redisUrl,
				workerId: this.#distributedConfig?.workerId,
				claimTTL: this.#distributedConfig?.claimTTL,
				fallbackToLocal: this.#distributedConfig?.fallbackToLocal,
			});

			const mode = this.#segmentProcessor.getMode();

			console.log(`HLSController initialized with ${mode} segment processing`);
		}

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
     * Get the current job processor status
     * @returns The current status of the job processor
     */
	getJobProcessorStatus (): {
        queueLength: number;
        activeJobs: number;
        maxConcurrentJobs: number;
        isProcessing: boolean;
        } {
		return this.#jobProcessor.getStatus();
	}

	/**
     * Get the segment processor
     * @returns The segment processor instance or null
     */
	getSegmentProcessor (): ISegmentProcessor | null {
		return this.#segmentProcessor;
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
	async dispose (): Promise<void> {
		// Clear load adjustment interval
		if (this.#loadAdjustmentInterval) {
			clearInterval(this.#loadAdjustmentInterval);
			this.#loadAdjustmentInterval = null;
		}

		// Dispose all streams
		for (const stream of this.#streams.values()) {
			void stream.dispose();
		}
		this.#streams.clear();

		// Dispose segment processor
		if (this.#segmentProcessor) {
			await this.#segmentProcessor.dispose();
			this.#segmentProcessor = null;
		}

		// Dispose client tracker
		this.#clientTracker.dispose();

		// Dispose job processor
		this.#jobProcessor.dispose();
	}


	/**
     * Set up job processor event listeners
     * @private
     */
	#hookUpJobProcessor (): void {
		this.#jobProcessor.on('job:failed', ({ job, error }) => {
			console.error(`Transcode job failed: ${job.id}`, error);
		});

		this.#jobProcessor.on('queue:full', ({ size, maxSize }) => {
			console.warn(`Job queue is full: ${size}/${maxSize}`);
		});

		this.#jobProcessor.on('concurrency:changed', ({ current, max }) => {
			console.info(`Concurrency changed: ${current}/${max}`);
		});

		// Optional: Periodically adjust concurrency based on system load
		this.#loadAdjustmentInterval = setInterval(() => {
			this.#jobProcessor.adjustConcurrencyBasedOnLoad();
		}, 30000); // Every 30 seconds
	}

	/**
     * Set up client tracker event listeners
     * @private
     */
	#hookUpClientTracker (): void {
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
		stream.on('dispose', ({ id }) => {
			this.#streams.delete(id);
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
				this.#jobProcessor,
			)
			.ioSync((stream) => this.#hookUpStream(stream))
			.ioSync((stream) => {
				this.#streams.set(stream.getStreamId(), stream);
			});

		return source.getFileId()
			.chain((fileId) => {
				const streamId = Stream.getStreamId(fileId, type, quality, streamIndex);
				const localStream = this.#streams.get(streamId);

				if (localStream) {
					return TaskEither.of(localStream);
				}

				return createStream();
			});
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
