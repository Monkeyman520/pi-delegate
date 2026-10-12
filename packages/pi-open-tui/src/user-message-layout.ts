import type { Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, type Component, type Markdown, type TUI } from "@earendil-works/pi-tui";
import type { OpenTuiConfig } from "./config.ts";
import { isImageRow } from "./message-layout.ts";

const ZONE_START = "\x1b]133;A\x07";
const ZONE_END = "\x1b]133;B\x07\x1b]133;C\x07";
type Renderer = TUI & { doRender(): void; getMountedRoots(): readonly Component[] };
type User = Component & { children: Component[]; outputPad: number; text: string; rebuild(): void };

function patch(target: object, key: string, value: unknown): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value });
	return () => {
		if (Reflect.get(target, key) !== value) return;
		if (descriptor) Object.defineProperty(target, key, descriptor);
		else Reflect.deleteProperty(target, key);
	};
}

// Editor factories receive Pi's forwarding reference; patch the current instance,
// not the reference's proxy target. Re-resolve when the host changes TUI mode.
function resolve(tui: TUI): Renderer {
	const probe = Symbol("open-tui-user-layout");
	let renderer: Renderer | undefined;
	try {
		if (!Reflect.set(tui, probe, function (this: Renderer) { return this; })) throw new Error("Read-only TUI");
		renderer = Reflect.get(tui, probe).call(tui);
		if (!renderer || typeof renderer.doRender !== "function" || typeof renderer.getMountedRoots !== "function") throw new Error("Unsupported TUI");
		return renderer;
	} finally {
		Reflect.deleteProperty(renderer ?? tui, probe);
	}
}

function markdown(user: User): Markdown | undefined {
	const child = user.children?.[0];
	// Host and extension can resolve separate SDK module copies. Check the
	// native shape rather than rejecting a compatible host via instanceof.
	if (user.children?.length !== 1 || child?.constructor.name !== "Markdown"
		|| typeof child.render !== "function" || typeof child.invalidate !== "function") return undefined;
	// Only adapt the inspected native shell. Never trim arbitrary whitespace or
	// guess how a replacement component allocates its own vertical padding.
	const padding = child as unknown as { paddingX: number; paddingY: number };
	return padding.paddingY === 1 && padding.paddingX === user.outputPad
		&& Number.isInteger(user.outputPad) && user.outputPad >= 0 ? child as Markdown : undefined;
}

/** Non-public User-only bridge. No installed-file, prototype, tool or Assistant patches. */
export function installUserMessageLayout(tui: TUI, getConfig: () => OpenTuiConfig, getTheme: () => Theme, unavailable: () => void, beforeBind?: () => void) {
	let active = true;
	let warned = false;
	let renderer: Renderer | undefined;
	let undoRenderer: (() => void) | undefined;
	const users = new Map<User, () => void>();
	const compact = () => active && getConfig().enabled && getConfig().messageLayout === "compact";
	const warn = () => { if (compact() && !warned) { warned = true; unavailable(); } };
	const restoreUsers = () => { for (const restore of users.values()) restore(); users.clear(); };

	function bindUser(user: User): void {
		if (users.has(user)) return;
		if (!markdown(user)) { warn(); return; }
		const native = user.render;
		const restore = patch(user, "render", function (this: User, width: number): string[] {
			if (!compact()) return native.call(this, width);
			const child = markdown(this);
			if (!child) { warn(); return native.call(this, width); }
			try {
				if (width <= 0) return [];
				const inset = Math.min(2, width - 1);
				const inner = Math.max(1, width - inset);
				// Keep the native Markdown and its transformers/styles. Remove exactly
				// its known one-line outer padding and configured horizontal margins.
				const rendered = child.render(inner + this.outputPad * 2);
				if (!rendered.length) return [];
				if (rendered.length < 3) { warn(); return native.call(this, width); }
				const theme = getTheme();
				const glyph = getConfig().icons.mode === "ascii" ? "|" : "▌";
				const lines = rendered.slice(1, -1).map((line) => {
					if (isImageRow(line)) return line;
					const prefix = inset ? theme.fg("accent", theme.bold(inset === 2 ? `${glyph} ` : glyph)) : "";
					const content = sliceByColumn(line, this.outputPad, this.outputPad + inner, true);
					return theme.bg("userMessageBg", truncateToWidth(prefix + content, width, ""));
				});
				// Preserve the native terminal prompt-zone markers after removing padding.
				lines[0] = ZONE_START + lines[0];
				lines[lines.length - 1] = ZONE_END + lines[lines.length - 1];
				return lines;
			} catch { warn(); return native.call(this, width); }
		});
		users.set(user, restore);
	}

	function scan(): void {
		if (!compact()) { restoreUsers(); return; }
		try {
			const pending: unknown[] = [...renderer!.getMountedRoots()];
			const seen = new Set<object>();
			const mounted = new Set<User>();
			while (pending.length) {
				const value = pending.pop();
				if (!value || typeof value !== "object" || seen.has(value)) continue;
				seen.add(value);
				if (seen.size > 20_000) throw new Error("Unsupported component tree");
				const component = value as Partial<User>;
				if (value.constructor.name === "UserMessageComponent") {
					if (typeof component.render !== "function" || typeof component.rebuild !== "function" || typeof component.text !== "string") { warn(); continue; }
					mounted.add(component as User);
					bindUser(component as User);
				}
				if (Array.isArray(component.children)) pending.push(...component.children);
			}
			for (const [user, restore] of users) if (!mounted.has(user)) { restore(); users.delete(user); }
		} catch { restoreUsers(); warn(); }
	}

	function refresh(): void {
		if (!active) return;
		try {
			const next = resolve(tui);
			if (next !== renderer) {
				undoRenderer?.(); restoreUsers();
				// Release this outer wrapper before another compatibility adapter
				// rebinds, then wrap its new method; preserve cleanup ownership/order.
				beforeBind?.();
				renderer = next;
				const native = next.doRender;
				undoRenderer = patch(next, "doRender", function (this: Renderer) {
					if (active) scan();
					return native.call(this);
				});
			}
			scan();
		} catch { restoreUsers(); warn(); }
	}
	function releaseRenderer(): void {
		restoreUsers(); undoRenderer?.();
		undoRenderer = undefined; renderer = undefined;
	}
	function cleanup(): void {
		if (!active) return;
		active = false;
		releaseRenderer();
	}
	refresh();
	return { refresh, releaseRenderer, cleanup };
}
