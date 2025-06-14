import { exec, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

import { TaskEither } from '@eleven-am/fp';

import { DistributedTranscodeJob, SegmentCoordinator, TranscodeJobQueue } from './distributed';
import ffmpeg from './ffmpeg';
import { QualityService } from './qualityService';
import { AudioQualityEnum, StreamType, VideoQualityEnum } from './types';
import { ExtendedEventEmitter } from './utils';

interface ClientState {
    clientId: string;
    fileId: string;
    filePath: string;
    audioQuality?: string;
    videoQuality?: string;
    videoIndex?: number;
    audioIndex?: number;
    segment: number;
}

interface ClientInfo extends ClientState {
    lastAccess: Date;
    audioQuality: string;
    videoQuality: string;
    videoIndex: number;
    audioIndex: number;
}

interface ClientInternalState {
    audioQuality: AudioQualityEnum;
    videoQuality: VideoQualityEnum;
    videoIndex: number;
    audioIndex: number;
    clientId: string;
    filePath: string;
    fileId: string;
}

interface ClientTrackerEvents {
    // Client events
    'client:registered': { clientId: string, fileId: string };
    'client:departed': { clientId: string, fileId: string };

    // Stream events
    'stream:requested': { streamId: string, clientId: string, priority: number };
    'stream:idle': { streamId: string, idleTime: number };
    'stream:abandoned': { streamId: string };

    // System events
    'system:loadChanged': { load: number, previousLoad: number };
    'system:overloaded': { load: number, activeClients: number };
    'system:stable': { load: number, activeClients: number };

    // Session events
    'session:updated': ClientInternalState;

    // Job events
    'job:completed': { jobId: string };
    'job:failed': { jobId: string, error: string };
}

enum ClientBehavior {
    FIRST_TIME = 'FIRST_TIME',
    SEEKING = 'SEEKING',
    SEQUENTIAL = 'SEQUENTIAL'
}

/**
 * ClientTracker - Monitors client activity and manages distributed transcoding
 *
 * This class tracks which clients are using which streams and ensures
 * that unused resources are cleaned up to optimize system resource usage.
 * It also manages distributed transcoding job priorities and execution.
 */
export class ClientTracker extends ExtendedEventEmitter<ClientTrackerEvents> {
    private readonly clients: Map<string, ClientInfo>;

    private readonly states: Map<string, ClientInternalState>;

    private readonly clientStreamMap: Map<string, Set<string>>;

    private readonly streamClientMap: Map<string, Set<string>>;

    private readonly clientSegmentHistory: Map<string, number[]>;

    private readonly clientLastAccess: Map<string, Date>;

    private readonly streamLastAccess: Map<string, Date>;

    private readonly pendingUnusedStreams: Map<string, NodeJS.Timeout>;

    private readonly activeJobs: Map<string, DistributedTranscodeJob>;

    private queueProcessorTimer: NodeJS.Timeout | null = null;

    private readonly maxSegmentHistorySize: number = 10;

    private lastSystemLoad: number = 0;

    private inactivityCheckInterval: NodeJS.Timeout | null = null;

    private readonly overloadThreshold: number = 80;

    private readonly loadCheckThreshold: number = 10;

    private readonly nodeId: string;

    constructor (
        private readonly qualityService: QualityService,
        private readonly segmentCoordinator: SegmentCoordinator,
        private readonly jobQueue: TranscodeJobQueue,
        private readonly inactivityCheckFrequency: number = 60_000,
        private readonly unusedStreamDebounceDelay: number = 300_000,
        private readonly inactivityThreshold: number = 1_800_000,
        private readonly maxConcurrentJobs: number = Math.max(1, os.cpus().length - 1),
    ) {
        super();

        this.nodeId = `node-${process.pid}-${Date.now()}`;
        this.clients = new Map();
        this.states = new Map();
        this.clientSegmentHistory = new Map();
        this.clientStreamMap = new Map();
        this.streamClientMap = new Map();
        this.clientLastAccess = new Map();
        this.streamLastAccess = new Map();
        this.pendingUnusedStreams = new Map();

        this.activeJobs = new Map<string, DistributedTranscodeJob>();

        this.initialize();
    }

    /**
	 * Get the segment coordinator (used by Stream class)
	 */
    public getSegmentCoordinator (): SegmentCoordinator {
        return this.segmentCoordinator;
    }

    /**
	 * Clean up resources
	 */
    public dispose (): void {
        if (this.inactivityCheckInterval) {
            clearInterval(this.inactivityCheckInterval);
            this.inactivityCheckInterval = null;
        }

        if (this.queueProcessorTimer) {
            clearTimeout(this.queueProcessorTimer);
            this.queueProcessorTimer = null;
        }

        for (const timer of this.pendingUnusedStreams.values()) {
            clearTimeout(timer);
        }

        this.pendingUnusedStreams.clear();
        this.activeJobs.clear();
    }

    /**
	 * Register client activity
	 * @param clientInfo Information about the client and its activity
	 */
    public registerClientActivity (clientInfo: ClientState): void {
        const now = new Date();
        const existingClient = this.clients.get(clientInfo.clientId);

        const fullClientInfo = {
            clientId: clientInfo.clientId,
            fileId: clientInfo.fileId,
            filePath: clientInfo.filePath,
            audioQuality: clientInfo.audioQuality ?? existingClient?.audioQuality,
            videoQuality: clientInfo.videoQuality ?? existingClient?.videoQuality,
            audioIndex: clientInfo.audioIndex ?? existingClient?.audioIndex,
            videoIndex: clientInfo.videoIndex ?? existingClient?.videoIndex,
            lastAccess: now,
        } as ClientInfo;

        const quality = clientInfo.videoQuality || clientInfo.audioQuality;
        const type = clientInfo.videoQuality ? StreamType.VIDEO : StreamType.AUDIO;
        const index = clientInfo.videoIndex || clientInfo.audioIndex;

        this.clients.set(clientInfo.clientId, fullClientInfo);

        this.clientLastAccess.set(clientInfo.clientId, now);

        const streamId = `${clientInfo.fileId}:${type}:${index}:${quality}`;

        this.updateLastAccess(clientInfo.clientId, streamId);

        const isNewClient = !this.clientStreamMap.has(clientInfo.clientId);

        if (isNewClient) {
            this.emit('client:registered', {
                clientId: clientInfo.clientId,
                fileId: clientInfo.fileId,
            });
        }

        this.updateClientSession(clientInfo.clientId);
    }

    /**
	 * Get the priority for a stream request
	 * @param clientId The ID of the client requesting the stream
	 * @param type The type of stream (video/audio)
	 * @param quality The quality of the stream requested
	 * @param segmentIndex The index of the segment requested
	 * @returns A TaskEither containing the calculated priority (higher = more important)
	 */
    public getPriority (clientId: string, type: StreamType, quality: string, segmentIndex: number): TaskEither<number> {
        const fileId = this.clients.get(clientId)?.fileId;

        if (!fileId) {
            return TaskEither.of(0);
        }

        const behavior = this.analyzeClientBehavior(clientId, segmentIndex);

        const BASE_PRIORITY = 50;
        const FIRST_TIME_BONUS = 30;
        const SEEKING_BONUS = 20;
        const SEQUENTIAL_BONUS = 5;

        let priority = BASE_PRIORITY;

        switch (behavior) {
            case ClientBehavior.FIRST_TIME:
                priority += FIRST_TIME_BONUS;
                break;
            case ClientBehavior.SEEKING:
                priority += SEEKING_BONUS;
                break;
            case ClientBehavior.SEQUENTIAL:
                priority += SEQUENTIAL_BONUS;
                break;
            default:
                break;
        }

        return this.calculateSystemLoad()
            .map((load) => {
                if (type === StreamType.VIDEO) {
                    const qualityInfo = this.qualityService.parseVideoQuality(quality);

                    if (qualityInfo.value === 'original') {
                        priority -= Math.floor(load / 5);
                    } else {
                        const heightFactor = qualityInfo.height <= 480
                            ? 10 :
                            qualityInfo.height <= 720 ? 5 : 0;

                        priority += Math.floor((load / 100) * heightFactor);
                    }
                }

                if (load > this.overloadThreshold) {
                    priority = Math.max(10, priority - 15);
                } else if (load < 30) {
                    priority += 10;
                }

                return Math.max(1, Math.min(100, priority));
            });
    }

    /**
	 * Handle a new transcode job from a stream
	 * @param job The distributed transcode job to queue
	 */
    public handleTranscodeJob (job: DistributedTranscodeJob): void {
        void this.enqueueJob(job);
        this.processJobQueue();
    }

    /**
	 * Initialize the tracker
	 */
    private initialize (): void {
        void this.updateSystemLoad().toResult();
        this.inactivityCheckInterval = setInterval(() => {
            this.checkForIdleStreams();
            this.checkForInactiveClients();
            void this.updateSystemLoad().toResult();
            this.cleanupActiveJobs();
        }, this.inactivityCheckFrequency);

        // Start job processing loop
        this.processJobQueue();
    }

    /**
	 * Update system load and emit events if significant changes
	 */
    private updateSystemLoad (): TaskEither<void> {
        return this.calculateSystemLoad()
            .map((load) => {
                const previousLoad = this.lastSystemLoad;

                this.lastSystemLoad = load;

                if (Math.abs(load - previousLoad) >= this.loadCheckThreshold) {
                    this.emit('system:loadChanged', { load,
                        previousLoad });
                }

                if (load >= this.overloadThreshold && previousLoad < this.overloadThreshold) {
                    this.emit('system:overloaded', {
                        load,
                        activeClients: this.clients.size,
                    });
                } else if (load < this.overloadThreshold && previousLoad >= this.overloadThreshold) {
                    this.emit('system:stable', {
                        load,
                        activeClients: this.clients.size,
                    });
                }
            });
    }

    /**
	 * Add a job to the distributed queue
	 * @param job The job to enqueue
	 */
    private async enqueueJob (job: DistributedTranscodeJob): Promise<void> {
        try {
            await this.jobQueue.push(job);
        } catch (error) {
            console.error('Failed to enqueue job:', error);
        }
    }

    /**
	 * Process jobs from the distributed queue
	 */
    private processJobQueue (): void {
        if (this.queueProcessorTimer !== null) {
            return;
        }

        const processNextJob = async () => {
            try {
                const load = await this.calculateSystemLoad().toPromise();

                // Check if we can start new jobs
                if (!this.canStartNewJob(load)) {
                    return;
                }

                // Try to get a job from the queue
                const job = await this.jobQueue.pop(this.nodeId);

                if (job) {
                    await this.executeJob(job);
                }
            } catch (error) {
                console.error('Error processing job queue:', error);
            }
        };

        const scheduleNext = (delay: number = 1000) => {
            this.queueProcessorTimer = setTimeout(async () => {
                this.queueProcessorTimer = null;
                await processNextJob();
                this.processJobQueue(); // Schedule next iteration
            }, delay);
        };

        void processNextJob().then(() => scheduleNext());
    }

    /**
	 * Execute a distributed transcode job
	 * @param job The job to execute
	 */
    private async executeJob (job: DistributedTranscodeJob): Promise<void> {
        this.activeJobs.set(job.id, job);

        try {
            // Create FFmpeg command from job data
            const command = ffmpeg(job.filePath)
                .inputOptions(job.inputOptions)
                .outputOptions(job.outputOptions)
                .output(job.outputPath);

            if (job.videoFilters) {
                command.videoFilters(job.videoFilters);
            }

            // Set up event handlers
            command.on('start', () => {
                console.log(`Started job ${job.id} for segment ${job.segmentIndex}`);
            });

            command.on('progress', async (progress) => {
                // Update segment coordinator as segments complete
                const segmentId = `${job.fileId}:${job.streamType}:${job.streamIndex}:${job.quality}:${progress.segment}`;

                try {
                    await this.segmentCoordinator.markSegmentComplete(segmentId);
                } catch (error) {
                    console.warn(`Failed to mark segment complete: ${segmentId}`, error);
                }
            });

            command.on('end', async () => {
                try {
                    await this.jobQueue.complete(job.id);
                    this.emit('job:completed', { jobId: job.id });
                    console.log(`Completed job ${job.id}`);
                } catch (error) {
                    console.error(`Failed to mark job complete: ${job.id}`, error);
                } finally {
                    this.activeJobs.delete(job.id);
                }
            });

            command.on('error', async (error) => {
                try {
                    await this.jobQueue.fail(job.id, error.message, true); // Requeue on failure
                    this.emit('job:failed', { jobId: job.id,
                        error: error.message });
                    console.error(`Job ${job.id} failed:`, error.message);
                } catch (failError) {
                    console.error(`Failed to mark job failed: ${job.id}`, failError);
                } finally {
                    this.activeJobs.delete(job.id);
                }
            });

            // Start the job
            command.run();
        } catch (error) {
            console.error(`Failed to execute job ${job.id}:`, error);
            this.activeJobs.delete(job.id);

            try {
                await this.jobQueue.fail(job.id, error instanceof Error ? error.message : 'Unknown error');
            } catch (failError) {
                console.error(`Failed to mark job failed: ${job.id}`, failError);
            }
        }
    }

    /**
	 * Check for idle streams and emit events
	 */
    private checkForIdleStreams (): void {
        const now = new Date();

        for (const [streamId, lastAccess] of this.streamLastAccess.entries()) {
            const idleTime = now.getTime() - lastAccess.getTime();

            if (!this.streamClientMap.has(streamId) || this.streamClientMap.get(streamId)!.size === 0) {
                if (this.pendingUnusedStreams.has(streamId)) {
                    continue;
                }

                this.emit('stream:idle', { streamId,
                    idleTime });
                this.debounceStreamUnused(streamId);
            }
        }
    }

    /**
	 * Handle debounce logic for marking a stream as unused
	 */
    private debounceStreamUnused (streamId: string): void {
        this.cancelStreamUnusedTimer(streamId);

        try {
            const timer = setTimeout(() => {
                try {
                    if (!this.streamClientMap.has(streamId) || this.streamClientMap.get(streamId)!.size === 0) {
                        this.emit('stream:abandoned', { streamId });

                        this.streamLastAccess.delete(streamId);
                        this.pendingUnusedStreams.delete(streamId);
                        this.streamClientMap.delete(streamId);

                        // Clean up segment coordinator state for this stream
                        void this.segmentCoordinator.cleanup(streamId).catch((error) => {
                            console.warn(`Failed to cleanup segment coordinator for stream ${streamId}:`, error);
                        });
                    }
                } catch (err) {
                    this.pendingUnusedStreams.delete(streamId);
                }
            }, this.unusedStreamDebounceDelay);

            this.pendingUnusedStreams.set(streamId, timer);
        } catch (err) {
            // no-op
        }
    }

    /**
	 * Cancel any pending unused timer for a stream
	 */
    private cancelStreamUnusedTimer (streamId: string): void {
        if (this.pendingUnusedStreams.has(streamId)) {
            try {
                clearTimeout(this.pendingUnusedStreams.get(streamId)!);
                this.pendingUnusedStreams.delete(streamId);
            } catch (err) {
                this.pendingUnusedStreams.delete(streamId);
            }
        }
    }

    /**
	 * Update last access timestamps for client and stream
	 */
    private updateLastAccess (clientId: string, streamId: string): void {
        const now = new Date();

        this.clientLastAccess.set(clientId, now);
        this.streamLastAccess.set(streamId, now);

        if (!this.clientStreamMap.has(clientId)) {
            this.clientStreamMap.set(clientId, new Set([streamId]));
        } else {
            this.clientStreamMap.get(clientId)!.add(streamId);
        }

        if (!this.streamClientMap.has(streamId)) {
            this.streamClientMap.set(streamId, new Set([clientId]));
        } else {
            this.streamClientMap.get(streamId)!.add(clientId);
        }

        this.cancelStreamUnusedTimer(streamId);
    }

    /**
	 * Check for inactive clients and clean them up
	 */
    private checkForInactiveClients (): void {
        const now = new Date();

        for (const [clientId, lastAccess] of this.clientLastAccess.entries()) {
            const inactiveTime = now.getTime() - lastAccess.getTime();

            if (inactiveTime > this.inactivityThreshold) {
                this.removeClient(clientId);
            }
        }
    }

    /**
	 * Remove a client and clean up their resources
	 */
    private removeClient (clientId: string): void {
        const client = this.clients.get(clientId);

        if (!client) {
            return;
        }

        const streams = this.clientStreamMap.get(clientId) || new Set();

        for (const streamId of streams) {
            const clients = this.streamClientMap.get(streamId);

            if (clients) {
                clients.delete(clientId);
                if (clients.size === 0) {
                    this.debounceStreamUnused(streamId);
                }
            }
        }

        this.clients.delete(clientId);
        this.clientStreamMap.delete(clientId);
        this.clientLastAccess.delete(clientId);
        this.clientSegmentHistory.delete(clientId);

        this.emit('client:departed', {
            clientId,
            fileId: client.fileId,
        });
    }

    /**
	 * Update a client's session information and emit event
	 * @param clientId The client ID to update
	 */
    private updateClientSession (clientId: string): void {
        try {
            const client = this.clients.get(clientId);
            const state = this.states.get(clientId);

            if (
                !client ||
				(
				    state?.audioIndex === client.audioIndex &&
					state?.videoIndex === client.videoIndex &&
					state?.audioQuality === client.audioQuality &&
					state?.videoQuality === client.videoQuality
				)
            ) {
                return;
            }

            const newState = {
                clientId,
                fileId: client.fileId,
                filePath: client.filePath,
                audioQuality: client.audioQuality,
                videoQuality: client.videoQuality,
                audioIndex: client.audioIndex,
                videoIndex: client.videoIndex,
            } as ClientInternalState;

            this.states.set(clientId, newState);
            this.emit('session:updated', newState);
        } catch (err) {
            // no-op
        }
    }

    /**
	 * Analyze client behavior based on segment access pattern
	 */
    private analyzeClientBehavior (clientId: string, segmentIndex: number): ClientBehavior {
        if (!this.clientSegmentHistory.has(clientId)) {
            this.clientSegmentHistory.set(clientId, [segmentIndex]);

            return ClientBehavior.FIRST_TIME;
        }

        const history = this.clientSegmentHistory.get(clientId)!;
        const lastSegment = history[history.length - 1];

        history.push(segmentIndex);
        if (history.length > this.maxSegmentHistorySize) {
            history.shift();
        }

        if (segmentIndex === lastSegment + 1) {
            return ClientBehavior.SEQUENTIAL;
        }

        return ClientBehavior.SEEKING;
    }

    /**
	 * Clean up stalled active jobs
	 */
    private cleanupActiveJobs (): void {
        const now = Date.now();
        const STALLED_JOB_THRESHOLD = 10 * 60 * 1000; // 10 minutes

        for (const [jobId, job] of this.activeJobs.entries()) {
            if (job.createdAt && (now - job.createdAt) > STALLED_JOB_THRESHOLD) {
                console.warn(`Cleaning up stalled job: ${jobId}`);
                this.activeJobs.delete(jobId);

                // Try to mark as failed in queue
                void this.jobQueue.fail(jobId, 'Job stalled - cleaned up by tracker').catch((error) => {
                    console.warn(`Failed to mark stalled job as failed: ${jobId}`, error);
                });
            }
        }
    }

    /**
	 * Check if a new job can be started based on system load
	 */
    private canStartNewJob (load: number): boolean {
        const activeJobsCount = this.activeJobs.size;
        const maxJobs = this.calculateMaxConcurrentJobs(load);

        return activeJobsCount < maxJobs;
    }

    /**
	 * Calculate the maximum number of concurrent jobs based on system load
	 */
    private calculateMaxConcurrentJobs (load: number): number {
        if (load > 80) {
            return Math.max(1, Math.floor(this.maxConcurrentJobs * 0.5));
        }
        if (load > 60) {
            return Math.max(1, Math.floor(this.maxConcurrentJobs * 0.7));
        }

        return this.maxConcurrentJobs;
    }

    /**
	 * Calculates the current server load as a number between 0-100
	 * Considers CPU usage, memory pressure, and active process count
	 */
    private calculateSystemLoad (): TaskEither<number> {
        const WEIGHTS = {
            cpu: 0.6,
            memory: 0.3,
            diskIO: 0.1,
        };

        /**
		 * Gets the current CPU usage by sampling over a short period
		 * @returns Promise resolving to CPU usage percentage (0-100)
		 */
        const getCpuUsage = async (): Promise<number> => {
            const initialMeasurements = os.cpus().map((cpu) => ({
                idle: cpu.times.idle,
                total: Object.values(cpu.times).reduce((sum: number, time: number) => sum + time, 0),
            }));

            await new Promise((resolve) => setTimeout(resolve, 200));

            const finalMeasurements = os.cpus().map((cpu) => ({
                idle: cpu.times.idle,
                total: Object.values(cpu.times).reduce((sum: number, time: number) => sum + time, 0),
            }));

            const cpuUsages = initialMeasurements.map((start, i) => {
                const end = finalMeasurements[i];
                const idleDiff = end.idle - start.idle;
                const totalDiff = end.total - start.total;

                return Math.max(0, Math.min(100, 100 - Math.round(100 * idleDiff / totalDiff)));
            });

            return cpuUsages.reduce((sum, usage) => sum + usage, 0) / cpuUsages.length;
        };

        /**
		 * Gets the current memory usage percentage
		 * @returns Memory usage percentage (0-100)
		 */
        const getMemoryUsage = (): number => {
            const totalMemory = os.totalmem();
            const freeMemory = os.freemem();
            const usedMemory = totalMemory - freeMemory;

            return Math.min(100, (usedMemory / totalMemory) * 100);
        };

        /**
		 * Gets the disk I/O pressure by using platform-specific commands
		 * @returns Promise resolving to disk I/O percentage (0-100)
		 */
        const getDiskIOPressure = async (): Promise<number> => {
            const DEFAULT_IO_VALUE = 50;

            try {
                if (process.platform === 'linux') {
                    // eslint-disable-next-line @typescript-eslint/no-use-before-define
                    return await getLinuxDiskIO();
                } else if (process.platform === 'darwin') {
                    // eslint-disable-next-line @typescript-eslint/no-use-before-define
                    return await getMacOSDiskIO();
                } else if (process.platform === 'win32') {
                    // eslint-disable-next-line @typescript-eslint/no-use-before-define
                    return await getWindowsDiskIO();
                }
            } catch (error) {
                // no-op
            }

            return DEFAULT_IO_VALUE;
        };

        /**
		 * Gets disk I/O on Linux using iostat
		 */
        const getLinuxDiskIO = (): Promise<number> => new Promise((resolve) => {
            exec('iostat -dx 1 1', (error, stdout) => {
                if (error) {
                    resolve(50);

                    return;
                }

                try {
                    const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
                    const deviceLineIndex = lines.findIndex((line) => line.includes('Device'));

                    if (deviceLineIndex === -1 || deviceLineIndex === lines.length - 1) {
                        resolve(50);

                        return;
                    }

                    const deviceLines = lines.slice(deviceLineIndex + 1);
                    const utilValues = deviceLines.map((line) => {
                        const fields = line.trim().split(/\s+/);


                        return parseFloat(fields[fields.length - 1]);
                    });

                    const avgUtil = utilValues.reduce((sum, util) => sum + util, 0) / utilValues.length;

                    resolve(Math.min(100, avgUtil));
                } catch (e) {
                    resolve(50);
                }
            });
        });

        /**
		 * Gets disk I/O on macOS using iostat
		 */
        const getMacOSDiskIO = (): Promise<number> => new Promise((resolve) => {
            exec('iostat -d -c 1', (error, stdout) => {
                if (error) {
                    resolve(50);

                    return;
                }

                try {
                    const diskLines = stdout.split('\n').filter((line) => line.includes('disk'));

                    if (diskLines.length === 0) {
                        resolve(50);

                        return;
                    }

                    let totalLoad = 0;
                    let deviceCount = 0;

                    for (const line of diskLines) {
                        const parts = line.trim().split(/\s+/);

                        if (parts.length >= 4) {
                            const tps = parseFloat(parts[2]);
                            const kbps = parseFloat(parts[3]);

                            if (!isNaN(tps) && !isNaN(kbps)) {
                                totalLoad += Math.min(100, (tps * kbps) / 100);
                                deviceCount++;
                            }
                        }
                    }

                    resolve(deviceCount > 0 ? totalLoad / deviceCount : 50);
                } catch (e) {
                    resolve(50);
                }
            });
        });

        /**
		 * Estimates disk I/O on Windows based on active processes
		 */
        const getWindowsDiskIO = (): Promise<number> => new Promise((resolve) => {
            try {
                const output = execSync('tasklist /fi "imagename eq ffmpeg.exe" /fo csv /nh').toString();
                const processCount = output.split('\n').filter((line: string) => line.includes('ffmpeg')).length;

                resolve(Math.min(100, processCount * 10));
            } catch (e) {
                resolve(50);
            }
        });

        /**
		 * Gets adjustment factor based on active clients
		 * @returns Client load adjustment factor (0-100)
		 */
        const getClientLoadAdjustment = (): number => {
            const activeClientCount = this.clients.size;


            return Math.min(100, activeClientCount * 5);
        };

        /**
		 * Checks if running in a container environment
		 * @returns True if running in a container
		 */
        const isRunningInContainer = (): boolean => {
            try {
                return fs.existsSync('/.dockerenv') || fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker');
            } catch {
                return false;
            }
        };

        return TaskEither
            .tryCatch(
                async () => {
                    const [cpuUsage, diskIOPressure] = await Promise.all([
                        getCpuUsage(),
                        getDiskIOPressure(),
                    ]);

                    const memoryUsage = getMemoryUsage();
                    const clientLoad = getClientLoadAdjustment();

                    const scaledCpuUsage = isRunningInContainer()
                        ? Math.min(100, cpuUsage * 1.2)
                        : cpuUsage;

                    const cpuFactor = scaledCpuUsage / 100;
                    const cpuWeight = WEIGHTS.cpu * (1 + 0.5 * cpuFactor);
                    const memoryWeight = WEIGHTS.memory * (1 - 0.3 * cpuFactor);
                    const diskWeight = WEIGHTS.diskIO * (1 - 0.3 * cpuFactor);
                    const totalWeight = cpuWeight + memoryWeight + diskWeight;

                    const systemLoad = (
                        (scaledCpuUsage * cpuWeight) +
						(memoryUsage * memoryWeight) +
						(diskIOPressure * diskWeight)
                    ) / totalWeight;

                    return Math.min(100, (systemLoad * 0.7) + (clientLoad * 0.3));
                },
                'Failed to calculate system load',
            )
            .orElse(() => TaskEither.of(50));
    }
}
