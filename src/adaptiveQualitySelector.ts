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

import { createNotFoundError, TaskEither } from '@eleven-am/fp';

import { MediaMetadata, VideoInfo, VideoQuality, VideoQualityEnum } from './types';

export interface AdaptiveQualityResult {
	selectedQualities: VideoQuality[];
	reason: string;
	complexityScore: number;
}

/**
 * Analyzes video content and selects optimal quality levels
 * Prevents upscaling and adjusts bitrates based on content complexity
 */
export class AdaptiveQualitySelector {
	private readonly qualityLevels: VideoQuality[] = [
		{ value: VideoQualityEnum.P240, height: 426, averageBitrate: 500000, maxBitrate: 700000 },
		{ value: VideoQualityEnum.P360, height: 640, averageBitrate: 800000, maxBitrate: 1000000 },
		{ value: VideoQualityEnum.P480, height: 854, averageBitrate: 1200000, maxBitrate: 1500000 },
		{ value: VideoQualityEnum.P720, height: 1280, averageBitrate: 2500000, maxBitrate: 3000000 },
		{ value: VideoQualityEnum.P1080, height: 1920, averageBitrate: 4500000, maxBitrate: 5500000 },
		{ value: VideoQualityEnum.P1440, height: 2560, averageBitrate: 9000000, maxBitrate: 11000000 },
		{ value: VideoQualityEnum.P4K, height: 3840, averageBitrate: 18000000, maxBitrate: 22000000 },
		{ value: VideoQualityEnum.P8K, height: 7680, averageBitrate: 50000000, maxBitrate: 60000000 },
	];

	/**
	 * Select optimal quality levels based on source video characteristics
	 */
	selectOptimalQualities (metadata: MediaMetadata): TaskEither<AdaptiveQualityResult> {
		return TaskEither.of(metadata)
			.map(md => md.videos[0])
			.filter(
				video => video !== undefined,
				() => createNotFoundError('No video stream found in metadata'),
			)
			.chain(video =>
				this.analyzeComplexityTask(metadata, video)
					.map(complexityScore => ({ video, complexityScore })),
			)
			.map(({ video, complexityScore }) => ({
				video,
				complexityScore,
				applicableQualities: this.filterQualitiesBySource(video),
			}))
			.map(data => ({
				...data,
				adjustedQualities: this.adjustBitratesForComplexity(
					data.applicableQualities,
					data.complexityScore,
					data.video,
				),
			}))
			.map(data => ({
				...data,
				finalQualities: this.addOriginalQualityIfNeeded(data.adjustedQualities, data.video),
			}))
			.map(data => ({
				selectedQualities: data.finalQualities,
				reason: this.generateSelectionReason(data.video, data.complexityScore, data.finalQualities),
				complexityScore: data.complexityScore,
			}));
	}

	/**
	 * Get recommended quality based on network conditions
	 */
	getRecommendedQuality (availableBandwidth: number, qualities: VideoQuality[]): TaskEither<VideoQuality> {
		const calculateTargetBitrate = (bandwidth: number) => bandwidth * 0.7;
		const sortByBitrateAsc = (qs: VideoQuality[]) => [...qs].sort((a, b) => a.averageBitrate - b.averageBitrate);
		const findBestFit = (sorted: VideoQuality[], target: number) =>
			sorted.reverse().find(q => q.averageBitrate <= target) || sorted[0];

		return TaskEither.of({ availableBandwidth, qualities })
			.filter(
				data => data.qualities.length > 0,
				() => createNotFoundError('No qualities available'),
			)
			.map(data => ({
				...data,
				targetBitrate: calculateTargetBitrate(data.availableBandwidth),
			}))
			.map(data => ({
				...data,
				sorted: sortByBitrateAsc(data.qualities),
			}))
			.map(data => findBestFit(data.sorted, data.targetBitrate))
			.filter(
				quality => quality !== undefined,
				() => createNotFoundError('No suitable quality found'),
			);
	}

	/**
	 * Analyze video complexity based on metadata - TaskEither version
	 */
	private analyzeComplexityTask (metadata: MediaMetadata, video: VideoInfo): TaskEither<number> {
		return TaskEither.of({ metadata, video })
			.map(data => ({
				...data,
				baseScore: 0.5,
				bitrateFactor: this.calculateBitrateFactor(data.video),
			}))
			.map(data => ({
				...data,
				scoreAfterBitrate: this.adjustScoreForBitrate(data.baseScore, data.bitrateFactor),
			}))
			.map(data => ({
				...data,
				scoreAfterFrameRate: this.adjustScoreForFrameRate(data.scoreAfterBitrate, data.video.frameRate),
			}))
			.map(data => ({
				...data,
				scoreAfterCodec: this.adjustScoreForCodec(data.scoreAfterFrameRate, data.video.codec),
			}))
			.map(data => ({
				...data,
				scoreAfterDuration: this.adjustScoreForDuration(data.scoreAfterCodec, data.metadata.duration),
			}))
			.map(data => this.normalizeScore(data.scoreAfterDuration));
	}

	// Pure helper functions
	private calculateBitrateFactor = (video: VideoInfo): number =>
		video.bitrate / (video.width * video.height * video.frameRate);

	private adjustScoreForBitrate = (score: number, bitrateFactor: number): number =>
		bitrateFactor > 0.15 ? score + 0.2 :
			bitrateFactor < 0.05 ? score - 0.2 :
				score;

	private adjustScoreForFrameRate = (score: number, frameRate: number): number =>
		frameRate > 30 ? score + 0.1 :
			frameRate < 25 ? score - 0.1 :
				score;

	private adjustScoreForCodec = (score: number, codec: string): number =>
		(codec.includes('hevc') || codec.includes('h265')) ? score + 0.1 : score;

	private adjustScoreForDuration = (score: number, duration: number): number =>
		duration > 3600 ? score + 0.05 : score;

	private normalizeScore = (score: number): number =>
		Math.max(0, Math.min(1, score));

	/**
	 * Filter quality levels to prevent upscaling
	 */
	private filterQualitiesBySource (video: VideoInfo): VideoQuality[] {
		return this.qualityLevels.filter((quality) => {
			// Never upscale
			if (quality.height > video.height) {
				return false;
			}

			// Skip very low qualities for high-res sources
			if (video.height >= 1920 && quality.height < 480) {
				return false;
			}

			return true;
		});
	}

	/**
	 * Adjust bitrates based on content complexity
	 */
	private adjustBitratesForComplexity (
		qualities: VideoQuality[],
		complexityScore: number,
		video: VideoInfo,
	): VideoQuality[] {
		return qualities.map((quality) => {
			// Calculate scale factor based on resolution ratio
			const scaleFactor = (quality.height / video.height) ** 2;

			// Adjust bitrate based on complexity
			let bitrateMultiplier = 1.0;

			if (complexityScore < 0.3) {
				// Simple content (presentations, screencasts)
				bitrateMultiplier = 0.6;
			} else if (complexityScore < 0.5) {
				// Medium-simple content
				bitrateMultiplier = 0.8;
			} else if (complexityScore > 0.7) {
				// Complex content (action, nature documentaries)
				bitrateMultiplier = 1.2;
			}

			// Apply scale factor for lower resolutions
			bitrateMultiplier *= Math.sqrt(scaleFactor);

			return {
				...quality,
				averageBitrate: Math.round(quality.averageBitrate * bitrateMultiplier),
				maxBitrate: Math.round(quality.maxBitrate * bitrateMultiplier),
			};
		});
	}

	/**
	 * Add original quality option for high-quality sources
	 */
	private addOriginalQualityIfNeeded (qualities: VideoQuality[], video: VideoInfo): VideoQuality[] {
		// Add original quality for high-res, high-bitrate sources
		if (video.height >= 1920 && video.bitrate > 10000000) {
			return [
				...qualities,
				{
					value: VideoQualityEnum.ORIGINAL,
					height: video.height,
					averageBitrate: video.bitrate,
					maxBitrate: Math.round(video.bitrate * 1.2),
				},
			];
		}

		return qualities;
	}

	/**
	 * Generate human-readable reason for quality selection
	 */
	private generateSelectionReason (
		video: VideoInfo,
		complexityScore: number,
		selectedQualities: VideoQuality[],
	): string {
		const parts: string[] = [];

		parts.push(`Source: ${video.width}x${video.height} @ ${video.frameRate}fps`);

		if (complexityScore < 0.3) {
			parts.push('Content identified as simple (low motion/detail)');
		} else if (complexityScore > 0.7) {
			parts.push('Content identified as complex (high motion/detail)');
		}

		const skippedUpscaling = this.qualityLevels.filter((q) => q.height > video.height).length;

		if (skippedUpscaling > 0) {
			parts.push(`Skipped ${skippedUpscaling} qualities to prevent upscaling`);
		}

		parts.push(`Selected ${selectedQualities.length} quality levels`);

		return parts.join('. ');
	}
}
