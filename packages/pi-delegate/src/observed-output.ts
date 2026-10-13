import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** JSON wire updates omit cumulative content: retain text deltas, not tool logs/thinking. */
export class ObservedOutput {
	private completed: string[] = [];
	private current = new Map<number, string>();
	observe(event: JsonAgentSessionEvent): void {
		if (event.type === "message_start" && event.message.role === "assistant") {
			const unfinished = this.currentText();
			if (unfinished) this.completed.push(unfinished);
			this.current.clear();
			for (const [index, block] of event.message.content.entries())
				if (block.type === "text") this.current.set(index, block.text);
		} else if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update?.type === "text_delta")
				this.current.set(
					update.contentIndex,
					(this.current.get(update.contentIndex) ?? "") + update.delta,
				);
			else if (update?.type === "text_end")
				this.current.set(update.contentIndex, update.content);
		} else if (
			event.type === "message_end" &&
			event.message.role === "assistant"
		) {
			const text =
				event.message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n") || this.currentText();
			if (text) this.completed.push(text);
			this.current.clear();
		}
	}
	private currentText(): string {
		return [...this.current.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, text]) => text)
			.join("\n");
	}
	text(): string {
		return [...this.completed, this.currentText()].filter(Boolean).join("\n\n");
	}
}
