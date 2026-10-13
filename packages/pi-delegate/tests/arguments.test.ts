import { expect, test } from "bun:test";
import {
	prepareDelegationArguments,
	validatePreparedArguments,
} from "../src/arguments.ts";

const diagnostics = [
	"__piDelegateBudgetError",
	"__piDelegateResultFormatError",
	"__piDelegateCwdError",
	"__piDelegateSelectionError",
	"__piDelegatePressureError",
];

test("raw preparation clears spoofed diagnostics, preserves input, and captures clone-safe errors", () => {
	const raw = {
		task: "probe",
		budget: null,
		resultFormat: false,
		cwd: null,
		model: null,
		thinkingLevel: "wrong",
		pressure: null,
		...Object.fromEntries(diagnostics.map((key) => [key, "spoof"])),
	};
	const prepared = prepareDelegationArguments(raw) as Record<string, unknown>;
	for (const field of [
		"budget",
		"resultFormat",
		"cwd",
		"model",
		"thinkingLevel",
		"pressure",
	])
		expect(prepared).not.toHaveProperty(field);
	for (const diagnostic of diagnostics) {
		expect(prepared[diagnostic]).toBeString();
		expect(prepared[diagnostic]).not.toBe("spoof");
	}
	expect(raw.budget).toBeNull();
	expect(() => validatePreparedArguments(structuredClone(prepared))).toThrow(
		"budget",
	);
	const clean = prepareDelegationArguments({
		task: "probe",
		...Object.fromEntries(diagnostics.map((key) => [key, "spoof"])),
	});
	expect(clean).toEqual({ task: "probe" });
});

test("diagnostic precedence is budget, format, cwd, selection, pressure", () => {
	const args = Object.fromEntries(
		diagnostics.map((key, index) => [key, `error-${index}`]),
	);
	for (const [index, diagnostic] of diagnostics.entries()) {
		expect(() => validatePreparedArguments(args)).toThrow(`error-${index}`);
		delete args[diagnostic];
	}
	expect(validatePreparedArguments(args)).toBeUndefined();
});

test("direct raw validation keeps precedence over later preparation errors and captures a fresh budget", () => {
	expect(() =>
		validatePreparedArguments({
			budget: null,
			__piDelegateResultFormatError: "format",
		}),
	).toThrow("budget");
	expect(() =>
		validatePreparedArguments({
			resultFormat: null,
			__piDelegateCwdError: "cwd",
		}),
	).toThrow("resultFormat");
	const args = { budget: { maxTurns: 2 } };
	const budget = validatePreparedArguments(args);
	args.budget.maxTurns = 9;
	expect(budget).toEqual({ maxTurns: 2 });
	for (const raw of [null, false, 1, [], "task", undefined])
		expect(prepareDelegationArguments(raw)).toBe(raw);
});
