import * as os from 'os';

export const STATUS_READ_CONCURRENCY = Math.max(
    1,
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
);

export class AsyncConcurrencyLimiter {
    private active = 0;
    private readonly waiters: Array<() => void> = [];

    constructor(readonly limit: number) {
        if (!Number.isInteger(limit) || limit < 1) { throw new Error('并发上限必须是正整数'); }
    }

    async run<T>(operation: () => Promise<T>): Promise<T> {
        if (this.active < this.limit) {
            this.active++;
        } else {
            // The releasing operation transfers its occupied slot directly to this waiter.
            await new Promise<void>(resolve => this.waiters.push(resolve));
        }
        try {
            return await operation();
        } finally {
            const next = this.waiters.shift();
            if (next) { next(); } else { this.active--; }
        }
    }
}

export const statusReadLimiter = new AsyncConcurrencyLimiter(STATUS_READ_CONCURRENCY);
