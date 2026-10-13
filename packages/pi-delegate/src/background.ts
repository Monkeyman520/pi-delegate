import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { DelegationOptions, DelegationResult } from "./delegation.ts";

import type { SteeringControl, SteeringReceipt } from "./steering.ts";
import { BACKGROUND_USAGE_NOTICE, taskQuery } from "./task-query.ts";
import type { TaskRecord } from "./tasks.ts";

export type {
	TaskQueryDetails as BackgroundTaskDetails,
	TaskQueryResult as BackgroundTaskResult,
} from "./task-query.ts";
export { BACKGROUND_USAGE_NOTICE } from "./task-query.ts";

import type { TaskQueryResult as BackgroundTaskResult } from "./task-query.ts";
export type BackgroundSteeringResult = {
	content: [{ type: "text"; text: string }];
	details: { taskId: string } & (
		| SteeringReceipt
		| {
				status: "unknown_task" | "terminal" | "cancelling" | "closing";
				error: string;
		  }
	);
	isError: boolean;
};

interface Task {
	id: string;
	controller: AbortController;
	record?: TaskRecord;
	operation: Promise<void>;
	phase: "queued" | "initializing" | "running";
	usage?: Usage;
	steering?: SteeringControl;
	result?: DelegationResult;
}

/** Owns work and queryable results independently of the initiating agent turn. */
export class BackgroundTasks {
	private tasks = new Map<string, Task>();
	private cleanups = new Set<Promise<void>>();
	private closed = false;

	constructor(
		private run: (options: DelegationOptions) => Promise<DelegationResult>,
		private failure: (error: unknown, cancelled: boolean) => DelegationResult,
	) {}

	start(options: DelegationOptions): BackgroundTaskResult {
		if (this.closed) throw new Error("Background task owner is closing");
		options.signal?.throwIfAborted();
		const task: Task = {
			id: options.taskRecord?.taskId ?? randomUUID(),
			record: options.taskRecord,
			controller: new AbortController(),
			operation: Promise.resolve(),
			phase: "queued",
		};
		this.tasks.set(task.id, task);
		// Reserve admission at acceptance; async settlement still follows acknowledgement.
		task.operation = (async () =>
			this.run({
				...options,
				signal: task.controller.signal,
				ui: undefined,
				onPhase: (phase) => {
					task.phase = phase;
					options.onPhase?.(phase);
				},
				onUsage: (usage) => {
					task.usage = structuredClone(usage);
					options.onUsage?.(usage);
				},
				onSteeringControl: (control) => {
					task.steering = control;
					options.onSteeringControl?.(control);
				},
			}))()
			.catch((error: unknown) =>
				this.failure(error, task.controller.signal.aborted),
			)
			.then((result) => {
				task.steering = undefined;
				task.result = result;
			});
		return this.view(task);
	}

	query(taskId: string): BackgroundTaskResult {
		const task = this.tasks.get(taskId);
		if (!task) {
			return {
				content: [{ type: "text", text: `Unknown background task: ${taskId}` }],
				details: {
					taskId,
					status: "failed",
					accounting: BACKGROUND_USAGE_NOTICE,
				},
				isError: true,
			};
		}
		return this.view(task, true);
	}

	async steer(
		taskId: string,
		message: string,
	): Promise<BackgroundSteeringResult> {
		const task = this.tasks.get(taskId);
		let receipt: BackgroundSteeringResult["details"];
		if (this.closed)
			receipt = {
				taskId,
				status: "closing",
				error: "Background task owner is closing",
			};
		else if (!task)
			receipt = {
				taskId,
				status: "unknown_task",
				error: `Unknown background task: ${taskId}`,
			};
		else if (task.result)
			receipt = {
				taskId,
				status: "terminal",
				error: `Background task is ${task.result.details.status}`,
			};
		else if (task.controller.signal.aborted)
			receipt = {
				taskId,
				status: "cancelling",
				error: "Background task is cancelling",
			};
		else
			receipt = {
				taskId,
				...(task.steering
					? await task.steering.steer(message)
					: {
							status: "not_ready" as const,
							error: "Child initialization has not completed",
						}),
			};
		const notice =
			receipt.status === "accepted"
				? `${receipt.disposition}: ${receipt.disposition === "handled" ? "A trusted Pi input handler handled this submission." : "Pi queued this instruction; it may already have drained or been cleared."} This is not a provider/model-consumption, execution, compliance, or final-result acknowledgement.`
				: `${receipt.status}: ${receipt.error}${receipt.status === "uncertain" ? " Submission outcome is uncertain; host processing may still finish. Do not automatically retry." : ""}`;
		return {
			content: [
				{ type: "text", text: `[Background steering ${taskId}] ${notice}` },
			],
			details: receipt,
			isError: receipt.status !== "accepted",
		};
	}

	async cancel(taskId: string): Promise<BackgroundTaskResult> {
		const task = this.tasks.get(taskId);
		if (!task) return this.query(taskId);
		if (!task.result) {
			task.record?.cancelRequested();
			task.controller.abort();
			await task.operation;
		}
		return this.query(taskId);
	}

	private view(task: Task, includeMetadata = false): BackgroundTaskResult {
		const record = task.record?.valid() ? task.record : undefined;
		const metadata = record?.details();
		const result = record?.result ?? task.result;
		return taskQuery(
			{
				taskId: task.id,
				mode: "background",
				status: result?.details.status ?? metadata?.status ?? task.phase,
				result,
				usage: metadata?.usage ?? result?.usage ?? task.usage,
				task: metadata,
			},
			includeMetadata ? "background" : "acknowledgement",
		);
	}

	/** Invalidate task access synchronously, then await execution-resource cleanup. */
	async invalidate(closing = false): Promise<void> {
		this.closed ||= closing;
		const tasks = this.tasks;
		this.tasks = new Map();
		// Retain detached work so overlapping invalidations cannot lose its cleanup.
		// Register before abort, whose listeners can synchronously reenter this owner.
		const cleanup = Promise.allSettled(
			[...tasks.values()].map((task) => task.operation),
		).then(() => {
			this.cleanups.delete(cleanup);
		});
		this.cleanups.add(cleanup);
		// Ordinary navigation waits only for work invalidated by this boundary,
		// not new work accepted while cleanup is pending. Closing rejects new work.
		const pending = [...this.cleanups];
		for (const task of tasks.values()) {
			if (!task.result) task.controller.abort();
		}
		await Promise.allSettled(pending);
	}
}
