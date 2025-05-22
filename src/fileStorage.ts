import crypto from 'crypto';
import * as fs from 'fs';
import * as pfs from 'fs/promises';
import * as path from 'path';

import { createNotFoundError, createUnknownError, TaskEither } from '@eleven-am/fp';

export class FileStorage {
    constructor (
        private readonly cacheDirectory: string,
    ) {
        fs.mkdirSync(this.cacheDirectory, { recursive: true });
    }

    /**
     * Generates a unique file ID based on the file's inode number.
     * @param filePath The path to the file.
     * @returns A TaskEither containing the generated file ID or an error.
     */
    generateFileId (filePath: string): TaskEither<string> {
        return TaskEither
            .tryCatch(
                () => pfs.stat(filePath),
                'Failed to generate file ID',
            )
            .map((stat) => {
                const hash = crypto.createHash('sha256');

                hash.update(stat.ino.toString());

                return hash.digest('hex');
            });
    }

    /**
     * Deletes a file at the specified path.
     * @param path The path to the file to delete.
     * @returns A TaskEither indicating success or failure.
     */
    deleteFile (path: string): TaskEither<void> {
        return TaskEither
            .tryCatch(
                () => pfs.unlink(path),
                'Failed to delete file',
            )
            .orElse((err) => {
                if (err.error.message.includes('ENOENT')) {
                    return TaskEither.of(undefined);
                }

                return TaskEither.error(createUnknownError('Failed to delete file')(err.error));
            });
    }

    /**
     * Deletes all files with a specified prefix.
     * @param prefix The prefix to match files against.
     * @returns A TaskEither indicating success or failure.
     */
    deleteFilesWithPrefix (prefix: string): TaskEither<void> {
        return this.listFiles(prefix)
            .chainItems((file) => this.deleteFile(file))
            .map(() => undefined);
    }

    /**
     * Checks if a file exists at the specified path.
     * @param path The path to check.
     * @returns A TaskEither containing true if the file exists, false otherwise.
     */
    exists (path: string): TaskEither<boolean> {
        return TaskEither
            .tryCatch(
                () => pfs.stat(path),
                'Failed to check file existence',
            )
            .map((stat) => stat.isFile())
            .orElse(() => TaskEither.of(false));
    }

    /**
     * Gets the base path for a given file ID.
     * @param fileId The file ID.
     * @returns The base path for the file ID.
     */
    getBasePath (fileId: string): string {
        return path.join(this.cacheDirectory, fileId);
    }

    /**
     * Gets a media source for a file at the specified path.
     * @param filePath The path to the file.
     * @returns A MediaSource object for the file.
     */
    getFileStream (filePath: string): TaskEither<NodeJS.ReadableStream> {
        return TaskEither
            .tryCatch(
                () => pfs.access(filePath, fs.constants.F_OK),
                'Failed to create read stream',
            )
            .map(() => fs.createReadStream(filePath));
    }

    /**
     * Lists all files that begin with the given prefix.
     * @param prefix The path prefix to search for.
     */
    listFiles (prefix: string): TaskEither<string[]> {
        const itemStats = (item: string) => TaskEither
            .tryCatch(
                () => pfs.stat(item),
                'Failed to get file stats',
            )
            .map((stat) => ({
                path: item,
                isDirectory: stat.isDirectory(),
            }))
            .matchTask([
                {
                    predicate: (item) => item.isDirectory,
                    // eslint-disable-next-line @typescript-eslint/no-use-before-define
                    run: (item) => readDir(item.path),
                },
                {
                    predicate: (item) => !item.isDirectory,
                    run: (item) => TaskEither.of([item.path]),
                },
            ]);

        const readDir = (dir: string): TaskEither<string[]> => TaskEither
            .tryCatch(
                () => pfs.readdir(dir),
                'Failed to read directory',
            )
            .chainItems(itemStats)
            .map((items) => items.flat());

        return TaskEither
            .tryCatch(
                () => pfs.readdir(prefix),
                'Failed to read directory',
            )
            .chainItems(itemStats)
            .map((items) => items.flat());
    }

    /**
     * Saves data from a readable stream to storage.
     * @param filePath The destination path.
     * @param content The readable stream containing the data to save.
     */
    saveFile (filePath: string, content: NodeJS.ReadableStream): TaskEither<void> {
        const promise = new Promise<void>((resolve, reject) => {
            const writeStream = fs.createWriteStream(filePath);

            content.on('error', reject);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            content.pipe(writeStream);
        });

        return TaskEither
            .of(fs.mkdirSync(path.dirname(filePath), { recursive: true }))
            .chain(() => TaskEither
                .tryCatch(
                    () => promise,
                    'Failed to save file',
                ));
    }

    /**
     * Gets the size of a file in bytes.
     * @param path The path to the file.
     * @returns A TaskEither containing the file size or an error.
     */
    getFileSize (path: string): TaskEither<number> {
        return this.exists(path)
            .filter(
                (exists) => exists,
                () => createNotFoundError(`File not found: ${path}`),
            )
            .chain(() => TaskEither
                .tryCatch(
                    () => pfs.stat(path),
                    'Failed to get file size',
                )
                .map((stat) => stat.size));
    }

    /**
     * Ensures that the directory for a given path exists.
     * @param path The path of the directory to check.
     * @returns A TaskEither containing the path if successful, or an error.
     */
    ensureDirectoryExists (path: string): TaskEither<string> {
        return TaskEither
            .tryCatch(
                () => pfs.mkdir(path, { recursive: true }),
                'Failed to create directory',
            )
            .map(() => path);
    }
}
