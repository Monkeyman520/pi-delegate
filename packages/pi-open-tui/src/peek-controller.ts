import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OpenTuiConfig } from "./config.ts";
import { resolveGlyphs } from "./icons.ts";
import { buildPeekLabel, collectPeekParts, createPeekState, formatElapsedDuration, reducePeek } from "./peek.ts";
import type { SessionLifecycle } from "./session-lifecycle.ts";

const HIDDEN_THINKING_HORIZONTAL_PADDING = 2;
// Pi's fullscreen transcript can reserve one more column for its scrollbar.
const HIDDEN_THINKING_SCROLLBAR_RESERVE = 1;
const DEFAULT_TICKER_INTERVAL_MS = 80;

export interface PeekLabelEditor {
	getViewportWidth(): number | undefined;
	setLatestHiddenThinkingLabel(label: string): boolean;
	resetHiddenThinkingLabelTarget(): void;
}

interface PeekControllerOptions {
	getConfig(): Pick<OpenTuiConfig, "enabled" | "thinkingPeek" | "icons">;
	getEditor(): PeekLabelEditor | undefined;
	getContext(): ExtensionContext | undefined;
	isActive(): boolean;
	isTuiContext(ctx: ExtensionContext): boolean;
	lifecycle: SessionLifecycle;
	now?: () => number;
	tickerIntervalMs?: number;
}

interface PeekMessage {
	role?: string;
	content?: unknown;
}

/** Owns one message's peek state and the lifetime of its host label target. */
export class PeekController {
	private readonly peek = createPeekState();
	private frame = 0;
	private settleTimer: NodeJS.Timeout | undefined;
	private tickerTimer: NodeJS.Timeout | undefined;
	private thinkingStartMs: number | undefined;
	private taskEpoch = 0;
	private labelActive = false;
	private warningShown = false;
	private activeCtx: ExtensionContext | undefined;
	private readonly options: PeekControllerOptions;
	private readonly now: () => number;
	private readonly tickerIntervalMs: number;

	constructor(options: PeekControllerOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.tickerIntervalMs = options.tickerIntervalMs ?? DEFAULT_TICKER_INTERVAL_MS;
	}

	startSession(): void {
		this.warningShown = false;
		this.startTask();
		this.reset();
	}

	startTask(): void {
		// Custom-message/continuation tasks may not emit a user message_start.
		this.taskEpoch++;
	}

	resetAndClear(ctx?: ExtensionContext): void {
		this.reset();
		this.clearLabel(ctx);
	}

	clearLabel(ctx?: ExtensionContext): void {
		this.stopTicker();
		if (!this.labelActive) return;
		const target = ctx ?? this.activeCtx ?? this.options.getContext();
		if (!target || !this.options.isTuiContext(target)) return;
		// The global reset is safe: completed messages return to Pi's native label.
		target.ui.setHiddenThinkingLabel();
		this.labelActive = false;
	}

	messageStart(message: PeekMessage | undefined, ctx: ExtensionContext): void {
		if (!this.options.lifecycle.isCurrent() || this.isAgentIdle(ctx)) return;
		if (message?.role === "user" || message?.role === "assistant") {
			// Keep Pi's native label until real thinking arrives.
			this.resetAndClear(ctx);
		}
	}

	messageUpdate(message: PeekMessage | undefined, ctx: ExtensionContext): void {
		if (!this.options.lifecycle.isCurrent() || this.isAgentIdle(ctx) || !this.isEnabled()) return;
		if (message?.role !== "assistant" || this.peek.phase === "done") return;
		this.activeCtx = ctx;
		const parts = collectPeekParts(message.content);
		if (parts.thinking && this.thinkingStartMs === undefined) {
			this.thinkingStartMs = this.now();
		}
		const elapsedMs = this.thinkingStartMs !== undefined ? this.now() - this.thinkingStartMs : undefined;
		const next = reducePeek(this.peek, parts, elapsedMs);
		const elapsedChanged = (this.peek.elapsedMs !== undefined && next.elapsedMs !== undefined)
			? formatElapsedDuration(this.peek.elapsedMs) !== formatElapsedDuration(next.elapsedMs)
			: this.peek.elapsedMs !== next.elapsedMs;
		const changed = next.phase !== this.peek.phase
			|| next.tail !== this.peek.tail
			|| next.milestone !== this.peek.milestone
			|| elapsedChanged;
		this.peek.phase = next.phase;
		this.peek.tail = next.tail;
		this.peek.milestone = next.milestone;
		this.peek.elapsedMs = next.elapsedMs;
		if (this.peek.phase === "thinking") {
			this.startTicker(ctx);
			if (changed) this.setLabel(ctx);
		} else if (this.peek.phase === "done") {
			this.stopTicker();
			if (changed) this.setLabel(ctx);
		}
	}

	messageEnd(message: PeekMessage | undefined, ctx: ExtensionContext): void {
		if (!this.options.lifecycle.isCurrent()) return;
		if (ctx) this.activeCtx = ctx;
		if (message?.role === "assistant" && this.peek.phase === "thinking") {
			this.stopTicker();
			// Sub-message finished (answer text or a tool call): freeze the peek line.
			this.peek.phase = "done";
			if (this.thinkingStartMs !== undefined) {
				this.peek.elapsedMs = this.now() - this.thinkingStartMs;
			}
			this.setLabel(ctx);
		}
	}

	settled(ctx: ExtensionContext): void {
		if (!this.options.lifecycle.isCurrent()) return;
		if (ctx) this.activeCtx = ctx;
		clearTimeout(this.settleTimer);
		const epoch = this.taskEpoch;
		const generation = this.options.lifecycle.currentGeneration();
		this.settleTimer = setTimeout(() => {
			this.settleTimer = undefined;
			if (!this.options.lifecycle.isCurrent(generation) || this.taskEpoch !== epoch) return;
			if (this.peek.phase === "thinking") {
				this.stopTicker();
				this.peek.phase = "done";
				if (this.thinkingStartMs !== undefined) {
					this.peek.elapsedMs = this.now() - this.thinkingStartMs;
				}
				this.setLabel(ctx);
			}
		}, 300);
	}

	configChanged(previousLines: number, ctx?: ExtensionContext): void {
		const config = this.options.getConfig();
		if (config.thinkingPeek.lines === 0 || !config.enabled) {
			this.stopTicker();
			this.resetAndClear(ctx);
		} else if (previousLines !== config.thinkingPeek.lines && this.labelActive) {
			this.setLabel(ctx);
		}
	}

	tick(ctx?: ExtensionContext): void {
		if (ctx) this.activeCtx = ctx;
		if (!this.options.lifecycle.isCurrent() || !this.isEnabled() || this.peek.phase !== "thinking") return;
		this.frame++;
		if (this.thinkingStartMs !== undefined) {
			this.peek.elapsedMs = this.now() - this.thinkingStartMs;
		}
		this.setLabel(ctx);
	}

	private startTicker(ctx?: ExtensionContext): void {
		if (ctx) this.activeCtx = ctx;
		if (this.tickerTimer !== undefined || this.tickerIntervalMs <= 0) return;
		this.tickerTimer = setInterval(() => {
			if (!this.options.lifecycle.isCurrent() || !this.isEnabled() || this.peek.phase !== "thinking") {
				this.stopTicker();
				return;
			}
			this.tick();
		}, this.tickerIntervalMs);
		this.tickerTimer.unref?.();
	}

	private stopTicker(): void {
		if (this.tickerTimer !== undefined) {
			clearInterval(this.tickerTimer);
			this.tickerTimer = undefined;
		}
	}

	private reset(): void {
		this.stopTicker();
		this.peek.phase = "idle";
		this.peek.tail = "";
		this.peek.milestone = undefined;
		this.peek.elapsedMs = undefined;
		this.thinkingStartMs = undefined;
		this.activeCtx = undefined;
		clearTimeout(this.settleTimer);
		this.settleTimer = undefined;
		this.options.getEditor()?.resetHiddenThinkingLabelTarget();
	}

	private isEnabled(): boolean {
		const config = this.options.getConfig();
		return this.options.lifecycle.isCurrent() && config.enabled && config.thinkingPeek.lines > 0 && this.options.isActive();
	}

	private setLabel(ctx?: ExtensionContext): void {
		if (!this.isEnabled() || this.peek.phase === "idle") return;
		const target = ctx ?? this.activeCtx ?? this.options.getContext();
		if (!target || !this.options.isTuiContext(target)) return;
		const editor = this.options.getEditor();
		const columns = editor?.getViewportWidth();
		const config = this.options.getConfig();
		const updated = columns !== undefined && editor?.setLatestHiddenThinkingLabel(buildPeekLabel(
			this.peek,
			this.frame,
			resolveGlyphs(config.icons.mode),
			Math.max(1, columns - HIDDEN_THINKING_HORIZONTAL_PADDING - HIDDEN_THINKING_SCROLLBAR_RESERVE),
			config.thinkingPeek.lines,
		));
		if (updated) this.labelActive = true;
		else if (!this.warningShown) {
			this.warningShown = true;
			target.ui.notify("open-tui: thinking peek unavailable on this host; retaining the native label", "warning");
		}
	}

	/** False during session-restore replay; absent/throwing host probes remain usable. */
	private isAgentIdle(ctx: ExtensionContext): boolean {
		try {
			return (ctx as ExtensionContext & { isIdle?: () => boolean }).isIdle?.() === true;
		} catch {
			return false;
		}
	}
}
