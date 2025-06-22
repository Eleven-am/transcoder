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

import { TaskEither } from '@eleven-am/fp';

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

    // Session events
    'session:updated': ClientInternalState;
}

enum ClientBehavior {
    FIRST_TIME = 'FIRST_TIME',
    SEEKING = 'SEEKING',
    SEQUENTIAL = 'SEQUENTIAL'
}

/**
 * ClientTracker - Monitors client activity and manages resources
 *
 * This class tracks which clients are using which streams and ensures
 * that unused resources are cleaned up to optimize system resource usage.
 */
export class ClientTracker extends ExtendedEventEmitter<ClientTrackerEvents> {
	private readonly clients: Map<string, ClientInfo>;

	private readonly states: Map<string, ClientInternalState>;

	private readonly clientStreamMap: Map<string, Set<string>>;

	private readonly streamClientMap: Map<string, Set<string>>;

	private readonly clientSegmentHistory: Map<string, number[]>;

	private readonly pendingUnusedStreams: Map<string, NodeJS.Timeout>;

	private readonly maxSegmentHistorySize: number = 10;

	private inactivityCheckInterval: NodeJS.Timeout | null = null;

	private readonly clientLastAccess: Map<string, Date> = new Map();

	private readonly streamLastAccess: Map<string, Date> = new Map();

	constructor (
        private readonly qualityService: QualityService,
        private readonly inactivityCheckFrequency: number = 60_000,
        private readonly unusedStreamDebounceDelay: number = 300_000,
        private readonly inactivityThreshold: number = 1_800_000,
	) {
		super();

		this.clients = new Map();
		this.states = new Map();
		this.clientSegmentHistory = new Map();
		this.clientStreamMap = new Map();
		this.streamClientMap = new Map();
		this.pendingUnusedStreams = new Map();

		this.initialize();
	}

	/**
     * Clean up resources
     */
	public dispose (): void {
		if (this.inactivityCheckInterval) {
			clearInterval(this.inactivityCheckInterval);
			this.inactivityCheckInterval = null;
		}

		for (const timer of this.pendingUnusedStreams.values()) {
			clearTimeout(timer);
		}

		this.pendingUnusedStreams.clear();
	}

	/**
     * Register client activity
     * @param clientInfo Information about the client and its activity
     */
	public registerClientActivity (clientInfo: ClientState): void {
		const now = new Date();

		// Update local state
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

		// Adjust priority based on quality
		if (type === StreamType.VIDEO) {
			const qualityInfo = this.qualityService.parseVideoQuality(quality);

			if (qualityInfo.value === 'original') {
				priority -= 10;
			} else {
				// Prioritize lower qualities slightly for better user experience
				const heightFactor = qualityInfo.height <= 480
					? 10 :
					qualityInfo.height <= 720 ? 5 : 0;

				priority += heightFactor;
			}
		}

		return TaskEither.of(Math.max(1, Math.min(100, priority)));
	}

	/**
     * Initialize the tracker
     */
	private initialize (): void {
		this.inactivityCheckInterval = setInterval(() => {
			this.checkForIdleStreams();
			this.checkForInactiveClients();
		}, this.inactivityCheckFrequency);
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
					}
				} catch {
					this.pendingUnusedStreams.delete(streamId);
				}
			}, this.unusedStreamDebounceDelay);

			this.pendingUnusedStreams.set(streamId, timer);
		} catch {
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
			} catch {
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
		} catch {
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
}
