import Redis from 'ioredis';

import { TranscodeJobQueue, DistributedTranscodeJob } from './interfaces';

/**
 * Redis implementation of TranscodeJobQueue for distributed job processing
 * Uses Redis sorted sets for priority queues and Redis sets for tracking job states
 */
export class RedisJobQueue implements TranscodeJobQueue {
    private readonly redis: Redis;

    private readonly nodeId: string;

    private readonly keyPrefix: string;

    private readonly roundRobinKey: string;

    private readonly heartbeatInterval: NodeJS.Timeout;

    constructor (
        redis: Redis,
        nodeId: string = `node-${process.pid}-${Date.now()}`,
        keyPrefix: string = 'hls:transcode',
    ) {
        this.redis = redis;
        this.nodeId = nodeId;
        this.keyPrefix = keyPrefix;
        this.roundRobinKey = `${keyPrefix}:round_robin`;

        // Register this node and start heartbeat
        this.registerNode();
        this.heartbeatInterval = setInterval(() => this.heartbeat(), 30000); // 30 second heartbeat
    }

    async push (job: DistributedTranscodeJob): Promise<void> {
        const jobKey = this.getJobKey(job.id);
        const queueKey = this.getQueueKey();

        // Store job data
        await this.redis.hset(jobKey, {
            id: job.id,
            priority: job.priority,
            createdAt: job.createdAt,
            filePath: job.filePath,
            fileId: job.fileId,
            streamType: job.streamType,
            streamIndex: job.streamIndex,
            quality: job.quality,
            segmentIndex: job.segmentIndex,
            inputOptions: JSON.stringify(job.inputOptions),
            outputOptions: JSON.stringify(job.outputOptions),
            videoFilters: job.videoFilters || '',
            outputPath: job.outputPath,
            segmentRange: JSON.stringify(job.segmentRange),
        });

        // Add to priority queue (using negative priority for correct sorting)
        await this.redis.zadd(queueKey, -job.priority, job.id);

        // Set TTL for job data
        await this.redis.expire(jobKey, 3600); // 1 hour TTL
    }

    async pop (nodeId: string): Promise<DistributedTranscodeJob | null> {
        // Check if it's this node's turn in round-robin
        const currentNode = await this.getNextNode();

        if (currentNode !== nodeId) {
            return null;
        }

        const queueKey = this.getQueueKey();
        const processingKey = this.getProcessingKey();

        // Atomically move job from queue to processing using Lua script
        const luaScript = `
            local queueKey = KEYS[1]
            local processingKey = KEYS[2]
            local nodeId = ARGV[1]
            local timestamp = ARGV[2]
            
            -- Get highest priority job
            local jobId = redis.call('ZRANGE', queueKey, 0, 0)[1]
            if not jobId then
                return nil
            end
            
            -- Remove from queue and add to processing
            redis.call('ZREM', queueKey, jobId)
            redis.call('HSET', processingKey, jobId, nodeId .. ':' .. timestamp)
            
            return jobId
        `;

        const jobId = await this.redis.eval(
            luaScript,
            2,
            queueKey,
            processingKey,
            nodeId,
            Date.now().toString(),
        ) as string | null;

        if (!jobId) {
            return null;
        }

        // Retrieve job data
        const jobKey = this.getJobKey(jobId);
        const jobData = await this.redis.hgetall(jobKey);

        if (!jobData || Object.keys(jobData).length === 0) {
            // Job data not found, clean up processing entry
            await this.redis.hdel(processingKey, jobId);

            return null;
        }

        // Convert back to DistributedTranscodeJob
        return {
            id: jobData.id,
            priority: parseInt(jobData.priority, 10),
            createdAt: parseInt(jobData.createdAt, 10),
            filePath: jobData.filePath,
            fileId: jobData.fileId,
            streamType: jobData.streamType as any,
            streamIndex: parseInt(jobData.streamIndex, 10),
            quality: jobData.quality,
            segmentIndex: parseInt(jobData.segmentIndex, 10),
            inputOptions: JSON.parse(jobData.inputOptions),
            outputOptions: JSON.parse(jobData.outputOptions),
            videoFilters: jobData.videoFilters || undefined,
            outputPath: jobData.outputPath,
            segmentRange: JSON.parse(jobData.segmentRange),
        };
    }

    async complete (jobId: string): Promise<void> {
        const processingKey = this.getProcessingKey();
        const completedKey = this.getCompletedKey();
        const jobKey = this.getJobKey(jobId);

        // Move from processing to completed
        const processingInfo = await this.redis.hget(processingKey, jobId);

        if (processingInfo) {
            await this.redis.hset(completedKey, jobId, `${processingInfo}:${Date.now()}`);
            await this.redis.hdel(processingKey, jobId);
        }

        // Clean up job data
        await this.redis.del(jobKey);
    }

    async fail (jobId: string, error: string, requeue: boolean = false): Promise<void> {
        const processingKey = this.getProcessingKey();
        const failedKey = this.getFailedKey();
        const jobKey = this.getJobKey(jobId);

        if (requeue) {
            // Get job data and requeue
            const jobData = await this.redis.hgetall(jobKey);

            if (jobData && Object.keys(jobData).length > 0) {
                const job: DistributedTranscodeJob = {
                    id: jobData.id,
                    priority: parseInt(jobData.priority, 10),
                    createdAt: parseInt(jobData.createdAt, 10),
                    filePath: jobData.filePath,
                    fileId: jobData.fileId,
                    streamType: jobData.streamType as any,
                    streamIndex: parseInt(jobData.streamIndex, 10),
                    quality: jobData.quality,
                    segmentIndex: parseInt(jobData.segmentIndex, 10),
                    inputOptions: JSON.parse(jobData.inputOptions),
                    outputOptions: JSON.parse(jobData.outputOptions),
                    videoFilters: jobData.videoFilters || undefined,
                    outputPath: jobData.outputPath,
                    segmentRange: JSON.parse(jobData.segmentRange),
                };

                await this.push(job);
            }
        } else {
            // Move to failed
            const processingInfo = await this.redis.hget(processingKey, jobId);

            if (processingInfo) {
                await this.redis.hset(failedKey, jobId, `${processingInfo}:${Date.now()}:${error}`);
            }
        }

        // Remove from processing
        await this.redis.hdel(processingKey, jobId);

        if (!requeue) {
            // Clean up job data if not requeuing
            await this.redis.del(jobKey);
        }
    }

    async size (): Promise<number> {
        const queueKey = this.getQueueKey();


        return await this.redis.zcard(queueKey);
    }

    async getProcessing (): Promise<string[]> {
        const processingKey = this.getProcessingKey();


        return await this.redis.hkeys(processingKey);
    }

    /**
	 * Register this node as active
	 */
    private async registerNode (): Promise<void> {
        const nodesKey = this.getNodesKey();
        const nodeKey = this.getNodeKey(this.nodeId);

        await this.redis.sadd(nodesKey, this.nodeId);
        await this.redis.hset(nodeKey, {
            lastSeen: Date.now(),
            status: 'active',
        });
        await this.redis.expire(nodeKey, 300); // 5 minute TTL
    }

    /**
	 * Send heartbeat to keep node alive
	 */
    private async heartbeat (): Promise<void> {
        const nodeKey = this.getNodeKey(this.nodeId);

        await this.redis.hset(nodeKey, 'lastSeen', Date.now());
        await this.redis.expire(nodeKey, 300); // 5 minute TTL
    }

    /**
	 * Get next node in round-robin fashion
	 */
    private async getNextNode (): Promise<string> {
        // Clean up dead nodes first
        await this.cleanupDeadNodes();

        const nodesKey = this.getNodesKey();
        const nodes = await this.redis.smembers(nodesKey);

        if (nodes.length === 0) {
            return this.nodeId; // Fallback if no nodes registered
        }

        // Sort nodes for consistent ordering
        nodes.sort();

        // Get and increment round-robin counter
        const counter = await this.redis.incr(this.roundRobinKey);
        const nodeIndex = (counter - 1) % nodes.length;

        return nodes[nodeIndex];
    }

    /**
	 * Clean up nodes that haven't sent heartbeat recently
	 */
    private async cleanupDeadNodes (): Promise<void> {
        const nodesKey = this.getNodesKey();
        const nodes = await this.redis.smembers(nodesKey);
        const cutoff = Date.now() - 300000; // 5 minutes ago

        for (const nodeId of nodes) {
            const nodeKey = this.getNodeKey(nodeId);
            const lastSeen = await this.redis.hget(nodeKey, 'lastSeen');

            if (!lastSeen || parseInt(lastSeen, 10) < cutoff) {
                await this.redis.srem(nodesKey, nodeId);
                await this.redis.del(nodeKey);
            }
        }
    }

    /**
	 * Get statistics about the queue
	 */
    async getStats () {
        const queueSize = await this.size();
        const processingCount = (await this.getProcessing()).length;
        const completedKey = this.getCompletedKey();
        const failedKey = this.getFailedKey();
        const nodesKey = this.getNodesKey();

        const [completedCount, failedCount, activeNodes] = await Promise.all([
            this.redis.hlen(completedKey),
            this.redis.hlen(failedKey),
            this.redis.smembers(nodesKey),
        ]);

        return {
            pending: queueSize,
            processing: processingCount,
            completed: completedCount,
            failed: failedCount,
            activeNodes: activeNodes.length,
            nodeId: this.nodeId,
        };
    }

    /**
	 * Clean up old completed and failed jobs
	 */
    async cleanup (maxAge: number = 3600000): Promise<void> { // Default 1 hour
        const cutoff = Date.now() - maxAge;
        const completedKey = this.getCompletedKey();
        const failedKey = this.getFailedKey();

        // Get all completed and failed jobs
        const [completed, failed] = await Promise.all([
            this.redis.hgetall(completedKey),
            this.redis.hgetall(failedKey),
        ]);

        // Clean up old entries
        const toDeleteCompleted: string[] = [];
        const toDeleteFailed: string[] = [];

        for (const [jobId, info] of Object.entries(completed)) {
            const timestamp = parseInt(info.split(':').pop() || '0', 10);

            if (timestamp < cutoff) {
                toDeleteCompleted.push(jobId);
            }
        }

        for (const [jobId, info] of Object.entries(failed)) {
            const timestamp = parseInt(info.split(':')[2] || '0', 10);

            if (timestamp < cutoff) {
                toDeleteFailed.push(jobId);
            }
        }

        if (toDeleteCompleted.length > 0) {
            await this.redis.hdel(completedKey, ...toDeleteCompleted);
        }

        if (toDeleteFailed.length > 0) {
            await this.redis.hdel(failedKey, ...toDeleteFailed);
        }
    }

    /**
	 * Dispose of resources
	 */
    async dispose (): Promise<void> {
        clearInterval(this.heartbeatInterval);

        // Remove this node from active nodes
        const nodesKey = this.getNodesKey();

        await this.redis.srem(nodesKey, this.nodeId);
        await this.redis.del(this.getNodeKey(this.nodeId));
    }

    // Key generation methods
    private getQueueKey (): string {
        return `${this.keyPrefix}:queue`;
    }

    private getProcessingKey (): string {
        return `${this.keyPrefix}:processing`;
    }

    private getCompletedKey (): string {
        return `${this.keyPrefix}:completed`;
    }

    private getFailedKey (): string {
        return `${this.keyPrefix}:failed`;
    }

    private getJobKey (jobId: string): string {
        return `${this.keyPrefix}:job:${jobId}`;
    }

    private getNodesKey (): string {
        return `${this.keyPrefix}:nodes`;
    }

    private getNodeKey (nodeId: string): string {
        return `${this.keyPrefix}:node:${nodeId}`;
    }
}
