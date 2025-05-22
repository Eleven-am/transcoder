import { spawn } from 'child_process';
import { ChildProcessWithoutNullStreams } from 'node:child_process';

import { ExtendedEventEmitter } from './utils';

interface FfmpegEventMap {
    'start': {
        command: string;
    };
    'progress': {
        segment: number;
    };
    'end': void;
    'error': Error;
}

export class FfmpegCommand extends ExtendedEventEmitter<FfmpegEventMap> {
    private readonly inputPath: string;

    private inputOpts: string[] = [];

    private outputOpts: string[] = [];

    private videoFilterOpts: string | undefined;

    private outputPath: string = '';

    private process: ChildProcessWithoutNullStreams | null = null;

    private isRunning: boolean = false;

    constructor (inputPath: string) {
        super();
        this.inputPath = inputPath;
    }

    /**
     * Add input options to the command
     * @param options Array of input options
     */
    inputOptions (options: string[]): FfmpegCommand {
        this.inputOpts.push(...options);

        return this;
    }

    /**
     * Add output options to the command
     * @param options Array of output options
     */
    outputOptions (options: string[]): FfmpegCommand {
        this.outputOpts.push(...options);

        return this;
    }

    /**
     * Add video filters to the command
     * @param filters Video filter string
     */
    videoFilters (filters: string): FfmpegCommand {
        this.videoFilterOpts = filters;

        return this;
    }

    /**
     * Set the output path
     * @param outputPath Path for the output file
     */
    output (outputPath: string): FfmpegCommand {
        this.outputPath = outputPath;

        return this;
    }

    /**
     * Execute the FFmpeg command
     */
    run (): void {
        if (this.isRunning) {
            return;
        }

        this.isRunning = true;
        const args = this.buildArgs();

        this.process = spawn('ffmpeg', args);

        let stderrBuffer = '';

        this.emit('start', {
            command: `ffmpeg ${args.join(' ')}`,
        });

        this.process.stderr.on('data', (data: Buffer) => {
            const output = data.toString();

            stderrBuffer += output;
        });

        this.process.stdout.on('data', (data: Buffer) => {
            const output = data.toString();
            const regex = /segment-(?<segment>\d+)\.ts/;
            const match = output.match(regex);

            if (match && match.groups) {
                const segment = parseInt(match.groups.segment, 10);

                this.emit('progress', { segment });
            }
        });

        this.process.on('close', (code: number | null) => {
            this.isRunning = false;

            if (code === 0 || code === null) {
                this.emit('end', undefined);
            } else {
                const error = new Error(`FFmpeg process exited with code ${code} and output: ${stderrBuffer}`);

                this.emit('error', error);
            }
        });

        this.process.on('error', (err) => {
            this.isRunning = false;
            this.emit('error', err);
        });
    }

    /**
     * Kill the FFmpeg process
     * @param signal Signal to send to the process
     */
    kill (signal: NodeJS.Signals = 'SIGKILL'): void {
        if (this.process && this.isRunning) {
            this.process.kill(signal);
        }
    }

    /**
     * Pipe the FFmpeg output to a stream rather than a file
     * @returns The stdout stream from the FFmpeg process
     */
    pipe (): NodeJS.ReadableStream {
        if (this.isRunning) {
            throw new Error('FFmpeg process is already running');
        }

        this.outputPath = '-';

        const args = this.buildArgs();

        this.process = spawn('ffmpeg', args);
        this.isRunning = true;

        let stderrBuffer = '';

        this.emit('start', {
            command: `ffmpeg ${args.join(' ')}`,
        });

        this.process.stderr.on('data', (data: Buffer) => {
            const output = data.toString();

            stderrBuffer += output;

            const progressRegex = /time=(\d+:\d+:\d+.\d+)/;
            const match = output.match(progressRegex);

            if (match) {
                this.emit('progress', { segment: 0 });
            }
        });

        this.process.on('error', (err) => {
            this.isRunning = false;
            this.emit('error', err);
        });

        this.process.on('close', (code: number | null) => {
            this.isRunning = false;

            if (code === 0 || code === null) {
                this.emit('end', undefined);
            } else {
                const error = new Error(`FFmpeg process exited with code ${code} and output: ${stderrBuffer}`);

                this.emit('error', error);
            }
        });

        return this.process.stdout;
    }

    /**
     * Build the complete FFmpeg command arguments
     */
    private buildArgs (): string[] {
        const args = [
            ...this.inputOpts,
            '-i',
            this.inputPath,
        ];

        if (this.videoFilterOpts) {
            args.push('-vf', this.videoFilterOpts);
        }

        args.push(...this.outputOpts);

        if (this.outputPath) {
            args.push(this.outputPath);
        }

        return args;
    }
}

/**
 * Factory function that mimics the fluent-ffmpeg module's interface
 * @param inputPath Input file path
 */
export default function ffmpeg (inputPath: string): FfmpegCommand {
    return new FfmpegCommand(inputPath);
}
