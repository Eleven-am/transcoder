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

import { EventEmitter } from 'events';

import { createInternalError, TaskEither } from '@eleven-am/fp';

import { SegmentProcessingData, SegmentProcessingResult } from './distributed';

export interface PipelineMetrics {
	activeSegments: number;
	completedSegments: number;
	failedSegments: number;
	averageProcessingTime: number;
	pipelineDepth: number;
}

/**
 * Pipelined segment processor that allows overlapping segment processing
 * for improved throughput and reduced latency
 */
export class SegmentPipelineProcessor extends EventEmitter {
	private readonly pipeline = new Map<number, Promise<SegmentProcessingResult>>();

	private readonly processingTimes: number[] = [];

	private completedCount = 0;

	private failedCount = 0;

	private readonly maxPipelineDepth: number;

	private readonly maxProcessingTimes = 100;

	constructor (maxPipelineDepth = 3) {
		super();
		this.maxPipelineDepth = maxPipelineDepth;
	}

	/**
	 * Process a segment with pipeline management
	 */
	async processSegment (
		segmentNumber: number,
		processor: (data: SegmentProcessingData) => Promise<SegmentProcessingResult>,
		data: SegmentProcessingData,
	): Promise<TaskEither<SegmentProcessingResult>> {
		// Wait for pipeline space
		await this.waitForPipelineSpace();

		const startTime = Date.now();

		// Create processing task
		const processingTask = TaskEither
			.tryCatch(
				() => processor(data),
				'Failed to process segment',
			)
			.io(() => this.handleSegmentSuccess(segmentNumber, startTime))
			.ioError(() => this.handleSegmentFailure(segmentNumber))
			.toPromise()
			.finally(() => this.cleanupSegment(segmentNumber));

		// Track in pipeline
		this.pipeline.set(segmentNumber, processingTask);
		this.emit('segment:started', { segmentNumber });

		return TaskEither.tryCatch(
			() => processingTask,
			'Failed to process segment in pipeline',
		);
	}

	/**
	 * Process multiple segments in batches with pipeline optimization
	 */
	async processBatch (
		segments: Array<{
			number: number;
			data: SegmentProcessingData;
		}>,
		processor: (data: SegmentProcessingData) => Promise<SegmentProcessingResult>,
	): Promise<TaskEither<SegmentProcessingResult[]>> {
		const processSegmentTask = (segment: { number: number; data: SegmentProcessingData }) =>
			this.processSegment(segment.number, processor, segment.data)
				.then(task => task.toPromise())
				.then(result => ({ index: segment.number, result }))
				.catch(error => ({ index: segment.number, error }));

		return TaskEither.of(segments)
			.chain(segs => TaskEither.tryCatch(
				() => Promise.all(segs.map(processSegmentTask)),
				'Failed to process batch segments',
			))
			.map(results => results.reduce<{
				successes: Array<{ index: number; result: SegmentProcessingResult }>;
				failures: Array<{ index: number; error: any }>;
			}>((acc, item) => {
				if ('error' in item) {
					acc.failures.push(item);
				} else {
					acc.successes.push(item);
				}
				return acc;
			}, { successes: [], failures: [] }))
			.filter(
				({ failures }) => failures.length === 0,
				({ failures }) => createInternalError(`Failed to process ${failures.length} segments`),
			)
			.map(({ successes }) => {
				const results: SegmentProcessingResult[] = [];
				successes.forEach(({ index, result }) => {
					results[index] = result;
				});
				return results;
			});
	}

	/**
	 * Wait for all segments in pipeline to complete
	 */
	async waitForPipeline (): Promise<void> {
		await Promise.all(Array.from(this.pipeline.values()));
	}

	/**
	 * Get current pipeline metrics
	 */
	getMetrics (): PipelineMetrics {
		return {
			activeSegments: this.pipeline.size,
			completedSegments: this.completedCount,
			failedSegments: this.failedCount,
			averageProcessingTime: this.calculateAverageProcessingTime(),
			pipelineDepth: this.maxPipelineDepth,
		};
	}

	/**
	 * Dynamically adjust pipeline depth based on performance
	 */
	adjustPipelineDepth (cpuUsage: number, memoryUsage: number): void {
		const currentDepth = this.maxPipelineDepth;
		let newDepth = currentDepth;

		// Reduce depth if system is under stress
		if (cpuUsage > 0.8 || memoryUsage > 0.8) {
			newDepth = Math.max(1, currentDepth - 1);
		} else if (cpuUsage < 0.5 && memoryUsage < 0.5) {
			// Increase depth if system has capacity
			newDepth = Math.min(6, currentDepth + 1);
		}

		if (newDepth !== currentDepth) {
			this.emit('pipeline:depthChanged', {
				oldDepth: currentDepth,
				newDepth,
				reason: cpuUsage > 0.8 ? 'high_cpu' : memoryUsage > 0.8 ? 'high_memory' : 'low_usage',
			});
		}
	}

	/**
	 * Clear the pipeline and reset metrics
	 */
	clear (): void {
		this.pipeline.clear();
		this.processingTimes.length = 0;
		this.completedCount = 0;
		this.failedCount = 0;
	}

	// Helper methods
	private async waitForPipelineSpace (): Promise<void> {
		while (this.pipeline.size >= this.maxPipelineDepth) {
			await Promise.race(Array.from(this.pipeline.values()));
		}
	}

	private handleSegmentSuccess = (segmentNumber: number, startTime: number) =>
		TaskEither.of(null).ioSync(() => {
			this.completedCount++;
			const processingTime = Date.now() - startTime;
			this.recordProcessingTime(processingTime);
			this.emit('segment:completed', { segmentNumber, processingTime });
		});

	private handleSegmentFailure = (segmentNumber: number) =>
		TaskEither.of(null).ioSync(() => {
			this.failedCount++;
			this.emit('segment:failed', { segmentNumber });
		});

	private cleanupSegment = (segmentNumber: number) => {
		this.pipeline.delete(segmentNumber);
		this.emit('pipeline:updated', this.getMetrics());
	};

	private recordProcessingTime (time: number): void {
		this.processingTimes.push(time);

		// Keep only recent processing times
		if (this.processingTimes.length > this.maxProcessingTimes) {
			this.processingTimes.shift();
		}
	}

	private calculateAverageProcessingTime (): number {
		if (this.processingTimes.length === 0) {
			return 0;
		}

		const sum = this.processingTimes.reduce((a, b) => a + b, 0);

		return Math.round(sum / this.processingTimes.length);
	}
}
