# Structured thinking milestones, timing telemetry, dynamic spinner, and sanitized peek presentation

**Spec ID:** 0014
**Status:** H4 implemented — automated package verification passed; live-terminal visual QA not performed
**Date:** 2026-10-14
**Presentation revision:** 2026-10-16
**Sources:** [ADR 0024](../adr/0024-structured-thinking-presentation-and-dynamic-spinner.md); Accepted refinement choices H1–H4 below; [Spec 0011](./0011-open-tui-tool-call-presentation.md).

## Source and coordination boundary

- **H1 — Established peek baseline:** `packages/pi-open-tui/src/peek.ts` implements a three-phase state machine (`idle` -> `thinking` -> `done`). `peekTail` extracts the trailing 1 or 2 logical lines of thinking text with whitespace normalization (`\s+`). `packages/pi-open-tui/src/peek-controller.ts` updates Pi's native `HiddenThinkingComponent` via `ThinkingLabelTarget.setHiddenThinkingLabel`. On message completion (`settled`), a 300ms timer previously cleared the label.
- **H2 — Accepted refinement choices:**
  1. **Phase/Milestone extraction**: Rule-based/regex heuristic detection of headings, steps, and planning guide words. The original layout is refined by H4: a separate status row precedes the configured number of sanitized preview body rows, with an optional milestone before elapsed duration.
  2. **Streaming timing and dynamic spinner**: Decouple spinner animation and timing updates from stream chunks. Run an autonomous ticker (default 80ms) that advances the spinner glyph and updates elapsed duration continuously from first thinking delta, freezing on completion. Exclude unverified token count estimation during streaming.
  3. **Visual boundary & finished state**: Retain the finished thinking summary label on the collapsed block (e.g. `  (分析代码 · 14.2s)`) instead of clearing after 300ms. Keep all presentation changes strictly within the existing `HiddenThinkingComponent` label API; do not modify Assistant message components or transcript rails.
  4. **Markdown sanitization**: Provide a preview sanitizer to strip `#` headers, code fences, inline backticks, blockquotes, and bullet markers.
  5. **Configuration compatibility**: Retain `thinkingPeek.lines: 0 | 1 | 2` as the primary switch without breaking schema changes.
- **H3 — Coordination boundary:** Follow [ADR 0024](../adr/0024-structured-thinking-presentation-and-dynamic-spinner.md). Maintain strict host containment to the label target; do not modify saved configuration schemas or public tool boundaries.
- **H4 — Confirmed presentation refinement:** The user requested lamp-only thinking identification without UI-added `think` / `thinking` words, title-before-duration ordering when a title exists, and preview text starting on the next row even without a title. They clarified scope as “启用 peek 的折叠块” and confirmed both the interpretation “1 行状态＋2 行预览正文，共 3 行” for `lines: 2` and the spec-only route with “是的 都确认”. `lines: 1` likewise denotes one preview body row following the separate status row; this changes layout, not the stored configuration value or default.
  - **Permissions and endpoint (completed refinement stage):** Revise only this existing spec. No ticket decomposition, implementation plan, production/test edits or QA execution. Preserve unrelated and pre-existing workspace changes.
  - **Artifact knowledge boundary:** Consume settled requirements and established solution choices only. Trace material assertions to this handoff or inspected sources; do not invent or revise domain facts, architecture, constraints, acceptance semantics or unconfirmed assumptions. A needed new fact or decision returns to refinement before continuing. Return at the spec-only endpoint.
  - **Knowledge result:** No CONTEXT/ADR update is needed: these are ordinary display requirements, not a new domain concept or architectural decision. H4 refines the historical layout examples in this spec and ADR 0024; that ADR remains unchanged because its integration boundary, timer ownership and persistence decision are preserved.
- **Inspected surfaces for H4:** [peek.ts](../../packages/pi-open-tui/src/peek.ts), [peek-controller.ts](../../packages/pi-open-tui/src/peek-controller.ts), [thinking-label.ts](../../packages/pi-open-tui/src/thinking-label.ts), [icons.ts](../../packages/pi-open-tui/src/icons.ts) and [config.ts](../../packages/pi-open-tui/src/config.ts). At refinement time, the formatter added `think`, placed duration before milestone in completed summaries and placed untitled preview text beside the running marker; these are the behaviors to change, not proof of H4 completion.

The pre-refinement version was marked Completed. Refinement established H4 without claiming implementation; subsequent explicitly invoked loop execution and its evidence are recorded below. No blocking requirement decision or pending qualifying knowledge update remains.

---

## Requirements

### R1 — Heuristic milestone and reasoning phase extraction

1. Parse cumulative thinking text during streaming to detect the current reasoning milestone or phase:
   - Headings (e.g. `#{1,6}\s+(.+)`).
   - Step or phase markers (e.g. `Step`, `Phase`, `步骤`, `阶段`).
   - Reasoning guide words (e.g. `Planning`, `Analyzing`, `Checking`, `Reviewing`, `Evaluating`, `Refining`, `Summary`, `规划`, `分析`, `检查`, `审查`, `评估`, `构思`, `总结`).
2. When a milestone is detected, extract the latest active milestone (up to 40 characters). The existing milestone is the optional display title; this refinement does not introduce a separate title source or change extraction rules. When no milestone matches, omit the title/badge without a placeholder.
3. For enabled peek on collapsed thinking blocks, identify thinking using the existing thinking icon slot alone; do not append UI-added `think`, `thinking` or `思考` text. Nerd mode uses ``, Unicode mode uses `💡`; retain the existing ASCII fallback and icon-mode selection. Remove labels, not matching words in actual titles or preview content.
4. Running presentation, with or without a title:
   - A dedicated status row contains the thinking icon, animated spinner, optional milestone badge and elapsed duration. If a title exists, it precedes the duration. Separate the spinner from the following metadata with one space, including when duration directly follows the spinner (user-confirmed follow-up).
   - Preview text always starts on the next row, never beside the status marker and never padded to the marker's width. Untitled status example: ` ⠧ 4.9s`.
   - **Two-line peek (`lines: 2`)**: One status row followed by up to two preview body rows: up to three rows total, not two rows including status. Use the body rows to wrap the current sanitized tail within the available width; the status prefix does not consume body columns.
   - **One-line peek (`lines: 1`)**: One status row followed by up to one preview body row. Do not change the saved default from `1` to `2`; “默认换行” means the preview starts on a new row without another option.
   - Retain a tail view of the latest reasoning content when it exceeds the body budget; do not let status metadata displace a configured preview row.

**Trace:** H2.1 and H4; `peek.ts`; `peek-controller.ts`; `icons.ts`; ADR 0024's unchanged label-target boundary.

---

### R2 — Streaming elapsed timing and dynamic spinner ticker

1. Track elapsed duration starting from the first thinking chunk in an assistant turn.
2. Format elapsed seconds for display:
   - Under 60s: formatted with one decimal place (e.g. `14.2s`, `0.0s`).
   - 60s and above: formatted as minutes and seconds (e.g. `1m 14s`).
3. Autonomous interval ticker:
   - While in the `thinking` phase, run an internal timer ticker (`DEFAULT_TICKER_INTERVAL_MS = 80ms`).
   - The ticker autonomously advances the spinner animation frame (`SPINNER_FRAMES`) and updates elapsed duration, independent of stream chunk arrivals.
   - When no new thinking chunks arrive, the spinner continues rotating and the timer progresses smoothly without stalling.
   - Unref the timer so it does not block node process exit.
4. Completion:
   - Stop the interval ticker immediately upon transitioning to `done` or `idle`.
   - Freeze the final elapsed duration on completion.
5. Display elapsed duration only; unverified token count estimations are excluded during streaming.

**Trace:** H2.2; `peek-controller.ts`; `peek.ts`; ADR 0024.

---

### R3 — Persistent collapsed summary upon completion

1. When thinking completes:
   - Cease spinner animation and switch to the completed glyph (`glyphs.done`).
   - Display the thinking icon, completed glyph and stable parenthesized summary. When a title exists, place it before the frozen duration, separated by ` · `: `  (分析代码 · 14.2s)`. Without a title, show only duration in parentheses, e.g. `  (14.2s)`, with no empty title or dangling separator. Keep the established icon-mode equivalents.
   - Do not render a `think` / `thinking` label in the completed state. With a supplied display title `Analyzing the four-pirate scenario shows` and frozen duration `1m 8s`, the formatting order is `  (Analyzing the four-pirate scenario shows · 1m 8s)`; this illustrates ordering and does not change the existing parser's title-length limit.
2. Retain the summary label on the `HiddenThinkingComponent` while collapsed, replacing the legacy 300ms auto-clearing behavior.
3. Reset lifecycle:
   - Clear or reset the label target when a new message starts (`messageStart`), when a new session starts (`startSession`), or on session shutdown.
   - Fallback: If thinking was abandoned without `messageEnd`, finalize thinking on `settled` after 300ms to preserve the last known duration and summary.
4. Boundary: Presentation is strictly constrained to the existing `ThinkingLabelTarget.setHiddenThinkingLabel` bridge without introducing adapters for Assistant messages or transcript rails.

**Trace:** H1; H2.3; H4; `peek.ts`; `peek-controller.ts`; ADR 0024 (persistence/boundary, not its historical metadata order).

---

### R4 — Markdown syntax and inline format sanitization

1. Provide `sanitizeThinkingPreview(text: string): string` to strip markdown tokens from preview text:
   - Header markers (`#{1,6}\s+`).
   - Code fences (````[a-z0-9_-]*\n?````) and inline backticks (`````).
   - Blockquote markers (`>\s+`) and list bullets (`[-*+]\s+`, `\d+[\.\)]\s+`).
   - Normalize embedded newlines and multiple spaces into single spaces.
2. Apply sanitization to preview text before clipping to width.

**Trace:** H2.4; `peek.ts`; ADR 0024.

---

### R5 — Configuration compatibility and terminal width safety

1. Preserve existing configuration schema in `OpenTuiConfig.thinkingPeek`:
   - `lines: 0`: Disabled (no peek label dispatched, ticker stopped).
   - `lines: 1`: One preview body row below a separate status row (up to two rows total while thinking).
   - `lines: 2`: Two preview body rows below a separate status row (up to three rows total while thinking).
2. Terminal width budgeting:
   - Budget columns based on viewport width minus padding and scrollbar reservation.
   - Truncate text cleanly according to visible terminal width and Unicode/CJK character widths.

**Trace:** H2.5 and H4; `config.ts`; `peek.ts`; ADR 0024 (configuration schema remains unchanged).

---

## Solution and integration contracts

Keep the existing formatter/controller/host-label path; only its presentation contract is refined by H4.

| Seam | Connects | Expects | Provides |
| --- | --- | --- | --- |
| Peek formatting | `peek-controller.ts` → `peek.ts` | Phase, sanitized tail, optional milestone, measured duration, spinner frame, resolved glyphs, width and configured body-row count | Width-safe lamp/status label, separate preview body rows while running, title-before-duration summary when done |
| Collapsed host label | Controller/editor → `ThinkingLabelTarget` → native collapsed component | Formatted label, including newlines | Updates the existing collapsed label and requests rendering without changing expanded reasoning content; retains existing unavailable-target warning/fallback |
| Configuration | Existing config → controller/formatter | `thinkingPeek.lines: 0 | 1 | 2` and existing icon setting | Disabled behavior for `0`; configured body-row budgets for `1`/`2`; no saved-value/default migration |

**Trace:** H3–H4; inspected `peek.ts`, `peek-controller.ts`, `thinking-label.ts`, `icons.ts` and `config.ts`. No new host API or component ownership is introduced.

## Verification and Acceptance Criteria

1. **Phase/Milestone Parser Tests (`peek.test.ts`)**:
   - Matches markdown headings (`#`), step markers (`Step 1`, `步骤二`), and reasoning guide words in English and Chinese.
   - Preserves the latest active milestone from cumulative thinking text.
   - Falls back gracefully to plain tail when no milestone matches.
2. **Sanitizer Tests (`peek.test.ts`)**:
   - Strips code fences, backticks, header markers, quotes, and bullets.
   - Normalizes whitespace into clean single-line preview strings.
3. **Timer & Label Formatting Tests (`peek.test.ts`)**:
   - Formats elapsed time correctly under 60s and over 60s.
   - Formats one- and two-body-row previews below a separate status row within width budgets, both with and without a title.
   - Formats completed summary with milestone before frozen duration upon done; omits absent title cleanly. No UI-added `think` / `thinking` label remains in any enabled collapsed peek state.
4. **Controller Lifecycle & Dynamic Ticker Tests (`peek-controller.test.ts`)**:
   - Starts timer on first thinking chunk and freezes on completion.
   - Ticker continuously rotates spinner frame and advances elapsed time without new stream deltas.
   - Ticker stops immediately when thinking finishes or is cleared.
   - Preserves completed label across settlement instead of clearing after 300ms.
   - Cleans up label on next message start or session reset.
   - Retains existing warning and fallback when host target is unavailable.

---

## Input-to-outcome acceptance scenarios for H4

- **Completed, titled:** Given an enabled collapsed peek with a detected title and elapsed duration, when reasoning finishes, the spinner becomes the completed glyph and the label reads `  (标题 · 1m 8s)` in Nerd mode. The title precedes frozen time and no extra thinking word is present. Settlement retains the summary.
- **Running, untitled, two body rows:** Given enabled `lines: 2`, no detected title, 4.9 seconds elapsed, enough terminal width and sanitized reasoning long enough for two body rows, when peek renders, row 1 is ` ⠧ 4.9s` for that spinner frame. Reasoning starts at the body left edge on row 2 and continues on row 3; neither body row shares the marker row or inherits its indentation. Later deltas continue showing the latest tail within those two body rows.
- **Running, titled:** Given the same mode with a detected milestone, when peek renders, the title is on the status row before elapsed time and the two preview body rows remain available. The title does not reintroduce an inline body or an added thinking label.
- **One body row and existing default:** Given enabled `lines: 1`, when reasoning streams, preview text starts below status and occupies at most one body row. Existing saved `1` and the default `1` stay unchanged.
- **No title on completion:** Given an untitled running peek, when it completes, show `  (4.9s)` for that frozen duration, without an empty title, dangling ` · ` or added thinking word.
- **Width, icon modes and content preservation:** Given narrow/wide terminals and CJK/emoji content, when these states render or resize, every row fits its visible-column budget. Nerd/Unicode lamp glyphs and the existing ASCII fallback follow the current icon setting. Genuine `think` / `thinking` words in reasoning text or a title are not deleted.
- **Scope boundary:** Given peek disabled (`lines: 0`), the extension disabled, or an expanded thinking block, this refinement does not restyle those surfaces. Existing native behavior and unsupported-host warning/fallback remain unchanged.

**Verification handoff:** Extend formatter and controller/host-label integration coverage for these scenarios and retain existing timer, sanitization and lifecycle checks. Verify the actual collapsed host label displays the separate body rows, not only the formatter string. No tests or runtime QA were executed during the spec-only refinement. The later loop execution evidence below establishes the automated checks actually performed.

## Explicit Exclusions

- No monkey-patching or wrapping of Assistant message components or transcript rails.
- No real-time token count estimation during streaming.
- No Editor border styling modifications for thinking state.
- No changes to saved configuration schema or settings command options.
- Restyling expanded thinking blocks, disabled peek/native labels, or unrelated delegate thinking metadata.
- Changing the default peek mode, icon-mode resolution, title extraction limits, timer ownership, or configuration schema as part of H4.
- Implementation, ticket decomposition, implementation planning or QA execution at this spec-only endpoint.


## H4 execution evidence — 2026-10-16

- **Authorization and route:** The user explicitly invoked `grimoire-loop` after approving H4. Implement → targeted verification → report; no separate planning artifact, tickets, commit or push. The spec-only permissions above describe the earlier completed refinement stage, not this later execution.
- **Changes:** `peek.ts` now uses icon-only identification, title-before-time metadata, a dedicated running status row and one/two full-width body rows. Formatter/controller expectations, actual host-label integration tests and the existing telemetry integration test follow that contract. Both package READMEs document the same layout. Existing configuration, timer/controller lifecycle and host bridge production code were not changed by H4 execution.
- **Red → green:** The 49 existing focused tests passed before H4 test changes. New expectations failed against the old formatter, including the actual Pi 1.1.0 collapsed component in regular/fullscreen modes. After implementation, all 56 focused tests passed.
- **Package verification:** `bun run --filter @wangjq4214/pi-open-tui test` passed all 326 tests without skips, including the real pinned host's rendered multiline labels, expanded/native behavior, narrowed viewport and frozen completion summary. `bun run typecheck` and `bun run --filter @wangjq4214/pi-open-tui build` passed. Tracked-file Biome checks passed (103 files); imported source/tests retain their pre-existing Biome opt-out.
- **Whole-workspace evidence limits:** `bun run check` fails on the pre-existing, unchanged, untracked `packages/pi-open-tui/fix-test.cjs` syntax errors. `bun run test` passed the six root tests, then exceeded the 120-second execution limit while running delegate tests and reported `Missing partial output file` in `length limit and presentation truncation remain independent`. That test failed the same way in isolation; no delegate source or test files were modified. These are not passing whole-workspace gates and were not repaired by changing this feature's scope.
- **Remaining limitation:** Automated host rendering is not live terminal/font/IME or external-provider visual acceptance. No such manual QA was performed. Existing icon-mode fallback and title extraction limits remain unchanged.
