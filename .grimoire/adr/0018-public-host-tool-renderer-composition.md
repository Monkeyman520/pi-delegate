# Compose Open TUI tool presentation through the public host renderer API

**Status:** Proposed
**Date:** 2026-10-12
**Partially supersedes:** [ADR 0011](./0011-import-upstream-open-tui-extension.md), only its Pi SDK development pin to 1.0.0.
**Partially superseded by:** [ADR 0019](./0019-universal-tool-presentation-with-specialized-composition.md), only the unknown-schema/specialized-renderer exclusion from enhanced presentation; conservative semantic handling and all other boundaries remain in force.

## Context

The user requested improved tool-call presentation in `packages/pi-open-tui/`. On 2026-10-12 they accepted the recommendation to use the public host renderer API, preserve existing tool behavior and detailed renderers, and allow upgrading the workspace Pi version. They subsequently accepted deliberate codemode presentation as one parent card containing observed child-call progress/metadata and the script's own output, without additionally retaining every child call's raw result.

Read-only inspection found no `registerToolRenderer` declaration or loader implementation in the workspace's Pi coding-agent 1.0.0. The installed Pi coding-agent 1.1.0 exposes `registerToolRenderer` and `ToolRendererResolver`: `next()` resolves the remaining extension renderers and then the tool's base renderers. This enables presentation composition without re-registering execution implementations.

Sources: `packages/pi-open-tui/package.json`, `packages/pi-delegate/package.json`, `packages/pi-open-tui/docs/roadmap.md`, and the inspected hosts' `dist/core/extensions/types.d.ts`; installed Pi 1.1.0 `dist/core/extensions/runner.js` and `docs/extensions.md`. The workspace host is under `packages/pi-open-tui/node_modules/@earendil-works/pi-coding-agent/`; the installed host is under `C:/Users/Derek Wang/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/`.

## Decision

- Use Pi 1.1.0's public tool-renderer composition API for the enhanced Open TUI tool presentation. Upgrade workspace Pi development dependencies from the current 1.0.0 baseline for this work; do not retain that pin by introducing a private tool-component patch.
- Keep this a presentation layer: do not re-register tools merely to change their appearance, replace their execution implementations, mutate model-facing arguments/results, or change execution, permissions, concurrency, or transcript semantics.
- Compose with existing renderers and preserve access to their detailed presentation. Unknown schemas and specialized third-party renderers require conservative handling rather than assumed tool-specific summaries.
- On hosts without the public renderer capability, retain native tool presentation and explicitly report that the enhancement is unavailable. This boundary applies to the new tool presentation and does not revoke existing separately recorded compatibility adaptations.
- Preserve the independent-package boundary from ADR 0011. The dependency upgrade does not authorize a dependency between Open TUI and pi-delegate.
- Treat codemode child calls as metadata within their owning parent presentation, not additional top-level transcript messages. Preserve script-result semantics: a completed script can contain failed or cancelled child calls, and those facts must not be conflated with script failure or the overall Agent run outcome.
- Use the host-provided codemode call records and output. Do not additionally retain every nested raw result to provide a purported complete child-result viewer. Expanded presentation exposes the script, parent output and available child records; host-truncated child arguments/errors and absent child results remain explicit limits.

## Consequences

- The workspace's earlier development pin to Pi SDK 1.0.0 is superseded for this upgrade; other ADR 0011 decisions remain in force.
- Both packages' development manifests currently pin Pi SDKs to 1.0.0. A workspace upgrade affects their host baseline and requires compatibility verification, not just a cosmetic Open TUI change. Exact dependency edits and test outcomes are not established by this record.
- Installed Pi 1.1.0 codemode `CodemodeToolDetails.calls` publishes name, compact/truncated argument text, status, completion duration and optional error/cost. Its renderer shows child records and parent output; it does not provide full child results. `dist/extensions/codemode/tool.d.ts`, `renderer.js`, `execute.js` and `docs/codemode.md` supplied the evidence for this boundary.
- Runtime capability fallback and the existing peer-version declaration must remain consistent; this record does not promise that every future host is compatible.
- The agreed ordinary-call and codemode display defaults, settings, and acceptance scenarios belong in [Spec 0011](../spec/0011-open-tui-tool-call-presentation.md), not in an expanded architectural UI contract. Exact preview budgets and internal component organization remain implementation details.
- Implementation and verification have not started. Proposed records an agreed direction not yet realized in code.
