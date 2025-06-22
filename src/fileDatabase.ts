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
