import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.env.HANDOFF_SCENARIO ?? "stop";
const send = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const usage = {
	input: 2,
	output: 3,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 5,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let started = false;
createInterface({ input: process.stdin })
	.on("line", (line) => {
		appendFileSync(process.env.HANDOFF_LOG, `${line}\n`);
		const command = JSON.parse(line);
		const reply = (data, error) =>
			send({ type: "response", id: command.id, success: !error, data, error });
		if (command.type === "get_entries") {
			reply({
				entries: started
					? [
							{
								type: "message",
								message: {
									role: "assistant",
									content: [
										{
											type: "text",
											text: readFileSync(process.env.HANDOFF_OUTPUT, "utf8"),
										},
									],
									usage,
									stopReason: scenario,
									errorMessage:
										scenario === "error"
											? "fixture execution failure"
											: undefined,
								},
							},
						]
					: [
							{
								type: "custom",
								customType: "pi-delegate:init",
								data: {
									ok: scenario !== "startup",
									error: "fixture startup failure",
								},
							},
						],
			});
		} else if (command.type === "get_state")
			reply({ sessionId: "handoff-fixture" });
		else if (command.type === "prompt") {
			if (command.message === "/pi-delegate-init")
				return reply({ disposition: "handled" });
			started = true;
			send({ type: "agent_start" });
			reply({ disposition: "started" });
			if (scenario !== "hold") send({ type: "agent_settled" });
		} else reply({});
	})
	.on("close", () => process.exit(0));
