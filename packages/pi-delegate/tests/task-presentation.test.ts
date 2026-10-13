import { expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { TaskProgress } from "../src/progress.ts";
import { outcomeColor, taskActivity } from "../src/task-presentation.ts";

test("terminal colors are shared, while activity/pressure styling remain view-local", () => {
	for (const [status, role] of [
		["completed", "success"],
		["incomplete", "warning"],
		["failed", "error"],
		["cancelled", "muted"],
		["queued", "muted"],
		["initializing", "muted"],
		["running", "muted"],
	] as const)
		expect(outcomeColor(status)).toBe(role);
});

test("activity projection preserves each view's clipping and empty-tool semantics", () => {
	const progress = new TaskProgress(
		1,
		"title",
		{ now: () => 0, schedule: () => () => {} },
		() => true,
		() => {},
	);
	expect(taskActivity(progress, "compact")).toBe("initializing…");
	progress.observe({ type: "agent_start" });
	progress.observe({
		type: "tool_execution_start",
		toolCallId: "one",
		toolName: "read",
	});
	progress.observe({
		type: "tool_execution_start",
		toolCallId: "two",
		toolName: "x".repeat(160),
	});
	expect(progress.latestTool).toBe("x".repeat(160));
	expect(taskActivity(progress, "compact")).toBe(
		`toolcall · ${"x".repeat(160)} (+1)`,
	);
	expect(stripTerminalSequences(taskActivity(progress, "summary"))).toBe(
		`toolcall · ${"x".repeat(117)}... (+1)`,
	);
	progress.observe({ type: "tool_execution_end", toolCallId: "two" });
	expect(taskActivity(progress, "summary")).toBe("toolcall · read");
	progress.observe({
		type: "tool_execution_start",
		toolCallId: "one",
		toolName: "",
	});
	expect(taskActivity(progress, "compact")).toBe("running…");
	expect(taskActivity(progress, "summary")).toBe("toolcall · ");
	progress.finish("completed");
	expect(taskActivity(progress, "summary")).toBe("completed");
	expect(taskActivity(progress, "compact")).toBe("completed");
});
