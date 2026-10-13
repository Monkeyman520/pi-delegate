import type { Usage } from "@earendil-works/pi-ai";
import type { DelegationResult } from "./delegation.ts";
import type { TaskDetails, TaskMode } from "./tasks.ts";

export const BACKGROUND_USAGE_NOTICE =
	"Background task usage is reported separately and is not automatically included in Pi parent-session totals.";
const SYNCHRONOUS_USAGE_NOTICE =
	"Synchronous usage is accounted through the initiating delegate result; queries do not charge it again.";

export interface TaskQueryDetails {
	taskId: string;
	status: TaskDetails["status"];
	result?: DelegationResult["details"];
	usage?: Usage;
	accounting: string;
	task?: TaskDetails;
}
export interface TaskQueryResult {
	content: [{ type: "text"; text: string }];
	details: TaskQueryDetails;
	isError: boolean;
}

/** A consumption-free projection: observations/results never become top-level usage charges. */
export function taskQuery(
	snapshot: {
		taskId: string;
		mode: TaskMode;
		status: TaskDetails["status"];
		result?: DelegationResult;
		usage?: Usage;
		task?: TaskDetails;
	},
	presentation: "acknowledgement" | "background" | "record",
): TaskQueryResult {
	const { taskId, mode, status, result, usage, task } = snapshot;
	const accounting =
		mode === "background" ? BACKGROUND_USAGE_NOTICE : SYNCHRONOUS_USAGE_NOTICE;
	const metadata =
		presentation !== "acknowledgement" && task
			? `\nTask metadata: ${JSON.stringify(task)}`
			: "";
	const output = result
		? (presentation === "record" ? "\n" : "\n\n") + result.content[0].text
		: `\n${presentation === "record" ? "No final result available." : "Accepted for background execution; this is not a final task result."}`;
	return {
		content: [
			{
				type: "text",
				text: `[${mode === "background" ? "Background" : "Synchronous"} task ${taskId}: ${status}]\n${accounting}${metadata}${output}`,
			},
		],
		details: {
			taskId,
			status,
			...(result ? { result: structuredClone(result.details) } : {}),
			...(usage ? { usage: structuredClone(usage) } : {}),
			accounting,
			...(task ? { task } : {}),
		},
		isError: result?.isError ?? false,
	};
}
