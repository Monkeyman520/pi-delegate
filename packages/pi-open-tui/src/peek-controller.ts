import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OpenTuiConfig } from "./config.ts";
import { resolveGlyphs } from "./icons.ts";
import { buildPeekLabel, collectPeekParts, createPeekState, reducePeek } from "./peek.ts";
import type { SessionLifecycle } from "./session-lifecycle.ts";

const HIDDEN_THINKING_HORIZONTAL_PADDING = 2;
// Pi's fullscreen transcript can reserve one more column for its scrollbar.
const HIDDEN_THINKING_SCROLLBAR_RESERVE = 1;

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
}

interface PeekMessage {
	role?: string;
	content?: unknown;
}

/** Owns one message's peek state and the lifetime of its host label target. */
export class PeekController {
	private readonly peek = createPeekState();
	private frame = 0;
	private settleTimer: ReturnType<typeof setTimeout> | undefined;
	private taskEpoch = 0;
	private labelActive = false;
	private warningShown = false;
	private readonly options: PeekControllerOptions;

	constructor(options: PeekControllerOptions) {
		this.options = options;
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
		if (!this.labelActive) return;
		const target = ctx ?? this.options.getContext();
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
		const next = reducePeek(this.peek, collectPeekParts(message.content));
		const changed = next.phase !== this.peek.phase || next.tail !== this.peek.tail;
		this.peek.phase = next.phase;
		this.peek.tail = next.tail;
		if (!changed) return;
		if (this.peek.phase === "thinking") {
			this.frame++;
			this.setLabel(ctx);
		} else if (this.peek.phase === "done") {
			this.setLabel(ctx);
		}
	}

	messageEnd(message: PeekMessage | undefined, ctx: ExtensionContext): void {
		if (!this.options.lifecycle.isCurrent()) return;
		if (message?.role === "assistant" && this.peek.phase === "thinking") {
			// Sub-message finished (answer text or a tool call): freeze the peek line.
			this.peek.phase = "done";
			this.setLabel(ctx);
		}
	}

	settled(ctx: ExtensionContext): void {
		const epoch = this.taskEpoch;
		if (this.settleTimer) clearTimeout(this.settleTimer);
		const generation = this.options.lifecycle.currentGeneration();
		this.settleTimer = setTimeout(() => {
			this.settleTimer = undefined;
			if (!this.options.lifecycle.isCurrent(generation) || this.taskEpoch !== epoch) return;
			this.resetAndClear(ctx);
		}, 300);
	}

	configChanged(previousLines: number, ctx?: ExtensionContext): void {
		const config = this.options.getConfig();
		if (config.thinkingPeek.lines === 0 || !config.enabled) {
			this.resetAndClear(ctx);
		} else if (previousLines !== config.thinkingPeek.lines && this.labelActive) {
			this.setLabel(ctx);
		}
	}

	private reset(): void {
		this.peek.phase = "idle";
		this.peek.tail = "";
		this.options.getEditor()?.resetHiddenThinkingLabelTarget();
		if (this.settleTimer) {
			clearTimeout(this.settleTimer);
			this.settleTimer = undefined;
		}
	}

	/** Pi decides visibility; the extension toggle only controls updates. */
	private isEnabled(): boolean {
		const config = this.options.getConfig();
		return this.options.lifecycle.isCurrent() && config.enabled && config.thinkingPeek.lines > 0 && this.options.isActive();
	}

	private setLabel(ctx?: ExtensionContext): void {
		if (!this.isEnabled() || this.peek.phase === "idle") return;
		const target = ctx ?? this.options.getContext();
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
