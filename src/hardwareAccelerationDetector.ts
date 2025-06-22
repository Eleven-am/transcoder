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

import { exec } from 'child_process';
import * as os from 'os';
import { promisify } from 'util';

import { createBadRequestError, createInternalError, TaskEither } from '@eleven-am/fp';

import { HardwareOptimizer } from './hardwareOptimizer';
import { CodecType, FFMPEGOptions, HardwareAccelerationConfig, HardwareAccelerationMethod } from './types';

const execAsync = promisify(exec);

export class HardwareAccelerationDetector {
	/**
     * Detect the best available hardware acceleration method
     * @returns A TaskEither with the hardware acceleration configuration
     */
	detectHardwareAcceleration (): TaskEither<HardwareAccelerationConfig> {
		const platform = os.platform();

		return this.checkFfmpegHardwareAccelerationSupport()
			.matchTask([
				{
					predicate: (isSupported) => !isSupported,
					run: () => TaskEither.of(this.getSoftwareConfig()),
				},
				{
					predicate: () => platform === 'darwin',
					run: () => this.detectVideoToolbox()
						.orElse(() => this.detectCuda()),
				},
				{
					predicate: () => platform === 'linux',
					run: () => this.detectVAAPI()
						.orElse(() => this.detectCuda())
						.orElse(() => this.detectQsv()),
				},
				{
					predicate: () => platform === 'win32',
					run: () => this.detectCuda()
						.orElse(() => this.detectAmf())
						.orElse(() => this.detectQsv()),
				},
			])
			.orElse(() => TaskEither.of(this.getSoftwareConfig()));
	}

	/**
     * Apply the hardware acceleration configuration to FFmpeg options
     * @param hwConfig Hardware acceleration configuration
     * @param width Target width
     * @param height Target height
     * @param codec Target codec (h264 or h265)
     * @returns Object with inputOptions, outputOptions, and videoFilters
     */
	applyHardwareConfig (
		hwConfig: HardwareAccelerationConfig | null,
		width: number,
		height: number,
		codec: CodecType = 'h264',
		frameRate = 30,
		bitrate = 4000000,
		isLiveStream = false,
	): FFMPEGOptions {
		hwConfig = hwConfig || this.getSoftwareConfig();

		// Use hardware optimizer for optimal settings
		const optimizer = new HardwareOptimizer();
		const optimizedSettingsEither = optimizer.getOptimalSettings({
			method: hwConfig.method,
			codec,
			width,
			height,
			frameRate,
			bitrate,
			isLiveStream,
		});

		// Extract the value from Either
		const optimizedSettings = optimizedSettingsEither.toValue();

		// Merge with existing config
		const baseOutputOptions = hwConfig.outputOptions[codec] || hwConfig.outputOptions['h264'];

		// Combine options, with optimized settings taking precedence
		const outputOptions = [
			...baseOutputOptions,
			...optimizedSettings.outputOptions.filter((opt) => {
				// Filter out duplicate options
				const optKey = opt.split(' ')[0];

				return !baseOutputOptions.some((baseOpt) => baseOpt.startsWith(optKey));
			}),
		];

		let videoFilters = optimizedSettings.videoFilters || '';

		// Add scale filter if needed
		if (hwConfig.videoFilters.scale && !videoFilters.includes('scale')) {
			const scaleFilter = hwConfig.videoFilters.scale
				.replace('%width%', width.toString())
				.replace('%height%', height.toString());

			if (videoFilters) {
				videoFilters += ',';
			}
			videoFilters += scaleFilter;
		}

		// Add deinterlace if needed
		if (hwConfig.videoFilters.deinterlace && !videoFilters.includes('deinterlace')) {
			if (videoFilters) {
				videoFilters += ',';
			}
			videoFilters += hwConfig.videoFilters.deinterlace;
		}

		// Get optimal thread count for software encoding
		const threadCount = optimizer.getOptimalThreadCount(width, height, hwConfig.method);

		const finalOutputOptions = threadCount
			? [...outputOptions, '-threads', threadCount.toString()]
			: outputOptions;

		return {
			inputOptions: [...hwConfig.inputOptions, ...optimizedSettings.inputOptions],
			outputOptions: finalOutputOptions,
			videoFilters,
		};
	}

	/**
     * Check if FFmpeg supports hardware acceleration with comprehensive testing
     * @returns A TaskEither with a boolean indicating if hardware acceleration is supported
     */
	private checkFfmpegHardwareAccelerationSupport (): TaskEither<boolean> {
		const checkFfmpegInstallTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -version'),
				'Failed to check FFmpeg installation',
			)
			.map((result) => result.stdout.includes('ffmpeg version'))
			.orElse(() => TaskEither.of(false));

		const checkFfmpegVersionTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -version'),
				'Failed to check FFmpeg version',
			)
			.map((result) => {
				const versionMatch = result.stdout.match(/ffmpeg version (\d+)\.(\d+)/);

				if (!versionMatch) {
					return false;
				}

				const major = parseInt(versionMatch[1], 10);
				const minor = parseInt(versionMatch[2], 10);

				return major > 4 || (major === 4 && minor >= 0);
			})
			.orElse(() => TaskEither.of(false));

		const checkHwAccelListTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -hwaccels'),
				'Failed to check hardware acceleration methods',
			)
			.map((result) => {
				const output = result.stdout.toLowerCase();

				return output.includes('hardware acceleration') ||
                    output.includes('hwaccels') ||
                    (output.includes('cuda') || output.includes('vaapi') ||
                        output.includes('videotoolbox') || output.includes('qsv') ||
                        output.includes('dxva2') || output.includes('d3d11va'));
			})
			.orElse(() => TaskEither.of(false));

		const checkHardwareCodecsTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -encoders'),
				'Failed to check hardware encoders',
			)
			.map((result) => {
				const output = result.stdout.toLowerCase();

				return output.includes('nvenc') ||
                    output.includes('vaapi') ||
                    output.includes('videotoolbox') ||
                    output.includes('qsv') ||
                    output.includes('amf') ||
                    output.includes('v4l2');
			})
			.orElse(() => TaskEither.of(false));

		const testBasicFunctionalityTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -f lavfi -i testsrc2=duration=0.1:size=64x64:rate=1 -t 0.1 -f null -c:v libx264 - 2>&1'),
				'Failed to test basic FFmpeg functionality',
			)
			.map((result) => {
				const output = (result.stderr || '') + (result.stdout || '');

				const hasCriticalErrors = output.includes('Unknown encoder') ||
                    output.includes('Encoder not found') ||
                    output.includes('No such file or directory') ||
                    output.includes('Permission denied') ||
                    output.includes('command not found');

				return !hasCriticalErrors;
			})
			.orElse(() => TaskEither.of(false));

		const checkEssentialLibrariesTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -version'),
				'Failed to check FFmpeg libraries',
			)
			.map((result) => {
				const output = result.stdout.toLowerCase();

				return output.includes('libavcodec') &&
                    output.includes('libavformat') &&
                    output.includes('libavutil') &&
                    (output.includes('libx264') || output.includes('openh264'));
			})
			.orElse(() => TaskEither.of(false));

		const checkHardwareConfigTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -version'),
				'Failed to check FFmpeg configuration',
			)
			.map((result) => {
				const output = result.stdout.toLowerCase();

				return output.includes('--enable-cuda') ||
                    output.includes('--enable-vaapi') ||
                    output.includes('--enable-videotoolbox') ||
                    output.includes('--enable-qsv') ||
                    output.includes('--enable-nvenc') ||
                    output.includes('--enable-amf') ||
                    (!output.includes('--disable-cuda') &&
                        !output.includes('--disable-vaapi') &&
                        !output.includes('--disable-videotoolbox'));
			})
			.orElse(() => TaskEither.of(true));

		return TaskEither
			.fromBind({
				ffmpegInstalled: checkFfmpegInstallTask,
				ffmpegVersion: checkFfmpegVersionTask,
				hwAccelList: checkHwAccelListTask,
				hardwareCodecs: checkHardwareCodecsTask,
				basicFunctionality: testBasicFunctionalityTask,
				essentialLibraries: checkEssentialLibrariesTask,
				hardwareConfig: checkHardwareConfigTask,
			})
			.map(({
				ffmpegInstalled,
				ffmpegVersion,
				hwAccelList,
				hardwareCodecs,
				basicFunctionality,
				essentialLibraries,
				hardwareConfig,
			}) => {
				const criticalChecks = ffmpegInstalled && ffmpegVersion && basicFunctionality && essentialLibraries;

				const hardwareChecks = hwAccelList || hardwareCodecs;

				return criticalChecks && hardwareChecks && hardwareConfig;
			});
	}

	/**
     * Detect CUDA (NVIDIA) hardware acceleration support with comprehensive testing
     * @returns A TaskEither with the CUDA hardware acceleration configuration
     */
	private detectCuda (): TaskEither<HardwareAccelerationConfig> {
		const checkCudaSupportTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -hwaccels'),
				'Failed to check CUDA support',
			)
			.map((result) => result.stdout.includes('cuda'));

		const checkNvidiaGpuTask = TaskEither
			.tryCatch(
				() => execAsync('nvidia-smi -L'),
				'Failed to check NVIDIA GPU',
			)
			.map((result) => result.stdout.toLowerCase().includes('gpu'))
			.orElse(() => TaskEither.of(false));

		const checkCuvidDecodersTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -decoders | grep _cuvid'),
				'Failed to check CUVID decoders',
			)
			.map((result) => {
				const decoders = result.stdout
					.split('\n')
					.filter((line) => line.includes('_cuvid'))
					.map((line) => line.trim().split(' ')[1])
					.filter(Boolean);

				return decoders.length > 0;
			})
			.orElse(() => TaskEither.of(false));

		const checkNvencEncodersTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -encoders | grep nvenc'),
				'Failed to check NVENC encoders',
			)
			.map((result) => {
				const encoders = result.stdout
					.split('\n')
					.filter((line) => line.includes('nvenc'))
					.map((line) => line.trim().split(' ')[1])
					.filter(Boolean);

				return encoders.length > 0;
			})
			.orElse(() => TaskEither.of(false));

		const testCudaInitTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -init_hw_device cuda -f null - 2>&1'),
				'Failed to test CUDA initialization',
			)
			.map((result) => {
				const output = (result.stderr || '') + (result.stdout || '');

				return !output.includes('Device creation failed') &&
                    !output.includes('No device available') &&
                    !output.includes('CUDA not available') &&
                    !output.includes('Cannot load nvcuda.dll') &&
                    !output.includes('Cannot load libcuda.so');
			})
			.orElse(() => TaskEither.of(false));

		const testNvencDeviceTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -f lavfi -i testsrc2=duration=1:size=320x240:rate=1 -t 1 -f null -hwaccel cuda -hwaccel_output_format cuda -c:v h264_nvenc - 2>&1'),
				'Failed to test NVENC device',
			)
			.map((result) => {
				const output = (result.stderr || '') + (result.stdout || '');
				const hasDeviceError = output.includes('Device creation failed') ||
                    output.includes('No device available') ||
                    output.includes('CUDA') && (
                    	output.includes('not available') ||
                        output.includes('not supported') ||
                        output.includes('failed') ||
                        output.includes('error')
                    ) ||
                    output.includes('NVENC') && (
                    	output.includes('not available') ||
                        output.includes('not supported') ||
                        output.includes('failed') ||
                        output.includes('error')
                    ) ||
                    output.includes('Hardware device setup failed') ||
                    output.includes('Cannot load nvcuda') ||
                    output.includes('Cannot load libcuda') ||
                    output.includes('No NVENC capable devices found') ||
                    output.includes('Driver does not support NVENC');

				return !hasDeviceError;
			})
			.orElse(() => TaskEither.of(false));

		const testNvencCapabilitiesTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -f lavfi -i testsrc2=duration=0.1:size=64x64:rate=1 -t 0.1 -f null -c:v h264_nvenc - 2>&1'),
				'Failed to test NVENC capabilities',
			)
			.map((result) => {
				const output = (result.stderr || '') + (result.stdout || '');

				const hasCriticalError = output.includes('Unknown encoder') ||
                    output.includes('No NVENC capable devices') ||
                    output.includes('Driver does not support NVENC');

				return !hasCriticalError;
			})
			.orElse(() => TaskEither.of(false));

		const checkNvidiaDriverTask = TaskEither
			.tryCatch(
				() => execAsync('nvidia-smi --query-gpu=driver_version --format=csv,noheader,nounits'),
				'Failed to check NVIDIA driver version',
			)
			.map((result) => {
				const version = result.stdout.trim();
				const versionNumber = parseFloat(version);

				return !isNaN(versionNumber) && versionNumber >= 390;
			})
			.orElse(() => TaskEither.of(true));

		return TaskEither
			.fromBind({
				cudaSupport: checkCudaSupportTask,
				nvidiaGpu: checkNvidiaGpuTask,
				cuvidDecoders: checkCuvidDecodersTask,
				nvencEncoders: checkNvencEncodersTask,
				cudaInit: testCudaInitTask,
				nvencDevice: testNvencDeviceTask,
				nvencCapabilities: testNvencCapabilitiesTask,
				nvidiaDriver: checkNvidiaDriverTask,
			})
			.filter(
				({
					cudaSupport,
					nvidiaGpu,
					cuvidDecoders,
					nvencEncoders,
					cudaInit,
					nvencDevice,
					nvencCapabilities,
					nvidiaDriver,
				}) => cudaSupport && nvidiaGpu && cuvidDecoders && nvencEncoders &&
                    cudaInit && (nvencDevice || nvencCapabilities) && nvidiaDriver,
				() => createInternalError('CUDA/NVENC acceleration not available or device not functional'),
			)
			.map(() => this.getCudaConfig());
	}

	/**
     * Detect VAAPI (Intel/AMD on Linux) hardware acceleration support with comprehensive testing
     * @returns A TaskEither with the VAAPI hardware acceleration configuration
     */
	private detectVAAPI (): TaskEither<HardwareAccelerationConfig> {
		const checkVaapiSupportTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -hwaccels'),
				'Failed to check VAAPI support',
			)
			.map((result) => result.stdout.includes('vaapi'));

		const checkVaapiEncodersTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -encoders | grep vaapi'),
				'Failed to check VAAPI encoders',
			)
			.map((result) => result.stdout.includes('vaapi'));

		const checkVaapiDecodersTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -decoders | grep vaapi'),
				'Failed to check VAAPI decoders',
			)
			.map((result) => result.stdout.includes('vaapi'))
			.orElse(() => TaskEither.of(true));

		const checkRenderDeviceTask = TaskEither
			.tryCatch(
				() => execAsync('ls /dev/dri/renderD*'),
				'Failed to check render device',
			)
			.map((result) => result.stdout.trim().split('\n'))
			.filter(
				(devices) => devices.length > 0,
				() => createInternalError('No render device found'),
			)
			.map(([device]): string | null => device)
			.orElse(() => TaskEither.of(null));

		const checkVainfoTask = TaskEither
			.tryCatch(
				() => execAsync('vainfo'),
				'Failed to check vainfo',
			)
			.map((result) => result.stdout.includes('VAProfile'))
			.orElse(() => TaskEither.of(false));

		const testVaapiDeviceTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -f lavfi -i testsrc2=duration=0.1:size=320x240:rate=1 -t 1 -f null -hwaccel vaapi -hwaccel_output_format vaapi -c:v h264_vaapi - 2>&1'),
				'Failed to test VAAPI device',
			)
			.map((result) => {
				const output = (result.stderr || '') + (result.stdout || '');

				const hasDeviceError = output.includes('Device creation failed') ||
                    output.includes('No device available') ||
                    output.includes('VAAPI') && (
                    	output.includes('not available') ||
                        output.includes('not supported') ||
                        output.includes('failed') ||
                        output.includes('error')
                    ) ||
                    output.includes('Hardware device setup failed') ||
                    output.includes('Cannot load libva') ||
                    output.includes('vaInitialize failed');

				return !hasDeviceError;
			})
			.orElse(() => TaskEither.of(false));

		const testVaapiInitTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -init_hw_device vaapi -f null - 2>&1'),
				'Failed to test VAAPI initialization',
			)
			.map((result) => {
				const output = (result.stderr || '') + (result.stdout || '');

				return !output.includes('Device creation failed') &&
                    !output.includes('No device available') &&
                    !output.includes('vaInitialize failed');
			})
			.orElse(() => TaskEither.of(false));

		return TaskEither
			.fromBind({
				vaapiSupport: checkVaapiSupportTask,
				vaapiEncoders: checkVaapiEncodersTask,
				vaapiDecoders: checkVaapiDecodersTask,
				renderDevice: checkRenderDeviceTask,
				vainfoAvailable: checkVainfoTask,
				vaapiDevice: testVaapiDeviceTask,
				vaapiInit: testVaapiInitTask,
			})
			.filter(
				({
					vaapiSupport,
					vaapiEncoders,
					vaapiDecoders,
					renderDevice,
					vainfoAvailable,
					vaapiDevice,
					vaapiInit,
				}) => vaapiSupport && vaapiEncoders && vaapiDecoders &&
                    Boolean(renderDevice) && vainfoAvailable &&
                    (vaapiDevice || vaapiInit),
				() => createInternalError('VAAPI acceleration not available or device not functional'),
			)
			.map(({ renderDevice }) => this.getVAAPIConfig(renderDevice!));
	}

	/**
     * Detect VideoToolbox (macOS) hardware acceleration support with device testing
     * @returns A TaskEither with the VideoToolbox hardware acceleration configuration
     */
	private detectVideoToolbox (): TaskEither<HardwareAccelerationConfig> {
		if (os.platform() !== 'darwin') {
			return TaskEither.error(createBadRequestError('VideoToolbox is only available on macOS'));
		}

		const checkVideoToolboxEncodersTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -encoders | grep videotoolbox'),
				'Failed to check VideoToolbox encoders',
			)
			.map((result) => result.stdout.includes('videotoolbox'));

		const checkVideoToolboxDecodersTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -decoders | grep videotoolbox'),
				'Failed to check VideoToolbox decoders',
			)
			.map((result) => result.stdout.includes('videotoolbox'))
			.orElse(() => TaskEither.of(true));

		const testVideoToolboxDeviceTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -f lavfi -i testsrc2=duration=1:size=320x240:rate=1 -t 1 -f null -c:v h264_videotoolbox - 2>&1'),
				'Failed to test VideoToolbox device',
			)
			.map((result) => {
				const output = (result.stderr || '') + (result.stdout || '');

				const hasDeviceError = output.includes('VideoToolbox') && (
					output.includes('Error') ||
                    output.includes('Failed') ||
                    output.includes('not available') ||
                    output.includes('not supported') ||
                    output.includes('Invalid argument') ||
                    output.includes('Operation not supported')
				);

				const hasGenericHardwareError = output.includes('Hardware acceleration') &&
                    output.includes('not available');

				return !hasDeviceError && !hasGenericHardwareError;
			})
			.orElse(() => TaskEither.of(false));

		const testVideoToolboxCapabilitiesTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -f videotoolbox -list_devices true -f null - 2>&1'),
				'Failed to check VideoToolbox capabilities',
			)
			.map((result) => {
				const output = (result.stderr || '') + (result.stdout || '');

				return !output.includes('Unknown input format') ||
                    !output.includes('VideoToolbox not available');
			})
			.orElse(() => TaskEither.of(true));

		return TaskEither
			.fromBind({
				videoToolboxEncoders: checkVideoToolboxEncodersTask,
				videoToolboxDecoders: checkVideoToolboxDecodersTask,
				videoToolboxDevice: testVideoToolboxDeviceTask,
				videoToolboxCapabilities: testVideoToolboxCapabilitiesTask,
			})
			.filter(
				({
					videoToolboxEncoders,
					videoToolboxDecoders,
					videoToolboxDevice,
					videoToolboxCapabilities,
				}) => videoToolboxEncoders && videoToolboxDecoders && videoToolboxDevice && videoToolboxCapabilities,
				() => createInternalError('VideoToolbox acceleration not available or device not functional'),
			)
			.map(() => this.getVideoToolboxConfig());
	}

	/**
     * Detect AMF (AMD) hardware acceleration support with device testing
     * @returns A TaskEither with the AMF hardware acceleration configuration
     */
	private detectAmf (): TaskEither<HardwareAccelerationConfig> {
		const checkAmfEncodersTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -encoders'),
				'Failed to check AMF encoders',
			)
			.map((result) => result.stdout.includes('h264_amf') || result.stdout.includes('hevc_amf'));

		const checkAmfHwaccelTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -hwaccels'),
				'Failed to check AMF hwaccel',
			)
			.map((result) => result.stdout.toLowerCase().includes('amf'));

		const testAmfDeviceTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -f lavfi -i testsrc2=duration=1:size=320x240:rate=1 -t 1 -f null -c:v h264_amf - 2>&1'),
				'Failed to test AMF device',
			)
			.map((result) => {
				const output = (result.stderr || '') + (result.stdout || '');
				const errorKeywords = [
					'Device creation failed',
					'No device available',
					'AMF',
					'not available',
					'not supported',
					'failed',
					'error',
				];

				return !errorKeywords.some((keyword) => output.includes(keyword));
			})
			.orElse(() => TaskEither.of(false));

		return TaskEither
			.fromBind({
				amfEncoders: checkAmfEncodersTask,
				amfHwaccel: checkAmfHwaccelTask,
				amfDevice: testAmfDeviceTask,
			})
			.filter(
				({ amfEncoders, amfHwaccel, amfDevice }) => amfEncoders && amfHwaccel && amfDevice,
				() => createInternalError('AMF acceleration not available or device not functional'),
			)
			.map(() => this.getAmfConfig());
	}

	/**
     * Detect Intel QuickSync Video support with device testing
     * @returns A TaskEither with the QSV hardware acceleration configuration
     */
	private detectQsv (): TaskEither<HardwareAccelerationConfig> {
		const checkQsvEncodersTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -encoders | grep qsv'),
				'Failed to check QSV encoders',
			)
			.map((result) => result.stdout.includes('qsv'));

		const checkQsvDecodersTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -decoders | grep qsv'),
				'Failed to check QSV decoders',
			)
			.map((result) => result.stdout.includes('qsv'));

		const testQsvDeviceTask = TaskEither
			.tryCatch(
				() => execAsync('ffmpeg -hide_banner -init_hw_device qsv -f null - 2>&1'),
				'Failed to test QSV device',
			)
			.map((result) => {
				const output = (result.stderr || '') + (result.stdout || '');

				return !output.includes('Device creation failed') &&
                    !output.includes('No device available');
			})
			.orElse(() => TaskEither.of(false));

		return TaskEither
			.fromBind({
				qsvEncoders: checkQsvEncodersTask,
				qsvDecoders: checkQsvDecodersTask,
				qsvDevice: testQsvDeviceTask,
			})
			.filter(
				({ qsvEncoders, qsvDecoders, qsvDevice }) => qsvEncoders && qsvDecoders && qsvDevice,
				() => createInternalError('QSV acceleration not available'),
			)
			.map(() => this.getQsvConfig());
	}

	/**
     * Get software encoding configuration (fallback)
     * @returns Software encoding configuration
     */
	private getSoftwareConfig (): HardwareAccelerationConfig {
		return {
			method: HardwareAccelerationMethod.NONE,
			inputOptions: [],
			outputOptions: {
				h264: ['-c:v', 'libx264', '-preset', 'faster'],
				h265: ['-c:v', 'libx265', '-preset', 'faster'],
			},
			videoFilters: {
				scale: 'scale=w=%width%:h=%height%:force_original_aspect_ratio=decrease:force_divisible_by=2',
			},
		};
	}

	/**
     * Get CUDA hardware acceleration configuration
     * @returns CUDA hardware acceleration configuration
     */
	private getCudaConfig (): HardwareAccelerationConfig {
		return {
			method: HardwareAccelerationMethod.CUDA,
			inputOptions: [
				'-hwaccel',
				'cuda',
				'-hwaccel_output_format',
				'cuda',
			],
			outputOptions: {
				h264: ['-c:v', 'h264_nvenc', '-preset', 'fast', '-tune', 'hq', '-rc', 'constqp', '-cq', '23'],
				h265: ['-c:v', 'hevc_nvenc', '-preset', 'fast', '-tune', 'hq', '-rc', 'constqp', '-cq', '25'],
			},
			videoFilters: {
				scale: 'scale_cuda=w=%width%:h=%height%:force_original_aspect_ratio=decrease:force_divisible_by=2',
				deinterlace: 'yadif_cuda=0:-1:0',
			},
		};
	}

	/**
     * Get VAAPI hardware acceleration configuration
     * @param renderDevice Path to render device (e.g. /dev/dri/renderD128)
     * @returns VAAPI hardware acceleration configuration
     */
	private getVAAPIConfig (renderDevice: string): HardwareAccelerationConfig {
		return {
			method: HardwareAccelerationMethod.VAAPI,
			deviceInfo: renderDevice,
			inputOptions: [
				'-hwaccel',
				'vaapi',
				'-hwaccel_device',
				renderDevice,
				'-hwaccel_output_format',
				'vaapi',
			],
			outputOptions: {
				h264: ['-c:v', 'h264_vaapi', '-qp', '23'],
				h265: ['-c:v', 'hevc_vaapi', '-qp', '25'],
			},
			videoFilters: {
				scale: 'scale_vaapi=w=%width%:h=%height%:force_original_aspect_ratio=decrease:force_divisible_by=2',
			},
		};
	}

	/**
     * Get VideoToolbox hardware acceleration configuration
     * @returns VideoToolbox hardware acceleration configuration
     */
	private getVideoToolboxConfig (): HardwareAccelerationConfig {
		return {
			method: HardwareAccelerationMethod.VIDEOTOOLBOX,
			inputOptions: [],
			outputOptions: {
				h264: ['-c:v', 'h264_videotoolbox', '-q:v', '30'],
				h265: ['-c:v', 'hevc_videotoolbox', '-q:v', '32'],
			},
			videoFilters: {
				scale: 'scale=w=%width%:h=%height%:force_original_aspect_ratio=decrease:force_divisible_by=2',
			},
		};
	}

	/**
     * Get AMD AMF hardware acceleration configuration
     * @returns AMF hardware acceleration configuration
     */
	private getAmfConfig (): HardwareAccelerationConfig {
		return {
			method: HardwareAccelerationMethod.AMF,
			inputOptions: [],
			outputOptions: {
				h264: ['-c:v', 'h264_amf', '-quality', 'balanced'],
				h265: ['-c:v', 'hevc_amf', '-quality', 'balanced'],
			},
			videoFilters: {
				scale: 'scale=w=%width%:h=%height%:force_original_aspect_ratio=decrease:force_divisible_by=2',
			},
		};
	}

	/**
     * Get Intel QuickSync Video hardware acceleration configuration
     * @returns QSV hardware acceleration configuration
     */
	private getQsvConfig (): HardwareAccelerationConfig {
		return {
			method: HardwareAccelerationMethod.QSV,
			inputOptions: [
				'-hwaccel',
				'qsv',
				'-hwaccel_output_format',
				'qsv',
			],
			outputOptions: {
				h264: ['-c:v', 'h264_qsv', '-q', '23'],
				h265: ['-c:v', 'hevc_qsv', '-q', '25'],
			},
			videoFilters: {
				scale: 'scale_qsv=w=%width%:h=%height%:force_divisible_by=2',
			},
		};
	}
}
