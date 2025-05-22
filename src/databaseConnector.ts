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
