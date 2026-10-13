import { expect, test } from "bun:test";
import type {
	JsonAgentSessionEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { ObservedUsage } from "../src/observed-usage.ts";
import { sumUsage } from "../src/usage.ts";

function usage(input: number) {
	return { ...sumUsage([]), input, totalTokens: input };
}
function assistant(input: number) {
	return { role: "assistant", usage: usage(input), content: [] };
}
function tool(id: string, input: number) {
	return {
		role: "toolResult",
		toolCallId: id,
		usage: usage(input),
		content: [],
	};
}
function entries(...messages: unknown[]): SessionEntry[] {
	return messages.map((message) => ({
		type: "message",
		message,
	})) as SessionEntry[];
}
function observe(target: ObservedUsage, value: unknown) {
	target.observe(value as JsonAgentSessionEvent);
}

test("stream updates replace current usage; completed and pending tools contribute exactly once", () => {
	const target = new ObservedUsage(entries(assistant(2)));
	observe(target, { type: "message_start", message: assistant(3) });
	observe(target, { type: "message_update", usage: usage(5) });
	expect(target.snapshot().input).toBe(7);
	observe(target, { type: "message_end", message: assistant(6) });
	observe(target, { type: "message_start", message: tool("a", 4) });
	observe(target, { type: "message_start", message: tool("b", 7) });
	expect(target.snapshot().input).toBe(19);
	observe(target, { type: "message_end", message: tool("a", 5) });
	expect(target.snapshot().input).toBe(20);
	expect(target.retained()).toEqual(target.snapshot());
});

test("readback replaces represented observations and includes auxiliary and unrepresented usage", () => {
	const target = new ObservedUsage(entries(assistant(1)), true);
	observe(target, { type: "message_start", message: assistant(2) });
	observe(target, { type: "message_end", message: assistant(2) });
	observe(target, { type: "message_start", message: assistant(3) });
	observe(target, { type: "message_start", message: tool("pending", 4) });
	const readback = [
		...entries(assistant(10), assistant(20)),
		{ type: "usage", usage: usage(6) },
	] as SessionEntry[];
	expect(target.readback(readback).input).toBe(43);
	expect(target.retained().input).toBe(43);
	expect(readback[1]).toMatchObject({ message: { usage: { input: 20 } } });
});

test("late assistant end and streaming updates supersede readback without mutating entries", () => {
	const target = new ObservedUsage([], true);
	observe(target, { type: "message_end", message: assistant(2) });
	observe(target, { type: "message_start", message: assistant(3) });
	const readback = entries(assistant(4), assistant(6));
	expect(target.readback(readback).input).toBe(10);
	observe(target, { type: "message_update", usage: usage(7) });
	expect(target.retained().input).toBe(11);
	observe(target, { type: "message_end", message: assistant(8) });
	expect(target.retained().input).toBe(12);
	expect(readback[1]).toMatchObject({ message: { usage: { input: 6 } } });
});

test("late tool end replaces represented readback and unread tool usage survives", () => {
	const target = new ObservedUsage([], true);
	observe(target, { type: "message_start", message: tool("a", 2) });
	observe(target, { type: "message_start", message: tool("b", 3) });
	expect(target.readback(entries(tool("a", 4))).input).toBe(7);
	observe(target, { type: "message_end", message: tool("a", 5) });
	observe(target, { type: "message_end", message: tool("b", 6) });
	expect(target.retained().input).toBe(11);
});
