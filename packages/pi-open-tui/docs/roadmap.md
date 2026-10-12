# Roadmap

[Back to README](../README.md) · [Development](development.md)

Unchecked items are unimplemented capability candidates, listed in suggested priority order. Behavior, defaults, and interfaces should be agreed before implementation. This list is not a release commitment. Compact tool presentation is implemented with live-terminal acceptance pending; user-message improvements remain exploratory.

## Completed

- [x] **Trustworthy run outcomes:** distinguish completed, interrupted, failed, and neutral ended runs in the Workline with different leading icons, labels and colors in every icon mode.
  - Publish at full-run `agent_settled`; preserve elapsed time through retries/compaction/continuations, native status priority, telemetry placement and attached/detached layouts. Reset evidence/results at run and session boundaries.
  - Use structured public host evidence, not tool failures or status text. Unknown evidence and unresolved truncation stay neutral. Pi 1.1.0 adds public settlement abort evidence, including post-loop cancellation; older hosts without it retain the observability limitation. See [Workline semantics](../README.md#configuration).
- [x] **Settings persistence foundation:** validate known configuration fields, retain unknown legacy fields, safely replace saved configuration and warn when a change is applied only to the current session.
- [x] **Project status reliability:** parse porcelain-v2 Git branches/counts/stashes, separate branch and detached commit switches, coalesce latest-only refreshes, and recognize runtime file suffixes.

## Implemented; live verification pending

- **Universal compact tool-call presentation:** every tool name, including native/extension/MCP tools and future tools without dedicated renderers, receives reliable status/argument/output/timing presentation. Verified native contracts add target/diff enhancements; specialized components retain their actual controls and metadata. Expanded details and host truncation/full-output paths remain accessible. Pi 1.1.0 public resolver composition preserves execution; older hosts keep native rendering with a capability notice, and `/open-tui` provides a native escape hatch.
- **Observable codemode parent:** ordered priority-selected child records, explicit hidden-status counts, separate script/child outcomes, actual parent output and model metadata; expanded script/parent content and host child summaries, without an additional raw-child-result archive.
- Automated host integration is covered; [live-terminal density, scrolling, images and input verification](development.md#tool-presentation-verification) remains pending. Unrelated top-level calls are not grouped.

## TODO

- [ ] **Extension status folding and filtering:** bound the space occupied by extension statuses, with configurable visibility, ordering, and pinned entries.
  - Show an overflow indicator and provide an on-demand view of full statuses. Preserve extension-provided colors and support narrow terminals.
  - Operate on generic extension status keys without depending on pi-delegate or interpreting arbitrary status text as structured task state.
- [ ] **Layout presets and focus mode:** offer Minimal, Standard, Diagnostic, and Presentation presets built from existing settings.
  - Provide a temporary focus mode that restores prior settings on exit rather than overwriting saved preferences.
  - Presentation mode can hide this extension's paths, hostname, session name, and thinking preview; it cannot promise to redact Pi's native header or transcript.
- [ ] **Recent-run telemetry:** provide an on-demand view of recent outcomes, duration, TTFT, TPS, and output tokens for the current session.
  - Keep bounded in-memory history, preserve existing measurement definitions, and distinguish missing measurements from zero. Do not retain prompts, tool contents, or reasoning text.
  - Avoid cross-session persistence or a telemetry database in the initial version.
- [ ] **Settings reset and diagnostics:** provide page-local reset and diagnostics for the configuration path, resolved icon mode, and relevant terminal capabilities.
  - Build on the completed validation/persistence foundation. Avoid exposing credentials or unrelated environment variables.
- [ ] **User-message presentation:** improve turn-boundary visibility with restrained colors and spacing, and explore reversible long-message folding and compact attachment summaries.
  - Keep stored and model-facing content unchanged. Hidden content must be explicitly indicated and fully recoverable; attachments must remain discoverable.
  - Proper per-message folding or custom message containers may require a Pi host extension point. Theme changes and display-Markdown transformations are not substitutes for native expansion state; do not rewrite user messages into custom entries or rely on private patches.
  - Show queued, steering, or follow-up states only when the host exposes reliable metadata. Copy/edit/resend controls and per-message shortcuts need separate interaction and API review.
