import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { resolveGlyphs } from "../src/icons.ts";
import { buildPeekLabel } from "../src/peek.ts";
import { PeekController, type PeekLabelEditor } from "../src/peek-controller.ts";
import { SessionLifecycle } from "../src/session-lifecycle.ts";

function fixture(initialTime?: number, tickerIntervalMs?: number) {
	let currentTime = initialTime ?? 1000;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	config.thinkingPeek.lines = 1;
	const lifecycle = new SessionLifecycle();
	lifecycle.start();
	const labels: string[] = [];
	const warnings: string[] = [];
	let clears = 0;
	let resets = 0;
	const host = { active: true, tui: true, supported: true, columns: 80 as number | undefined };
	const ctx = {
		ui: {
			setHiddenThinkingLabel(label?: string) { assert.equal(label, undefined); clears++; },
			notify(message: string, level: string) { assert.equal(level, "warning"); warnings.push(message); },
		},
	} as unknown as ExtensionContext;
	let editor: PeekLabelEditor | undefined = {
		getViewportWidth: () => host.columns,
		setLatestHiddenThinkingLabel(label) {
			if (!host.supported) return false;
			labels.push(label);
			return true;
		},
		resetHiddenThinkingLabelTarget() { resets++; },
	};
	const controller = new PeekController({
		getConfig: () => config,
		getEditor: () => editor,
		getContext: () => ctx,
		isActive: () => host.active,
		isTuiContext: () => host.tui,
		lifecycle,
		now: () => currentTime,
		tickerIntervalMs,
	});
	const update = (thinking: string, text = "") => controller.messageUpdate({
		role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text }],
	}, ctx);
	return {
		controller, config, lifecycle, host, ctx, labels, warnings, update,
		advance(ms: number) { currentTime += ms; },
		tick(ms = 80) {
			currentTime += ms;
			controller.tick(ctx);
		},
		get clears() { return clears; }, get resets() { return resets; },
		setEditor(next: PeekLabelEditor | undefined) { editor = next; },
	};
}

const assistant = { role: "assistant" };

test("peek updates only on changed thinking, freezes on answer/end, and resets each message target", () => {
	const f = fixture();
	f.controller.messageStart(assistant, f.ctx);
	f.update("first");
	assert.match(f.labels.at(-1)!, /~ ⠋ \d+\.\d+s\nfirst$/);
	f.update("first");
	assert.equal(f.labels.length, 1);
	f.update("second");
	assert.match(f.labels.at(-1)!, /~ ⠋ \d+\.\d+s\nsecond$/);
	f.update("second", "answer");
	assert.match(f.labels.at(-1)!, /~ \+ \(\d+\.\d+s\)$/);
	f.update("ignored", "longer answer");
	f.controller.messageEnd(assistant, f.ctx);
	assert.equal(f.labels.length, 3);
	f.controller.messageStart({ role: "toolResult" }, f.ctx);
	assert.equal(f.resets, 1);
	assert.equal(f.clears, 0);
	f.controller.messageStart(assistant, f.ctx);
	assert.equal(f.resets, 2);
	assert.equal(f.clears, 1);
	f.update("next message");
	assert.match(f.labels.at(-1)!, /~ ⠋ \d+\.\d+s\nnext message$/);
	f.controller.messageEnd({ role: "toolResult" }, f.ctx);
	assert.equal(f.labels.length, 4);
	f.controller.messageEnd(assistant, f.ctx);
	assert.match(f.labels.at(-1)!, /~ \+ \(\d+\.\d+s\)$/);
	f.controller.messageStart({ role: "user" }, f.ctx);
	assert.equal(f.clears, 2);
});

test("elapsed timer starts on first thinking chunk, progresses across deltas, and freezes on completion", () => {
	const f = fixture(1000);
	f.controller.messageStart(assistant, f.ctx);
	f.update("start thinking");
	assert.match(f.labels.at(-1)!, /~ ⠋ 0\.0s\nstart thinking$/);

	f.advance(14200);
	f.update("working on logic");
	assert.match(f.labels.at(-1)!, /~ ⠋ 14\.2s\nworking on logic$/);

	f.advance(2000);
	f.controller.messageEnd(assistant, f.ctx);
	assert.match(f.labels.at(-1)!, /~ \+ \(16\.2s\)$/);

	// Later time advances do not change the frozen duration
	f.advance(10000);
	f.controller.settled(f.ctx);
	assert.match(f.labels.at(-1)!, /~ \+ \(16\.2s\)$/);
});

test("ticker continuously updates spinner frame and elapsed time without new thinking deltas", (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	const f = fixture(1000);
	f.controller.messageStart(assistant, f.ctx);
	f.update("thinking deeply");
	assert.match(f.labels.at(-1)!, /~ ⠋ 0\.0s\nthinking deeply$/);

	// No new message updates arrive, but ticker ticks:
	f.advance(80);
	t.mock.timers.tick(80);
	assert.match(f.labels.at(-1)!, /~ ⠙ 0\.1s\nthinking deeply$/);

	f.advance(80);
	t.mock.timers.tick(80);
	assert.match(f.labels.at(-1)!, /~ ⠹ 0\.2s\nthinking deeply$/);

	// Stop ticker upon completion
	f.controller.messageEnd(assistant, f.ctx);
	assert.match(f.labels.at(-1)!, /~ \+ \(0\.2s\)$/);
});

test("elapsed timer preserves detected milestone in completed summary", () => {
	const f = fixture(1000);
	f.controller.messageStart(assistant, f.ctx);
	f.update("## Architecture Analysis\nworking...");
	f.advance(18400);
	f.controller.messageEnd(assistant, f.ctx);
	assert.match(f.labels.at(-1)!, /~ \+ \(Architecture Analysis · 18\.4s\)$/);
});

test("plain answers keep the native label; mixed first updates are already done", () => {
	const f = fixture();
	f.controller.messageUpdate(undefined, f.ctx);
	f.controller.messageUpdate({ role: "user", content: "text" }, f.ctx);
	f.controller.messageUpdate({ role: "assistant", content: [{ type: "text", text: "plain" }] }, f.ctx);
	f.controller.messageEnd(assistant, f.ctx);
	assert.deepEqual(f.labels, []);
	f.update("short thought", "answer");
	assert.equal(f.labels.length, 1);
	assert.match(f.labels[0]!, /~ \+ \(\d+\.\d+s\)$/);
});

test("settlement preserves the completed label instead of clearing after 300ms", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.update("thinking");
	f.controller.messageEnd(assistant, f.ctx);
	assert.match(f.labels.at(-1)!, /~ \+ \(\d+\.\d+s\)$/);
	f.controller.settled(f.ctx);
	t.mock.timers.tick(300);
	assert.equal(f.clears, 0, "completed label remains visible after settlement");

	// Next message start clears the prior label
	f.controller.messageStart(assistant, f.ctx);
	assert.equal(f.clears, 1, "cleared on next message start");
	f.update("later");
	assert.match(f.labels.at(-1)!, /~ ⠋ \d+\.\d+s\nlater$/);
	f.controller.resetAndClear();
	assert.equal(f.clears, 2, "fallback context is used when omitted");
});

test("settlement fallback finalizes abandoned thinking without messageEnd after delay", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture(1000);
	f.controller.messageStart(assistant, f.ctx);
	f.update("incomplete thought");
	assert.match(f.labels.at(-1)!, /~ ⠋ 0\.0s\nincomplete thought$/);

	f.advance(5000);
	// Abrupt settlement without prior messageEnd
	f.controller.settled(f.ctx);
	t.mock.timers.tick(299);
	assert.match(f.labels.at(-1)!, /~ ⠋ 0\.0s\nincomplete thought$/);

	t.mock.timers.tick(1);
	assert.match(f.labels.at(-1)!, /~ \+ \(5\.0s\)$/);
});

test("startTask cancels pending settlement fallback before 300ms", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture(1000);
	f.controller.messageStart(assistant, f.ctx);
	f.update("streaming thought");
	f.controller.settled(f.ctx);
	t.mock.timers.tick(100);

	// Next task starts before the 300ms timer
	f.controller.startTask();
	t.mock.timers.tick(250);
	assert.match(f.labels.at(-1)!, /~ ⠋ 0\.0s\nstreaming thought$/);
});

test("a new task preserves label until next message start", () => {
	const f = fixture();
	f.update("old task");
	f.controller.messageEnd(assistant, f.ctx);
	f.controller.settled(f.ctx);
	assert.equal(f.clears, 0);

	f.controller.startTask();
	assert.equal(f.clears, 0);
	f.controller.messageStart(assistant, f.ctx);
	assert.equal(f.clears, 1);
	f.update("current task");
	assert.match(f.labels.at(-1)!, /~ ⠋ \d+\.\d+s\ncurrent task$/);
});

test("session generation and shutdown independently guard delayed cleanup", () => {
	const f = fixture();
	f.update("old session");
	f.controller.messageEnd(assistant, f.ctx);
	f.controller.settled(f.ctx);
	assert.equal(f.clears, 0);
	f.lifecycle.shutdown();
	f.controller.messageStart(assistant, f.ctx);
	f.update("late event");
	f.controller.messageEnd(assistant, f.ctx);
	assert.equal(f.labels.length, 2);
	f.controller.resetAndClear(f.ctx); // UI uninstall also cleans up after shutdown
	assert.equal(f.clears, 1);
});

test("session restart and tree navigation reset targets, labels and pending timers", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.update("old session");
	f.controller.settled(f.ctx);
	f.lifecycle.start();
	f.controller.startSession();
	f.controller.clearLabel(f.ctx);
	f.update("new session");
	t.mock.timers.tick(300);
	assert.equal(f.clears, 1);
	assert.match(f.labels.at(-1)!, /new session$/);
	f.controller.settled(f.ctx);
	f.controller.startTask();
	f.controller.resetAndClear(f.ctx); // session_tree wiring
	f.update("new leaf");
	t.mock.timers.tick(300);
	assert.equal(f.clears, 2);
	assert.match(f.labels.at(-1)!, /new leaf$/);
});

test("line count changes rerender an active label with current viewport and unchanged spinner", () => {
	const f = fixture();
	f.update("previous\nlatest");
	assert.doesNotMatch(f.labels.at(-1)!, /previous/);
	f.host.columns = 30;
	f.config.thinkingPeek.lines = 2;
	f.controller.configChanged(1);
	assert.equal(f.labels.at(-1), buildPeekLabel(
		{ phase: "thinking", tail: "previous\nlatest", elapsedMs: 0 }, 0, resolveGlyphs("ascii"), 27, 2,
	));
	f.controller.configChanged(2);
	assert.equal(f.labels.length, 2);
	f.controller.resetAndClear();
	f.config.thinkingPeek.lines = 1;
	f.controller.configChanged(2);
	assert.equal(f.labels.length, 2, "inactive labels are not resurrected");
});

for (const toggle of ["enabled", "lines"] as const) {
	test(`${toggle} disable/re-enable clears state and waits for fresh thinking`, () => {
		const f = fixture();
		f.update("old");
		f.controller.messageEnd(assistant, f.ctx);
		f.controller.settled(f.ctx);
		assert.equal(f.clears, 0);
		if (toggle === "enabled") f.config.enabled = false;
		else f.config.thinkingPeek.lines = 0;
		f.controller.configChanged(1);
		assert.equal(f.clears, 1);
		f.update("disabled");
		assert.equal(f.labels.length, 2);
		f.config.enabled = true;
		f.config.thinkingPeek.lines = 1;
		f.controller.configChanged(toggle === "lines" ? 0 : 1);
		assert.equal(f.labels.length, 2);
		f.controller.messageStart(assistant, f.ctx);
		f.update("fresh");
		assert.match(f.labels.at(-1)!, /fresh$/);
	});
}

test("unsupported hosts warn once per session, keep native label, and can recover", () => {
	const f = fixture();
	f.host.supported = false;
	f.update("cannot write");
	assert.deepEqual(f.labels, []);
	assert.equal(f.warnings.length, 1);
	f.update("cannot write again");
	assert.equal(f.warnings.length, 1, "only warns once");
	f.host.supported = true;
	f.update("recovered");
	assert.equal(f.labels.length, 1);
});

test("missing viewport/editor falls back safely and target resets follow the current editor", () => {
	const f = fixture();
	f.setEditor(undefined);
	f.update("no editor");
	assert.deepEqual(f.labels, []);
	f.controller.startSession();
	assert.equal(f.resets, 0);
});

test("inactive/non-TUI/replayed events do not write labels; throwing idle probes still work", () => {
	const f = fixture();
	f.host.active = false;
	f.update("inactive");
	f.host.active = true;
	f.host.tui = false;
	f.update("not tui");
	f.host.tui = true;
	const idleCtx = {
		...f.ctx,
		isIdle() { return true; },
	} as unknown as ExtensionContext;
	f.controller.messageUpdate({
		role: "assistant", content: [{ type: "thinking", thinking: "idle" }],
	}, idleCtx);
	const brokenCtx = {
		...f.ctx,
		isIdle() { throw new Error("probe failed"); },
	} as unknown as ExtensionContext;
	f.controller.messageUpdate({
		role: "assistant", content: [{ type: "thinking", thinking: "broken probe" }],
	}, brokenCtx);
	assert.equal(f.labels.length, 1);
	assert.match(f.labels[0]!, /broken probe$/);
});
