# Opt-in task execution budgets

**Spec ID:** 0012
**Status:** Implemented
**Date:** 2026-10-12
**Sources:** The settled refinement conversation: the user accepted the recommended time/turn-only execution-budget semantics and one-spec route, and additionally required telling the subagent its limits before it works; [ADR 0022](../adr/0022-opt-in-task-execution-budgets.md); [roadmap, optional execution budgets](../../packages/pi-delegate/docs/roadmap.md#5-optional-execution-budgets).

## Source and coordination boundary

- **H — Accepted handoff:** Per-task, opt-in maximum running time and completed turns; independently omitted limits and no budget when both are omitted; either observed limit triggers cancellation without extra model wrap-up allowance; same synchronous/background semantics; queue and initialization excluded, provider/tool waits included; assistant-plus-tools turn counting; `cancelled` with a specific budget-stop cause and trigger value; retain observed text/usage with partial-data disclosure; reject erroneous configuration before child startup without silently correcting it or treating zero as disabling. Token/cost limits are deferred. The earlier `budget.maxSeconds` / `budget.maxTurns` example was illustrative, not a mandated API spelling.
- **H-child — Additional user requirement:** Disclose the limits to the subagent so it can plan for completion. The accepted scope requires upfront information, not a guarantee that any task can be completed within its allowance.
- **A — Durable decision:** ADR 0022, Proposed, separates observed execution-stop triggers from advisory pressure and usage visibility, keeps ownership and cleanup intact, and requires initial-prompt disclosure.
- **B — Existing contracts:** [ADR 0003](../adr/0003-per-delegation-soft-pressure.md) and [spec 0003](./0003-subagent-soft-pressure.md) establish advisory pressure and time/turn definitions. [ADR 0006](../adr/0006-runtime-concurrency-and-delegated-usage.md) and [spec 0007](./0007-concurrency-scheduling-and-cost-visibility.md) establish admission, cleanup and delegated accounting. [ADR 0021](../adr/0021-query-only-background-result-retrieval.md) updates historical background delivery requirements to query-only results. [Spec 0009](./0009-task-listing-details-and-floating-panel.md) establishes scope-local retained observations/results; [spec 0010](./0010-lightweight-result-handoff-template.md) keeps optional result reporting advisory.
- **L — Current source evidence:** [delegate.ts](../../packages/pi-delegate/src/delegate.ts) has shared execution, original-task observation, final-entry usage readback and cancellation cleanup; [rpc.ts](../../packages/pi-delegate/src/rpc.ts) owns transport and process shutdown; [pressure.ts](../../packages/pi-delegate/src/pressure.ts) and [progress.ts](../../packages/pi-delegate/src/progress.ts) observe task time and completed turns; [result-format.ts](../../packages/pi-delegate/src/result-format.ts) composes the initial task/context/handoff prompt. [runtime.md](../../packages/pi-delegate/docs/runtime.md) documents ownership and accounting limits. Existing cancellation retains observed usage but does not generally retain intermediate assistant text.

The selected endpoint is one requirements spec and the associated ADR recording, not implementation, a plan, ticket slicing or QA. This spec consumes the settled handoff and verified sources only; it does not authorize inventing requirements, architecture or unconfirmed assumptions. A needed new semantic decision must return to refinement and be recorded when qualifying before work resumes. Historical spec/ADR statuses are not proof of current behavior; L supplies the current integration evidence.

## Requirements

### R1 — Explicit invocation-local limits

- Let the parent supply an optional running-time maximum and an optional completed-turn maximum for one `delegate` invocation. Each limit is independently optional. Omitting one leaves that dimension unlimited; omitting both introduces no execution budget and preserves existing behavior.
- No default hard limits are added. Existing default pressure reminders remain advisory.
- Resolve and retain the task's effective budget at invocation acceptance, including while queued. Another task's settings or observations cannot change it.
- Time values must represent positive finite durations; turns must represent positive integer completed-turn counts. Reject erroneous supplied configuration explicitly before launching a child in either mode. Do not silently repair it, and do not use zero as a disabling value.
- API spelling, internal representation and timer implementation remain implementation details; the interface must document its time unit and omission/validation semantics.

**Trace:** H; A; B invocation capture and prelaunch validation boundaries.

### R2 — Upfront child-visible budget disclosure

- For a task with an enabled budget, include its effective enabled limits in the original task prompt, before original-task model execution. A parent-only tool description or UI notice is insufficient.
- State units, which dimensions have limits, when running time starts, that queueing/initialization are excluded, that task-time provider/tool waits are included, and that turns mean completed assistant responses with associated tools.
- State that either observed limit triggers cancellation with no additional model reporting allowance. Distinguish the budget from advisory pressure, which cannot extend it.
- Tell the child to prioritize the core goal, avoid unnecessary scope expansion, and prepare an honest report of completed/unfinished work and blockers within the allowance. Do not promise successful completion or fabricate a report after cancellation.
- Preserve the task, supplemental context and optional handoff instructions. Budget information does not change output-format requirements, task permissions or workspace authority. It must not require the final answer to include new sections when the task requires a conflicting format.
- Completely unbudgeted invocations do not gain an invented numerical budget. This requirement does not demand a live remaining-budget counter or proof that the model read/complied with the instructions.

**Trace:** H-child; H; A; L prompt composition; B advisory handoff contract.

### R3 — Original-task clock and inclusive OR triggers

- Begin time measurement at the observed original-task start, consistent with the existing pressure/task-progress boundary. Queue residence and child initialization do not consume this running-time allowance.
- Once started, include provider requests, tools and waiting during original-task execution. Do not count only token generation or active tool CPU time.
- Count one turn when an assistant response and its associated tools/results complete, using the existing completed-turn observation. A streaming response or a response with unfinished tools is not a completed turn. Tools, nested tools and parallel calls are not separate turns.
- While execution remains active, trigger budget cancellation when elapsed time is greater than or equal to its enabled maximum **OR** the completed-turn count is greater than or equal to its enabled maximum. Neither both conditions nor a strictly greater observation is required.
- Trigger at most one budget cancellation per task when time/turn observations overlap. A time threshold remains observable while a provider/tool is held; it does not wait for another completed turn.
- Dispose budget activity at settlement, cancellation and ownership teardown. Do not reopen settled work or allow an old timer/observation to stop a different task or replacement runtime.

**Trace:** H; A; B time/turn and ownership definitions; L original-task observations.

### R4 — Stop behavior, reasons and resource ownership

- A budget-triggered stop is cancellation, not successful completion, a new terminal status or generation-length incompleteness. Preserve `completed`, `incomplete`, `failed` and `cancelled` as existing outcome categories.
- Record an explicit budget-stop cause distinguishing it from manual cancellation, the triggering dimension and configured limit, and the observed time/count that triggered stopping. Preserve enough effective-budget information to interpret the stop without guessing from generic cancellation text.
- Trigger cancellation without an extra model wrap-up period, steering-only substitute or follow-up delegation/generation solely to obtain a final report. Earlier advisory pressure remains available independently.
- Complete runner-owned execution cleanup before synchronous return/background terminal completion and before releasing the admission slot. Preserve queued/manual cancellation, background independence from ordinary parent-turn cancellation, and session/branch invalidation.
- Background budget outcomes remain available through existing task discovery/status/result retention, without automatic terminal messages or a parent wake-up. Synchronous calls return their results directly. Existing task records may observe these results but do not acquire a second execution owner.
- Document that observation, cancellation and process cleanup are not instantaneous. This contract does not promise an exact wall-clock process-stop deadline or that no next provider request can begin after the completed-turn threshold. File changes and external effects are not rolled back.

**Trace:** H; A; roadmap stop/cleanup boundary; B ownership, admission and query-only retrieval; L RPC shutdown behavior.

### R5 — Available partial output and usage

- Preserve already observed assistant text when the budget cancels execution, including text from an unfinished response when available. Return it through the existing result/output-artifact mechanisms with clear cancellation and partial-output labeling rather than presenting it as a complete final answer.
- Do not discard previously observed text merely because cancellation prevents final entries from being read. Do not promise unobserved output, tool logs or a full execution transcript, and do not generate an artificial final answer after stopping.
- Preserve all available reported usage, reconcile with authoritative entries when available, and disclose when cancellation leaves partial totals. Unreported provider usage cannot be recovered.
- Maintain existing large-output presentation/artifact behavior and workspace lifetime; owned process/initialization cleanup must not remove the selected workspace or separately retained output artifact.
- Retained output/results and repeated queries do not incur another delegated usage charge. Keep background accounting separate from Pi's parent totals and preserve the runtime cumulative delegated contribution of cancelled work.

**Trace:** H; roadmap output/usage retention and no rollback; A; B output/accounting boundaries; L current text-retention gap.

### R6 — Independent pressure and public explanation

- Keep `pressure` advisory and independent of execution budgets. Its reminders cannot postpone stopping or change a budget-stop cause, and an omitted budget cannot gain a hard limit from pressure alone.
- Do not silently reorder, clamp or derive pressure thresholds from the budget. A pressure stage beyond a stop threshold is not a promised reminder before cancellation.
- Document the opt-in API, validation, clock/count definitions, child disclosure, threshold-driven cancellation, partial output/usage and no-rollback limitations. Explain that neither disclosure nor an execution-completed result establishes task acceptance.
- Keep the feature functional in RPC/non-TUI mode. A new budget-specific TUI layout is not required to enforce or interpret the result.

**Trace:** H; A; B advisory pressure and acceptance boundaries; roadmap explicit opt-in limits.

## Solution

Extend the existing invocation contract with a captured, task-local optional budget. Compose its effective limits and semantics into the original task prompt alongside the existing task/context and optional reporting convention. Observe original-task elapsed time and completed turns within the shared synchronous/background runner, and connect an observed threshold to existing cancellation and owned cleanup rather than advisory steering alone. Retain the stop cause, observed text and available usage through existing result/query mechanisms.

This describes required ownership and exchanges, not a prescribed new module/class or cancellation API. Lifecycle races must retain a truthful stop cause, deduplicate budget cancellation, avoid reopening settled work and preserve cleanup/accounting. No exact provider-request ceiling is inferred from parent-side event observation.

### Seams

| Seam | Connects | Expects | Provides |
| --- | --- | --- | --- |
| Invocation capture | Parent delegate input → accepted task/queued execution | Optional valid time/turn maxima | Isolated effective budget; invalid input rejected before child launch (R1) |
| Prompt composition | Effective budget + task/context/report convention → original child prompt | Accepted budget and existing prompt content | Upfront child-visible values and planning/stop semantics without extra permissions or output-format changes (R2) |
| Task observations | Original-task start, elapsed clock and completed-turn events → budget eligibility | Same task's running lifecycle, no queue/startup contribution | Inclusive OR stop trigger, held-time observation and deduplication (R3) |
| Cancellation ownership | Budget trigger → runner and existing synchronous/background owner | Due threshold and stop metadata | Cancelled outcome, control/timer closure and cleanup before capacity release (R4) |
| Retention/accounting | Observed text/usage + final readback when possible → result, retained records and ledger | Available data, including incomplete responses | Clearly partial output, attributable stop cause and no duplicate usage charge (R4–R5) |

## End-to-End Tests

These are acceptance scenarios for later execution, not performed tests or an implementation plan. Representative small limits are fixture inputs, not new product defaults. Use deterministic local providers and held lifecycle/tool events where needed; do not claim a cancellation-latency SLA or exact supplier billing.

### T1 — No budget and independent optional limits (R1, R3, R6)

- **Given:** Unbudgeted, time-only, turn-only and combined-budget invocations, including synchronous and background calls.
- **When:** Controlled tasks cross time/turn observations and advisory pressure thresholds.
- **Then:** Unbudgeted work is not automatically stopped by pressure; an omitted dimension is unlimited; enabled limits follow inclusive OR semantics and do not leak across tasks.

### T2 — Child receives the actual budget before working (R1–R2)

- **Given:** Accepted budgeted work, including a task held in the queue, a supplemental context and an optional handoff request; another task has strict JSON-only output requirements.
- **When:** The original model request is captured after initialization.
- **Then:** It contains the correct invocation-local enabled limits, units, original-task/count definitions and cancellation/no-extra-reporting semantics, with guidance to prioritize and report within the allowance. Task/context remain present; disclosure does not grant authority or require extra final sections. Verify actual model-input composition, not just a helper return value or parent UI text.

### T3 — Queue/init excluded; held provider/tool time included (R3–R4)

- **Given:** A budgeted task spends controlled time queued and initializing, then starts original work with a held provider request or tool.
- **When:** Original-task elapsed time stays below, then reaches its maximum.
- **Then:** Queue/startup do not consume the allowance; held running/waiting time does. Reaching the maximum triggers cancellation without awaiting turn completion or granting another reporting generation. Cleanup finishes before a queued follower receives the slot.

### T4 — Completed turns and overlapping triggers (R3–R4)

- **Given:** A child below its turn maximum has a response with multiple/parallel tool calls, with at least one tool still pending.
- **When:** The response and tools finish, reaching the maximum; in another run the time and turn conditions overlap.
- **Then:** Pending tools do not count a completed turn; the completed response/tools add one regardless of tool count. Enabled threshold equality triggers stopping, overlapping observations cause one cancellation, and result metadata truthfully identifies a budget cause/value/observation. No assertion that RPC cancellation prevents every possible next-request race is made.

### T5 — Cancellation retains partial text and usage (R4–R5)

- **Given:** A child has emitted assistant text and reported usage, with an unfinished response and enough text to exercise the existing large-output path.
- **When:** A budget triggers and final-entry readback is unavailable.
- **Then:** The cancelled result distinguishes budget stopping, preserves available text with partial labeling and retains observed usage. Large output remains retrievable; the workspace survives. Repeated status queries and ledger observations do not charge usage twice. A readable-final-entries variant verifies reconciliation instead of snapshot-plus-entry addition.

### T6 — Pressure and budget remain independent (R2, R4, R6)

- **Given:** One task receives pressure before its budget; another has a pressure stage later than its budget; another has no budget.
- **When:** Controlled observations reach the relevant thresholds.
- **Then:** Pressure remains a reminder, does not extend the budget and is not silently clamped/reordered. The budgeted tasks cancel without extra model wrap-up calls; the unbudgeted task may continue. Upfront disclosure describes the distinction.

### T7 — Ownership, settlement and invalidation races (R3–R5)

- **Given:** Concurrent synchronous/background tasks, including queued tasks, normal terminal outcomes and an active budget timer.
- **When:** Manual cancellation, settlement or existing scope/runtime invalidation occurs near a budget observation; ordinary parent-turn cancellation occurs after background acceptance.
- **Then:** Execution ownership remains unchanged. Queued cancellation never launches a child, terminal work is not reopened/reclassified by a late timer, cancelled work cleans up with one capacity release, old callbacks cannot affect new tasks/runtime, and background work is not cancelled merely by ordinary parent-turn cancellation. Available consumption remains attributable under existing accounting lifetimes.

### T8 — Validation and query-only retrieval (R1, R4, R6)

- **Given:** Erroneous budgets, including zero, nonfinite/nonpositive durations and noninteger turn counts; valid budget stops in synchronous/background and non-TUI modes.
- **When:** The calls are submitted and retained results are queried.
- **Then:** Invalid supplied values fail explicitly before child launch rather than disabling/repairing the budget. Synchronous results return directly; background results remain discoverable/queryable with stop metadata and partial output/usage, without automatic messages or wake-up. Enforcement does not depend on a widget.

## Decisions and exclusions

- **Time/turn-only opt-in budgets:** H and ADR 0022. No token/cost policies or exact supplier-billing ceiling.
- **Observed thresholds and immediate cancellation initiation:** H and ADR 0022. No extra model reporting grace period, automatic follow-up generation, exact process-stop deadline or strict next-provider-request ceiling.
- **Upfront planning information:** H-child and ADR 0022. Disclosure is required, completion/compliance is not guaranteed; no live budget-query tool or countdown contract is added.
- **Existing lifecycle and results:** B and ADR 0022. No new terminal status, execution owner, automatic background completion messages, workspace rollback or task retry.
- **Scope:** One bounded feature with shared contracts; no ticket decomposition, implementation plan, production/test changes, execution-record export or new TUI layout is authorized at this endpoint.

## Completion and limitations

The accepted requirements are settled; no blocking domain choice remains for this spec. Public field names and internal implementation details are reversible within the contract, not authorization to change its semantics. This is a requirements draft, not evidence that the feature exists or tests pass. The child can still fail to complete an oversized task; observed cancellation can lag thresholds, current work/cleanup may extend activity, and retained text/usage may be partial. Acceptance scenarios require subsequent implementation and verification.
