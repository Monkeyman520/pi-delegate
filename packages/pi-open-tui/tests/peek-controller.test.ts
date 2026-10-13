import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { resolveGlyphs } from "../src/icons.ts";
import { buildPeekLabel } from "../src/peek.ts";
import { PeekController, type PeekLabelEditor } from "../src/peek-controller.ts";
import { SessionLifecycle } from "../src/session-lifecycle.ts";
import { stripAnsi } from "../src/utils.ts";

function fixture() {
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
	});
	controller.startSession();
	const update = (thinking: string, text = "") => controller.messageUpdate({
		role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text }],
	}, ctx);
	return {
		controller, config, lifecycle, host, ctx, labels, warnings, update,
		get clears() { return clears; }, get resets() { return resets; },
		setEditor(next: PeekLabelEditor | undefined) { editor = next; },
	};
}

const assistant = { role: "assistant" };

test("peek updates only on changed thinking, freezes on answer/end, and resets each message target", () => {
	const f = fixture();
	f.controller.messageStart(assistant, f.ctx);
	f.update("first");
	assert.match(f.labels.at(-1)!, /think ⠙ first$/);
	f.update("first");
	assert.equal(f.labels.length, 1);
	f.update("second");
	assert.match(f.labels.at(-1)!, /think ⠹ second$/);
	f.update("second", "answer");
	assert.equal(f.labels.at(-1), "~ think +");
	f.update("ignored", "longer answer");
	f.controller.messageEnd(assistant, f.ctx);
	assert.equal(f.labels.length, 3);
	f.controller.messageStart({ role: "toolResult" }, f.ctx);
	assert.equal(f.resets, 2);
	assert.equal(f.clears, 0);
	f.controller.messageStart(assistant, f.ctx);
	assert.equal(f.resets, 3);
	assert.equal(f.clears, 1);
	f.update("next message");
	assert.match(f.labels.at(-1)!, /think ⠸ next message$/); // frames persist across messages
	f.controller.messageEnd({ role: "toolResult" }, f.ctx);
	assert.equal(f.labels.length, 4);
	f.controller.messageEnd(assistant, f.ctx);
	assert.equal(f.labels.at(-1), "~ think +");
	f.controller.messageStart({ role: "user" }, f.ctx);
	assert.equal(f.clears, 2);
});

test("plain answers keep the native label; mixed first updates are already done", () => {
	const f = fixture();
	f.controller.messageUpdate(undefined, f.ctx);
	f.controller.messageUpdate({ role: "user", content: [{ type: "thinking", thinking: "ignored" }] }, f.ctx);
	f.update("", "plain answer");
	f.controller.messageEnd(assistant, f.ctx);
	assert.deepEqual(f.labels, []);
	f.update("short thought", "answer");
	assert.deepEqual(f.labels, ["~ think +"]);
});

test("settlement holds the label for 300ms then resets its target and restores native label", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.update("thinking");
	f.controller.messageEnd(assistant, f.ctx);
	f.controller.settled(f.ctx);
	t.mock.timers.tick(299);
	assert.equal(f.clears, 0);
	assert.equal(f.resets, 1);
	t.mock.timers.tick(1);
	assert.equal(f.clears, 1);
	assert.equal(f.resets, 2);
	f.update("later");
	assert.match(f.labels.at(-1)!, /later$/);
	f.controller.resetAndClear();
	assert.equal(f.clears, 2, "fallback context is used when omitted");
});

test("a new no-user task epoch protects the existing label from old delayed cleanup", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.update("old task");
	f.controller.settled(f.ctx);
	f.controller.startTask(); // no message_start during task preparation
	t.mock.timers.tick(300);
	assert.equal(f.clears, 0);
	assert.equal(f.resets, 1);
	f.update("current task");
	assert.match(f.labels.at(-1)!, /think ⠹ current task$/);
	f.controller.settled(f.ctx);
	t.mock.timers.tick(300);
	assert.equal(f.clears, 1);
});

test("settlement replacement and message boundaries cancel pending cleanup", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.update("one");
	f.controller.settled(f.ctx);
	t.mock.timers.tick(100);
	f.controller.settled(f.ctx);
	t.mock.timers.tick(200);
	assert.equal(f.clears, 0);
	f.controller.messageStart(assistant, f.ctx);
	f.update("two");
	t.mock.timers.tick(100);
	assert.equal(f.clears, 1, "only message_start cleared the old label");
	assert.match(f.labels.at(-1)!, /two$/);
});

test("session generation and shutdown independently guard delayed cleanup", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = fixture();
	f.update("old session");
	f.controller.settled(f.ctx);
	f.lifecycle.start(); // even if the controller's explicit reset has not run yet
	t.mock.timers.tick(300);
	assert.equal(f.clears, 0);
	f.controller.settled(f.ctx);
	f.lifecycle.shutdown();
	t.mock.timers.tick(300);
	assert.equal(f.clears, 0);
	f.controller.messageStart(assistant, f.ctx);
	f.update("late event");
	f.controller.messageEnd(assistant, f.ctx);
	assert.equal(f.labels.length, 1);
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
		{ phase: "thinking", tail: "previous\nlatest" }, 1, resolveGlyphs("ascii"), 27, 2,
	));
	f.controller.configChanged(2);
	assert.equal(f.labels.length, 2);
	f.controller.resetAndClear();
	f.config.thinkingPeek.lines = 1;
	f.controller.configChanged(2);
	assert.equal(f.labels.length, 2, "inactive labels are not resurrected");
});

for (const toggle of ["enabled", "lines"] as const) {
	test(`${toggle} disable/re-enable clears state, cancels settlement and waits for fresh thinking`, (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const f = fixture();
		f.update("old");
		f.controller.settled(f.ctx);
		if (toggle === "enabled") f.config.enabled = false;
		else f.config.thinkingPeek.lines = 0;
		f.controller.configChanged(1);
		assert.equal(f.clears, 1);
		f.update("disabled");
		assert.equal(f.labels.length, 1);
		f.config.enabled = true;
		f.config.thinkingPeek.lines = 1;
		f.controller.configChanged(toggle === "lines" ? 0 : 1);
		assert.equal(f.labels.length, 1);
		f.update("fresh");
		t.mock.timers.tick(300);
		assert.equal(f.clears, 1);
		assert.match(f.labels.at(-1)!, /fresh$/);
	});
}

test("unsupported hosts warn once per session, keep native label, and can recover", () => {
	const f = fixture();
	f.host.supported = false;
	f.update("missing target");
	f.update("still missing");
	assert.equal(f.warnings.length, 1);
	assert.match(f.warnings[0]!, /thinking peek unavailable on this host; retaining the native label/);
	f.controller.resetAndClear();
	assert.equal(f.clears, 0, "failed label writes do not trigger a global native reset");
	f.host.supported = true;
	f.update("recovered");
	assert.match(f.labels.at(-1)!, /recovered$/);
	f.host.supported = false;
	f.controller.messageStart(assistant, f.ctx);
	f.update("missing again");
	assert.equal(f.warnings.length, 1);
	f.lifecycle.start();
	f.controller.startSession();
	f.controller.clearLabel(f.ctx);
	f.update("new session missing");
	assert.equal(f.warnings.length, 2);
});

test("missing viewport/editor falls back safely and target resets follow the current editor", () => {
	const f = fixture();
	f.host.columns = undefined;
	f.update("no viewport");
	assert.deepEqual(f.labels, []);
	assert.equal(f.warnings.length, 1);
	f.host.columns = 1;
	f.update("narrow");
	assert.equal(stripAnsi(f.labels.at(-1)!), "…");
	f.setEditor(undefined);
	f.controller.resetAndClear();
	assert.equal(f.resets, 1);
	f.update("no editor");
	assert.equal(f.warnings.length, 1);
	let nextResets = 0;
	f.setEditor({
		getViewportWidth: () => 80,
		setLatestHiddenThinkingLabel: () => true,
		resetHiddenThinkingLabelTarget: () => { nextResets++; },
	});
	f.controller.messageStart(assistant, f.ctx);
	assert.equal(nextResets, 1);
});

test("inactive/non-TUI/replayed events do not write labels; throwing idle probes still work", () => {
	const f = fixture();
	f.host.active = false;
	f.update("inactive");
	f.host.active = true;
	f.host.tui = false;
	f.update("non-TUI");
	assert.deepEqual(f.labels, []);
	assert.deepEqual(f.warnings, []);
	f.host.tui = true;
	const idleCtx = { ...f.ctx, isIdle: () => true } as ExtensionContext;
	f.controller.messageStart(assistant, idleCtx);
	f.controller.messageUpdate({ role: "assistant", content: [{ type: "thinking", thinking: "replay" }] }, idleCtx);
	assert.equal(f.resets, 1);
	assert.deepEqual(f.labels, []);
	const throwingCtx = { ...f.ctx, isIdle: () => { throw new Error("unsupported"); } } as ExtensionContext;
	f.controller.messageStart(assistant, throwingCtx);
	f.controller.messageUpdate({ role: "assistant", content: [{ type: "thinking", thinking: "live" }] }, throwingCtx);
	assert.match(f.labels.at(-1)!, /live$/);
	f.host.tui = false;
	f.controller.clearLabel();
	assert.equal(f.clears, 0);
	f.host.tui = true;
	f.controller.clearLabel();
	assert.equal(f.clears, 1);
});
