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

import { Either, TaskEither } from '@eleven-am/fp';

export function streamToString (stream: NodeJS.ReadableStream): TaskEither<string> {
	const promise = new Promise<string>((resolve, reject) => {
		let data = '';

		stream.on('data', (chunk) => {
			data += chunk;
		});
		stream.on('end', () => {
			resolve(data);
		});
		stream.on('error', (err) => {
			reject(err);
		});
	});

	return TaskEither.tryCatch(
		() => promise,
		'Failed to convert stream to string',
	);
}

export function streamToJson<T> (stream: NodeJS.ReadableStream): TaskEither<T> {
	const json = (string: string) => Either
		.tryCatch(
			() => JSON.parse(string),
			'Failed to parse JSON',
		)
		.toTaskEither();

	return streamToString(stream).chain(json);
}

export class ExtendedEventEmitter<EventMap extends Record<string, any>> extends EventEmitter {
	emit<K extends keyof EventMap & string> (event: K, args: EventMap[K]): boolean {
		return super.emit(event, args);
	}

	on<K extends keyof EventMap & string> (event: K, listener: (args: EventMap[K]) => void): this {
		return super.on(event, listener);
	}

	once<K extends keyof EventMap & string> (event: K, listener: (args: EventMap[K]) => void): this {
		return super.once(event, listener);
	}
}
