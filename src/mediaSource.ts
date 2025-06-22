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

import * as path from 'path';

import { TaskEither } from '@eleven-am/fp';

import { FileStorage } from './fileStorage';
import { SegmentStream, StreamType } from './types';

export class MediaSource {
	constructor (
        private readonly filePath: string,
        private readonly storage: FileStorage,
	) {}

	/**
     * Retrieves the path of the media file
     */
	getFileId (): TaskEither<string> {
		return this.storage.generateFileId(this.filePath);
	}

	/**
     * Deletes the temporary files associated with the media source generated during transcoding
     */
	deleteTempFiles (): TaskEither<void> {
		return this.getFileId()
			.chain((fileId) => this.storage.deleteFilesWithPrefix(this.storage.getBasePath(fileId)));
	}

	/**
     * Retrieves the absolute path of the media file
     */
	getFilePath (): string {
		return this.filePath;
	}

	/**
     * Checks if a segment exists in the storage
     * @param streamType The type of stream (video/audio)
     * @param streamIndex The index of the stream
     * @param quality The quality of the segment
     * @param segmentNumber The number of the segment
     */
	segmentExist (streamType: StreamType, streamIndex: number, quality: string, segmentNumber: number): TaskEither<boolean> {
		return this.getSegmentPath(streamType, streamIndex, quality, segmentNumber)
			.chain((segmentPath) => this.storage.exists(segmentPath));
	}

	/**
     * Retrieves the directory path for a specific stream type, index and quality
     * @param streamType The type of stream (video/audio)
     * @param streamIndex The index of the stream
     * @param quality The quality of the stream
     */
	getStreamDirectory (streamType: StreamType, streamIndex: number, quality: string): TaskEither<string> {
		return this.getFileId()
			.map((fileId) => path.join(
				this.storage.getBasePath(fileId),
				`${streamType}${streamIndex}`,
				quality,
			))
			.chain((path) => this.storage.ensureDirectoryExists(path));
	}

	/**
     * Retrieves the input stream of a segment
     * @param streamType The type of stream (video/audio)
     * @param streamIndex The index of the stream
     * @param quality The quality of the segment
     * @param segmentNumber The number of the segment
     */
	getSegmentStream (streamType: StreamType, streamIndex: number, quality: string, segmentNumber: number): TaskEither<SegmentStream> {
		return this.getSegmentPath(streamType, streamIndex, quality, segmentNumber)
			.chain((segmentPath) => TaskEither.fromBind({
				stream: this.storage.getFileStream(segmentPath),
				size: this.storage.getFileSize(segmentPath),
			}));
	}

	/**
     * Retrieves the path of a segment in the storage
     * @param streamType The type of stream (video/audio)
     * @param streamIndex The index of the stream
     * @param quality The quality of the segment
     * @param segmentNumber The number of the segment
     */
	private getSegmentPath (streamType: StreamType, streamIndex: number, quality: string, segmentNumber: number): TaskEither<string> {
		return this.getFileId()
			.map((fileId) => path.join(
				this.storage.getBasePath(fileId),
				`${streamType}${streamIndex}`,
				quality,
				`segment-${segmentNumber}.ts`,
			))
			.map((segmentPath) => path.normalize(segmentPath));
	}
}
