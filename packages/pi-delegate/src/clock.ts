/** Task-local monotonic time; policy state remains with each observer. */
export interface Clock {
	/** Monotonic seconds. */
	now(): number;
	/** Returns an idempotent cancellation function. */
	schedule(callback: () => void, delayMs: number): () => void;
}
export const taskClock: Clock = {
	now: () => performance.now() / 1000,
	schedule: (callback, ms) => {
		const timer = setTimeout(callback, ms);
		return () => clearTimeout(timer);
	},
};
