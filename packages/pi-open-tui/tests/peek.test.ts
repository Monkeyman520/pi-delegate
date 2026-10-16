import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildPeekLabel,
	clipTail,
	collectPeekParts,
	createPeekState,
	extractMilestone,
	formatElapsedDuration,
	peekTail,
	reducePeek,
	sanitizeThinkingPreview,
} from "../src/peek.ts";
import { resolveGlyphs } from "../src/icons.ts";
import { sanitizeStatus } from "../src/utils.ts";

const glyphs = resolveGlyphs("ascii");

test("collectPeekParts joins thinking and answer text, ignoring other parts", () => {
	const parts = collectPeekParts([
		{ type: "thinking", thinking: "alpha" },
		{ type: "text", text: "answer" },
		{ type: "toolCall", id: "x", name: "read", arguments: {} },
		{ type: "thinking", thinking: " beta" },
	]);
	assert.deepEqual(parts, { thinking: "alpha beta", text: "answer" });
});

test("collectPeekParts tolerates non-array content", () => {
	assert.deepEqual(collectPeekParts(undefined), { thinking: "", text: "" });
	assert.deepEqual(collectPeekParts("nope"), { thinking: "", text: "" });
});

test("collectPeekParts ignores non-string fields without coercing or throwing", () => {
	assert.deepEqual(
		collectPeekParts([
			{ type: "thinking", thinking: Symbol("invalid"), text: "fallback" },
			{ type: "thinking", thinking: { invalid: true }, text: " next" },
			{ type: "text", text: { invalid: true } },
			{ type: "text", text: Symbol("invalid") },
		]),
		{ thinking: "fallback next", text: "" },
	);
});

test("peekTail shows the last logical line only", () => {
	assert.equal(peekTail("first line\nsecond line here"), "second line here");
});

test("peekTail keeps the last two logical lines when requested", () => {
	assert.equal(peekTail("first\nsecond\n\nthird", 2), "second\nthird");
});

test("peekTail trims and collapses whitespace", () => {
	assert.equal(peekTail("  padded   text  \n"), "padded text");
	assert.equal(peekTail("   "), "");
	assert.equal(peekTail(""), "");
});

test("peekTail keeps the full tail; width bounding is clipTail's job", () => {
	assert.equal(peekTail("x".repeat(500)).length, 500);
});

test("clipTail keeps the end of long text within budget", () => {
	const tail = clipTail("x".repeat(500), 10);
	assert.equal(tail, "…" + "x".repeat(9));
});

test("clipTail truncates wide CJK text by visible width, not code points", () => {
	const tail = clipTail("思".repeat(100), 10);
	// budget 10 → 1 col for "…" + 4 wide chars (8 cols) = 9 visible columns
	assert.equal(tail, "…" + "思".repeat(4));
	assert.ok(visibleWidth(tail) <= 10);
});

test("clipTail returns text that already fits untouched", () => {
	assert.equal(clipTail("short", 10), "short");
	assert.equal(clipTail("思思", 4), "思思");
	assert.equal(clipTail("\u200babc", 3), "\u200babc");
	assert.equal(clipTail("\u200b思", 2), "\u200b思");
});

test("clipTail handles degenerate budgets", () => {
	assert.equal(clipTail("abc", 0), "");
	assert.equal(clipTail("abc", -5), "");
	assert.equal(clipTail("", 5), "");
	assert.equal(clipTail("abcdef", 1), "…");
});

test("clipTail preserves complete graphemes at the tail boundary", () => {
	for (const grapheme of ["😀", "👩‍💻", "e\u0301"]) {
		const tail = clipTail(grapheme.repeat(50), 5);
		assert.equal(tail, "…" + grapheme.repeat(Math.floor(4 / visibleWidth(grapheme))));
		assert.ok(visibleWidth(tail) <= 5);
	}
});

test("buildPeekLabel renders each phase", () => {
	const state = createPeekState();
	assert.equal(buildPeekLabel(state, 0, glyphs, 80), "~ ·");

	state.phase = "thinking";
	state.tail = "deriving";
	assert.equal(buildPeekLabel(state, 1, glyphs, 80), "~ ⠙\nderiving");

	state.phase = "done";
	assert.equal(buildPeekLabel(state, 2, glyphs, 80), "~ +");
});

test("buildPeekLabel puts two unindented body rows below a dedicated status row", () => {
	const label = buildPeekLabel(
		{ phase: "thinking", tail: "previous thought\nlatest thought" },
		0,
		glyphs,
		80,
		2,
	);
	assert.deepEqual(label.split("\n"), ["~ ⠋", "previous thought", "latest thought"]);
});

test("buildPeekLabel wraps an overflowing latest thought instead of keeping the previous one", () => {
	const label = buildPeekLabel(
		{ phase: "thinking", tail: "previous thought\nabcdefghijklmnopqrstuvwxyz" },
		0,
		glyphs,
		20,
		2,
	);
	const [status, first, second] = label.split("\n");
	assert.ok(first !== undefined && second !== undefined);
	assert.ok(!label.includes("previous thought"));
	assert.equal(status, "~ ⠋");
	assert.equal(first, "abcdefghijklmnopqrst");
	assert.match(second, /uvwxyz$/);
	assert.equal(first.indexOf("abcdefghijklmnopqrst"), second.indexOf("uvwxyz"));
});

test("buildPeekLabel follows new deltas after a long thought fills both rows", () => {
	for (const thought of ["word ".repeat(200), "思考".repeat(500), "x".repeat(1000)]) {
		const before = buildPeekLabel({ phase: "thinking", tail: thought }, 0, glyphs, 30, 2);
		for (const delta of ["NEW", "NEW_DELTA"]) {
			const after = buildPeekLabel({ phase: "thinking", tail: thought + delta }, 0, glyphs, 30, 2);
			assert.notEqual(after, before);
			assert.ok(after.endsWith(delta), "the latest delta must be visible with a fixed spinner frame");
			const rows = after.split("\n");
			assert.equal(rows.length, 3);
			assert.ok(rows.every((row) => visibleWidth(row) <= 30));
		}
	}
});

test("buildPeekLabel never exceeds the label width, even on narrow terminals", () => {
	const state = { phase: "thinking" as const, tail: "思".repeat(200) };
	for (const width of [80, 40, 8, 200]) {
		assert.ok(buildPeekLabel(state, 0, glyphs, width).split("\n").every((row) => visibleWidth(row) <= width));
	}
	for (const line of buildPeekLabel({ phase: "thinking", tail: "前一行\n最新一行" }, 0, glyphs, 40, 2).split("\n")) {
		assert.ok(visibleWidth(line) <= 40);
	}
});

test("buildPeekLabel fills wide terminals instead of a fixed cap", () => {
	const state = { phase: "thinking" as const, tail: "x".repeat(500) };
	const line = buildPeekLabel(state, 0, glyphs, 200);
	assert.ok(visibleWidth(line) > 92, "wide terminals must see more than the old 92-col cap");
});

test("reducePeek: spinner starts on thinking, stops when answer text arrives", () => {
	const idle = createPeekState();
	const t = reducePeek(idle, { thinking: "reasoning", text: "" });
	assert.equal(t.phase, "thinking");
	assert.equal(t.tail, "reasoning");

	const done = reducePeek(t, { thinking: "reasoning more", text: "answer" });
	assert.equal(done.phase, "done");

	// Cumulative thinking keeps arriving after the answer starts: stay done.
	const after = reducePeek(done, { thinking: "reasoning more", text: "answer more" });
	assert.equal(after.phase, "done");
	assert.equal(after.tail, "reasoning more");
});

test("reducePeek keeps two thinking lines for the double-line label", () => {
	const next = reducePeek(createPeekState(), { thinking: "previous\nlatest", text: "" });
	assert.equal(next.phase, "thinking");
	assert.equal(next.tail, "previous\nlatest");
});

test("reducePeek: a mixed thinking+text first update never spins", () => {
	const next = reducePeek(createPeekState(), { thinking: "short", text: "hi" });
	assert.equal(next.phase, "done");
});

test("reducePeek: text-only updates stay idle", () => {
	const next = reducePeek(createPeekState(), { thinking: "", text: "plain answer" });
	assert.equal(next.phase, "idle");
});

test("buildPeekLabel neutralizes terminal control sequences in thinking text", () => {
	const dirty = "\x1b]0;pwned\x07\x1b[31mred\x1b[0m\x1b[2J\x1b[?25l tail";
	const line = buildPeekLabel({ phase: "thinking", tail: dirty }, 0, glyphs, 80);
	assert.equal(line, "~ ⠋\nred tail");
	assert.ok(!line.includes("\x1b[31m"), "injected SGR must be removed");
	assert.ok(!line.includes("\x1b]"), "injected OSC must be removed");
	assert.ok(!line.includes("\x1b"), "no raw control sequences may remain");
});

test("sanitizeStatus preserves text around unsupported CSI sequences", () => {
	assert.equal(sanitizeStatus("\x1b[?25lvisible\x1b[31m text"), "visible text");
});

test("sanitizeThinkingPreview strips headers, fences, backticks, quotes, and bullets", () => {
	assert.equal(sanitizeThinkingPreview("## Analyzing constraints"), "Analyzing constraints");
	assert.equal(sanitizeThinkingPreview("```ts\nconst x = 1;\n```"), "const x = 1;");
	assert.equal(sanitizeThinkingPreview("inspect `peek.ts` code"), "inspect peek.ts code");
	assert.equal(sanitizeThinkingPreview("> some quote"), "some quote");
	assert.equal(sanitizeThinkingPreview("- list item\n* another\n1. numbered"), "list item another numbered");
	assert.equal(sanitizeThinkingPreview("   spaced   out   \n\n text  "), "spaced out text");
});

test("extractMilestone detects headings, steps, and reasoning guide words", () => {
	assert.equal(extractMilestone("## Architecture Analysis\nsome rambling thoughts"), "Architecture Analysis");
	assert.equal(extractMilestone("Step 3: verifying seams\nmore details"), "Step 3: verifying seams");
	assert.equal(extractMilestone("阶段 2：边界验证\n详细分析"), "阶段 2：边界验证");
	assert.equal(extractMilestone("Planning: layout structure\nnext line"), "Planning: layout structure");
	assert.equal(extractMilestone("分析代码约束条件\n正在核对"), "分析代码约束条件");
	assert.equal(extractMilestone("just rambling thoughts without any markers"), undefined);
});

test("extractMilestone keeps the latest active milestone from cumulative thinking", () => {
	const cumulative = "Step 1: start\nworking...\n## Step 2: refine\nmore thoughts\n### Final Verification\nclosing";
	assert.equal(extractMilestone(cumulative), "Final Verification");
});

test("formatElapsedDuration formats seconds under 60s and minutes/seconds over 60s", () => {
	assert.equal(formatElapsedDuration(0), "0.0s");
	assert.equal(formatElapsedDuration(3400), "3.4s");
	assert.equal(formatElapsedDuration(14250), "14.3s");
	assert.equal(formatElapsedDuration(60000), "1m 0s");
	assert.equal(formatElapsedDuration(74200), "1m 14s");
});

test("buildPeekLabel puts milestones before elapsed time without consuming preview body rows", () => {
	const stateWithMeta = {
		phase: "thinking" as const,
		tail: "previous thought\nexamining controller logic",
		milestone: "分析约束",
		elapsedMs: 14200,
	};
	const singleLine = buildPeekLabel(stateWithMeta, 0, glyphs, 80, 1);
	assert.equal(singleLine, "~ ⠋ [分析约束] 14.2s\nexamining controller logic");

	const twoLine = buildPeekLabel(stateWithMeta, 0, glyphs, 80, 2);
	const lines = twoLine.split("\n");
	assert.deepEqual(lines, ["~ ⠋ [分析约束] 14.2s", "previous thought", "examining controller logic"]);
});

test("buildPeekLabel formats completed summary with duration and milestone upon done", () => {
	const doneState = {
		phase: "done" as const,
		tail: "done thoughts",
		milestone: "构思边界",
		elapsedMs: 18400,
	};
	const label = buildPeekLabel(doneState, 0, glyphs, 80, 1);
	assert.equal(label, "~ + (构思边界 · 18.4s)");
});

test("buildPeekLabel matches lamp-only running and completed examples", () => {
	const nerd = resolveGlyphs("nerd");
	assert.equal(buildPeekLabel({ phase: "thinking", tail: "previous thought\nlatest thought", elapsedMs: 4900 }, 7, nerd, 80, 2),
		" ⠧ 4.9s\nprevious thought\nlatest thought");
	assert.equal(buildPeekLabel({ phase: "done", tail: "", milestone: "Analyzing the four-pirate scenario shows", elapsedMs: 68000 }, 0, nerd, 100),
		"  (Analyzing the four-pirate scenario shows · 1m 8s)");
	assert.equal(buildPeekLabel({ phase: "done", tail: "", elapsedMs: 4900 }, 0, nerd, 80), "  (4.9s)");
});

test("buildPeekLabel preserves genuine thinking words in titles and preview text across icon modes", () => {
	for (const mode of ["nerd", "unicode", "ascii"] as const) {
		const icons = resolveGlyphs(mode);
		const state = { phase: "thinking" as const, tail: "I think about thinking", milestone: "think / thinking", elapsedMs: 4900 };
		assert.equal(buildPeekLabel(state, 7, icons, 80), `${icons.thinking} ⠧ [think / thinking] 4.9s\nI think about thinking`);
		assert.equal(buildPeekLabel({ ...state, phase: "done" }, 7, icons, 80), `${icons.thinking} ${icons.done} (think / thinking · 4.9s)`);
	}
});

test("buildPeekLabel keeps preview columns independent of metadata on narrow and wide terminals", () => {
	for (const mode of ["nerd", "unicode", "ascii"] as const) {
		for (const width of [1, 2, 8, 30, 80, 200]) {
			for (const milestone of [undefined, "分析边界".repeat(8)]) {
				const icons = resolveGlyphs(mode);
				const tail = "思考👩‍💻e\u0301".repeat(100);
				const label = buildPeekLabel({ phase: "thinking", tail, milestone, elapsedMs: 68000 }, 0, icons, width, 2);
				const plain = buildPeekLabel({ phase: "thinking", tail, elapsedMs: 68000 }, 0, icons, width, 2);
				const rows = label.split("\n");
				assert.equal(rows.length, 3);
				assert.ok(rows.every((row) => visibleWidth(row) <= width));
				assert.deepEqual(rows.slice(1), plain.split("\n").slice(1));
			}
		}
	}
});

test("buildPeekLabel does not add empty preview rows without body content", () => {
	assert.equal(buildPeekLabel({ phase: "thinking", tail: "", elapsedMs: 0 }, 0, glyphs, 80, 2), "~ ⠋ 0.0s");
});

test("buildPeekLabel strips terminal sequences from optional titles as well as body text", () => {
	const state = { phase: "thinking" as const, tail: "body", milestone: "\x1b]0;pwned\x07\x1b[31mtitle\x1b[0m", elapsedMs: 0 };
	assert.equal(buildPeekLabel(state, 0, glyphs, 80), "~ ⠋ [title] 0.0s\nbody");
	assert.equal(buildPeekLabel({ ...state, phase: "done" }, 0, glyphs, 80), "~ + (title · 0.0s)");
});
