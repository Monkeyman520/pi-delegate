import type { Usage } from "@earendil-works/pi-ai";
import type {
	JsonAgentSessionEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { entriesUsage, sumUsage } from "./usage.ts";

/** Task-local consumption observations; readback replaces matching messages, never charges them twice. */
export class ObservedUsage {
	private completed: Usage;
	private assistantCount: number;
	private streaming?: Usage;
	private version = 0;
	private streamingVersion = 0;
	private readbackVersion = 0;
	private entries?: SessionEntry[];
	private messages = new Map<string, { usage: Usage; version: number }>();
	private pendingTools = new Map<string, Usage>();

	constructor(
		entries: SessionEntry[] = [],
		private retainReadback = false,
	) {
		this.completed = entriesUsage(entries);
		this.assistantCount = entries.filter(
			(entry) => entry.type === "message" && entry.message.role === "assistant",
		).length;
	}

	observe(event: JsonAgentSessionEvent): void {
		if (event.type === "message_start") {
			const message = event.message;
			if (message.role === "assistant") {
				this.streaming = message.usage;
				this.streamingVersion = ++this.version;
			}
			// Usage can be available before asynchronous tool-result end hooks finish.
			if (message.role === "toolResult" && message.usage)
				this.pendingTools.set(message.toolCallId, message.usage);
		} else if (event.type === "message_update") {
			this.streaming = event.usage;
			this.streamingVersion = ++this.version;
		} else if (event.type === "message_end") {
			const message = event.message;
			if (message.role !== "assistant" && message.role !== "toolResult") return;
			const key =
				message.role === "assistant"
					? `assistant:${this.assistantCount++}`
					: `tool:${message.toolCallId}`;
			if (this.retainReadback && message.usage)
				this.messages.set(key, {
					usage: message.usage,
					version: ++this.version,
				});
			if (message.usage)
				this.completed = sumUsage([this.completed, message.usage]);
			if (message.role === "assistant") this.streaming = undefined;
			else this.pendingTools.delete(message.toolCallId);
		}
	}

	snapshot(): Usage {
		return sumUsage([
			this.completed,
			...this.pendingTools.values(),
			...(this.streaming ? [this.streaming] : []),
		]);
	}

	/** Preserve the observation version at the response boundary, before shutdown can emit more events. */
	readback(entries: SessionEntry[]): Usage {
		this.entries = entries;
		this.readbackVersion = this.version;
		return this.retained();
	}

	retained(): Usage {
		if (!this.entries) return this.snapshot();
		let index = 0;
		const represented = new Set<string>();
		const entries = this.entries.map((entry) => {
			if (entry.type !== "message") return entry;
			const message = entry.message;
			const key =
				message.role === "assistant"
					? `assistant:${index++}`
					: message.role === "toolResult"
						? `tool:${message.toolCallId}`
						: undefined;
			if (!key) return entry;
			represented.add(key);
			const observed = this.messages.get(key);
			if (
				key === `assistant:${this.assistantCount}` &&
				this.streaming &&
				this.streamingVersion > this.readbackVersion
			)
				return { ...entry, message: { ...message, usage: this.streaming } };
			return observed && observed.version > this.readbackVersion
				? { ...entry, message: { ...message, usage: observed.usage } }
				: entry;
		});
		return sumUsage([
			entriesUsage(entries),
			...[...this.messages]
				.filter(([key]) => !represented.has(key))
				.map(([, value]) => value.usage),
			...(this.streaming && !represented.has(`assistant:${this.assistantCount}`)
				? [this.streaming]
				: []),
			...[...this.pendingTools]
				.filter(([id]) => !represented.has(`tool:${id}`))
				.map(([, value]) => value),
		]);
	}
}
