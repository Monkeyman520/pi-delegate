import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig, saveConfig, type OpenTuiConfig } from "../src/config.ts";
import { installEditor, OpenTuiEditor } from "../src/editor.ts";
import { getPendingUiChange } from "../src/index.ts";
import { registerSettingsCommand } from "../src/settings-command.ts";

interface SettingsComponent extends Component, Focusable {
	handleInput(data: string): void;
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

async function openSettings(
	initialConfig = structuredClone(DEFAULT_CONFIG),
	onChange?: (config: OpenTuiConfig) => void,
	settingsTheme: Theme = theme,
): Promise<{
	component: SettingsComponent;
	getConfig: () => OpenTuiConfig;
	isClosed: () => boolean;
	isOverlayClosed: () => boolean;
	waitForClose: () => Promise<void>;
}> {
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	let component: SettingsComponent | undefined;
	let config = initialConfig;
	let closed = false;
	let overlayClosed = false;

	const pi = {
		registerCommand: (_name: string, options: { handler: typeof commandHandler }) => {
			commandHandler = options.handler;
		},
	} as unknown as ExtensionAPI;

	registerSettingsCommand(pi, {
		getConfig: () => config,
		onConfigChanged: (nextConfig) => {
			config = nextConfig;
			onChange?.(nextConfig);
		},
		onOverlayClosed: () => {
			overlayClosed = true;
		},
	});

	const tui = { requestRender() {} } as TUI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (value: void) => void,
				) => Component,
			) => new Promise<void>((resolve) => {
				component = factory(tui, settingsTheme, {} as KeybindingsManager, (_value: void) => {
					closed = true;
					resolve();
				}) as SettingsComponent;
			}),
		},
	} as unknown as ExtensionContext;

	assert.ok(commandHandler);
	const closePromise = Promise.resolve(commandHandler("", ctx));
	assert.ok(component);

	return {
		component,
		getConfig: () => config,
		isClosed: () => closed,
		isOverlayClosed: () => overlayClosed,
		waitForClose: () => closePromise,
	};
}

function selectedLine(component: SettingsComponent): string {
	return component.render(80).find((line) => line.includes("→ ")) ?? "";
}

test("previews border styles without reinstalling and localizes their names", async () => {
	for (const language of ["en", "zh"] as const) {
		let mounted: OpenTuiEditor | undefined;
		let installs = 0;
		const editorTui = {
			terminal: { rows: 24 }, requestRender() {},
			getShowHardwareCursor: () => false,
		} as unknown as TUI;
		const handle = installEditor({} as ExtensionAPI, {
			ui: { setEditorComponent: (factory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]) => {
				installs++;
				assert.ok(factory);
				mounted = factory(editorTui, {
					borderColor: (s: string) => s,
					selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s,
						description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s },
				}, {} as Parameters<NonNullable<typeof factory>>[2]) as OpenTuiEditor;
			} },
		} as unknown as ExtensionContext, "block", undefined, "minimal");
		assert.ok(mounted);
		assert.match(mounted.render(40)[0] ?? "", /^─+$/);
		handle.setBorderStyle("surround");
		const config = structuredClone(DEFAULT_CONFIG);
		config.settingsLanguage = language;
		const settings = await openSettings(config, (next) => {
			handle.setBorderStyle(next.editorBorderStyle);
			assert.match(mounted!.render(40)[0] ?? "", next.editorBorderStyle === "minimal" ? /^─+$/ : /^╭/);
		});
		settings.component.handleInput("\t");
		settings.component.handleInput("\x1b[B");
		settings.component.handleInput("\x1b[B");
		assert.match(selectedLine(settings.component), language === "zh" ? /编辑器边框.*环绕/ : /Editor border.*Surround/);
		settings.component.handleInput("\r");
		assert.equal(settings.getConfig().editorBorderStyle, "minimal");
		assert.match(selectedLine(settings.component), language === "zh" ? /简洁/ : /Minimal/);
		settings.component.handleInput(" ");
		assert.equal(settings.getConfig().editorBorderStyle, "surround");
		assert.equal(installs, 1);
		settings.component.handleInput("q");
		await settings.waitForClose();
	}
});

for (const setting of ["icons", "thinkingPeek"] as const) {
	test(`preserves unknown nested config fields when cycling ${setting} through the panel`, async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-nested-settings-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		let settings: Awaited<ReturnType<typeof openSettings>> | undefined;
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			const icons = { mode: "auto", legacyGlyphs: { branch: "custom" }, futureModes: ["custom"] };
			const thinkingPeek = { lines: 1, legacyStyle: { color: "muted" }, futureEnabled: false };
			writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ icons, thinkingPeek }), "utf8");
			const config = loadConfig();
			assert.deepEqual(config.icons, icons);
			assert.deepEqual(config.thinkingPeek, thinkingPeek);
			settings = await openSettings(config, saveConfig);

			if (setting === "icons") {
				settings.component.handleInput("\t");
				assert.match(selectedLine(settings.component), /Icon mode/);
			} else {
				settings.component.handleInput("\x1b[B");
				settings.component.handleInput("\x1b[B");
				assert.match(selectedLine(settings.component), /Thinking peek/);
			}

			const values = setting === "icons" ? ["nerd", "unicode", "ascii", "auto"] : [2, 0, 1];
			for (const value of values) {
				settings.component.handleInput("\r");
				const expectedIcons = setting === "icons" ? { ...icons, mode: value } : icons;
				const expectedThinkingPeek = setting === "thinkingPeek" ? { ...thinkingPeek, lines: value } : thinkingPeek;
				assert.deepEqual(settings.getConfig().icons, expectedIcons);
				assert.deepEqual(settings.getConfig().thinkingPeek, expectedThinkingPeek);
				const reloaded = loadConfig();
				assert.deepEqual(reloaded.icons, expectedIcons);
				assert.deepEqual(reloaded.thinkingPeek, expectedThinkingPeek);
				assert.equal(settings.isClosed(), false);
			}
			assert.deepEqual(config.icons, icons);
			assert.deepEqual(config.thinkingPeek, thinkingPeek);
		} finally {
			settings?.component.handleInput("q");
			await settings?.waitForClose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
}

test("persists border styles and defaults legacy config to surround", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-border-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "open-tui.json"), "{}");
		assert.equal(loadConfig().editorBorderStyle, "surround");
		for (const style of ["minimal", "surround"] as const) {
			const config = structuredClone(DEFAULT_CONFIG);
			config.editorBorderStyle = style;
			saveConfig(config);
			assert.equal(loadConfig().editorBorderStyle, style);
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("closes cleanly after enabling or disabling the UI", async () => {
	for (const enabled of [true, false]) {
		const config = structuredClone(DEFAULT_CONFIG);
		config.enabled = enabled;
		const settings = await openSettings(config);

		settings.component.handleInput("\r");
		assert.equal(settings.getConfig().enabled, !enabled);
		assert.equal(settings.isClosed(), false);
		assert.equal(settings.isOverlayClosed(), false);

		settings.component.handleInput("q");
		assert.equal(settings.isClosed(), true);
		assert.equal(settings.isOverlayClosed(), false);
		await settings.waitForClose();
		assert.equal(settings.isOverlayClosed(), true);
	}
});

test("leaves fullscreen wheel speed to Pi settings", async () => {
	const settings = await openSettings();
	assert.doesNotMatch(settings.component.render(80).join("\n"), /wheel speed/i);
	assert.equal("fullscreen" in settings.getConfig(), false);
});

test("previews cursor styles from the Appearance tab", async () => {
	const writes: string[] = [];
	let editorInstalls = 0;
	let hardwareCursor = false;
	const editorTui = {
		terminal: { rows: 24, write: (data: string) => writes.push(data) },
		requestRender() {},
		getShowHardwareCursor: () => hardwareCursor,
		setShowHardwareCursor: (enabled: boolean) => {
			hardwareCursor = enabled;
		},
	} as unknown as TUI;
	const editor = installEditor({} as ExtensionAPI, {
		ui: {
			setEditorComponent: (factory: unknown) => {
				editorInstalls++;
				if (typeof factory === "function") {
					factory(editorTui, {
						borderColor: (text: string) => text,
						selectList: {},
					}, { matches: () => false });
				}
			},
		},
	} as unknown as ExtensionContext);
	const settings = await openSettings(undefined, (config) => editor.setCursorStyle(config.cursorStyle));

	settings.component.handleInput("\t");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\r");

	assert.equal(settings.getConfig().cursorStyle, "bar");
	assert.equal(settings.isClosed(), false);
	assert.equal(editorInstalls, 1);
	assert.equal(hardwareCursor, true);
	assert.ok(writes.includes("\x1b[6 q"));

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().cursorStyle, "underline");
	assert.ok(writes.includes("\x1b[4 q"));

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().cursorStyle, "block");
	assert.equal(hardwareCursor, false);
	assert.ok(writes.includes("\x1b[0 q"));
	assert.equal(editorInstalls, 1);
	assert.match(selectedLine(settings.component), /Cursor style/);
	assert.match(settings.component.render(80).join("\n"), /\[Appearance\].*Icon mode.*Cursor style/s);

	settings.component.handleInput("q");
	await settings.waitForClose();
	assert.equal(settings.isOverlayClosed(), true);
	editor.cleanup();
});

test("message layout defaults to normal, toggles live and localizes in Appearance", async () => {
	for (const language of ["en", "zh"] as const) {
		const config = structuredClone(DEFAULT_CONFIG);
		config.settingsLanguage = language;
		const observed: string[] = [];
		const settings = await openSettings(config, (next) => observed.push(next.messageLayout));
		settings.component.handleInput("\t");
		for (let i = 0; i < 5; i++) settings.component.handleInput("\x1b[B");
		assert.match(selectedLine(settings.component), language === "zh" ? /消息布局.*常规/ : /Message layout.*Normal/);
		settings.component.handleInput("\r");
		assert.equal(settings.getConfig().messageLayout, "compact");
		assert.match(selectedLine(settings.component), language === "zh" ? /紧凑/ : /Compact/);
		assert.equal(settings.isClosed(), false);
		settings.component.handleInput(" ");
		assert.deepEqual(observed, ["compact", "normal"]);
		settings.component.handleInput("q"); await settings.waitForClose();
	}
});

test("reconciles enabled changes with the installed UI", () => {
	assert.equal(getPendingUiChange(true, false), "install");
	assert.equal(getPendingUiChange(false, true), "uninstall");
	assert.equal(getPendingUiChange(true, true), undefined);
	assert.equal(getPendingUiChange(false, false), undefined);
});

test("keeps the changed setting selected", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Git branch/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().footerSegments.gitBranch, false);
	assert.match(selectedLine(settings.component), /Git branch/);
});

test("remembers the selection for each tab", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	// Wrap through all five tabs, preserving the Footer selection.
	for (let i = 0; i < 5; i++) settings.component.handleInput("\t");

	assert.match(selectedLine(settings.component), /Git branch/);
});

test("configures telemetry from its own tab", async () => {
	const settings = await openSettings();

	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	settings.component.handleInput("\t");
	assert.match(selectedLine(settings.component), /Enabled/);

	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().telemetry.enabled, false);
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().telemetry.tps, false);
});

test("supports localized settings and keyboard shortcuts", async () => {
	const settings = await openSettings();
	assert.match(settings.component.render(80).join("\n"), /Open TUI Settings.*General.*Language/s);

	settings.component.handleInput("\x1b[B");
	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().settingsLanguage, "zh");
	assert.match(settings.component.render(80).join("\n"), /Open TUI 设置.*常规.*语言.*简体中文/s);
	assert.match(selectedLine(settings.component), /语言/);

	const reopened = await openSettings(structuredClone(settings.getConfig()));
	assert.match(reopened.component.render(80).join("\n"), /Open TUI 设置.*简体中文/s);

	reopened.component.handleInput("\x1b[B");
	reopened.component.handleInput("\x1b[C");
	assert.match(reopened.component.render(80).join("\n"), /\[外观\].*图标模式.*光标样式/s);
	reopened.component.handleInput("\x1b[D");
	assert.match(selectedLine(reopened.component), /语言/);
	reopened.component.handleInput("q");
	assert.equal(reopened.isClosed(), true);
});

test("configures inline footer from General settings", async () => {
	const settings = await openSettings();
	// Enabled → Language → Thinking peek → Inline footer
	for (let i = 0; i < 3; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Inline footer/);
	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().inlineFooter, true);
});

test("configures the hostname footer segment", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\x1b[C");
	settings.component.handleInput("\x1b[C");
	settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Hostname/);

	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().footerSegments.hostname, true);
	assert.match(selectedLine(settings.component), /Hostname/);
});

test("configures the extension status line with Space", async () => {
	const settings = await openSettings();
	settings.component.handleInput("\x1b[C");
	settings.component.handleInput("\x1b[C");
	for (let i = 0; i < 10; i++) settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Extension status line/);

	settings.component.handleInput(" ");
	assert.equal(settings.getConfig().footerSegments.extensionStatuses, false);
	assert.match(selectedLine(settings.component), /Extension status line/);
});

test("keeps localized settings and values within narrow widths", async () => {
	const config = structuredClone(DEFAULT_CONFIG);
	config.settingsLanguage = "zh";
	const settings = await openSettings(config);

	for (const width of [24, 36, 48]) {
		const lines = settings.component.render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
		}
		const output = lines.join("\n");
		assert.match(output, /开启/);
		assert.match(output, /简体中文/);
	}
});

test("normalizes invalid settings values", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({
			settingsLanguage: "de",
			cursorStyle: "invalid",
			editorBorderStyle: "invalid",
			inlineFooter: "yes",
			thinkingPeek: { lines: 9 },
			fullscreen: { wheelScrollLines: 10 },
		}), "utf8");
		const loaded = loadConfig();
		assert.equal(loaded.settingsLanguage, "en");
		assert.equal(loaded.cursorStyle, "block");
		assert.equal(loaded.editorBorderStyle, "surround");
		assert.equal(loaded.inlineFooter, false);
		assert.equal(loaded.thinkingPeek.lines, 1);
		assert.equal("fullscreen" in loaded, true);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("cycles the thinking peek line count from General settings", async () => {
	const config = structuredClone(DEFAULT_CONFIG);
	const settings = await openSettings(config);
	// Enabled → Language → Thinking peek
	settings.component.handleInput("\x1b[B");
	settings.component.handleInput("\x1b[B");
	assert.match(selectedLine(settings.component), /Thinking peek/);
	assert.match(selectedLine(settings.component), /1 line/);
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().thinkingPeek.lines, 2);
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().thinkingPeek.lines, 0);
	settings.component.handleInput("\r");
	assert.equal(settings.getConfig().thinkingPeek.lines, 1);
	settings.component.handleInput("q");
});

test("Workline settings are independent, localized and persist normalized defaults", async () => {
	for (const language of ["en", "zh"] as const) {
		const config = structuredClone(DEFAULT_CONFIG);
		config.settingsLanguage = language;
		const settings = await openSettings(config);
		settings.component.handleInput("\t");
		for (let i = 0; i < 3; i++) settings.component.handleInput("\x1b[B");
		assert.match(selectedLine(settings.component), language === "zh" ? /Workline 跑马灯.*开启/ : /Workline marquee.*On/);
		settings.component.handleInput("\r");
		assert.deepEqual(settings.getConfig().workline, { marquee: false, attachToBorder: true });
		settings.component.handleInput("\x1b[B");
		assert.match(selectedLine(settings.component), language === "zh" ? /Workline 贴合边框.*开启/ : /Workline attached to border.*On/);
		settings.component.handleInput(" ");
		assert.deepEqual(settings.getConfig().workline, { marquee: false, attachToBorder: false });
		settings.component.handleInput("q");
		await settings.waitForClose();
	}
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-workline-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		for (const workline of [undefined, null, [], false, { marquee: "yes", attachToBorder: 1 }]) {
			writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ workline }));
			assert.deepEqual(loadConfig().workline, DEFAULT_CONFIG.workline);
		}
		writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ workline: { marquee: false } }));
		assert.deepEqual(loadConfig().workline, { marquee: false, attachToBorder: true });
		for (const marquee of [true, false]) for (const attachToBorder of [true, false]) {
			const config = structuredClone(DEFAULT_CONFIG);
			config.workline = { marquee, attachToBorder };
			saveConfig(config);
			assert.deepEqual(loadConfig().workline, config.workline);
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("compact tool presentation is independently toggleable and localized", async () => {
	for (const language of ["en", "zh"] as const) {
		const config = structuredClone(DEFAULT_CONFIG);
		config.settingsLanguage = language;
		const settings = await openSettings(config);
		for (let i = 0; i < 4; i++) settings.component.handleInput("\x1b[B");
		assert.match(selectedLine(settings.component), language === "zh" ? /紧凑工具展示.*开启/ : /Compact tool presentation.*On/);
		settings.component.handleInput(" ");
		assert.equal(settings.getConfig().toolPresentation, false);
		assert.equal(settings.getConfig().enabled, true);
		assert.deepEqual(settings.getConfig().footerSegments, config.footerSegments);
		settings.component.handleInput("q");
		await settings.waitForClose();
	}
});

function selectSetting(component: SettingsComponent, label: RegExp): void {
	for (let i = 0; i < 12 && !label.test(selectedLine(component)); i++) component.handleInput("\x1b[B");
	assert.match(selectedLine(component), label);
}

function clearTextInput(component: SettingsComponent): void {
	component.handleInput("\x05"); // Move to the end before clearing the prefilled value.
	component.handleInput("\x15");
}

test("exposes all tool border settings in a localized tab and previews independent changes", async () => {
	for (const language of ["en", "zh"] as const) {
		const config = structuredClone(DEFAULT_CONFIG);
		config.settingsLanguage = language;
		const original = structuredClone(config);
		const observed: OpenTuiConfig[] = [];
		const settings = await openSettings(config, (next) => observed.push(next));
		for (let i = 0; i < 4; i++) settings.component.handleInput("\t");
		assert.match(settings.component.render(80).join("\n"), language === "zh" ? /\[工具边框\]/ : /\[Tool borders\]/);
		assert.match(selectedLine(settings.component), language === "zh" ? /工具卡片边框.*关闭/ : /Tool box borders.*Off/);
		settings.component.handleInput(" ");
		assert.equal(settings.getConfig().toolBoxBorder.enabled, true);
		settings.component.handleInput("\x1b[B");
		const styleNames = language === "zh" ? ["粗线", "双线", "虚线", "自定义", "单线"] : ["Bold", "Double", "Dashed", "Custom", "Single"];
		for (const [i, style] of (["bold", "double", "dashed", "custom", "single"] as const).entries()) {
			settings.component.handleInput("\r");
			assert.equal(settings.getConfig().toolBoxBorder.style, style);
			assert.ok(selectedLine(settings.component).includes(styleNames[i]!));
		}
		settings.component.handleInput("\x1b[B");
		settings.component.handleInput(" ");
		assert.equal(settings.getConfig().toolBoxBorder.colorMode, "static");
		assert.match(selectedLine(settings.component), language === "zh" ? /固定配色/ : /Static/);
		settings.component.handleInput("\r");
		assert.equal(settings.getConfig().toolBoxBorder.colorMode, "status");
		for (const [edge, label] of [
			["top", language === "zh" ? /上边框.*开启/ : /Top border.*On/],
			["bottom", language === "zh" ? /下边框.*开启/ : /Bottom border.*On/],
			["left", language === "zh" ? /左边框.*开启/ : /Left border.*On/],
		] as const) {
			selectSetting(settings.component, label);
			settings.component.handleInput(" ");
			assert.equal(settings.getConfig().toolBoxBorder[edge].enabled, false);
		}
		assert.equal(observed.length, 11);
		assert.deepEqual(config, original, "UI changes must not mutate the previous configuration");
		assert.deepEqual({ ...settings.getConfig(), toolBoxBorder: original.toolBoxBorder }, original);
		for (const width of [24, 36, 48, 80]) {
			for (const line of settings.component.render(width)) assert.ok(visibleWidth(line) <= width);
		}
		settings.component.handleInput("\t");
		assert.match(selectedLine(settings.component), language === "zh" ? /启用/ : /Enabled/);
		settings.component.handleInput("q");
		await settings.waitForClose();
	}
});

test("edits and resets border symbols and static color without losing nested fields on save/reload", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-open-tui-border-settings-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	let settings: Awaited<ReturnType<typeof openSettings>> | undefined;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const border = Object.assign(structuredClone(DEFAULT_CONFIG.toolBoxBorder), {
			color: "muted", legacyStyle: { keep: true },
			top: { enabled: true, char: "-", legacyField: "keep" },
		});
		writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ toolBoxBorder: border }));
		const config = loadConfig();
		const original = structuredClone(config);
		settings = await openSettings(config, saveConfig);
		settings.component.focused = true;
		settings.component.handleInput("\x1b[Z");
		for (const [label, value, edge] of [
			[/Top symbol/, "#", "top"],
			[/Bottom symbol/, "=", "bottom"],
			[/Left symbol/, "q", "left"],
		] as const) {
			selectSetting(settings.component, label);
			settings.component.handleInput(" ");
			clearTextInput(settings.component);
			settings.component.handleInput(value);
			assert.deepEqual(loadConfig().toolBoxBorder, settings.getConfig().toolBoxBorder, "Typing is not a save");
			assert.equal(settings.isClosed(), false, "q is text inside an input");
			assert.ok(settings.component.render(80).some((line) => line.includes("\x1b_pi:c")));
			settings.component.focused = false;
			assert.ok(settings.component.render(80).every((line) => !line.includes("\x1b_pi:c")));
			settings.component.focused = true;
			for (const width of [24, 36, 48]) {
				for (const line of settings.component.render(width)) assert.ok(visibleWidth(line) <= width);
			}
			settings.component.handleInput("\r");
			assert.equal(settings.getConfig().toolBoxBorder[edge].char, value);
			assert.match(selectedLine(settings.component), label);
			assert.deepEqual(loadConfig().toolBoxBorder, settings.getConfig().toolBoxBorder);
			settings.component.handleInput("\r");
			clearTextInput(settings.component);
			settings.component.handleInput("\r");
			assert.equal(Object.hasOwn(settings.getConfig().toolBoxBorder[edge], "char"), false);
			assert.match(selectedLine(settings.component), /Default/);
			assert.deepEqual(loadConfig().toolBoxBorder, settings.getConfig().toolBoxBorder);
		}
		selectSetting(settings.component, /Static color/);
		settings.component.handleInput("\r");
		clearTextInput(settings.component);
		settings.component.handleInput("accent");
		settings.component.handleInput("\x1b[D");
		settings.component.handleInput("\x1b[C");
		settings.component.handleInput("\r");
		assert.equal(settings.getConfig().toolBoxBorder.color, "accent");
		assert.deepEqual(loadConfig().toolBoxBorder, settings.getConfig().toolBoxBorder);
		settings.component.handleInput("\r");
		clearTextInput(settings.component);
		settings.component.handleInput("\r");
		assert.equal(Object.hasOwn(loadConfig().toolBoxBorder, "color"), false);
		assert.deepEqual((loadConfig().toolBoxBorder as typeof border).legacyStyle, { keep: true });
		assert.equal((loadConfig().toolBoxBorder.top as typeof border.top).legacyField, "keep");
		assert.deepEqual(config, original);
	} finally {
		settings?.component.handleInput("\x1b");
		if (settings && !settings.isClosed()) settings.component.handleInput("\x1b");
		await settings?.waitForClose();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("cancels text edits and rejects unsafe symbols and unknown theme colors", async () => {
	for (const language of ["en", "zh"] as const) {
		const config = structuredClone(DEFAULT_CONFIG);
		config.settingsLanguage = language;
		config.toolBoxBorder.top.char = "#";
		const observed: OpenTuiConfig[] = [];
		const settings = await openSettings(config, (next) => observed.push(next), {
			...theme,
			fg: (color: string, text: string) => {
				if (color === "notAColor") throw new Error("Unknown theme color");
				return text;
			},
		} as Theme);
		settings.component.handleInput("\x1b[Z");
		selectSetting(settings.component, language === "zh" ? /上边框符号/ : /Top symbol/);
		settings.component.handleInput("\r");
		clearTextInput(settings.component);
		settings.component.handleInput("界");
		settings.component.handleInput("\r");
		assert.match(settings.component.render(80).join("\n"), language === "zh" ? /占一个显示列/ : /one visible column/);
		assert.equal(settings.getConfig().toolBoxBorder.top.char, "#");
		assert.equal(observed.length, 0);
		settings.component.handleInput("\x1b");
		assert.match(selectedLine(settings.component), language === "zh" ? /上边框符号/ : /Top symbol/);
		assert.equal(settings.isClosed(), false);
		selectSetting(settings.component, language === "zh" ? /固定颜色/ : /Static color/);
		settings.component.handleInput("\r");
		settings.component.handleInput("notAColor");
		settings.component.handleInput("\r");
		assert.match(settings.component.render(80).join("\n"), language === "zh" ? /未知的主题颜色/ : /Unknown theme color/);
		assert.equal(observed.length, 0);
		settings.component.handleInput("\x1b");
		settings.component.handleInput("q");
		await settings.waitForClose();
	}
});
