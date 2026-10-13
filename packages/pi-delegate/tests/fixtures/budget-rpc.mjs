import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.env.BUDGET_SCENARIO;
const log = (value) =>
	appendFileSync(process.env.BUDGET_LOG, `${JSON.stringify(value)}\n`);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (command, data) =>
	send({ type: "response", id: command.id, success: true, data });
const usage = (n) => ({
	input: n,
	output: n,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: n * 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const assistant = (text, n, timestamp) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	usage: usage(n),
	timestamp,
	stopReason: "aborted",
});
const first = assistant("first observed answer", 2, 1);
const partial = assistant(
	`partial ${scenario === "large" ? "line\n".repeat(3000) : "answer"}`,
	5,
	2,
);
let started = false;
log({
	kind: "spawn",
	pid: process.pid,
	snapshot: process.env.PI_DELEGATE_SNAPSHOT,
});
createInterface({ input: process.stdin })
	.on("line", (line) => {
		const command = JSON.parse(line);
		log(command);
		if (command.type === "prompt" && command.message === "/pi-delegate-init") {
			setTimeout(
				() => reply(command, { disposition: "handled" }),
				scenario === "init" ? 150 : 0,
			);
		} else if (command.type === "get_entries" && !started) {
			reply(command, {
				entries: [
					{
						type: "custom",
						customType: "pi-delegate:init",
						data: { ok: true },
					},
				],
			});
		} else if (command.type === "prompt") {
			started = true;
			send({ type: "turn_end" }); // Pre-start observations must not consume turns.
			send({ type: "agent_start" });
			send({ type: "message_start", message: first });
			send({ type: "message_end", message: first });
			send({ type: "message_start", message: { ...partial, content: [] } });
			send({
				type: "message_update",
				usage: usage(3),
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "partial ",
				},
			});
			send({
				type: "message_update",
				usage: usage(5),
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: partial.content[0].text.slice(8),
				},
			});
			if (scenario === "turn" || scenario === "overlap")
				send({ type: "turn_end" });
			if (scenario === "settled" || scenario === "overlap") {
				send({
					type: "message_end",
					message: { ...partial, stopReason: "stop" },
				});
				send({ type: "agent_settled" });
			}
			if (scenario !== "held-acceptance")
				reply(command, { disposition: "started" });
		} else if (command.type === "abort") {
			reply(command, {});
		} else if (command.type === "get_entries") {
			if (["readback", "settled", "late-readback"].includes(scenario))
				reply(command, {
					entries: [
						{ type: "message", message: { ...first, usage: usage(4) } },
						{
							type: "message",
							message: {
								...partial,
								usage: usage(6),
								stopReason: scenario === "settled" ? "stop" : "aborted",
							},
						},
					],
				});
			// Other scenarios deliberately hold final-entry readback.
		} else if (command.type === "get_state")
			reply(command, { sessionId: "fixture" });
		else reply(command, {});
	})
	.on("close", () => {
		if (scenario === "late-readback")
			send({ type: "message_end", message: { ...partial, usage: usage(7) } });
		log({ kind: "closed" });
		process.exit(0);
	});
