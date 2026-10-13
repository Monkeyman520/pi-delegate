import type { PressureClock } from "../../src/pressure.ts";
import { taskClock } from "../../src/progress.ts";
import type { AgentStatus } from "../../src/status.ts";
import { TaskRecords } from "../../src/tasks.ts";
import { taskInput } from "./task-record.ts";

/** Exercise the same record-to-view path as registration, including headless records. */
export function statusRecords(
	status: AgentStatus,
	clock: PressureClock = taskClock,
) {
	const records = new TaskRecords(clock);
	records.subscribe(status.update);
	const accept = (task: string, title?: string) => {
		const record = records.accept({ ...taskInput, task, title });
		status.show(record.progress);
		return record.progress;
	};
	return { records, accept };
}
