import { spawn } from 'child_process';
import * as path from 'path';

import { createBadRequestError, TaskEither } from '@eleven-am/fp';

import { DatabaseConnector } from './databaseConnector';
import { MediaSource } from './mediaSource';
import { QualityService } from './qualityService';
import {
    AudioInfo,
    AudioQualityEnum,
    HardwareAccelerationConfig,
    HardwareAccelerationMethod,
    MediaMetadata,
    Stream,
    SubtitleInfo,
    VideoInfo,
    VideoQualityEnum,
} from './types';

interface MasterPlaylist {
    master: string;
    video: {
        index: number;
        quality: VideoQualityEnum;
    };
    audio: {
        index: number;
        quality: AudioQualityEnum;
    };
}

export class MetadataService {
    constructor (
        private readonly qualityService: QualityService,
        private readonly databaseConnector: DatabaseConnector,
    ) {}

    /**
     * Get metadata for a file, extracting it if necessary
     * @param source The media source to get metadata from
     */
    getMetadata (source: MediaSource): TaskEither<MediaMetadata> {
        return source.getFileId()
            .fromPromise((fileId) => this.databaseConnector.metadataExists(fileId))
            .matchTask([
                {
                    predicate: ({ exists }) => exists,
                    run: ({ fileId }) => TaskEither
                        .tryCatch(() => this.databaseConnector.getMetadata(fileId)),
                },
                {
                    predicate: ({ exists }) => !exists,
                    run: ({ fileId }) => this.extractMediaInfo(fileId, source)
                        .fromPromise((metadata) => this.databaseConnector.saveMetadata(fileId, metadata)),
                },
            ]);
    }

    /**
     * Detect the best codec for the given source video
     * This is especially important for CUDA which has specific decoders per codec
     * @param source The media source to detect the codec from
     * @param hwConfig Hardware acceleration configuration
     * @returns A TaskEither with the updated hardware acceleration configuration
     */
    detectOptimalCodecConfig (source: MediaSource, hwConfig: HardwareAccelerationConfig | null): TaskEither<HardwareAccelerationConfig | null> {
        const args = [
            '-hide_banner',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=codec_name',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            source.getFilePath(),
        ];

        return TaskEither
            .fromNullable(hwConfig)
            .filter(
                (hwConfig) => hwConfig.method === HardwareAccelerationMethod.CUDA,
                () => createBadRequestError('Hardware acceleration is not enabled or not CUDA'),
            )
            .chain((hwConfig) => this.probe(args).map((codec) => ({
                codec: codec.trim(),
                hwConfig,
            })))
            .map(({ codec, hwConfig }) => {
                if (codec === 'mpeg1video') {
                    return ['mpeg1_cuvid', hwConfig] as const;
                } else if (codec === 'mpeg2video') {
                    return ['mpeg2_cuvid', hwConfig] as const;
                }

                return [`${codec}_cuvid`, hwConfig] as const;
            })
            .map(([decoderName, hwConfig]): HardwareAccelerationConfig | null => ({
                ...hwConfig,
                inputOptions: [
                    ...hwConfig.inputOptions,
                    '-c:v',
                    decoderName,
                ],
            }))
            .orElse(() => TaskEither.of(hwConfig));
    }

    /**
     * Get the master playlist for the media file
     * @returns The master playlist as a string
     */
    getMasterPlaylist (source: MediaSource): TaskEither<MasterPlaylist> {
        const genPlaylist = (metadata: MediaMetadata): MasterPlaylist => {
            const videoRenditions = metadata.videos.map((x) => this.generateVideoRenditionEntries(x));

            const master = [
                '#EXTM3U',
                ...metadata.audios.map((x) => this.generateAudioRenditionEntries(x)),
                '',
                ...videoRenditions.map(({ mediaTypes }) => mediaTypes),
                '',
                ...videoRenditions.map(({ mappedProfile }) => mappedProfile),
            ];

            const defaultAudio = metadata.audios.find((audio) => audio.isDefault);
            const defaultVideo = metadata.videos.find((video) => video.isDefault);

            const audioQuality = defaultAudio
                ? {
                    index: defaultAudio.index,
                    quality: this.isAudioHLSCompatible(defaultAudio) ? AudioQualityEnum.ORIGINAL : AudioQualityEnum.AAC,
                }
                : {
                    index: 0,
                    quality: AudioQualityEnum.AAC,
                };

            const videoQuality = defaultVideo
                ? {
                    index: defaultVideo.index,
                    quality: this.isVideoHLSCompatible(defaultVideo) ? VideoQualityEnum.ORIGINAL : VideoQualityEnum.P240,
                }
                : {
                    index: 0,
                    quality: VideoQualityEnum.P240,
                };

            const string = master.join('\n');

            return {
                master: string,
                video: videoQuality,
                audio: audioQuality,
            };
        };

        return this.getMetadata(source).map((metadata) => genPlaylist(metadata));
    }

    /**
     * Create metadata for a file
     * @param source Media source to create metadata for
     * @returns TaskEither containing the created metadata
     */
    createMetadata (source: MediaSource): TaskEither<void> {
        return this.getMetadata(source).map(() => undefined);
    }

    /**
     * Extract keyframes from a file using ffprobe
     * @param source Media source to extract keyframes from
     * @param videoIndex Index of the video stream
     * @returns TaskEither containing keyframe data
     */
    private extractKeyframes (source: MediaSource, videoIndex: number): TaskEither<number[]> {
        const args = [
            '-loglevel',
            'error',
            '-analyzeduration',
            '100000000',
            '-probesize',
            '100000000',
            '-select_streams',
            `v:${videoIndex}`,
            '-show_entries',
            'packet=pts_time,flags',
            '-fflags',
            '+genpts',
            '-of',
            'csv=print_section=0',
            source.getFilePath(),
        ];

        return this.probe(args)
            .map((output) => output.split('\n'))
            .mapItems((line) => line.trim())
            .filterItems((line) => line.length > 0)
            .mapItems((line) => line.split(','))
            .filterItems(([pts, flags]) => pts !== 'N/A' && Boolean(flags) && flags.includes('K'))
            .mapItems(([pts]) => parseFloat(pts))
            .filterItems((timestamp) => !isNaN(timestamp) && timestamp >= 0)
            .map((keyframes) => {
                if (keyframes.length > 0 && keyframes[0] > 0) {
                    keyframes.unshift(0);
                }

                keyframes.sort((a, b) => a - b);

                return keyframes;
            });
    }

    /**
     * Extract media information from a file using ffprobe
     * @returns TaskEither containing media metadata
     * @param fileId Unique identifier for the media file
     * @param source Media source to extract metadata from
     */
    private extractMediaInfo (fileId: string, source: MediaSource): TaskEither<MediaMetadata> {
        const filePath = source.getFilePath();

        const args = [
            '-print_format',
            'json',
            '-show_format',
            '-show_streams',
            '-show_chapters',
            filePath,
        ];

        return TaskEither
            .fromBind({
                ffprobe: this.probe(args),
                keyframes: this.extractKeyframes(source, 0),
            })
            .map(({ ffprobe, keyframes }) => {
                const ffprobeData = JSON.parse(ffprobe);
                const mediaInfo: MediaMetadata = {
                    keyframes,
                    id: fileId,
                    path: filePath,
                    extension: path.extname(filePath).substring(1),
                    mimeCodec: null,
                    duration: parseFloat(ffprobeData.format.duration || '0'),
                    container: ffprobeData.format.format_name || null,
                    videos: [],
                    audios: [],
                    subtitles: [],
                    fonts: [],
                    chapters: [],
                    extractionTimestamp: new Date(),
                };

                let videoIndex = 0;
                let audioIndex = 0;
                let subtitleIndex = 0;

                for (const stream of ffprobeData.streams || []) {
                    if (stream.codec_type === 'video' && !stream.disposition?.attached_pic) {
                        const videoStream = this.processVideoStream(stream, videoIndex++);

                        mediaInfo.videos.push(videoStream);
                    } else if (stream.codec_type === 'audio') {
                        const audioStream = this.processAudioStream(stream, audioIndex++);

                        mediaInfo.audios.push(audioStream);
                    } else if (stream.codec_type === 'subtitle') {
                        const subtitleStream = this.processSubtitleStream(stream, subtitleIndex++);

                        mediaInfo.subtitles.push(subtitleStream);
                    } else if (stream.codec_type === 'attachment') {
                        if (stream.tags?.filename &&
                            (stream.tags.filename.endsWith('.ttf') ||
                                stream.tags.filename.endsWith('.otf'))) {
                            mediaInfo.fonts.push(stream.tags.filename);
                        }
                    }
                }

                if (ffprobeData.chapters) {
                    for (const chapter of ffprobeData.chapters) {
                        if (chapter.tags) {
                            mediaInfo.chapters.push({
                                startTime: parseFloat(chapter.start_time),
                                endTime: parseFloat(chapter.end_time),
                                name: chapter.tags.title || `Chapter ${chapter.id}`,
                                type: 'content',
                            });
                        }
                    }
                }

                this.generateMimeCodec(mediaInfo);

                return mediaInfo;
            });
    }

    /**
     * Run ffprobe with the given arguments
     * @param args Arguments to pass to ffprobe
     * @private
     */
    private probe (args: string[]): TaskEither<string> {
        const promise = () => new Promise<string>((resolve, reject) => {
            const process = spawn('ffprobe', args);

            let stdout = '';
            let stderr = '';

            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            process.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            process.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`FFprobe exited with code ${code}: ${stderr}`));

                    return;
                }
                resolve(stdout);
            });
        });

        return TaskEither.tryCatch(
            () => promise(),
            (err) => createBadRequestError(`FFprobe error: ${err.message}`),
        );
    }

    /**
     * Process a video stream from FFprobe output
     */
    private processVideoStream (stream: any, index: number): VideoInfo {
        return {
            index,
            codec: stream.codec_name,
            mimeCodec: this.getMimeCodec(stream),
            title: stream.tags?.title || null,
            language: stream.tags?.language || null,
            width: parseInt(stream.width, 10) || 0,
            height: parseInt(stream.height, 10) || 0,
            bitrate: parseInt(stream.bit_rate ?? 1800000, 10) || 0,
            isDefault: Boolean(stream.disposition?.default),
        };
    }

    /**
     * Process an audio stream from FFprobe output
     */
    private processAudioStream (stream: any, index: number): AudioInfo {
        return {
            index,
            codec: stream.codec_name,
            mimeCodec: this.getMimeCodec(stream),
            title: stream.tags?.title || null,
            language: stream.tags?.language || null,
            bitrate: parseInt(stream.bit_rate, 10) || 0,
            isDefault: Boolean(stream.disposition?.default),
            isForced: Boolean(stream.disposition?.forced),
            channels: parseInt(stream.channels, 10) || 2,
        };
    }

    /**
     * Process a subtitle stream from FFprobe output
     */
    private processSubtitleStream (stream: any, index: number): SubtitleInfo {
        const extension = this.getSubtitleExtension(stream.codec_name);

        return {
            index,
            extension,
            isExternal: false,
            codec: stream.codec_name,
            title: stream.tags?.title || null,
            isForced: Boolean(stream.disposition?.forced),
            language: stream.tags?.language || null,
            isDefault: Boolean(stream.disposition?.default),
            isHearingImpaired: Boolean(stream.disposition?.hearing_impaired),
        };
    }

    /**
     * Generate MIME codec string
     */
    private generateMimeCodec (mediaInfo: MediaMetadata): void {
        if (mediaInfo.videos.length > 0 && mediaInfo.audios.length > 0) {
            const videoCodec = mediaInfo.videos[0].mimeCodec;
            const audioCodec = mediaInfo.audios[0].mimeCodec;

            if (videoCodec && audioCodec) {
                mediaInfo.mimeCodec = `video/mp4; codecs="${videoCodec}, ${audioCodec}"`;
            }
        }
    }

    /**
     * Get MIME codec string for a codec
     */
    private getMimeCodec (stream: Stream): string | null {
        switch (stream.codec_name) {
            case 'h264': {
                let ret = 'avc1';

                switch ((stream.profile || '').toLowerCase()) {
                    case 'high':
                        ret += '.6400';
                        break;
                    case 'main':
                        ret += '.4D40';
                        break;
                    case 'baseline':
                        ret += '.42E0';
                        break;
                    default:
                        ret += '.4240';
                        break;
                }

                ret += (stream.level || 0).toString(16).padStart(2, '0');

                return ret;
            }

            case 'h265':
            case 'hevc': {
                // The h265 syntax is a bit of a mystery at the time this comment was written.
                // This is what I've found through various sources:
                // FORMAT: [codecTag].[profile].[constraint?].L[level * 30].[UNKNOWN]
                let ret = 'hvc1';

                if (stream.profile === 'main 10') {
                    ret += '.2.4';
                } else {
                    ret += '.1.4';
                }

                // Note: Go version multiplies by 30 (not 3)
                ret += `.L${((stream.level || 0) * 30).toString(16).toUpperCase()
                    .padStart(2, '0')}.BO`;

                return ret;
            }

            case 'av1': {
                // https://aomedia.org/av1/specification/annex-a/
                // FORMAT: [codecTag].[profile].[level][tier].[bitDepth]
                let ret = 'av01';

                switch ((stream.profile || '').toLowerCase()) {
                    case 'main':
                        ret += '.0';
                        break;
                    case 'high':
                        ret += '.1';
                        break;
                    case 'professional':
                        ret += '.2';
                        break;
                    default:
                        break;
                }

                let bitdepth = parseInt(stream.bits_per_raw_sample || '0', 10);

                if (bitdepth !== 8 && bitdepth !== 10 && bitdepth !== 12) {
                    bitdepth = 8;
                }

                const tierflag = 'M';

                ret += `.${(stream.level || 0).toString(16).toUpperCase()
                    .padStart(2, '0')}${tierflag}.${bitdepth.toString().padStart(2, '0')}`;

                return ret;
            }

            case 'aac': {
                let ret = 'mp4a';

                switch ((stream.profile || '').toLowerCase()) {
                    case 'he':
                        ret += '.40.5';
                        break;
                    case 'lc':
                        ret += '.40.2';
                        break;
                    default:
                        ret += '.40.2';
                        break;
                }

                return ret;
            }

            case 'mp3':
                return 'mp4a.40.34';

            case 'opus':
                return 'Opus';

            case 'ac3':
                return 'mp4a.a5';

            case 'eac3':
                return 'mp4a.a6';

            case 'flac':
                return 'fLaC';

            case 'alac':
                return 'alac';

            default:
                return null;
        }
    }

    /**
     * Get subtitle extension for a codec
     */
    private getSubtitleExtension (codec: string): string | null {
        const extensionMap: Record<string, string | null> = {
            subrip: 'srt',
            ass: 'ass',
            ssa: 'ass',
            mov_text: 'vtt',
            webvtt: 'vtt',
            dvb_subtitle: null,
            hdmv_pgs_subtitle: null,
            dvd_subtitle: null,
        };

        return extensionMap[codec] || null;
    }

    /**
     * Check if the video codec is HLS-compatible for direct playback
     */
    private isVideoHLSCompatible (video: VideoInfo): boolean {
        return video.mimeCodec?.toLowerCase().startsWith('avc1') ?? false;
    }

    /**
     * Check if the audio codec is HLS-compatible for direct playback
     */
    private isAudioHLSCompatible (audio: AudioInfo): boolean {
        return audio.mimeCodec?.toLowerCase().includes('mp4a.40.2') ??
            audio.codec?.toLowerCase() === 'aac';
    }

    /**
     * Generate audio rendition entries for HLS master playlist
     * @param audio The audio stream information
     * @returns Object containing rendition entries and compatibility info
     * @private
     */
    private generateAudioRenditionEntries (audio: AudioInfo) {
        const playlist = [
            '#EXT-X-MEDIA:TYPE=AUDIO',
            'GROUP-ID="audio"',
        ];

        const isCompatible = this.isAudioHLSCompatible(audio);

        if (audio.language) {
            playlist.push(`LANGUAGE="${audio.language}"`);
            if (isCompatible) {
                playlist.push(`NAME="${audio.language}"`);
            } else {
                playlist.push(`NAME="${audio.language} (AAC)"`);
            }
        }

        if (audio.isDefault) {
            playlist.push('DEFAULT=YES');
        }

        if (isCompatible) {
            playlist.push(`CHANNELS="${audio.channels}"`);
            playlist.push(`URI="audio/${audio.index}/original/playlist.m3u8"`);
        } else {
            playlist.push('CHANNELS="2"');
            playlist.push(`URI="audio/${audio.index}/aac/playlist.m3u8"`);
        }

        return playlist.join(',');
    }

    /**
     * Generate video rendition entries for HLS master playlist
     * @param video The video stream information
     * @returns Object containing media types and mapped profile
     * @private
     */
    private generateVideoRenditionEntries (video: VideoInfo) {
        const bitrate = video.bitrate;
        const isCompatible = this.isVideoHLSCompatible(video);
        let qualities = this.qualityService.getVideoQualities(video);
        const original = this.qualityService.getNonTranscodeVideoQualities();
        const aspectRatio = video.width / video.height;

        const transcodePrefix = 'avc1.6400';
        const transcodeCodec = `${transcodePrefix}28`;
        const audioCodec = 'mp4a.40.2';

        if (isCompatible) {
            qualities = qualities.filter((quality) => quality.height !== video.height);
            qualities.push(original);
        }

        const mappedProfile = qualities.map((quality) => {
            const defaultQuality = this.qualityService.determineVideoQuality(video);
            const width = quality.value !== VideoQualityEnum.ORIGINAL ?
                Math.round(aspectRatio * quality.height + 0.5) :
                video.width;

            const height = quality.value !== VideoQualityEnum.ORIGINAL ?
                quality.height
                : video.height;

            const averageBitrate = quality.value === VideoQualityEnum.ORIGINAL ?
                Math.min(Math.floor(bitrate * 0.8), defaultQuality.averageBitrate) :
                quality.averageBitrate;

            const bandWith = quality.value !== VideoQualityEnum.ORIGINAL ?
                quality.maxBitrate
                : Math.min(bitrate, defaultQuality.maxBitrate);

            const codec = quality.value !== VideoQualityEnum.ORIGINAL ?
                transcodeCodec
                : video.mimeCodec;

            const attributes: string[] = [
                `AVERAGE-BANDWIDTH=${averageBitrate}`,
                `BANDWIDTH=${bandWith}`,
                `RESOLUTION=${width}x${height}`,
                `CODECS="${codec},${audioCodec}"`,
                'AUDIO="audio"',
                'CLOSED-CAPTIONS=NONE',
            ];

            return [
                `#EXT-X-STREAM-INF:${attributes.join(',')}`,
                `video/${video.index}/${quality.value}/playlist.m3u8`,
            ].join('\n');
        })
            .join('\n');

        const mediaTypes = qualities
            .map((quality): string => [
                '#EXT-X-MEDIA:TYPE=VIDEO',
                `GROUP-ID="${quality.value}"`,
                `NAME="Video ${video.index}"`,
                ...(video.isDefault ? ['DEFAULT=YES'] : []),
            ].join(','))
            .join('\n');

        return {
            mediaTypes,
            mappedProfile,
        };
    }
}
