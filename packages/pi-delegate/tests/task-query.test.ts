import { expect, test } from "bun:test";
import { BACKGROUND_USAGE_NOTICE, taskQuery } from "../src/task-query.ts";
import { TaskRecords } from "../src/tasks.ts";
import { taskInput, taskResult } from "./fixtures/task-record.ts";

for (const mode of ["synchronous", "background"] as const) {
	test(`${mode}: record projection keeps exact text and defensive result/usage snapshots without top-level charges`, () => {
		const record = new TaskRecords().accept({ ...taskInput, mode });
		const result = taskResult();
		result.details.fullOutputPath = "retained.txt";
		record.complete(result);
		const task = record.details();
		const view = taskQuery(
			{
				taskId: record.taskId,
				mode,
				status: task.status,
				task,
				result: record.result,
				usage: task.usage,
			},
			"record",
		);
		const title = mode === "background" ? "Background" : "Synchronous";
		const notice =
			mode === "background"
				? BACKGROUND_USAGE_NOTICE
				: "Synchronous usage is accounted through the initiating delegate result; queries do not charge it again.";
		expect(view.content[0].text).toBe(
			`[${title} task ${record.taskId}: completed]\n${notice}\nTask metadata: ${JSON.stringify(task)}\navailable result`,
		);
		expect(view).not.toHaveProperty("usage");
		if (view.details.result) view.details.result.fullOutputPath = "mutated";
		if (view.details.usage) view.details.usage.input = 999;
		expect(record.result?.details.fullOutputPath).toBe("retained.txt");
		expect(task.usage.input).toBe(0);
	});
}

test("background acknowledgement includes metadata in details but not text, and unavailable usage stays absent", () => {
	const record = new TaskRecords().accept(taskInput);
	const task = record.details();
	const view = taskQuery(
		{
			taskId: record.taskId,
			mode: "background",
			status: "queued",
			task,
			usage: task.usage,
		},
		"acknowledgement",
	);
	expect(view.details.task).toEqual(task);
	expect(view.content[0].text).toBe(
		`[Background task ${record.taskId}: queued]\n${BACKGROUND_USAGE_NOTICE}\nAccepted for background execution; this is not a final task result.`,
	);
	const headless = taskQuery(
		{ taskId: "standalone", mode: "background", status: "queued" },
		"background",
	);
	expect(headless.details).not.toHaveProperty("usage");
	expect(headless.details).not.toHaveProperty("task");
});

test("background final query preserves the double separator and incomplete is not an error", () => {
	const result = taskResult("incomplete");
	const view = taskQuery(
		{
			taskId: "exact",
			mode: "background",
			status: "incomplete",
			result,
			usage: result.usage,
		},
		"background",
	);
	expect(view.content[0].text).toBe(
		`[Background task exact: incomplete]\n${BACKGROUND_USAGE_NOTICE}\n\navailable result`,
	);
	expect(view.isError).toBe(false);
	for (const status of ["failed", "cancelled"] as const) {
		const result = taskResult(status);
		expect(
			taskQuery(
				{ taskId: "exact", mode: "background", status, result },
				"background",
			).isError,
		).toBe(true);
	}
});
