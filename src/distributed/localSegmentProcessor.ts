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

import * as fs from 'fs';
import * as path from 'path';

import ffmpeg from '../ffmpeg';
import { ISegmentProcessor, SegmentProcessingData, SegmentProcessingResult } from './interfaces';

/**
 * Local segment processor - processes segments on the current machine
 * This is the default processor that maintains backward compatibility
 */
export class LocalSegmentProcessor implements ISegmentProcessor {
	private disposed = false;

	private readonly workerId: string;

	constructor (workerId?: string) {
		this.workerId = workerId || process.env.HOSTNAME || `local-${Date.now()}`;
	}

	async processSegment (data: SegmentProcessingData): Promise<SegmentProcessingResult> {
		const startTime = Date.now();

		try {
			// Check if segment already exists
			if (await this.segmentExists(data.outputPath)) {
				return {
					success: true,
					segmentIndex: data.segmentIndex,
					outputPath: data.outputPath,
					cached: true,
					processingTime: Date.now() - startTime,
				};
			}

			// Process the segment using FFmpeg
			await this.runFFmpeg(data);

			return {
				success: true,
				segmentIndex: data.segmentIndex,
				outputPath: data.outputPath,
				processingTime: Date.now() - startTime,
			};
		} catch (error) {
			return {
				success: false,
				segmentIndex: data.segmentIndex,
				outputPath: data.outputPath,
				processingTime: Date.now() - startTime,
				error: error as Error,
			};
		}
	}

	private async runFFmpeg (data: SegmentProcessingData): Promise<void> {
		const { inputOptions, outputOptions, videoFilters } = data.ffmpegOptions;

		// Ensure output directory exists (async)
		const outputDir = path.dirname(data.outputPath);

		await fs.promises.mkdir(outputDir, { recursive: true });

		// Create temp file path with worker ID to avoid collisions
		const tempPath = `${data.outputPath}.${this.workerId}.tmp`;

		return new Promise((resolve, reject) => {
			const command = ffmpeg(data.sourceFilePath)
				.inputOptions(inputOptions)
				.outputOptions(outputOptions)
				.output(tempPath);

			if (videoFilters) {
				command.videoFilters(videoFilters);
			}

			command.on('end', async () => {
				try {
					// Atomic rename from temp to final path
					await fs.promises.rename(tempPath, data.outputPath);
					resolve();
				} catch (renameError: any) {
					// If rename fails due to file already existing, that's ok
					if (renameError.code === 'EEXIST') {
						console.log(`Segment ${data.segmentIndex} already exists (lost race to another worker)`);
						// Clean up our temp file
						await fs.promises.unlink(tempPath).catch(() => {});
						resolve();
					} else {
						reject(renameError);
					}
				}
			});
			command.on('error', async (err) => {
				// Attempt to clean up temp file on error
				try {
					await fs.promises.unlink(tempPath);
				} catch (unlinkError) {
					// Ignore unlink errors - file may not exist
				}
				reject(err);
			});

			command.run();
		});
	}

	private async segmentExists (filePath: string): Promise<boolean> {
		try {
			await fs.promises.access(filePath);

			return true;
		} catch {
			return false;
		}
	}

	async isHealthy (): Promise<boolean> {
		// Local processor is always healthy
		return !this.disposed;
	}

	getMode (): 'local' | 'distributed' {
		return 'local';
	}

	async dispose (): Promise<void> {
		this.disposed = true;
	}
}
