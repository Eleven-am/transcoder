import path from 'path';
import { Readable } from 'stream';

import { DatabaseConnector } from './databaseConnector';
import { FileStorage } from './fileStorage';
import { MediaMetadata } from './types';
import { streamToJson } from './utils';


export class FileDatabase implements DatabaseConnector {
    constructor (private readonly localStorage: FileStorage) {}

    getMetadata (fileId: string): Promise<MediaMetadata> {
        return this.localStorage.getFileStream(this.getMetadataPath(fileId))
            .chain(streamToJson<MediaMetadata>)
            .toPromise();
    }

    metadataExists (fileId: string): Promise<{ exists: boolean, fileId: string }> {
        return this.localStorage.exists(this.getMetadataPath(fileId))
            .map((exists) => ({
                exists,
                fileId,
            }))
            .toPromise();
    }

    saveMetadata (fileId: string, metadata: MediaMetadata): Promise<MediaMetadata> {
        const jsonString = JSON.stringify(metadata, null, 2);
        const readableJsonStream: NodeJS.ReadableStream = Readable.from(jsonString);

        return this.localStorage.saveFile(this.getMetadataPath(fileId), readableJsonStream)
            .map(() => metadata)
            .toPromise();
    }

    private getMetadataPath (fileId: string): string {
        return path.join(
            this.localStorage.getBasePath(fileId),
            'metadata.json',
        );
    }
}
