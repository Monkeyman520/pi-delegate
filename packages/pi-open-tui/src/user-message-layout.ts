import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, sliceByColumn, truncateToWidth, type Component, type Markdown, type TUI } from "@earendil-works/pi-tui";
import type { OpenTuiConfig } from "./config.ts";
import { isImageRow, MessageRail } from "./message-layout.ts";
import { patch, resolveRenderer, type HostRenderer } from "./host-patches.ts";

const ZONE_START = "\x1b]133;A\x07";
const ZONE_END = "\x1b]133;B\x07\x1b]133;C\x07";
type Renderer = HostRenderer & { getMountedRoots(): readonly Component[] };
type User = Component & { children: Component[]; outputPad: number; text: string; rebuild(): void };
type Skill = Component & {
	children: Component[]; paddingX: number; paddingY: number; bgFn: unknown;
	handleMouse: NonNullable<Component["handleMouse"]>; updateDisplay(): void;
};

function skillShell(skill: Skill): boolean {
	const child = skill.children?.[0];
	return skill.children?.length === 1 && child?.constructor.name === "MouseRegion"
		&& typeof child.render === "function" && typeof child.handleMouse === "function"
		&& typeof skill.render === "function" && typeof skill.handleMouse === "function"
		&& typeof skill.updateDisplay === "function" && typeof skill.bgFn === "function"
		&& skill.paddingY === 1 && Number.isInteger(skill.paddingX) && skill.paddingX >= 0;
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

/** Non-public User/skill bridge. No installed-file, prototype, tool or Assistant patches. */
export function installUserMessageLayout(tui: TUI, getConfig: () => OpenTuiConfig, getTheme: () => Theme, unavailable: () => void, beforeBind?: () => void) {
	let active = true;
	let warned = false;
	let renderer: Renderer | undefined;
	let undoRenderer: (() => void) | undefined;
	const users = new Map<Component, () => void>();
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
				const padding = Math.min(1, width - inset - 1);
				const inner = Math.max(1, width - inset - padding);
				// Keep native Markdown, transformers and one-line vertical padding.
				// Replace only its configured horizontal margins with our rail/body inset.
				const rendered = child.render(inner + this.outputPad * 2);
				if (!rendered.length) return [];
				if (rendered.length < 3) { warn(); return native.call(this, width); }
				const theme = getTheme();
				const glyph = getConfig().icons.mode === "ascii" ? "|" : "┃";
				const lines = rendered.map((line) => {
					if (isImageRow(line)) return line;
					const prefix = inset ? theme.fg("userMessageText", inset === 2 ? `${glyph} ` : glyph) : "";
					const content = sliceByColumn(line, this.outputPad, this.outputPad + inner, true);
					// The rail/gap are outside the background; only the body owns its left margin.
					const body = theme.bg("userMessageBg", truncateToWidth(" ".repeat(padding) + content, width - inset, ""));
					return prefix + body;
				});
				// Preserve the native terminal prompt-zone markers on the padded shell.
				lines[0] = ZONE_START + lines[0];
				lines[lines.length - 1] = ZONE_END + lines[lines.length - 1];
				return lines;
			} catch { warn(); return native.call(this, width); }
		});
		users.set(user, restore);
	}

	function bindSkill(skill: Skill): void {
		if (users.has(skill)) return;
		if (!skillShell(skill)) { warn(); return; }
		// Compose the real native MouseRegion/content, not flattened native Box output.
		// This removes only the shell background/padding and retains click-to-expand.
		const body = new Box(1, 0);
		const rail = new MessageRail(body, (text) => getTheme().fg("accent",
			getConfig().icons.mode === "ascii" ? text.replace("┃", "|") : text));
		const nativeRender = skill.render;
		const nativeMouse = skill.handleMouse;
		let renderedCompact = false;
		const restoreRender = patch(skill, "render", function (this: Skill, width: number): string[] {
			renderedCompact = false;
			if (!compact()) return nativeRender.call(this, width);
			if (!skillShell(this)) { warn(); return nativeRender.call(this, width); }
			try {
				body.children = this.children;
				const bodyWidth = Math.max(1, width - Math.min(2, Math.max(0, width - 1)));
				body.setPaddingX(Math.min(1, Math.floor((bodyWidth - 1) / 2)));
				const lines = rail.render(width);
				renderedCompact = true;
				return lines;
			} catch { warn(); return nativeRender.call(this, width); }
		});
		let restoreMouse: () => void;
		try {
			restoreMouse = patch(skill, "handleMouse", function (this: Skill, event: Parameters<Skill["handleMouse"]>[0]) {
				if (!compact() || !renderedCompact || !skillShell(this)) return nativeMouse.call(this, event);
				// Expansion/invalidation can replace the native MouseRegion between frames.
				if (body.children !== this.children) {
					body.children = this.children;
					rail.render(event.width);
				}
				return rail.handleMouse(event);
			});
		} catch { restoreRender(); warn(); return; }
		users.set(skill, () => { restoreMouse(); restoreRender(); });
	}

	function scan(): void {
		if (!compact()) { restoreUsers(); return; }
		try {
			const pending: unknown[] = [...renderer!.getMountedRoots()];
			const seen = new Set<object>();
			const mounted = new Set<Component>();
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
				if (value.constructor.name === "SkillInvocationMessageComponent") {
					mounted.add(component as unknown as Skill);
					bindSkill(component as unknown as Skill);
				}
				if (Array.isArray(component.children)) pending.push(...component.children);
			}
			for (const [user, restore] of users) if (!mounted.has(user)) { restore(); users.delete(user); }
		} catch { restoreUsers(); warn(); }
	}

	// Coordinated editor refreshes only rebind. Discover mounted User/skill cards once at the
	// protected frame seam; standalone callers may still request an immediate scan.
	function refresh(scanMounted = true): void {
		if (!active) return;
		try {
			const next = resolveRenderer(tui) as Renderer;
			if (typeof next.getMountedRoots !== "function") throw new Error("Unsupported TUI roots");
			if (next !== renderer) {
				undoRenderer?.(); restoreUsers();
				beforeBind?.();
				renderer = next;
				const native = next.doRender;
				undoRenderer = patch(next, "doRender", function (this: Renderer) {
					if (active) scan();
					return native.call(this);
				});
			}
			if (scanMounted) scan();
			else if (!compact()) restoreUsers();
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
