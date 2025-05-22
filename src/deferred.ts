/** Represents the possible states of a Promise */
type PromiseState = 'pending' | 'fulfilled' | 'rejected';

/**
 * A Deferred represents a Promise with exposed resolve and reject methods
 * that can be called from outside the Promise constructor.
 * @template T The type of the value with which the Promise will be resolved
 */
export class Deferred<T = any> {
    #promise!: Promise<T>;

    #state: PromiseState = 'pending';

    #originalResolve!: (value: T | PromiseLike<T>) => void;

    #originalReject!: (reason?: any) => void;

    #resolveHandler!: (value: T | PromiseLike<T>) => void;

    #rejectHandler!: (reason?: any) => void;

    /**
     * Creates a new Deferred instance with a pending Promise
     */
    constructor () {
        this.#createPromise();
    }

    /**
     * Returns the underlying Promise object
     * @returns The Promise that will be resolved or rejected
     */
    public promise (): Promise<T> {
        return this.#promise;
    }

    /**
     * Returns the current state of the Promise
     * @returns The current state: 'pending', 'fulfilled', or 'rejected'
     */
    public state (): PromiseState {
        return this.#state;
    }

    /**
     * Resolves the Promise with the given value
     * @param value The value to resolve the Promise with
     */
    public resolve (value: T | PromiseLike<T>): Deferred {
        this.#resolveHandler(value);

        return this;
    }

    /**
     * Rejects the Promise with the given reason
     * @param reason The reason for the rejection
     */
    public reject (reason?: any): Deferred {
        this.#rejectHandler(reason);

        return this;
    }

    /**
     * Resets the Deferred to create a new Promise
     * @returns This Deferred instance for chaining
     */
    public reset (): Deferred {
        this.#createPromise();

        return this;
    }

    /**
     * Checks if the Promise is in the pending state
     * @returns True if the Promise is pending, false otherwise
     */
    public isPending (): boolean {
        return this.#state === 'pending';
    }

    /**
     * Checks if the Promise is in the fulfilled state
     * @returns True if the Promise is fulfilled, false otherwise
     */
    public isFulfilled (): boolean {
        return this.#state === 'fulfilled';
    }

    /**
     * Checks if the Promise is in the rejected state
     * @returns True if the Promise is rejected, false otherwise
     */
    public isRejected (): boolean {
        return this.#state === 'rejected';
    }

    /**
     * Creates or resets the internal Promise
     * @private
     */
    #createPromise (): void {
        this.#state = 'pending';

        this.#promise = new Promise<T>((resolve, reject) => {
            this.#originalResolve = resolve;
            this.#originalReject = reject;

            this.#resolveHandler = (value: T | PromiseLike<T>): void => {
                this.#state = 'fulfilled';
                this.#originalResolve(value);
            };

            this.#rejectHandler = (reason?: any): void => {
                this.#state = 'rejected';
                this.#originalReject(reason);
            };
        });
    }
}

/**
 * Creates a new Deferred instance
 * @template T The type of the value with which the Promise will be resolved
 * @returns A new Deferred instance
 */
export function defer<T = any> (): Deferred<T> {
    return new Deferred<T>();
}
