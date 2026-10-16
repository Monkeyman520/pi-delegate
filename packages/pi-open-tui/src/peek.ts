import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { IconGlyphs } from "./icons.ts";
import { sanitizeStatus } from "./utils.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_PEEK_LINES = 2;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type PeekPhase = "idle" | "thinking" | "done";

export interface PeekState {
	phase: PeekPhase;
	tail: string;
	milestone?: string;
	elapsedMs?: number;
}

export interface PeekMessageParts {
	thinking: string;
	text: string;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

const normalizePeekLineCount = (lineCount: number): number => Math.max(1, Math.min(MAX_PEEK_LINES, Math.floor(lineCount)));
const HEADING_RE = /^#{1,6}\s+(.+)$/;
const STEP_PHASE_RE = /^(?:Step|Phase|步骤|阶段)\s*[\d一二三四五六七八九十]+[:：\s]*(.+)?$/i;
const GUIDE_WORD_RE = /^(?:Planning|Analyzing|Checking|Reviewing|Evaluating|Refining|Summary|规划|分析|检查|审查|评估|构思|总结)(?:[:：\s].*|[\u4e00-\u9fa5].*)?$/i;

export function sanitizeThinkingPreview(raw: string): string {
	if (!raw) return "";
	return raw
		.replace(/```[a-z0-9_-]*\n?/gi, " ")
		.replace(/`/g, "")
		.split("\n")
		.map((line) => {
			let l = line.trim();
			l = l.replace(/^#{1,6}\s+/, "");
			l = l.replace(/^>\s+/, "");
			l = l.replace(/^[-*+]\s+/, "");
			l = l.replace(/^\d+[\.\)]\s+/, "");
			return l.trim();
		})
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

export function extractMilestone(fullThinking: string): string | undefined {
	if (!fullThinking) return undefined;
	const lines = fullThinking.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const rawLine = lines[i]?.trim();
		if (!rawLine) continue;
		const headingMatch = HEADING_RE.exec(rawLine);
		if (headingMatch?.[1]) {
			const clean = sanitizeThinkingPreview(headingMatch[1]);
			if (clean) return clean.slice(0, 40);
		}
		if (STEP_PHASE_RE.test(rawLine) || GUIDE_WORD_RE.test(rawLine)) {
			const clean = sanitizeThinkingPreview(rawLine);
			if (clean) return clean.slice(0, 40);
		}
	}
	return undefined;
}

export function formatElapsedDuration(ms: number): string {
	const totalSec = Math.max(0, ms) / 1000;
	if (totalSec < 60) {
		return `${totalSec.toFixed(1)}s`;
	}
	const mins = Math.floor(totalSec / 60);
	const secs = Math.floor(totalSec % 60);
	return `${mins}m ${secs}s`;
}

/**
 * Pure phase machine for one assistant-message update.
 *
 * Thinking text is cumulative: once the answer starts, later updates still
 * carry the full thinking block alongside new text. To keep the spinner honest:
 * - idle + thinking        -> thinking (spinner starts)
 * - idle + thinking + text -> done    (already answered, never spin)
 * - thinking + text        -> done    (answer started: stop spinner)
 * - done + thinking        -> done    (never restart the spinner)
 * - any + text only        -> idle stays idle (plain answer, nothing to peek)
 */
export function reducePeek(prev: PeekState, parts: PeekMessageParts, elapsedMs?: number): PeekState {
	const tail = parts.thinking ? peekTail(parts.thinking, MAX_PEEK_LINES) : prev.tail;
	const milestone = parts.thinking ? extractMilestone(parts.thinking) ?? prev.milestone : prev.milestone;
	let phase = prev.phase;
	if (parts.thinking && phase === "idle") phase = "thinking";
	if (parts.text && phase === "thinking") phase = "done";
	const nextElapsed = elapsedMs !== undefined ? elapsedMs : prev.elapsedMs;
	return { phase, tail, milestone, elapsedMs: nextElapsed };
}

/** Fresh peek state (no task running yet). */
export function createPeekState(): PeekState {
	return { phase: "idle", tail: "" };
}

/**
 * Collect the running thinking text and answer text from an assistant
 * message's content parts. Thinking arrives token-by-token, so re-calling
 * this on every `message_update` yields the cumulative text.
 */
export function collectPeekParts(content: unknown): PeekMessageParts {
	let thinking = "";
	let text = "";
	if (!Array.isArray(content)) return { thinking, text };
	for (const rawPart of content) {
		if (!rawPart || typeof rawPart !== "object") continue;
		const part = rawPart as { type?: unknown; thinking?: unknown; text?: unknown };
		if (part.type === "thinking") {
			thinking += stringValue(part.thinking) ?? stringValue(part.text) ?? "";
		} else if (part.type === "text") {
			text += stringValue(part.text) ?? "";
		}
	}
	return { thinking, text };
}

/**
 * Extract the last non-empty logical lines of the thinking text, whitespace-
 * normalized. NOT width-bounded: clipping to the terminal happens at render
 * time in buildPeekLabel/clipTail, so wide terminals get to see more of it.
 */
export function peekTail(fullThinking: string, lineCount = 1): string {
	if (!fullThinking) return "";
	const count = normalizePeekLineCount(lineCount);
	const lines: string[] = [];
	let end = fullThinking.length;
	while (end > 0 && lines.length < count) {
		const start = fullThinking.lastIndexOf("\n", end - 1) + 1;
		const line = sanitizeThinkingPreview(fullThinking.slice(start, end));
		if (line) lines.push(line);
		end = start - 1;
	}
	return lines.reverse().join("\n");
}

/**
 * Clip a tail string to `budget` visible columns, keeping the END (it is a
 * tail view) and prefixing "…" when clipped. Walk backwards over complete
 * graphemes so measurement is limited to the visible suffix.
 */
export function clipTail(text: string, budget: number): string {
	if (!text || budget <= 0) return "";
	const limit = budget - 1; // reserve one column for the ellipsis
	let w = 0;
	let end = text.length;
	let clippedStart = end;
	const segments = graphemeSegmenter.segment(text);
	while (end > 0) {
		const part = segments.containing(end - 1)!;
		w += visibleWidth(part.segment);
		if (w > budget) return "…" + text.slice(clippedStart);
		end = part.index;
		if (w <= limit) clippedStart = end;
	}
	return text;
}

/**
 * Build the label Pi renders in its hidden-thinking block. `width` is a
 * conservative budget that keeps each native Text row within the terminal.
 * The status marker has its own row; lineCount budgets only preview body rows.
 * An overflowing latest logical line uses both body rows in two-line mode
 * instead of retaining the previous logical line.
 */
export function buildPeekLabel(
	state: PeekState,
	frame: number,
	glyphs: IconGlyphs,
	width: number,
	lineCount = 1,
): string {
	const w = Math.max(1, Math.floor(width));
	const prefix = glyphs.thinking;
	const count = normalizePeekLineCount(lineCount);
	const fit = (line: string): string => truncateToWidth(line, w, "…");
	// Titles, like preview text, originate in untrusted model output.
	const milestone = state.milestone ? sanitizeStatus(state.milestone) : "";
	switch (state.phase) {
		case "thinking": {
			const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "";
			const timeStr = state.elapsedMs !== undefined ? formatElapsedDuration(state.elapsedMs) : "";
			const metadata = [milestone ? `[${milestone}]` : "", timeStr].filter(Boolean).join(" ");
			const marker = `${prefix} ${spin}${metadata ? ` ${metadata}` : ""}`;
			const safeLines = state.tail
				.split("\n")
				.map((tail) => sanitizeStatus(tail))
				.filter(Boolean)
				.slice(-count);
			const latest = safeLines.at(-1) ?? "";
			let body = safeLines.map((tail) => clipTail(tail, w));
			if (count >= 2) {
				const window = clipTail(latest, w * count);
				const latestWrapped = wrapTextWithAnsi(window, w);
				if (latestWrapped.length > 1) {
					// Word wrapping may add short rows; always retain the newest content.
					body = latestWrapped.slice(-count).map(fit);
				}
			}
			return [fit(marker), ...body].join("\n");
		}
		case "done": {
			const timeStr = state.elapsedMs !== undefined ? formatElapsedDuration(state.elapsedMs) : "";
			const meta = [milestone, timeStr].filter(Boolean).join(" · ");
			const metaStr = meta ? ` (${meta})` : "";
			return fit(`${prefix} ${glyphs.done}${metaStr}`);
		}
		default:
			return fit(`${prefix} ·`);
	}
}
