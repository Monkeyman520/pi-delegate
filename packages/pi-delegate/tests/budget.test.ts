import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import {
	type BudgetStop,
	budgetParameters,
	resolveBudget,
	TaskBudget,
} from "../src/budget.ts";
import { delegationPrompt } from "../src/result-format.ts";

for (const value of [
	null,
	[],
	1,
	false,
	{ maxSeconds: 0 },
	{ maxSeconds: -1 },
	{ maxSeconds: NaN },
	{ maxSeconds: Infinity },
	{ maxSeconds: "1" },
	{ maxSeconds: null },
	{ maxTurns: 0 },
	{ maxTurns: 1.5 },
	{ maxTurns: Infinity },
	{ maxTurns: "1" },
	{ tokens: 1 },
]) {
	test(`reject erroneous budget ${JSON.stringify(value)}`, () => {
		expect(() => resolveBudget(value)).toThrow(/budget/);
	});
}
test("independent optional limits, no default, fresh capture and public schema", () => {
	expect(resolveBudget(undefined)).toBeUndefined();
	expect(resolveBudget({})).toBeUndefined();
	for (const input of [
		{ maxSeconds: 0.5 },
		{ maxTurns: 1 },
		{ maxSeconds: 2, maxTurns: 3 },
	]) {
		expect(Value.Check(budgetParameters, input)).toBe(true);
		expect(resolveBudget(input)).toEqual(input);
		expect(resolveBudget(input)).not.toBe(input);
	}
});
function harness(input: { maxSeconds?: number; maxTurns?: number }) {
	let now = 0;
	let callback: (() => void) | undefined;
	let delay = 0;
	const stops: BudgetStop[] = [];
	const budget = new TaskBudget(input, (cause) => stops.push(cause), {
		now: () => now,
		schedule: (fn, ms) => {
			callback = fn;
			delay = ms;
			return () => {
				callback = undefined;
			};
		},
	});
	return {
		budget,
		stops,
		set: (value: number) => {
			now = value;
		},
		tick: () => callback?.(),
		callback: () => callback,
		delay: () => delay,
	};
}
test("queue/init excluded, held provider/tool time included, equality and OR stop once", () => {
	const h = harness({ maxSeconds: 2, maxTurns: 1 });
	h.set(100);
	h.budget.observe({ type: "turn_end" });
	h.tick();
	expect(h.stops).toEqual([]);
	h.budget.observe({ type: "agent_start" });
	const late = h.callback();
	h.set(101.999);
	h.tick();
	expect(h.stops).toEqual([]);
	h.set(102);
	h.budget.observe({ type: "turn_end" });
	late?.();
	expect(h.stops).toEqual([
		{ cause: "budget", dimension: "seconds", limit: 2, observed: 2 },
	]);
	expect(h.callback()).toBeUndefined();
});
test("turn-only counts completed turns, not messages, tools or agent_end", () => {
	const h = harness({ maxTurns: 2 });
	h.budget.observe({ type: "agent_start" });
	for (const type of [
		"message_update",
		"message_end",
		"tool_execution_end",
		"tool_execution_end",
		"agent_end",
		"turn_end",
	])
		h.budget.observe({ type });
	h.set(1e9);
	h.tick();
	expect(h.stops).toEqual([]);
	h.budget.observe({ type: "turn_end" });
	expect(h.stops).toEqual([
		{ cause: "budget", dimension: "turns", limit: 2, observed: 2 },
	]);
});
for (const type of ["agent_settled", "rpc_failure", "dispose"])
	test(`${type} closes timer and ignores stale callbacks/start/turns`, () => {
		const h = harness({ maxSeconds: 1, maxTurns: 1 });
		h.budget.observe({ type: "agent_start" });
		const late = h.callback();
		if (type === "dispose") h.budget.dispose();
		else h.budget.observe({ type });
		h.set(100);
		late?.();
		h.budget.observe({ type: "agent_start" });
		h.budget.observe({ type: "turn_end" });
		expect(h.stops).toEqual([]);
		expect(h.callback()).toBeUndefined();
	});
test("very large finite duration caps each timer, not the allowance", () => {
	const h = harness({ maxSeconds: Number.MAX_VALUE });
	h.budget.observe({ type: "agent_start" });
	expect(h.delay()).toBe(2_147_483_647);
	h.set(2_147_484);
	h.tick();
	expect(h.stops).toEqual([]);
	h.budget.dispose();
});
test("prompt disclosure preserves task/context/handoff and format/authority; unbudgeted unchanged", () => {
	const prompt = delegationPrompt("Return only JSON", "context", "handoff", {
		maxTurns: 2,
	});
	for (const text of [
		"Task:\nReturn only JSON",
		"Supplementary context:\ncontext",
		"Result reporting convention",
		"unlimited",
		"2 turns",
		"queueing",
		"initialization",
		"associated tools/results",
		"no additional model reporting allowance",
		"cannot extend",
		"no extra final sections",
		"no additional permissions",
	])
		expect(prompt).toContain(text);
	expect(delegationPrompt("task")).toBe("Task:\ntask");
});
