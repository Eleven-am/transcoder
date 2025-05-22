import { exec } from 'child_process';
import os from 'os';
import { promisify } from 'util';

import { createBadRequestError, createInternalError, TaskEither } from '@eleven-am/fp';

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
    applyHardwareConfig (hwConfig: HardwareAccelerationConfig | null, width: number, height: number, codec: CodecType = 'h264'): FFMPEGOptions {
        hwConfig = hwConfig || this.getSoftwareConfig();
        const outputOptions = hwConfig.outputOptions[codec] || hwConfig.outputOptions['h264'];

        let videoFilters = '';

        if (hwConfig.videoFilters.scale) {
            const scaleFilter = hwConfig.videoFilters.scale
                .replace('%width%', width.toString())
                .replace('%height%', height.toString());

            videoFilters += scaleFilter;
        }

        if (hwConfig.videoFilters.deinterlace) {
            if (videoFilters) {
                videoFilters += ',';
            }
            videoFilters += hwConfig.videoFilters.deinterlace;
        }

        return {
            inputOptions: hwConfig.inputOptions,
            outputOptions,
            videoFilters,
        };
    }

    /**
     * Check if FFmpeg supports hardware acceleration listing
     * @returns A TaskEither with a boolean indicating if hardware acceleration is supported
     */
    private checkFfmpegHardwareAccelerationSupport (): TaskEither<boolean> {
        return TaskEither
            .tryCatch(
                () => execAsync('ffmpeg -hide_banner -hwaccels'),
                'Failed to check FFmpeg hardware acceleration support',
            )
            .map((result) => result.stdout.includes('Hardware acceleration methods:'))
            .orElse(() => TaskEither.of(false));
    }

    /**
     * Detect CUDA (NVIDIA) hardware acceleration support
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

        return TaskEither
            .fromBind({
                cudaSupport: checkCudaSupportTask,
                nvidiaGpu: checkNvidiaGpuTask,
                cuvidDecoders: checkCuvidDecodersTask,
                nvencEncoders: checkNvencEncodersTask,
            })
            .filter(
                ({
                    cudaSupport,
                    nvidiaGpu,
                    cuvidDecoders,
                    nvencEncoders,
                }) => cudaSupport && nvidiaGpu && cuvidDecoders && nvencEncoders,
                () => createInternalError('CUDA acceleration not available'),
            )
            .map(() => this.getCudaConfig());
    }

    /**
     * Detect VAAPI (Intel/AMD on Linux) hardware acceleration support
     * @returns A TaskEither with the VAAPI hardware acceleration configuration
     */
    private detectVAAPI (): TaskEither<HardwareAccelerationConfig> {
        const checkVaapiSupportTask = TaskEither
            .tryCatch(
                () => execAsync('ffmpeg -hide_banner -hwaccels'),
                'Failed to check VAAPI support',
            )
            .map((result) => result.stdout.includes('vaapi'));

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

        return TaskEither
            .fromBind({
                vaapiSupport: checkVaapiSupportTask,
                renderDevice: checkRenderDeviceTask,
                vainfoAvailable: checkVainfoTask,
            })
            .filter(
                ({
                    vaapiSupport,
                    renderDevice,
                    vainfoAvailable,
                }) => vaapiSupport && Boolean(renderDevice) && vainfoAvailable,
                () => createInternalError('VAAPI acceleration not available'),
            )
            .map(({ renderDevice }) => this.getVAAPIConfig(renderDevice!));
    }

    /**
     * Detect VideoToolbox (macOS) hardware acceleration support
     * @returns A TaskEither with the VideoToolbox hardware acceleration configuration
     */
    private detectVideoToolbox (): TaskEither<HardwareAccelerationConfig> {
        if (os.platform() !== 'darwin') {
            return TaskEither.error(createBadRequestError('VideoToolbox is only available on macOS'));
        }

        return TaskEither
            .tryCatch(
                () => execAsync('ffmpeg -hide_banner -encoders | grep videotoolbox'),
                'Failed to check VideoToolbox support',
            )
            .map((result) => result.stdout.includes('videotoolbox'))
            .filter(
                (supported) => supported,
                () => createInternalError('VideoToolbox acceleration not available'),
            )
            .map(() => this.getVideoToolboxConfig());
    }

    /**
     * Detect Intel QuickSync Video support
     * @returns A TaskEither with the QSV hardware acceleration configuration
     */
    private detectQsv (): TaskEither<HardwareAccelerationConfig> {
        return TaskEither
            .tryCatch(
                () => execAsync('ffmpeg -hide_banner -encoders | grep qsv'),
                'Failed to check QSV support',
            )
            .map((result) => result.stdout.includes('qsv'))
            .filter(
                (supported) => supported,
                () => createInternalError('QSV acceleration not available'),
            )
            .chain(() => TaskEither
                .tryCatch(
                    () => execAsync('ffmpeg -hide_banner -decoders | grep qsv'),
                    'Failed to check QSV decoders',
                ))
            .filter(
                (result) => result.stdout.includes('qsv'),
                () => createInternalError('QSV decoders not available'),
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
                scale: 'scale=w=%width%:h=%height%:force_original_aspect_ratio=decrease',
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
                h264: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq'],
                h265: ['-c:v', 'hevc_nvenc', '-preset', 'p4', '-tune', 'hq'],
            },
            videoFilters: {
                scale: 'scale_cuda=w=%width%:h=%height%:force_original_aspect_ratio=decrease',
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
                h264: ['-c:v', 'h264_vaapi'],
                h265: ['-c:v', 'hevc_vaapi'],
            },
            videoFilters: {
                scale: 'scale_vaapi=w=%width%:h=%height%:force_original_aspect_ratio=decrease',
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
                h264: ['-c:v', 'h264_videotoolbox', '-q:v', '50'],
                h265: ['-c:v', 'hevc_videotoolbox', '-q:v', '50'],
            },
            videoFilters: {
                scale: 'scale=w=%width%:h=%height%:force_original_aspect_ratio=decrease',
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
                h264: ['-c:v', 'h264_qsv'],
                h265: ['-c:v', 'hevc_qsv'],
            },
            videoFilters: {
                scale: 'scale_qsv=w=%width%:h=%height%:force_original_aspect_ratio=decrease',
            },
        };
    }
}
