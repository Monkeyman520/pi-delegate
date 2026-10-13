# Opt-in task execution budgets with upfront child disclosure

**Status:** Completed
**Date:** 2026-10-12

## Context

The user requested the execution-budget candidate in [the roadmap](../../packages/pi-delegate/docs/roadmap.md), asked about unresolved questions, and accepted the recommended first increment: optional per-task running-time and completed-turn limits, cancellation on either observed threshold, no additional model wrap-up allowance, and no token/cost policy. The user additionally required telling the subagent its limits before it works, so it can plan and prioritize within them.

Existing [ADR 0003](./0003-per-delegation-soft-pressure.md) establishes advisory pressure rather than automatic cancellation. [ADR 0006](./0006-runtime-concurrency-and-delegated-usage.md) establishes shared admission through owned cleanup and separate usage accounting; visibility itself does not stop tasks. [ADR 0021](./0021-query-only-background-result-retrieval.md) keeps background results query-only. None supplies an opt-in execution-stop policy.

Sources:

- This refinement conversation: the recommended semantics and route, followed by the user's acceptance and requirement to disclose limits to the subagent.
- `packages/pi-delegate/docs/roadmap.md`, optional execution budgets: opt-in time/turn limits, recorded stop reasons, output/usage retention, owned cleanup, no side-effect rollback, token/cost policies deferred.
- `packages/pi-delegate/src/delegate.ts`, `src/pressure.ts`, `src/progress.ts` and `src/rpc.ts`: shared runner, original-task observations, advisory steering, usage retention and bounded process cleanup.
- `packages/pi-delegate/src/result-format.ts`: initial task/context prompt and optional advisory handoff composition.
- `packages/pi-delegate/docs/runtime.md`: queue/startup clock exclusions, cancellation ownership, usage limitations, query-only results and workspace boundaries.

## Decision

- Add an explicitly enabled, parent-configured execution budget belonging to one delegation. Its time and completed-turn limits are independently optional; omitting both adds no limit. Apply the same policy to synchronous and background task execution while retaining their existing owners.
- Measure original-task running time, excluding queueing and initialization but including provider/tool execution and waits. Count completed assistant-plus-associated-tools turns, not individual messages or tools.
- When either enabled threshold is observed reached, trigger cancellation and complete runner-owned cleanup. Do not add a model wrap-up grace period or a follow-up generation merely to produce a report. Preserve available output and reported usage, and identify the budget-triggered cancellation separately from manual cancellation.
- Keep advisory pressure independent. It may encourage earlier completion but neither extends nor replaces the budget; displaying usage is not a token/cost enforcement policy.
- Disclose the effective limits, counting boundary and stop behavior in the original task prompt before child model work, with guidance to prioritize the core goal and prepare an honest report within the budget. Disclosure is information for planning, not a promise of completion, model consumption/compliance, or extra authority.
- Treat limits as observed stop triggers, not exact process-stop deadlines or provider-request ceilings. RPC observation/cancellation races and cleanup can extend activity past a threshold. Cancellation cannot roll back files, external effects or already incurred/unreported usage. Token and monetary ceilings remain outside this increment.

This is additive to ADRs 0003, 0006 and 0021, not a supersession of their pressure, scheduling, ownership, retrieval or accounting decisions. [Spec 0012](../spec/0012-opt-in-task-execution-budgets.md) supplies the requirements contract and representative verification scenarios.

## Consequences

- The child can adapt task scope and reporting to a known allowance instead of discovering the budget only through termination. Upfront disclosure cannot make an oversized task feasible or guarantee a final answer.
- Cancellation-trigger state, observations and timers must share the task's lifecycle; they cannot outlive settlement or invalidate another task/runtime. Capacity remains occupied until owned cleanup completes.
- Result consumers need an explicit budget-stop cause and partial-output semantics without a new terminal status or automatic background messages.
- Mid-run text retention needs additional behavior: the current runner retains observed usage on cancellation but does not generally preserve intermediate assistant text on that path.
- This records a selected direction only. No production changes, tests, implementation or QA are performed at this refinement endpoint.
