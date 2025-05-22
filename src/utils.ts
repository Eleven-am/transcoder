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
