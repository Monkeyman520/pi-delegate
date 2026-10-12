import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type JsonObject, validateToolArguments } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
	type DelegationOptions,
	registerDelegate,
	runDelegation,
} from "../src/delegate.ts";
import { delegationPrompt, type ResultFormat } from "../src/result-format.ts";
import { configurationContext } from "./fixtures/configuration-context.ts";
import { taskResult } from "./fixtures/task-record.ts";

const report =
	"Completion: reviewed; unfinished: none\nChanges: no file changes\nDeliverables: none available\nVerification: bun test not run (analysis only)\nBlockers and decisions: none";
const task = "/analyze only; do not modify files";
const context = "Explicit supplementary context";

function registration(run: typeof runDelegation) {
	const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
	const hooks = new Map<string, () => unknown>();
	const messages: { content: { text: string }[] }[] = [];
	let inheritanceReads = 0;
	registerDelegate(
		{
			registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) =>
				tools.set(tool.name, tool),
			on: (name: string, hook: () => unknown) => {
				hooks.set(name, hook);
				return () => {};
			},
			getAllTools: () => {
				inheritanceReads++;
				return [];
			},
			getActiveTools: () => [],
			getCommands: () => [],
			sendMessage: (message: { content: { text: string }[] }) =>
				messages.push(message),
		} as unknown as ExtensionAPI,
		run,
	);
	const tool = tools.get("delegate");
	if (!tool) throw new Error("Missing delegate");
	const ctx = {
		...configurationContext,
		cwd: process.cwd(),
		mode: "rpc",
		isProjectTrusted: () => false,
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as ExtensionToolContext;
	const prepare = (args: JsonObject) =>
		validateToolArguments(tool, {
			type: "toolCall",
			id: "call",
			name: "delegate",
			arguments: (tool.prepareArguments?.(args) ?? args) as JsonObject,
		});
	return {
		tools,
		tool,
		ctx,
		messages,
		prepare,
		inheritanceReads: () => inheritanceReads,
		close: async () => {
			await hooks.get("session_shutdown")?.();
		},
	};
}

async function until(predicate: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 5000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("Handoff fixture timed out");
		await Bun.sleep(5);
	}
}

async function fixture(
	action: (
		options: DelegationOptions,
		commands: () => { type: string; message?: string }[],
	) => Promise<void>,
	output = report,
	scenario = "stop",
) {
	const dir = await mkdtemp(join(tmpdir(), "delegate-handoff-"));
	const log = join(dir, "commands.jsonl");
	const outputPath = join(dir, "output.txt");
	await writeFile(outputPath, output);
	const commands = () =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	try {
		await action(
			{
				cwd: dir,
				args: [],
				task,
				context,
				snapshot: { version: 1, tools: [], active: [] },
				cliPath: resolve("tests/fixtures/handoff-rpc.mjs"),
				env: {
					HANDOFF_LOG: log,
					HANDOFF_OUTPUT: outputPath,
					HANDOFF_SCENARIO: scenario,
				},
			},
			commands,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function assertConvention(prompt: string) {
	expect(
		prompt.startsWith(`Task:\n${task}\n\nSupplementary context:\n${context}`),
	).toBe(true);
	for (const part of [
		"unfinished work",
		"changed file paths",
		"no file changes",
		"commit references",
		"none are available",
		"commands and results",
		"not performed and the reasons",
		"decisions needed from the parent",
		"options/recommendation",
		"unknown",
		"Do not invent",
		"take precedence",
		"return only JSON",
		"grants no extra permission",
		"not an enforced schema",
		"parent owns",
	])
		expect(prompt).toContain(part);
}

for (const background of [false, true]) {
	for (const prepared of [false, true]) {
		for (const resultFormat of [null, "json", "", 0, true, {}, ["handoff"]]) {
			test(`reject invalid format ${JSON.stringify(resultFormat)}, background=${background}, prepared=${prepared}`, async () => {
				let runs = 0;
				const r = registration(async () => {
					runs++;
					return taskResult();
				});
				try {
					const raw = { task, background, resultFormat };
					const args = prepared ? r.prepare(raw) : raw;
					const result = await r.tool.execute(
						"invalid",
						args,
						undefined,
						undefined,
						r.ctx,
					);
					expect(result.isError).toBe(true);
					expect(result.details).toMatchObject({
						status: "failed",
						error: expect.stringContaining("resultFormat"),
					});
					expect(result.details).not.toHaveProperty("taskId");
					expect(result.usage?.totalTokens).toBe(0);
					expect(r.inheritanceReads()).toBe(0);
					expect(runs).toBe(0);
					expect(r.messages).toEqual([]);
					expect(raw).toEqual({ task, background, resultFormat });
				} finally {
					await r.close();
				}
			});
		}
	}
}

test("format preparation clears caller diagnostics, isolates calls, and exposes the single literal schema", async () => {
	const calls: DelegationOptions[] = [];
	const r = registration(async (options) => {
		calls.push(options);
		return taskResult();
	});
	try {
		const bad = r.prepare({ task, resultFormat: null });
		const good = r.prepare({
			task,
			resultFormat: "handoff",
			__piDelegateResultFormatError: "injected",
		});
		expect(good).not.toHaveProperty("__piDelegateResultFormatError");
		expect(
			(await r.tool.execute("good", good, undefined, undefined, r.ctx)).isError,
		).toBe(false);
		expect(
			(await r.tool.execute("bad", bad, undefined, undefined, r.ctx)).isError,
		).toBe(true);
		expect(calls.map((call) => call.resultFormat)).toEqual(["handoff"]);
		expect(r.tool.parameters).toMatchObject({
			properties: {
				resultFormat: {
					const: "handoff",
					description: expect.stringContaining(
						"Explicit task output requirements prevail",
					),
				},
			},
		});
	} finally {
		await r.close();
	}
});

for (const resultFormat of [undefined, "handoff"] satisfies (
	| ResultFormat
	| undefined
)[]) {
	for (const background of [false, true]) {
		test(`public actual RPC submission and text channels, format=${resultFormat}, background=${background}`, async () => {
			await fixture(async (options, commands) => {
				let captured: DelegationOptions | undefined;
				const r = registration((accepted) => {
					captured = accepted;
					return runDelegation({
						...accepted,
						cliPath: options.cliPath,
						env: options.env,
						resultFormat: accepted.resultFormat,
						requestedConfiguration: undefined,
					});
				});
				try {
					const result = await r.tool.execute(
						"valid",
						r.prepare({
							task,
							context,
							cwd: options.cwd,
							background,
							...(resultFormat ? { resultFormat } : {}),
						}),
						undefined,
						undefined,
						r.ctx,
					);
					if (background)
						await until(async () => {
							const query = await r.tools
								.get("delegate_status")
								?.execute(
									"query",
									{ taskId: (result.details as { taskId: string }).taskId },
									undefined,
									undefined,
									r.ctx,
								);
							return (
								!!query && !!(query.details as { result?: unknown }).result
							);
						});
					const submission = commands().filter((command) =>
						command.message?.startsWith("Task:"),
					);
					expect(submission).toHaveLength(1);
					if (resultFormat) assertConvention(submission[0]?.message ?? "");
					else
						expect(submission[0]?.message).toBe(
							`Task:\n${task}\n\nSupplementary context:\n${context}`,
						);
					expect(captured?.resultFormat).toBe(resultFormat);
					const id = (result.details as { taskId: string }).taskId;
					const query = await r.tools
						.get("delegate_status")
						?.execute("query", { taskId: id }, undefined, undefined, r.ctx);
					expect(query?.content[0]).toMatchObject({
						text: expect.stringContaining(report),
					});
					expect(query).not.toHaveProperty("usage");
					if (background) {
						expect(r.messages).toHaveLength(0);
						// Repeated explicit queries preserve the retained result.
						const recovered = await r.tools
							.get("delegate_status")
							?.execute("again", { taskId: id }, undefined, undefined, r.ctx);
						expect(recovered?.content[0]).toMatchObject({
							text: expect.stringContaining(report),
						});
					} else {
						expect(result.content[0]).toMatchObject({ text: report });
						expect(result.usage?.totalTokens).toBe(5);
					}
				} finally {
					await r.close();
				}
			});
		});
	}
}

test("queued background keeps the captured selection through admission and child submission", async () => {
	await fixture(async (options, commands) => {
		let release!: () => void;
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		let blockerStarted = false;
		let queuedStarted = false;
		const previous = process.env.PI_DELEGATE_CONCURRENCY;
		process.env.PI_DELEGATE_CONCURRENCY = "1";
		const r = registration(async (accepted) => {
			if (accepted.task === "blocker") {
				blockerStarted = true;
				await hold;
				return taskResult();
			}
			queuedStarted = true;
			return runDelegation({
				...accepted,
				cliPath: options.cliPath,
				env: options.env,
				resultFormat: accepted.resultFormat,
				requestedConfiguration: undefined,
			});
		});
		try {
			const blocker = r.tool.execute(
				"blocker",
				{ task: "blocker", background: true },
				undefined,
				undefined,
				r.ctx,
			);
			await until(() => blockerStarted);
			await blocker;
			const ack = await r.tool.execute(
				"queued",
				r.prepare({
					task,
					context,
					cwd: options.cwd,
					background: true,
					resultFormat: "handoff",
				}),
				undefined,
				undefined,
				r.ctx,
			);
			expect(ack.details).toMatchObject({ status: "queued" });
			expect(queuedStarted).toBe(false);
			expect(commands()).toEqual([]);
			release();
			const id = (ack.details as { taskId: string }).taskId;
			let finalText = "";
			await until(async () => {
				const query = await r.tools
					.get("delegate_status")
					?.execute("query", { taskId: id }, undefined, undefined, r.ctx);
				finalText =
					query?.content[0]?.type === "text" ? query.content[0].text : "";
				return !!query && !!(query.details as { result?: unknown }).result;
			});
			assertConvention(
				commands().find((command) => command.message?.startsWith("Task:"))
					?.message ?? "",
			);
			expect(finalText).toContain(report);
			expect(r.messages).toHaveLength(0);
		} finally {
			release();
			await r.close();
			if (previous === undefined) delete process.env.PI_DELEGATE_CONCURRENCY;
			else process.env.PI_DELEGATE_CONCURRENCY = previous;
		}
	});
});

for (const [scenario, output, status, isError] of [
	["stop", '{"only":"JSON"}', "completed", false],
	["stop", "plain free text with no sections", "completed", false],
	["length", "Completion: unfinished", "incomplete", false],
	["error", "partial diagnostic text", "failed", true],
	["aborted", "partial cancelled text", "cancelled", true],
	["startup", "unused", "failed", true],
] as const) {
	test(`handoff is advisory for ${scenario} / ${output}`, async () => {
		await fixture(
			async (options, commands) => {
				const result = await runDelegation({
					...options,
					task: "Return only JSON",
					resultFormat: "handoff",
				});
				expect(result.details.status).toBe(status);
				expect(result.isError).toBe(isError);
				expect(result.content[0].text).not.toContain("Deliverables:");
				if (scenario !== "startup") {
					expect(result.content[0].text).toContain(output);
					if (scenario === "stop") expect(result.content[0].text).toBe(output);
					expect(
						commands().filter((command) =>
							command.message?.startsWith("Task:"),
						),
					).toHaveLength(1);
					expect(
						commands().find((command) => command.message?.startsWith("Task:"))
							?.message,
					).toContain("take precedence");
				} else {
					expect(result.content[0].text).toContain("fixture startup failure");
					expect(
						commands().filter((command) =>
							command.message?.startsWith("Task:"),
						),
					).toEqual([]);
				}
			},
			output,
			scenario,
		);
	});
}

test("active handoff cancellation keeps existing cleanup and does not submit a repair prompt", async () => {
	await fixture(
		async (options, commands) => {
			const controller = new AbortController();
			const operation = runDelegation({
				...options,
				resultFormat: "handoff",
				signal: controller.signal,
			});
			try {
				await until(() =>
					commands().some((command) => command.message?.startsWith("Task:")),
				);
				controller.abort();
				const result = await operation;
				expect(result.details.status).toBe("cancelled");
				expect(result.content[0].text).not.toContain("Deliverables:");
				expect(
					commands().filter((command) => command.type === "prompt"),
				).toHaveLength(2);
			} finally {
				controller.abort();
				await operation;
			}
		},
		"unused",
		"hold",
	);
});

test("large completed handoff keeps preview metadata and original full-output text", async () => {
	const output = `${report}\n${"evidence line\n".repeat(4000)}`;
	await fixture(async (options) => {
		const result = await runDelegation({ ...options, resultFormat: "handoff" });
		try {
			expect(result.details.status).toBe("completed");
			expect(result.details.truncation?.truncated).toBe(true);
			expect(result.details.fullOutputPath).toBeDefined();
			expect(
				readFileSync(result.details.fullOutputPath as string, "utf8"),
			).toBe(output);
		} finally {
			if (result.details.fullOutputPath)
				await rm(resolve(result.details.fullOutputPath, ".."), {
					recursive: true,
					force: true,
				});
		}
	}, output);
});

test("omitted prompt preserves context omission/empty values and slash safety", () => {
	expect(delegationPrompt("/command")).toBe("Task:\n/command");
	expect(delegationPrompt("task", "")).toBe(
		"Task:\ntask\n\nSupplementary context:\n",
	);
});
