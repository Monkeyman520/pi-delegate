import { type ExecutionBudget, resolveBudget } from "./budget.ts";
import { validateSelection } from "./configuration.ts";
import { validateCwdInput } from "./cwd.ts";
import { validatePressureInput } from "./pressure.ts";
import { validateResultFormat } from "./result-format.ts";

// Pi converts optional nulls/scalars and clones prepared arguments. Capture raw errors
// in clone-safe fields so execution can return the normal failed delegation result.
const checks = [
	{
		diagnostic: "__piDelegateBudgetError",
		fields: ["budget"],
		validate: (args: Record<string, unknown>) => resolveBudget(args.budget),
	},
	{
		diagnostic: "__piDelegateResultFormatError",
		fields: ["resultFormat"],
		validate: (args: Record<string, unknown>) =>
			validateResultFormat(args.resultFormat),
	},
	{
		diagnostic: "__piDelegateCwdError",
		fields: ["cwd"],
		validate: (args: Record<string, unknown>) => validateCwdInput(args.cwd),
	},
	{
		diagnostic: "__piDelegateSelectionError",
		fields: ["model", "thinkingLevel"],
		validate: (args: Record<string, unknown>) =>
			validateSelection(args.model, args.thinkingLevel),
	},
	{
		diagnostic: "__piDelegatePressureError",
		fields: ["pressure"],
		validate: (args: Record<string, unknown>) =>
			validatePressureInput(args.pressure),
	},
] as const;

export function prepareDelegationArguments(args: unknown): unknown {
	if (args === null || typeof args !== "object" || Array.isArray(args))
		return args;
	const prepared = { ...(args as Record<string, unknown>) };
	// A caller must never supply an authoritative internal diagnostic.
	for (const check of checks) delete prepared[check.diagnostic];
	for (const check of checks) {
		try {
			check.validate(prepared);
		} catch (error) {
			for (const field of check.fields) delete prepared[field];
			prepared[check.diagnostic] =
				error instanceof Error ? error.message : String(error);
		}
	}
	return prepared;
}

function rejectDiagnostic(
	args: Record<string, unknown>,
	diagnostic: string,
): void {
	if (args[diagnostic] !== undefined)
		throw new Error(args[diagnostic] as string);
}

/** Keep rejection precedence, including direct execute callers that skipped preparation. */
export function validatePreparedArguments(
	args: Record<string, unknown>,
): ExecutionBudget | undefined {
	rejectDiagnostic(args, checks[0].diagnostic);
	const budget = resolveBudget(args.budget);
	rejectDiagnostic(args, checks[1].diagnostic);
	validateResultFormat(args.resultFormat);
	for (const check of checks.slice(2)) rejectDiagnostic(args, check.diagnostic);
	// Cwd, selection and resolved pressure are validated at invocation capture below.
	return budget;
}
