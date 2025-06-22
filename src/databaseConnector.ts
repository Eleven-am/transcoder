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

import { MediaMetadata } from './types';

export interface DatabaseConnector {

    /**
     * Retrieve media metadata for the given file ID
     * @param fileId Unique identifier for the media file
     */
    getMetadata(fileId: string): Promise<MediaMetadata>;

    /**
     * Save media metadata for the given file ID
     * @param fileId Unique identifier for the media file
     * @param metadata The media metadata to save
     */
    saveMetadata(fileId: string, metadata: MediaMetadata): Promise<MediaMetadata>;

    /**
     * Check if metadata exists for the given file ID
     * @param fileId Unique identifier for the media file
     */
    metadataExists(fileId: string): Promise<{ exists: boolean, fileId: string }>;
}
