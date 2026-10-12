import * as host from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme, ToolRenderers, ToolRendererResolver, CodemodeToolDetails } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, getCapabilities, imageFallback, visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { OpenTuiConfig } from "./config.ts";
import { resolveGlyphs } from "./icons.ts";

type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Child = CodemodeToolDetails["calls"][number];
type Status = Child["status"] | "pending";
const CARD = Symbol("open-tui-tool-card");
const CHILD_ROWS = 5;
const OUTPUT_LINES = 3;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function clean(text: string): string {
	// Never allow untrusted arguments/output to inject terminal controls into a summary.
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
function duration(ms: number | undefined): string {
	return ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function textOutput(result: Result): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

/** Strictly validate the available host metadata; never infer child status from output. */
export function codemodeCalls(details: unknown): Child[] | undefined {
	if (!record(details) || !Array.isArray(details.calls)) return undefined;
	if (details.fullOutputPath !== undefined && typeof details.fullOutputPath !== "string") return undefined;
	if (!details.calls.every((call: unknown) => record(call)
		&& typeof call.id === "string" && typeof call.name === "string" && typeof call.args === "string"
		&& ["running", "ok", "error", "cancelled"].includes(String(call.status))
		&& (call.durationMs === undefined || finite(call.durationMs))
		&& (call.cost === undefined || finite(call.cost))
		&& (call.error === undefined || typeof call.error === "string"))) return undefined;
	return details.calls as Child[];
}

export function selectChildren(calls: readonly Child[], budget = CHILD_ROWS): { shown: Child[]; hidden: Child[] } {
	const priority = calls.filter((call) => call.status !== "ok");
	const selected = new Set([...priority, ...calls.filter((call) => call.status === "ok")].slice(0, budget));
	return { shown: calls.filter((call) => selected.has(call)), hidden: calls.filter((call) => !selected.has(call)) };
}
function counts(calls: readonly Child[]): string {
	return (["running", "ok", "error", "cancelled"] as const)
		.map((status) => ({ status, count: calls.filter((call) => call.status === status).length }))
		.filter(({ count }) => count > 0).map(({ status, count }) => `${count} ${status}`).join(", ");
}

/** Native identity gates only tool-specific enhancements, never basic styling eligibility. */
function nativeRenderers(): Map<string, ToolRenderers & { parameters: unknown }> {
	const cwd = process.cwd();
	const definitions = [
		host.createReadToolDefinition(cwd), host.createBashToolDefinition(cwd),
		host.createEditToolDefinition(cwd), host.createWriteToolDefinition(cwd),
		host.createGrepToolDefinition(cwd), host.createFindToolDefinition(cwd), host.createLsToolDefinition(cwd),
	];
	const native = new Map<string, ToolRenderers & { parameters: unknown }>(definitions.map((tool) => [tool.name, tool as ToolRenderers & { parameters: unknown }]));
	// Capture a definition on a capture-only stub, not the real API: no tools are re-registered or executed.
	host.createCodemodeExtension()({ registerTool: (tool: { name: string } & ToolRenderers & { parameters: unknown }) => native.set(tool.name, tool) } as unknown as ExtensionAPI);
	return native;
}
function target(name: string, args: unknown): string | undefined {
	if (!record(args)) return undefined;
	if (name === "codemode") return typeof args.code === "string" ? "script" : undefined;
	if (name === "bash") return typeof args.command === "string" ? args.command : undefined;
	if (name === "grep" || name === "find") {
		return typeof args.pattern === "string" && (args.path === undefined || typeof args.path === "string")
			? `${args.pattern}${args.path ? ` in ${args.path}` : ""}` : undefined;
	}
	if (name === "ls") return args.path === undefined ? "." : typeof args.path === "string" ? args.path : undefined;
	if (typeof args.path !== "string") return undefined;
	if (name === "edit" && !(Array.isArray(args.edits) && args.edits.length > 0
		&& args.edits.every((edit) => record(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string"))
		&& !(typeof args.oldText === "string" && typeof args.newText === "string")) return undefined;
	if (name === "write" && typeof args.content !== "string") return undefined;
	if (name === "read" && ((args.offset !== undefined && !finite(args.offset)) || (args.limit !== undefined && !finite(args.limit)))) return undefined;
	return args.path;
}

// Keep generic summaries bounded without interpreting keys as paths, commands or outcomes.
function argumentPreview(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return clean(value).slice(0, 160) + (value.length > 160 ? "…" : "");
	if (value === null || typeof value !== "object") return value;
	if (depth >= 2) return Array.isArray(value) ? "[…]" : "{…}";
	if (Array.isArray(value)) return [...value.slice(0, 6).map((item) => argumentPreview(item, depth + 1)), ...(value.length > 6 ? ["…"] : [])];
	const entries = Object.entries(value);
	return Object.fromEntries([
		...entries.slice(0, 6).map(([key, item]) => [clean(key), argumentPreview(item, depth + 1)]),
		...(entries.length > 6 ? [["…", "…"]] : []),
	]);
}
function argumentsText(args: unknown, expanded = false): string {
	try { return JSON.stringify(expanded ? args : argumentPreview(args), null, expanded ? 2 : undefined) ?? ""; }
	catch { return "[arguments unavailable]"; }
}

/** Compose actual children, rather than flattening their lines and losing mouse/focus routing. */
class ToolContainer extends Container {
	private readonly components: () => Component[];
	constructor(components: () => Component[]) {
		super();
		this.components = components;
	}
	override render(width: number): string[] {
		this.children = this.components();
		return super.render(width);
	}
}

interface CardState {
	epoch: number;
	result?: Result;
	nativeCall?: Component;
	nativeResult?: Component;
}
interface LiveCall { started: number; invalidate?: () => void; finishNative?: () => void }

/** Session-scoped evidence only. Results and child records remain owned by the host's parent result. */
export class ToolPresentation {
	private readonly live = new Map<string, LiveCall>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private epoch = 0;
	private interactive = false;
	readonly available: boolean;
	readonly resolver: ToolRendererResolver | undefined;

	private readonly getConfig: () => OpenTuiConfig;
	private readonly now: () => number;

	constructor(getConfig: () => OpenTuiConfig, pi: ExtensionAPI, now = () => performance.now()) {
		this.getConfig = getConfig;
		this.now = now;
		this.available = typeof pi.registerToolRenderer === "function";
		if (!this.available) return;
		const native = nativeRenderers();
		this.resolver = (name, next) => {
			const base = next();
			const expected = native.get(name);
			// Shell factories allocate closures: require both the native schema reference and
			// native function source. All other tools use exact renderer function identity.
			const sameFunctions = base && expected && (base.renderCall === expected.renderCall && base.renderResult === expected.renderResult
				|| name === "bash" && base.renderCall?.toString() === expected.renderCall?.toString()
					&& base.renderResult?.toString() === expected.renderResult?.toString()
					&& pi.getAllTools().some((tool) => tool.name === name && tool.parameters === expected.parameters));
			const recognized = !!base && !!expected && base.renderShell === expected.renderShell && !!sameFunctions;
			return this.compose(name, base ?? {}, recognized);
		};
		pi.registerToolRenderer(this.resolver);
	}

	startSession(interactive: boolean): void { this.reset(); this.interactive = interactive; }
	reset(): void {
		this.epoch++;
		for (const call of this.live.values()) call.finishNative?.();
		this.live.clear(); this.stopTimer();
	}
	shutdown(): void { this.reset(); this.interactive = false; }
	start(id: string, parentId?: string): void {
		if (!this.available || !this.interactive || parentId) return;
		this.live.set(id, { started: this.now() });
		if (!this.timer) {
			this.timer = setInterval(() => {
				if (this.enhanced()) for (const call of this.live.values()) call.invalidate?.();
			}, 500);
			this.timer.unref?.();
		}
	}
	end(id: string): void {
		this.live.get(id)?.finishNative?.();
		this.live.delete(id); if (this.live.size === 0) this.stopTimer();
	}
	private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
	private enhanced(): boolean { const config = this.getConfig(); return config.enabled && config.toolPresentation; }

	private card(context: ToolRenderContext): CardState {
		const state = context.state as Record<symbol, CardState>;
		return state[CARD] ??= { epoch: this.epoch };
	}
	private status(context: ToolRenderContext): Status {
		return context.isPartial ? context.executionStarted ? "running" : "pending" : context.isError ? "error" : "ok";
	}
	private statusText(status: Status, theme: Theme): string {
		const glyphs = resolveGlyphs(this.getConfig().icons.mode);
		const icon = status === "ok" ? glyphs.done : status === "error" ? glyphs.failed
			: status === "cancelled" ? glyphs.interrupted : glyphs.working;
		return theme.fg(status === "error" ? "error" : status === "ok" ? "success" : "warning", `${icon} ${status}`);
	}
	private elapsed(context: ToolRenderContext, state: CardState): number | undefined {
		if (finite(context.durationMs)) return context.durationMs;
		const live = state.epoch === this.epoch && context.isPartial ? this.live.get(context.toolCallId) : undefined;
		return live ? Math.max(0, this.now() - live.started) : undefined;
	}

	private nativeContext(name: string, context: ToolRenderContext, state: CardState): ToolRenderContext {
		// A detached shell card may render again after navigation. Do not let native live
		// state resurrect its timer or borrow observations from the replacement session.
		return name === "bash" && state.epoch !== this.epoch
			? { ...context, state: {}, executionStarted: false }
			: context;
	}
	private nativeResult(name: string, base: ToolRenderers, result: Result, options: Parameters<NonNullable<ToolRenderers["renderResult"]>>[1], theme: Theme, context: ToolRenderContext, state: CardState): Component {
		state.nativeResult = base.renderResult!(result, options, theme, { ...this.nativeContext(name, context, state), lastComponent: state.nativeResult });
		const live = state.epoch === this.epoch ? this.live.get(context.toolCallId) : undefined;
		if (name === "bash" && live && options.isPartial) {
			// Native shell rendering owns a refresh timer. Finalize it even when a branch/session
			// drops this component before the host can deliver its final result to the UI.
			live.finishNative = () => {
				base.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, theme,
					{ ...context, isPartial: false, lastComponent: state.nativeResult });
			};
		}
		return state.nativeResult;
	}
	private compose(name: string, base: ToolRenderers, recognized: boolean): ToolRenderers {
		const optimized = (args: unknown, result?: Result) => recognized && target(name, args) !== undefined
			&& !(name === "codemode" && result && !codemodeCalls(result.details));
		const renderCall = (args: unknown, theme: Theme, context: ToolRenderContext, state: CardState): Component => {
			try {
				state.nativeCall = base.renderCall?.(args, theme, {
					...(recognized ? this.nativeContext(name, context, state) : context), lastComponent: state.nativeCall,
				});
			} catch { state.nativeCall = undefined; } // Preserve the host's renderer-callback fallback.
			return state.nativeCall ?? new Text(`${theme.fg("toolTitle", theme.bold(clean(name)))}\n${argumentsText(args, context.expanded || !this.enhanced())}`, 0, 0);
		};
		const defaultResult = (result: Result, options: Parameters<NonNullable<ToolRenderers["renderResult"]>>[1], theme: Theme, context: ToolRenderContext): Component => {
			// Generic details also recover raw parent content omitted by a specialized renderer.
			// Images themselves remain owned by ToolExecutionComponent.
			const output = textOutput(result).split("\n").map(clean);
			const lines = options.expanded || !this.enhanced() ? output : output.slice(0, OUTPUT_LINES);
			if (!options.expanded && this.enhanced() && output.length > OUTPUT_LINES) lines.push("More output — expand for details");
			if (!context.showImages || !getCapabilities().images) {
				for (const part of result.content) if (part.type === "image") lines.push(imageFallback(part.mimeType));
			}
			return new Text(lines.map((line) => theme.fg(context.isError ? "error" : "toolOutput", line)).join("\n"), 0, 0);
		};
		const renderResult = (result: Result, options: Parameters<NonNullable<ToolRenderers["renderResult"]>>[1], theme: Theme, context: ToolRenderContext, state: CardState): Component => {
			if (base.renderResult) {
				try {
					if (recognized) return this.nativeResult(name, base, result, options, theme, context, state);
					state.nativeResult = base.renderResult(result, options, theme, { ...context, lastComponent: state.nativeResult });
					return state.nativeResult;
				} catch { state.nativeResult = undefined; }
			}
			return defaultResult(result, options, theme, context);
		};
		return {
			...base,
			renderCall: (args, theme, context) => {
				const state = this.card(context);
				const live = state.epoch === this.epoch ? this.live.get(context.toolCallId) : undefined;
				if (live) live.invalidate = context.invalidate;
				return new ToolContainer(() => {
					if (!this.enhanced()) return [renderCall(args, theme, context, state)];
					const special = optimized(args, state.result);
					const header: Component = {
						invalidate() {},
						render: (width) => {
							const value = special ? target(name, args)! : argumentsText(args);
							const summary = !(special && name === "codemode") && state.result && !context.isPartial
								? clean(textOutput(state.result).split("\n").find((line) => line.trim()) ?? "") : "";
							const time = duration(this.elapsed(context, state));
							const title = `${this.statusText(this.status(context), theme)} ${theme.fg("toolTitle", clean(name))}${value ? ` ${theme.bold(theme.fg("accent", clean(value)))}` : ""}`;
							const suffix = time && width >= 16 ? ` ${theme.fg("dim", time)}` : "";
							const line = truncateToWidth(`${title}${summary ? ` · ${theme.fg(context.isError ? "error" : "muted", summary)}` : ""}`, Math.max(1, width - visibleWidth(suffix))) + suffix;
							return [line, ...(special && name === "codemode" && !state.result
								? [truncateToWidth(theme.fg("dim", host.keyHint("app.tools.expand", "to expand script")), width)] : [])];
						},
					};
					// Do not flatten custom components: they may own buttons, focus or mouse regions.
					const details = context.expanded && !special && base.renderCall ? [new Text(argumentsText(args, true), 0, 0)] : [];
					return [header, ...details, ...(context.expanded || !special && base.renderCall ? [renderCall(args, theme, context, state)] : [])];
				});
			},
			renderResult: (result, options, theme, context) => {
				const state = this.card(context);
				state.result = result;
				if (recognized && name === "bash" && !options.isPartial && state.nativeResult) renderResult(result, options, theme, context, state);
				return new ToolContainer(() => {
					const special = optimized(context.args, result);
					const calls = special && name === "codemode" ? codemodeCalls(result.details) : undefined;
					if (!this.enhanced() || options.expanded) {
						const note = this.enhanced() && calls ? new Text(theme.fg("muted", "Child records are host summaries (arguments/errors may be truncated); raw child results are not retained."), 0, 0) : undefined;
						const raw = this.enhanced() && options.expanded && !special && base.renderResult
							? [defaultResult(result, options, theme, context)] : [];
						return [...(note ? [note] : []), ...raw, renderResult(result, options, theme, context, state)];
					}
					const body: Component[] = [];
					// Preserve a third-party renderer's own compact presentation and actual controls.
					if (!special && base.renderResult) body.push(renderResult(result, options, theme, context, state));
					const preview: Component = {
						invalidate() {},
						render: (width) => {
							const lines: string[] = [];
							if (calls) {
								lines.push(...wrapTextWithAnsi(theme.fg("muted", `Observed ${calls.length} calls${calls.length ? `: ${counts(calls)}` : ""}`), Math.max(1, width)));
								const { shown, hidden } = selectChildren(calls);
								for (const call of shown) {
									const time = duration(call.durationMs);
									const cost = call.cost === undefined ? "" : ` $${call.cost.toPrecision(3)}`;
									lines.push(`  ${this.statusText(call.status, theme)} ${theme.fg("toolTitle", clean(call.name))} ${clean(call.args)}${time ? ` ${theme.fg("dim", time)}` : ""}${theme.fg("dim", cost)}`);
									if (call.error) lines.push(theme.fg("error", `    ${clean(call.error)}`));
								}
								if (hidden.length) lines.push(...wrapTextWithAnsi(theme.fg("warning", `Hidden ${hidden.length}: ${counts(hidden)} — expand for all records`), Math.max(1, width)));
							}
							if (special && name === "edit") {
								const details = record(result.details) ? result.details : {};
								if (!context.isError && typeof details.diff === "string") {
									const diff = new Text(host.renderDiff(details.diff), 0, 0).render(width);
									lines.push(...diff.slice(0, 6));
									if (diff.length > 6) lines.push(theme.fg("dim", "More diff — expand for details"));
								} else lines.push(...renderResult(result, options, theme, context, state).render(width));
							} else if (!options.isPartial || context.isError) {
								let output = textOutput(result);
								if (calls) output = output.replace(/^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/, "");
								const preview = output.split("\n").filter((line) => line.trim()).slice(0, OUTPUT_LINES);
								for (const line of preview) lines.push(theme.fg(context.isError ? "error" : "toolOutput", clean(line)));
								if (context.isError && !calls) {
									const tail = output.split("\n").reverse().find((line) => line.trim());
									if (tail && !preview.includes(tail)) lines.push(theme.fg("error", clean(tail)));
								}
								if (context.isError && calls) {
									const errorIndex = output.lastIndexOf("Script error:");
									if (errorIndex >= 0) lines.push(theme.fg("error", clean(output.slice(errorIndex))));
								}
							}
							if (!base.renderResult && (!context.showImages || !getCapabilities().images)) {
								for (const part of result.content) if (part.type === "image") lines.push(imageFallback(part.mimeType));
							}
							lines.push(...this.notices(result, theme, width));
							lines.push(theme.fg("dim", `${host.keyHint("app.tools.expand", "to expand")} · ${calls ? "script, output & host child summaries (no raw child results)" : "arguments & result"}`));
							return lines.map((line) => truncateToWidth(line, width));
						},
					};
					return [preview, ...body];
				});
			},
		};
	}

	private notices(result: Result, theme: Theme, width: number): string[] {
		const details = record(result.details) ? result.details : {};
		const lines: string[] = [];
		if (record(details.truncation) && details.truncation.truncated === true) lines.push("Output truncated by host");
		for (const key of ["matchLimitReached", "resultLimitReached", "entryLimitReached", "linesTruncated"]) {
			if (details[key]) lines.push(`Host truncation: ${key} = ${details[key]}`);
		}
		if (typeof details.fullOutputPath === "string") lines.push(`Full output: ${clean(details.fullOutputPath)}`);
		// Known native notices may be in a tail rather than structured details (read/grep/bash).
		for (const line of textOutput(result).split("\n")) {
			if (/^\[(?:Output truncated|Truncated:|First line exceeds|Showing |Full output|.*(?:truncated|full output (?:saved|written)))/i.test(line)) lines.push(clean(line));
		}
		// Paths/notices wrap rather than ellipsize: a hidden tail must not hide file access.
		return [...new Set(lines)].flatMap((line) => wrapTextWithAnsi(theme.fg("warning", line), Math.max(1, width)));
	}
}
