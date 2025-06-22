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

import { Either } from '@eleven-am/fp';

import { CodecType, FFMPEGOptions, HardwareAccelerationMethod } from './types';

export interface HardwareOptimizationOptions {
	method: HardwareAccelerationMethod;
	codec: CodecType;
	width: number;
	height: number;
	frameRate: number;
	bitrate: number;
	isLiveStream?: boolean;
}

/**
 * Provides hardware-specific optimizations for different acceleration methods
 * Optimizes encoder settings based on hardware capabilities
 */
export class HardwareOptimizer {
	/**
	 * Get optimal settings for specific hardware acceleration method
	 */
	getOptimalSettings (options: HardwareOptimizationOptions): Either<FFMPEGOptions> {
		const methodHandlers = [
			{
				predicate: (o: HardwareOptimizationOptions) => o.method === HardwareAccelerationMethod.CUDA,
				run: (o: HardwareOptimizationOptions) => this.getNvidiaOptimalSettings(o),
			},
			{
				predicate: (o: HardwareOptimizationOptions) => o.method === HardwareAccelerationMethod.VIDEOTOOLBOX,
				run: (o: HardwareOptimizationOptions) => this.getVideoToolboxOptimalSettings(o),
			},
			{
				predicate: (o: HardwareOptimizationOptions) => o.method === HardwareAccelerationMethod.QSV,
				run: (o: HardwareOptimizationOptions) => this.getQuickSyncOptimalSettings(o),
			},
			{
				predicate: (o: HardwareOptimizationOptions) => o.method === HardwareAccelerationMethod.VAAPI,
				run: (o: HardwareOptimizationOptions) => this.getVaapiOptimalSettings(o),
			},
			{
				predicate: (o: HardwareOptimizationOptions) => o.method === HardwareAccelerationMethod.AMF,
				run: (o: HardwareOptimizationOptions) => this.getAMFOptimalSettings(o),
			},
			{
				predicate: () => true, // Default case
				run: (o: HardwareOptimizationOptions) => this.getSoftwareOptimalSettings(o),
			},
		];

		return Either.of(options).match(methodHandlers);
	}

	/**
	 * NVIDIA GPU optimizations
	 */
	private getNvidiaOptimalSettings (options: HardwareOptimizationOptions): FFMPEGOptions {
		const selectEncoder = (codec: CodecType) => codec === 'h265' ? 'hevc_nvenc' : 'h264_nvenc';
		
		const baseInputOptions = () => [
			'-hwaccel', 'cuda',
			'-hwaccel_output_format', 'cuda',
		];

		const baseOutputOptions = (encoder: string) => [
			'-c:v', encoder,
			'-preset', 'p4',
			'-tune', 'hq',
			'-rc', 'vbr',
			'-rc-lookahead', '32',
			'-temporal-aq', '1',
			'-spatial-aq', '1',
			'-b_ref_mode', 'middle',
		];

		const addResolutionOptions = (height: number, frameRate: number) => {
			const gopSize = String(frameRate * 2);
			return height >= 2160 ? ['-tier', 'high', '-level', '5.1', '-g', gopSize] :
			       height >= 1440 ? ['-level', '5.0', '-g', gopSize] :
			       ['-g', gopSize];
		};

		const addLiveStreamOptions = (isLive?: boolean) => 
			isLive ? ['-zerolatency', '1', '-preset', 'p2'] : [];

		const addBFrameOptions = (codec: CodecType) => 
			['-bf', codec === 'h264' ? '3' : '4'];

		const encoder = selectEncoder(options.codec);
		
		return Either.of({
			inputOptions: baseInputOptions(),
			outputOptions: [
				...baseOutputOptions(encoder),
				...addResolutionOptions(options.height, options.frameRate),
				...addLiveStreamOptions(options.isLiveStream),
				...addBFrameOptions(options.codec),
			],
			videoFilters: undefined,
		}).toValue();
	}

	/**
	 * Apple VideoToolbox optimizations
	 */
	private getVideoToolboxOptimalSettings (options: HardwareOptimizationOptions): FFMPEGOptions {
		const encoder = options.codec === 'h265' ? 'hevc_videotoolbox' : 'h264_videotoolbox';

		const inputOptions = [
			'-hwaccel', 'videotoolbox',
		];

		const outputOptions = [
			'-c:v', encoder,
			'-profile:v', options.codec === 'h265' ? 'main' : 'high',
			'-realtime', options.isLiveStream ? '1' : '0',
		];

		// Quality vs speed trade-off
		if (!options.isLiveStream) {
			outputOptions.push(
				'-allow_sw', '1', // Allow software fallback for better quality
				'-alpha_quality', '0.75',
				'-compression_level', '0.5', // Better compression
			);
		}

		// Frame rate specific
		if (options.frameRate > 30) {
			outputOptions.push('-max_slice_bytes', '1500'); // For high frame rates
		}

		// Resolution specific
		if (options.height >= 2160) {
			outputOptions.push(
				'-pix_fmt', 'yuv420p10le', // 10-bit for 4K
			);
		} else {
			outputOptions.push(
				'-pix_fmt', 'yuv420p',
			);
		}

		return {
			inputOptions,
			outputOptions,
			videoFilters: undefined,
		};
	}

	/**
	 * Intel Quick Sync optimizations
	 */
	private getQuickSyncOptimalSettings (options: HardwareOptimizationOptions): FFMPEGOptions {
		const encoder = options.codec === 'h265' ? 'hevc_qsv' : 'h264_qsv';

		const inputOptions = [
			'-hwaccel', 'qsv',
			'-hwaccel_output_format', 'qsv',
		];

		const outputOptions = [
			'-c:v', encoder,
			'-preset', 'medium', // Better than 'fast' for quality
			'-global_quality', '25', // Quality parameter for QSV
			'-look_ahead', '1', // Enable lookahead
			'-look_ahead_depth', '40', // Lookahead depth
		];

		// Adaptive encoding features
		if (!options.isLiveStream) {
			outputOptions.push(
				'-adaptive_i', '1', // Adaptive I-frame placement
				'-adaptive_b', '1', // Adaptive B-frame placement
				'-b_strategy', '1', // B-frame strategy
			);
		}

		// High resolution optimizations
		if (options.height >= 1440) {
			outputOptions.push(
				'-rdo', '1', // Rate distortion optimization
				'-max_frame_size', String(Math.round(options.bitrate / options.frameRate / 8 * 1.5)),
			);
		}

		return {
			inputOptions,
			outputOptions,
			videoFilters: undefined,
		};
	}

	/**
	 * VAAPI (AMD/Intel integrated) optimizations
	 */
	private getVaapiOptimalSettings (options: HardwareOptimizationOptions): FFMPEGOptions {
		const encoder = options.codec === 'h265' ? 'hevc_vaapi' : 'h264_vaapi';

		const inputOptions = [
			'-hwaccel', 'vaapi',
			'-hwaccel_device', '/dev/dri/renderD128',
			'-hwaccel_output_format', 'vaapi',
		];

		const outputOptions = [
			'-c:v', encoder,
			'-quality', '1', // Quality mode
			'-compression_level', '1', // Better compression
		];

		// Rate control
		if (options.isLiveStream) {
			outputOptions.push(
				'-rc_mode', 'CBR', // Constant bitrate for streaming
			);
		} else {
			outputOptions.push(
				'-rc_mode', 'VBR', // Variable bitrate for files
			);
		}

		// Profile settings
		if (options.codec === 'h264') {
			outputOptions.push(
				'-profile', '100', // High profile
				'-level', '41',
			);
		}

		return {
			inputOptions,
			outputOptions,
			videoFilters: 'format=nv12|vaapi,hwupload', // Upload to VAAPI surface
		};
	}

	/**
	 * AMD AMF optimizations
	 */
	private getAMFOptimalSettings (options: HardwareOptimizationOptions): FFMPEGOptions {
		const encoder = options.codec === 'h265' ? 'hevc_amf' : 'h264_amf';

		const outputOptions = [
			'-c:v', encoder,
			'-quality', 'balanced', // Quality preset
			'-rc', 'vbr_peak', // Peak constrained VBR
			'-preanalysis', '1', // Enable pre-analysis
		];

		// Quality enhancements
		if (!options.isLiveStream) {
			outputOptions.push(
				'-preencode', '1', // Pre-encode for better quality
				'-vbaq', '1', // Variance based adaptive quantization
			);
		}

		// Resolution specific
		if (options.height >= 1440) {
			outputOptions.push(
				'-pa_activity_type', 'y', // Luma-based activity
				'-pa_scene_change_detection', '1',
			);
		}

		return {
			inputOptions: [],
			outputOptions,
			videoFilters: undefined,
		};
	}

	/**
	 * Software encoding optimizations
	 */
	private getSoftwareOptimalSettings (options: HardwareOptimizationOptions): FFMPEGOptions {
		const encoder = options.codec === 'h265' ? 'libx265' : 'libx264';

		const outputOptions = [
			'-c:v', encoder,
		];

		if (encoder === 'libx264') {
			outputOptions.push(
				'-preset', options.isLiveStream ? 'faster' : 'medium',
				'-tune', this.getX264Tune(options),
				'-x264-params', this.getX264Params(options),
			);
		} else {
			outputOptions.push(
				'-preset', options.isLiveStream ? 'faster' : 'medium',
				'-x265-params', this.getX265Params(options),
			);
		}

		return {
			inputOptions: [],
			outputOptions,
			videoFilters: undefined,
		};
	}

	/**
	 * Get x264 tuning based on content
	 */
	private getX264Tune (options: HardwareOptimizationOptions): string {
		if (options.isLiveStream) {
			return 'zerolatency';
		}

		// Could be extended to detect content type
		return 'film'; // Good default
	}

	/**
	 * Get x264 specific parameters
	 */
	private getX264Params (options: HardwareOptimizationOptions): string {
		const params: string[] = [
			'aq-mode=3', // AQ mode 3 is good for most content
			'aq-strength=0.8',
			'deblock=-1,-1', // Slight deblocking
		];

		if (!options.isLiveStream) {
			params.push(
				'rc-lookahead=60',
				'b-adapt=2',
				'direct=auto',
			);
		}

		return params.join(':');
	}

	/**
	 * Get x265 specific parameters
	 */
	private getX265Params (options: HardwareOptimizationOptions): string {
		const params: string[] = [
			'aq-mode=3',
			'aq-strength=0.8',
			'deblock=-1:-1',
		];

		if (options.height >= 2160) {
			params.push(
				'ctu=64', // Larger CTU for 4K
				'min-cu-size=8',
			);
		}

		if (!options.isLiveStream) {
			params.push(
				'rc-lookahead=40',
				'b-adapt=2',
				'weightb=1',
			);
		}

		return params.join(':');
	}

	/**
	 * Get recommended thread count based on resolution and hardware
	 */
	getOptimalThreadCount (width: number, height: number, method: HardwareAccelerationMethod): number | undefined {
		// Hardware encoders handle threading internally
		if (method !== HardwareAccelerationMethod.NONE) {
			return undefined;
		}

		// For software encoding
		const pixels = width * height;

		if (pixels >= 3840 * 2160) { // 4K
			return 8;
		} else if (pixels >= 1920 * 1080) { // 1080p
			return 6;
		} else if (pixels >= 1280 * 720) { // 720p
			return 4;
		}

		return 3; // Lower resolutions
	}
}