import path from 'path';

import { TaskEither } from '@eleven-am/fp';

import { FileStorage } from './fileStorage';
import { StreamType } from './types';

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
    getSegmentStream (streamType: StreamType, streamIndex: number, quality: string, segmentNumber: number): TaskEither<NodeJS.ReadableStream> {
        return this.getSegmentPath(streamType, streamIndex, quality, segmentNumber)
            .chain((segmentPath) => this.storage.getFileStream(segmentPath));
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
