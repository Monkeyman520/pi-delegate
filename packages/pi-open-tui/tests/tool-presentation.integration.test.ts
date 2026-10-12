import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
	createBashToolDefinition, createReadToolDefinition, createEditToolDefinition, createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, createCodemodeExtension,
	DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager, getPackageDir, initTheme, VERSION,
	type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ModelRegistry, type ToolInfo, type ToolRenderers, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, TuiMainScreen, TuiAltScreen, stripTerminalSequences, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { codemodeCalls, selectChildren, ToolPresentation } from "../src/tool-presentation.ts";
import openTui from "../src/index.ts";
import { createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

// Actual upgraded host registration, resolver chain and ToolExecutionComponent, with controlled
// results and an in-memory terminal. No provider, real terminal/font or IME visual claims.
const { ToolExecutionComponent } = await import(pathToFileURL(join(getPackageDir(), "dist/modes/interactive/components/tool-execution.js")).href);
initTheme("dark");

async function fixture(t: test.TestContext, mode: "regular" | "fullscreen" = "regular") {
	assert.equal(VERSION, "1.1.0");
	const cwd = await mkdtemp(join(tmpdir(), "open-tui-presentation-"));
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	let presentation!: ToolPresentation;
	let api!: ExtensionAPI;
	let now = 100;
	const read = createReadToolDefinition(cwd);
	const bash = createBashToolDefinition(cwd);
	const edit = createEditToolDefinition(cwd);
	const write = createWriteToolDefinition(cwd);
	const grep = createGrepToolDefinition(cwd);
	const find = createFindToolDefinition(cwd);
	const ls = createLsToolDefinition(cwd);
	let codemode!: ToolDefinition;
	const specialized = { renderCall: () => new Text("SPECIAL CALL", 0, 0), renderResult: () => new Text("SPECIAL RESULT AND CONTROLS", 0, 0) };
	const loader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [
			(pi) => { api = pi; presentation = new ToolPresentation(() => config, pi, () => now); },
			(pi) => { pi.registerToolRenderer((name, next) => name === "special" ? specialized : next()); },
			(pi) => { createCodemodeExtension()({ ...pi, registerTool(tool: ToolDefinition) { codemode = tool; pi.registerTool(tool); } } as unknown as ExtensionAPI); },
		],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	// Only resolve renderers: model registry is unused by this boundary.
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, SessionManager.inMemory(cwd), {} as ModelRegistry);
	// The real API binds tool discovery during session startup. Supply the real native schema for shell recognition.
	loaded.runtime.getAllTools = () => [read, bash, edit, write, grep, find, ls, codemode] as unknown as ToolInfo[];
	let writes = "";
	const terminal: Terminal = {
		columns: 100, rows: 40, kittyProtocolActive: false,
		start() {}, stop() {}, async drainInput() {}, write(data) { writes += data; }, moveBy() {},
		showCursor() {}, hideCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
		setTitle() {}, setProgress() {}, setProgramStatus() {},
	};
	const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
	presentation.startSession(true);
	t.after(async () => { presentation.shutdown(); tui.stop(); await rm(cwd, { recursive: true, force: true }); });
	const component = (name: string, id: string, args: unknown, base: ToolRenderers | undefined = runner.getToolDefinition(name) ?? ({ read, bash, edit, write, grep, find, ls, codemode } as Record<string, ToolRenderers>)[name]) => {
		const renderers = runner.resolveToolRenderers(name, () => base);
		return new ToolExecutionComponent(name, id, args, { outputPad: 0 }, renderers, tui, cwd);
	};
	return { cwd, config, presentation, component, runner, api, read, codemode, tui, terminal, writes: () => writes, advance(ms: number) { now += ms; } };
}
function result(text: string, details: unknown = undefined, isError = false, durationMs?: number) {
	return { content: [{ type: "text" as const, text }], details, isError, durationMs };
}
function frame(component: InstanceType<typeof ToolExecutionComponent>, width = 100): string {
	const lines = component.render(width);
	assert.ok(lines.every((line: string) => visibleWidth(line) <= width), `overflow at ${width}`);
	return stripTerminalSequences(lines.join("\n"));
}

for (const mode of ["regular", "fullscreen"] as const) {
	test(`${mode}: actual host compacts success, preserves expansion, width, duration and native escape hatch`, async (t) => {
		const f = await fixture(t, mode);
		const args = { path: "中文/é👩‍💻.txt" };
		const output = Array.from({ length: 25 }, (_, i) => `line-${i}`).join("\n");
		const value = result(output, undefined, false, 1500);
		const original = JSON.stringify({ args, value });
		const card = f.component("read", "one", args);
		card.updateResult(value);
		f.tui.addChild(card);
		assert.match(frame(card), /\+ ok read 中文/);
		assert.match(frame(card), /1\.5s/);
		assert.doesNotMatch(frame(card), /line-24/);
		card.setExpanded(true);
		assert.match(frame(card), /line-24/);
		card.setExpanded(false);
		for (const mode of ["ascii", "unicode", "nerd", "auto"] as const) {
			f.config.icons.mode = mode;
			for (const width of [12, 30, 60, 100]) frame(card, width);
		}
		initTheme("light"); card.invalidate(); frame(card); initTheme("dark"); card.invalidate();
		f.tui.start(); f.tui.renderNow(true);
		assert.ok(f.writes().length > 0);
		f.config.toolPresentation = false;
		assert.doesNotMatch(frame(card), /\+ ok read/);
		f.config.toolPresentation = true; f.config.enabled = false;
		assert.doesNotMatch(frame(card), /\+ ok read/);
		assert.equal(JSON.stringify({ args, value }), original);
	});
}

test("host error evidence, tail notices/paths, edit diff and image controls survive", async (t) => {
	const f = await fixture(t);
	const read = f.component("read", "read", { path: "file.txt" });
	read.updateResult(result("error is just a word\n" + "many\n".repeat(15) + "[Output truncated: Full output saved to: /tmp/full-tail.txt]", { truncation: { truncated: true }, fullOutputPath: "/tmp/中文/full-output.txt" }));
	assert.match(frame(read), /\+ ok/);
	assert.match(frame(read), /Output truncated by host/);
	assert.match(frame(read), /full-tail\.txt/);
	assert.match(frame(read), /full-output\.txt/);
	read.updateResult(result("permission denied\nfull error tail", undefined, true));
	assert.match(frame(read), /x error read/);
	assert.match(frame(read), /permission denied/);
	const bash = f.component("bash", "failure", { command: "a-command" });
	bash.updateResult(result("earlier output\n".repeat(30) + "Command exited with code 1", undefined, true));
	assert.match(frame(bash), /Command exited with code 1/);
	const edit = f.component("edit", "edit", { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] });
	edit.updateResult(result("Successfully replaced", { diff: "-1 old\n+1 new", firstChangedLine: 1 }));
	assert.match(frame(edit), /old/); assert.match(frame(edit), /new/);
	edit.setExpanded(true); frame(edit); edit.setExpanded(false);
	assert.match(frame(edit), /new/, "diff remains after expand/collapse");
	const image = f.component("read", "image", { path: "a.png" });
	const content = { content: [{ type: "image", data: "fixture", mimeType: "image/png" }], details: undefined, isError: false };
	image.updateResult(content);
	image.setShowImages(false);
	image.setExpanded(true);
	assert.match(frame(image), /image/i);
	assert.equal(content.content[0]!.data, "fixture");
});

test("codemode prioritizes ordered child activity, retains independent parent outcome/output and expanded records", async (t) => {
	const f = await fixture(t);
	const code = "// script-start\n" + "console.log('script-middle');\n".repeat(25) + "return 'script-end';";
	const calls = [
		{ id: "c/0", name: "read", args: '{"path":"one"}', status: "ok", durationMs: 1000 },
		{ id: "c/1", name: "read", args: '{"path":"two"}', status: "error", error: "child permission denied", durationMs: 1000 },
		{ id: "c/2", name: "models.classify", args: '{"provider":"typesafe","model":"jev"}', status: "running", cost: 0.005 },
		{ id: "c/3", name: "read", args: "bounded host argument...", status: "cancelled", error: "script ended" },
		...Array.from({ length: 8 }, (_, i) => ({ id: `c/${i + 4}`, name: `tool-${i}`, args: "summary", status: "ok" })),
	];
	const card = f.component("codemode", "c", { code });
	card.markExecutionStarted();
	card.updateResult(result("", { calls }), true);
	assert.match(frame(card), /Observed 12 calls/);
	assert.match(frame(card), /child permission denied/);
	assert.match(frame(card), /models.classify.*typesafe.*jev.*0\.005/);
	assert.match(frame(card), /cancelled/);
	assert.match(frame(card), /Hidden 7: 7 ok/);
	assert.doesNotMatch(frame(card), /%|script-middle/);
	card.updateResult(result("Script completed\nWall time 1.5 seconds\nOutput:\ncount: 2\n" + "output\n".repeat(20) + "parent-end", { calls, fullOutputPath: "/tmp/parent-output.txt" }, false, 1500));
	const compact = frame(card);
	assert.match(compact, /\+ ok codemode/); assert.match(compact, /1\.5s/);
	assert.match(compact, /1 error/); assert.match(compact, /count: 2/);
	assert.match(compact, /parent-output.txt/);
	card.setExpanded(true);
	const expanded = frame(card);
	assert.match(expanded, /script-end/); assert.match(expanded, /parent-end/);
	assert.match(expanded, /tool-7/); assert.match(expanded, /host summaries/);
	assert.match(expanded, /raw child results are not\s+retained/);
	card.setExpanded(false);
	card.updateResult(result("partial output\n" + "before\n".repeat(8) + "Script error: failed after write", { calls }, true));
	assert.match(frame(card), /x error codemode/); assert.match(frame(card), /partial output/);
	assert.match(frame(card), /failed after write/);
});

test("unknown/specialized schemas are styled without guessing malformed codemode records", async (t) => {
	const f = await fixture(t);
	const specialized = { renderCall: () => new Text("OTHER CALL", 0, 0), renderResult: () => new Text("OTHER RESULT", 0, 0) };
	assert.notEqual(f.runner.resolveToolRenderers("read", () => specialized), specialized);
	const other = f.component("read", "other", { command: "not necessarily a shell command" }, specialized);
	other.updateResult(result("actual output"));
	assert.match(frame(other), /ok read.*"command":/);
	assert.match(frame(other), /OTHER CALL/); assert.match(frame(other), /OTHER RESULT/);
	const special = f.component("special", "s", {}, specialized);
	special.updateResult(result("special output"));
	assert.match(frame(special), /ok special/);
	assert.match(frame(special), /SPECIAL CALL/);
	assert.match(frame(special), /SPECIAL RESULT AND CONTROLS/);
	const wrong = f.component("read", "wrong", { url: "not a file path" });
	wrong.updateResult(result("content"));
	assert.match(frame(wrong), /ok read.*"url":/);
	const code = f.component("codemode", "unknown", { code: "return 1;" });
	code.updateResult(result("unknown output", undefined));
	assert.match(frame(code), /ok codemode/);
	assert.doesNotMatch(frame(code), /Observed/);
	assert.match(frame(code), /return 1/);
	for (const details of [null, {}, { calls: [{ id: "1", name: "read", args: "{}", status: "guessed" }] }, { calls: [], fullOutputPath: 3 }]) assert.equal(codemodeCalls(details), undefined);
});

for (const mode of ["regular", "fullscreen"] as const) {
	test(`${mode}: every tool source and future tool gets generic styling without a dedicated renderer`, async (t) => {
		const f = await fixture(t, mode);
		for (const name of ["replace", "replace_match", "insert", "copy", "move", "ffgrep", "fffind", "delegate", "delegate_status", "computer_use_click", "mcp__example__search", "future_tool_2026"]) {
			const args = { query: "中文/é👩‍💻", custom: { mode: "example" } };
			const returned = result("actual output\n" + "other output\n".repeat(15) + "last-output", { fullOutputPath: "/tmp/" + "long/".repeat(8) + "saved.txt" }, false, 250);
			const snapshot = JSON.stringify({ args, returned });
			f.presentation.start(name); f.advance(500);
			const card = f.component(name, name, args);
			card.markExecutionStarted();
			assert.ok(frame(card).includes(`running ${name}`));
			assert.match(frame(card), /500ms/);
			card.updateResult(returned);
			assert.ok(frame(card).includes(`ok ${name}`));
			assert.match(frame(card), /"query":/); assert.match(frame(card), /actual output/);
			assert.match(frame(card), /250ms/); assert.doesNotMatch(frame(card), /last-output/);
			for (const width of [12, 30, 60]) frame(card, width);
			assert.match(frame(card, 22).replace(/\s+/g, ""), /saved\.txt/);
			card.setExpanded(true);
			assert.match(frame(card), /last-output/); assert.match(frame(card), /example/);
			card.setExpanded(false);
			card.updateResult(result("permission denied\n" + "output\n".repeat(10) + "failure-tail", undefined, true));
			assert.ok(frame(card).includes(`error ${name}`));
			assert.match(frame(card), /permission denied/); assert.match(frame(card), /failure-tail/);
			assert.equal(JSON.stringify({ args, returned }), snapshot);
			f.presentation.end(name);
		}
	});
}

test("late registration, missing renderers, history, generic images and settings keep content recoverable", async (t) => {
	const f = await fixture(t);
	const before = f.component("late_registered", "before", { path: "not-yet-connected" });
	before.updateResult(result("historical content"));
	assert.match(frame(before), /ok late_registered/);
	assert.doesNotMatch(frame(before), /0ms|Took|Elapsed/);
	let executed = 0;
	f.api.registerTool({ ...f.read, name: "late_registered", renderCall: undefined, renderResult: undefined,
		async execute() { executed++; return result("registered result"); } });
	const tool = f.runner.getToolDefinition("late_registered")!;
	assert.ok(tool);
	const value = await tool.execute("late", { path: "file" }, undefined, undefined, {} as ExtensionToolContext);
	const card = f.component("late_registered", "late", { path: "file" });
	card.updateResult({ ...value, isError: false });
	assert.match(frame(card), /ok late_registered.*"path":/); assert.match(frame(card), /registered result/);
	assert.equal(executed, 1, "rendering does not execute the tool again");
	const output = result("preview\n" + "data\n".repeat(12) + "last-data");
	card.updateResult(output);
	assert.doesNotMatch(frame(card), /last-data/);
	f.config.toolPresentation = false;
	assert.doesNotMatch(frame(card), /ok late_registered/);
	assert.match(frame(card), /last-data/);
	f.config.toolPresentation = true;
	assert.match(frame(card), /ok late_registered/);
	assert.doesNotMatch(frame(card), /last-data/);
	const image = f.component("mcp__image__fetch", "image", {});
	image.updateResult({ content: [{ type: "image", data: "fixture", mimeType: "image/png" }], details: undefined, isError: false });
	image.setShowImages(false);
	assert.match(frame(image), /image/i);
	image.setExpanded(true); assert.match(frame(image), /image/i);
});

test("renderer callback failures retain unified presentation and recover generic details", async (t) => {
	const f = await fixture(t);
	const base: ToolRenderers = {
		renderCall() { throw new Error("custom call renderer failed"); },
		renderResult() { throw new Error("custom result renderer failed"); },
	};
	const args = { content: "hidden argument ".repeat(20) + "ARGUMENT-END" };
	const card = f.component("broken_renderer", "broken", args, base);
	card.updateResult(result("output preview\n" + "output\n".repeat(10) + "OUTPUT-END"));
	assert.match(frame(card), /ok broken_renderer/);
	assert.match(frame(card), /output preview/);
	assert.doesNotMatch(frame(card), /ARGUMENT-END|OUTPUT-END/);
	card.setExpanded(true);
	assert.match(frame(card), /ARGUMENT-END/); assert.match(frame(card), /OUTPUT-END/);
	f.config.toolPresentation = false;
	assert.doesNotMatch(frame(card), /ok broken_renderer/);
	assert.match(frame(card), /OUTPUT-END/);
});

test("generic arguments are bounded and sanitized without inventing familiar-name semantics", async (t) => {
	const f = await fixture(t);
	for (const args of [undefined, null, "script text", [1, "two"], { path: "not-guaranteed-to-be-a-file", command: "not-guaranteed-to-be-a-shell" }]) {
		const card = f.component("bash", "foreign-bash", args, {});
		card.updateResult(result("error is only output", { calls: [{ status: "error" }], diff: "not an edit diff" }));
		assert.match(frame(card), /ok bash/);
		assert.doesNotMatch(frame(card), /Observed|More diff|x error/);
		card.setExpanded(true); frame(card, 20);
	}
	const args = { content: "long-content-".repeat(10000) + "ARGUMENT-END", injected: "\u001b[31mred\u001b]52;c;payload\u0007", nested: { one: { two: "deep" } } };
	const card = f.component("future", "bounded", args);
	card.updateResult(result("plain result"));
	assert.doesNotMatch(frame(card), /ARGUMENT-END|\u001b|\u0007/);
	card.setExpanded(true);
	assert.match(frame(card), /ARGUMENT-END/);
	const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
	const cycle = f.component("future", "cycle", cyclic);
	cycle.updateResult(result("result")); frame(cycle); cycle.setExpanded(true);
	assert.match(frame(cycle), /arguments unavailable/);
});

for (const renderShell of ["default", "self"] as const) {
	test(`${renderShell}: specialized components retain mouse/focus/input, state and lastComponent through composition`, async (t) => {
		const f = await fixture(t, "fullscreen");
		let clicks = 0; let invalidations = 0;
		const keys: string[] = [];
		const seenLast: Array<Component | undefined> = [];
		const sharedStates: unknown[] = [];
		const control = (label: string): Component & { focused: boolean } => ({
			focused: false, wantsKeyRelease: true,
			render: (width) => new Text(label, 0, 0).render(width),
			handleMouse(event) { if (event.type === "click") { clicks++; return { handled: true, focus: true }; } return undefined; },
			handleInput(data) { keys.push(data); },
			invalidate() { invalidations++; },
		});
		const callControl = control("CALL CONTROL");
		const resultControl = control("RESULT CONTROL — IMPORTANT METADATA");
		const base: ToolRenderers = {
			renderShell,
			renderCall(_args, _theme, ctx) { seenLast.push(ctx.lastComponent); sharedStates.push(ctx.state); return callControl; },
			renderResult(_result, _options, _theme, ctx) { seenLast.push(ctx.lastComponent); sharedStates.push(ctx.state); return resultControl; },
		};
		const card = f.component("mcp__interactive__widget", "interactive", { field: "value", content: "long argument ".repeat(30) + "ARGUMENT-END" }, base);
		card.updateResult(result("actual output\n" + "long output\n".repeat(15) + "OUTPUT-END"));
		for (const expanded of [false, true, false]) {
			card.setExpanded(expanded);
			const rendered = frame(card);
			assert.match(rendered, /ok mcp__interactive__widget/);
			assert.match(rendered, /CALL CONTROL/); assert.match(rendered, /IMPORTANT METADATA/);
			if (expanded) {
				assert.match(rendered, /ARGUMENT-END/); assert.match(rendered, /OUTPUT-END/);
			} else assert.doesNotMatch(rendered, /ARGUMENT-END|OUTPUT-END/);
			const lines = card.render(100);
			for (const label of ["CALL CONTROL", "RESULT CONTROL"]) {
				const y = lines.findIndex((line: string) => stripTerminalSequences(line).includes(label));
				assert.ok(y >= 0);
				const handled = card.handleMouse({ type: "click", button: "left", x: 1, y, screenX: 1, screenY: y, width: 100, height: lines.length, shift: false, ctrl: false, alt: false }) as { handled?: boolean; focus?: boolean; focusTarget?: Component; target: { component: Component } };
				assert.equal(handled.handled, true); assert.equal(handled.focus, true);
				const focused = handled.focusTarget ?? handled.target.component;
				assert.equal(focused, label === "CALL CONTROL" ? callControl : resultControl);
				assert.equal(focused.wantsKeyRelease, true);
				f.tui.setFocus(focused);
				focused.handleInput?.("test-key");
			}
			card.invalidate(); frame(card, 22);
		}
		assert.equal(clicks, 6); assert.equal(keys.length, 6); assert.ok(invalidations > 0);
		assert.ok(seenLast.includes(callControl) && seenLast.includes(resultControl));
		assert.ok(sharedStates.every((state) => state === sharedStates[0]));
		f.config.toolPresentation = false;
		assert.doesNotMatch(frame(card), /ok mcp__interactive__widget/);
		assert.match(frame(card), /CALL CONTROL/); assert.match(frame(card), /RESULT CONTROL/);
		f.config.enabled = false; f.config.toolPresentation = true;
		assert.doesNotMatch(frame(card), /ok mcp__interactive__widget/);
	});
}

test("native enhancements and all unfamiliar codemode child rows remain available", async (t) => {
	const f = await fixture(t);
	for (const [name, args, expected] of [
		["write", { path: "written.txt", content: "content" }, "written.txt"],
		["grep", { pattern: "needle", path: "src" }, "needle in src"],
		["find", { pattern: "*.ts", path: "src" }, "*.ts in src"],
		["ls", { path: "src" }, "src"],
	] as const) {
		const card = f.component(name, name, args);
		card.updateResult(result("output"));
		assert.ok(frame(card).includes(`ok ${name} ${expected}`));
	}
	const names = ["replace", "delegate", "computer_use_click", "mcp__new__tool", "future_tool"];
	const calls = names.map((name, i) => ({ id: `all/${i}`, name, args: `host-args-${i}`, status: "ok" }));
	const card = f.component("codemode", "all", { code: "return 'parent';" });
	card.updateResult(result("parent", { calls }));
	for (const name of names) assert.ok(frame(card).includes(`ok ${name}`));
	assert.match(frame(card), /Observed 5 calls/);
	card.setExpanded(true);
	for (const name of names) assert.ok(frame(card).includes(name));
	assert.match(frame(card), /raw child results are not\s+retained/);
});

test("live clocks are event-evidenced, isolated and forgotten on session/branch transitions", async (t) => {
	const f = await fixture(t);
	f.presentation.start("a"); f.advance(1000); f.presentation.start("b"); f.advance(500);
	const a = f.component("read", "a", { path: "a" }); const b = f.component("read", "b", { path: "b" });
	a.markExecutionStarted(); b.markExecutionStarted();
	assert.match(frame(a), /1\.5s/); assert.match(frame(b), /500ms/);
	f.presentation.start("a/1", "a");
	const nested = f.component("read", "a/1", { path: "nested" }); nested.markExecutionStarted();
	assert.doesNotMatch(frame(nested), /\d+(?:ms|s)/);
	f.presentation.reset(); f.presentation.start("a"); f.advance(2000);
	assert.doesNotMatch(frame(a), /\d+(?:ms|s)/, "old card cannot borrow a reused id's new clock");
	a.updateResult(result("historical content"));
	assert.doesNotMatch(frame(a), /0ms|2\.0s|Took/);
	f.presentation.shutdown(); f.presentation.start("inactive");
	assert.doesNotMatch(frame(f.component("read", "inactive", { path: "inactive" })), /\d+(?:ms|s)/);
});

test("important overflow remains discoverable and selected rows retain call order", () => {
	const calls = Array.from({ length: 12 }, (_, i) => ({ id: `${i}`, name: "read", args: "{}", status: i % 3 === 0 ? "ok" : "error" as "ok" | "error" }));
	const { shown, hidden } = selectChildren(calls);
	assert.deepEqual(shown.map((call) => call.id), ["1", "2", "4", "5", "7"]);
	assert.equal(hidden.filter((call) => call.status === "error").length, 3);
	assert.equal(codemodeCalls({ calls: [] })?.length, 0);
});

test("codemode parents keep separate records, no-call scripts and hidden failures remain explicit at narrow widths", async (t) => {
	const f = await fixture(t);
	const a = f.component("codemode", "parent-a", { code: 'return "a";' });
	const b = f.component("codemode", "parent-b", { code: 'return "b";' });
	const calls = Array.from({ length: 8 }, (_, i) => ({ id: `a/${i}`, name: "read", args: "a-only", status: "error" }));
	a.updateResult(result("a output", { calls }), true);
	b.updateResult(result("b output", { calls: [] }));
	assert.match(frame(a), /Observed 8 calls: 8 error/);
	assert.doesNotMatch(frame(b), /a-only|8 error/);
	assert.match(frame(b), /Observed 0 calls/); assert.match(frame(b), /b output/);
	const narrow = frame(a, 22).replace(/\s+/g, " ");
	assert.match(narrow, /Hidden 3: 3 error/);
	const read = f.component("read", "path", { path: "中文/" + "very-long/".repeat(8) });
	read.updateResult(result("preview", { fullOutputPath: "/tmp/" + "long/".repeat(8) + "saved.txt" }));
	assert.match(frame(read, 22).replace(/\s+/g, ""), /saved\.txt/);
});


test("actual shell schema and renderer are enhanced without recreating historical timing", async (t) => {
	const f = await fixture(t);
	const card = f.component("bash", "shell", { command: "echo " + "long-command ".repeat(30) });
	card.updateResult(result("shell output", undefined, false, 2200));
	assert.match(frame(card, 40), /ok bash/); assert.match(frame(card, 40), /2\.2s/);
	card.setExpanded(true); assert.match(frame(card), /shell output/);
	card.updateResult(result("old output"));
	assert.doesNotMatch(frame(card), /Took|Elapsed/);
});

test("native shell refresh timers finish after collapse/completion and branch reset", async (t) => {
	const f = await fixture(t);
	const intervals = new Map<ReturnType<typeof setInterval>, number>();
	const cleared = new Set<ReturnType<typeof setInterval>>();
	const originalSet = globalThis.setInterval;
	const originalClear = globalThis.clearInterval;
	t.mock.method(globalThis, "setInterval", ((callback: () => void, ms: number) => {
		const handle = originalSet(callback, ms);
		intervals.set(handle, ms);
		return handle;
	}) as typeof setInterval);
	t.mock.method(globalThis, "clearInterval", ((handle: ReturnType<typeof setInterval>) => {
		cleared.add(handle);
		originalClear(handle);
	}) as typeof clearInterval);
	for (const action of ["complete", "reset"] as const) {
		f.presentation.start(action);
		const card = f.component("bash", action, { command: "echo running" });
		card.markExecutionStarted(); card.setExpanded(true);
		card.updateResult(result("partial"), true); frame(card);
		const nativeTimer = [...intervals].find(([handle, ms]) => ms === 1000 && !cleared.has(handle))?.[0];
		assert.ok(nativeTimer, "expanded native shell starts its own refresh timer");
		card.setExpanded(false); frame(card);
		if (action === "complete") {
			card.updateResult(result("done", undefined, false, 500)); frame(card);
			f.presentation.end(action);
		} else f.presentation.reset();
		assert.ok(cleared.has(nativeTimer), `${action} clears the timer even after collapse`);
		if (action === "reset") {
			card.setExpanded(true); frame(card);
			assert.equal([...intervals].filter(([handle, ms]) => ms === 1000 && !cleared.has(handle)).length, 0,
				"rendering a detached old card does not resurrect its native timer");
		}
	}
});

test("actual codemode sandbox streams dynamic calls, caught child errors, output and irreversible side effects unchanged", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.cwd, "secret.txt"), "raw-child-secret-content");
	const tools = [createReadTool(f.cwd), createWriteTool(f.cwd)];
	let next = 0;
	const ctx = {
		tools, sessionManager: SessionManager.inMemory(f.cwd),
		async executeTool(name: string, args: unknown) {
			const toolCall = { type: "toolCall" as const, id: `actual/${++next}`, name, arguments: args };
			try {
				const tool = tools.find((candidate) => candidate.name === name)!;
				const value = await tool.execute(toolCall.id, args as never);
				return { toolCall, result: value, isError: false };
			} catch (error) {
				return { toolCall, result: result(String(error)), isError: true };
			}
		},
	} as unknown as ExtensionToolContext;
	const code = `const results = await Promise.allSettled([tools.read({path:"secret.txt"}), tools.read({path:"missing.txt"})]);\ntext(results.filter(r => r.status === "fulfilled").length);\nawait tools.write({path:"written.txt", content:"side effect"});\nreturn "actual-parent-count";`;
	const card = f.component("codemode", "actual", { code });
	card.markExecutionStarted();
	const updates: number[] = [];
	const returned = await f.codemode.execute("actual", { code }, undefined, (update) => {
		updates.push(codemodeCalls(update.details)?.length ?? -1);
		card.updateResult({ ...update, isError: false }, true);
		frame(card);
	}, ctx);
	assert.ok(updates.includes(1) && updates.includes(2) && updates.includes(3));
	const snapshot = JSON.stringify(returned);
	card.updateResult({ ...returned, isError: false });
	assert.match(frame(card), /1 error/); assert.match(frame(card), /\n1\s*\n/); // Actual parent output preview, not a reconstructed child result.
	assert.doesNotMatch(JSON.stringify(returned), /Script error:/);
	card.setExpanded(true);
	assert.match(frame(card), /actual-parent-count/);
	assert.doesNotMatch(frame(card), /raw-child-secret-content/, "absent child content is never reconstructed");
	assert.equal(JSON.stringify(returned), snapshot);
	const failedCode = `await tools.write({path:"written.txt", content:"mutation survives"}); text("partial output"); throw new Error("parent failed");`;
	const failed = await f.codemode.execute("failed", { code: failedCode }, undefined, undefined, ctx);
	const failedCard = f.component("codemode", "failed", { code: failedCode });
	failedCard.updateResult({ ...failed, isError: true });
	assert.match(frame(failedCard), /partial output/); assert.match(frame(failedCard), /parent failed/);
	const written = await tools[0]!.execute("verify", { path: "written.txt" } as never);
	assert.ok(written.content.some((part) => part.type === "text" && part.text.includes("mutation survives")));
});

test("unsupported public capability preserves native presentation and emits an explicit notice", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "open-tui-unsupported-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(dir, { recursive: true, force: true }); });
	const config = structuredClone(DEFAULT_CONFIG);
	config.thinkingPeek.lines = 0;
	for (const key of Object.keys(config.footerSegments) as Array<keyof typeof config.footerSegments>) config.footerSegments[key] = false;
	await writeFile(join(dir, "open-tui.json"), JSON.stringify(config));
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
	const notices: string[] = [];
	const pi = { on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, registerCommand() {} } as unknown as ExtensionAPI;
	const ctx = { hasUI: true, mode: "tui", cwd: dir, ui: { notify(message: string) { notices.push(message); }, setFooter() {}, setEditorComponent() {}, setHiddenThinkingLabel() {} } } as unknown as ExtensionContext;
	const presentation = new ToolPresentation(() => config, pi);
	assert.equal(presentation.available, false); assert.equal(presentation.resolver, undefined);
	openTui(pi);
	await handlers.get("session_start")!({ type: "session_start" }, ctx);
	assert.ok(notices.some((message) => message.includes("public renderer API") && message.includes("native presentation")));
	await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
});
