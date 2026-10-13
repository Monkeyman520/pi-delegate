import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { DelegationStatus } from "./delegation.ts";
import type { TaskProgress } from "./progress.ts";

const outcomeColors: Record<DelegationStatus, ThemeColor> = {
	completed: "success",
	incomplete: "warning",
	failed: "error",
	cancelled: "muted",
};
export function outcomeColor(
	status: DelegationStatus | TaskProgress["executionPhase"],
): ThemeColor {
	return status === "queued" ||
		status === "initializing" ||
		status === "running"
		? "muted"
		: outcomeColors[status];
}

/** Compact rows clip the whole line; discoverable summaries bound individual tool names. */
export function taskActivity(
	progress: TaskProgress,
	view: "compact" | "summary",
): string {
	const tool = progress.latestTool;
	if (progress.status) return progress.status;
	if (view === "compact" ? !!tool : progress.tools.size > 0) {
		const name = view === "summary" ? truncateToWidth(tool ?? "", 120) : tool;
		return `toolcall · ${name}${progress.tools.size > 1 ? ` (+${progress.tools.size - 1})` : ""}`;
	}
	return progress.activity;
}
