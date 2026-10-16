import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, initTheme, VERSION, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, TuiAltScreen, stripTerminalSequences, visibleWidth, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { PeekController } from "../src/peek-controller.ts";
import { SessionLifecycle } from "../src/session-lifecycle.ts";
import { ThinkingLabelTarget } from "../src/thinking-label.ts";

function component() {
	return {
		children: [] as unknown[], label: "Thinking...",
		setHiddenThinkingLabel(label: string) { this.label = label; },
		setHideThinkingBlock() {}, updateContent() {},
	};
}

test("thinking compatibility finds the latest component, tolerates cycles and resets its cached target", () => {
	const first = component();
	const second = component();
	let renders = 0;
	const tui = { children: [first, { children: [second] }] as unknown[], requestRender() { renders++; } };
	tui.children.push(tui, null);
	const bridge = new ThinkingLabelTarget(tui as unknown as TUI);
	assert.equal(bridge.set("latest"), true);
	assert.equal(first.label, "Thinking...");
	assert.equal(second.label, "latest");
	const third = component();
	tui.children.push(third);
	bridge.set("cached");
	assert.equal(second.label, "cached");
	bridge.reset();
	bridge.set("next message");
	assert.equal(third.label, "next message");
	assert.equal(renders, 3);
});

test("missing/incompatible/throwing host components fail safely and later recover", () => {
	const tui = { children: [{ children: [], setHiddenThinkingLabel() { throw new Error("incompatible"); } }] as unknown[], requestRender() {} };
	const bridge = new ThinkingLabelTarget(tui as unknown as TUI);
	assert.equal(bridge.set("no target"), false);
	const broken = component();
	broken.setHiddenThinkingLabel = () => { throw new Error("host changed"); };
	tui.children.push(broken);
	assert.equal(bridge.set("throwing"), false);
	const recovered = component();
	tui.children.push(recovered);
	assert.equal(bridge.set("recovered"), true);
	assert.equal(recovered.label, "recovered");
});

// Actual pinned host component and TUI, not a fake label target. The clock and
// terminal are deterministic; this does not establish live font/IME compatibility.
const { AssistantMessageComponent } = await import(pathToFileURL(join(getPackageDir(), "dist/modes/interactive/components/assistant-message.js")).href);
initTheme("dark");

for (const mode of ["regular", "fullscreen"] as const) {
	test(`peek renders separate status/body rows in the actual ${mode} collapsed host block`, (t) => {
		assert.equal(VERSION, "1.1.0");
		let columns = 80;
		const terminal: Terminal = {
			get columns() { return columns; }, rows: 24, kittyProtocolActive: false,
			start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {},
			showCursor() {}, hideCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
			setTitle() {}, setProgress() {}, setProgramStatus() {},
		};
		const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
		const config = structuredClone(DEFAULT_CONFIG);
		config.icons.mode = "nerd";
		config.thinkingPeek.lines = 2;
		const lifecycle = new SessionLifecycle();
		lifecycle.start();
		let now = 1000;
		let message = { role: "assistant", content: [{ type: "thinking", thinking: "previous thought\nlatest thought" }] };
		const component = new AssistantMessageComponent(message, true);
		tui.addChild(component);
		const bridge = new ThinkingLabelTarget(tui);
		const ctx = {
			ui: {
				setHiddenThinkingLabel(label = "Thinking...") { component.setHiddenThinkingLabel(label); },
				notify(message: string) { assert.fail(message); },
			},
		} as unknown as ExtensionContext;
		const controller = new PeekController({
			getConfig: () => config,
			getEditor: () => ({
				getViewportWidth: () => terminal.columns,
				setLatestHiddenThinkingLabel: (label) => bridge.set(label),
				resetHiddenThinkingLabelTarget: () => bridge.reset(),
			}),
			getContext: () => ctx, isActive: () => true, isTuiContext: () => true,
			lifecycle, now: () => now, tickerIntervalMs: 0,
		});
		t.after(() => { controller.resetAndClear(ctx); tui.stop(); });
		const rows = () => {
			const rendered: string[] = component.render(terminal.columns);
			assert.ok(rendered.every((row) => visibleWidth(row) <= terminal.columns));
			return rendered.map((row) => stripTerminalSequences(row).trim()).filter(Boolean);
		};
		controller.messageStart(message, ctx);
		controller.messageUpdate(message, ctx);
		now += 4900;
		controller.tick(ctx);
		assert.deepEqual(rows(), [" ⠙ 4.9s", "previous thought", "latest thought"]);

		// Hidden label updates must not replace the host's expanded reasoning.
		component.setHideThinkingBlock(false);
		assert.equal(rows().join(" "), "previous thought latest thought");
		controller.tick(ctx);
		assert.equal(rows().join(" "), "previous thought latest thought");
		component.setHideThinkingBlock(true);

		message = { ...message, content: [{ type: "thinking", thinking: "## 分析边界\nprevious thought\nlatest thought" }] };
		component.updateContent(message, true);
		controller.messageUpdate(message, ctx);
		assert.deepEqual(rows(), [" ⠹ [分析边界] 4.9s", "previous thought", "latest thought"]);
		const titledRows: string[] = component.render(terminal.columns).map((row: string) => stripTerminalSequences(row));
		assert.ok(titledRows.filter((row) => row.trim()).every((row) => row.startsWith(" ") && !row.startsWith("  ")), "only native output padding, not status-width indentation");

		columns = 24;
		controller.tick(ctx);
		assert.deepEqual(rows().slice(1), ["previous thought", "latest thought"]);
		columns = 80;
		config.thinkingPeek.lines = 1;
		controller.configChanged(2, ctx);
		assert.deepEqual(rows().slice(1), ["latest thought"]);

		now = 69000;
		controller.messageEnd(message, ctx);
		assert.deepEqual(rows(), ["  (分析边界 · 1m 8s)"]);
		now += 10000;
		controller.tick(ctx);
		assert.deepEqual(rows(), ["  (分析边界 · 1m 8s)"]);

		config.thinkingPeek.lines = 0;
		controller.configChanged(1, ctx);
		assert.deepEqual(rows(), ["Thinking..."]);
	});
}
