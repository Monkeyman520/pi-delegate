import { Container, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ToolBoxBorderStyle } from "./config.ts";

// Pi image rows contain protocol payloads, not normal terminal text. Leave them
// opaque rather than adding a rail or passing them through text truncation.
export function isImageRow(line: string): boolean {
	return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}
/** A visual inset around real components, retaining their focus and mouse ownership. */
export class MessageRail extends Container {
	private inset = 0;
	private readonly paint: (text: string) => string;
	private readonly glyph: string;
	constructor(component: Component, paint: (text: string) => string, glyph = "┃") {
		super();
		this.paint = paint;
		this.glyph = glyph;
		this.addChild(component);
	}
	override render(width: number): string[] {
		if (width <= 0) return [];
		this.inset = Math.min(2, Math.max(0, width - 1));
		const prefix = this.paint(this.inset === 2 ? `${this.glyph} ` : this.inset === 1 ? this.glyph : "");
		return super.render(Math.max(1, width - this.inset)).map((line) =>
			isImageRow(line) ? line : truncateToWidth(prefix + line, width, ""));
	}
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.x < this.inset) return undefined;
		return super.handleMouse({ ...event, x: event.x - this.inset, width: Math.max(1, event.width - this.inset) });
	}
}

export interface BorderGlyphs {
	top: string;
	topLeft: string;
	left: string;
	bottom: string;
	bottomLeft: string;
	right: string;
	topRight: string;
	bottomRight: string;
}

export function resolveBorderGlyphs(style: ToolBoxBorderStyle, ascii: boolean): BorderGlyphs {
	if (ascii) {
		const h = style === "bold" || style === "double" ? "=" : "-";
		return {
			top: h,
			topLeft: "+",
			left: "|",
			bottom: h,
			bottomLeft: "+",
			right: "|", topRight: "+", bottomRight: "+",
		};
	}
	switch (style) {
		case "bold":
			return { top: "━", topLeft: "┏", left: "┃", bottom: "━", bottomLeft: "┗", right: "┃", topRight: "┓", bottomRight: "┛" };
		case "double":
			return { top: "═", topLeft: "╔", left: "║", bottom: "═", bottomLeft: "╚", right: "║", topRight: "╗", bottomRight: "╝" };
		case "dashed":
			return { top: "┄", topLeft: "┌", left: "┆", bottom: "┄", bottomLeft: "└", right: "┆", topRight: "┐", bottomRight: "┘" };
		case "single":
		case "custom":
		default:
			return { top: "─", topLeft: "┌", left: "│", bottom: "─", bottomLeft: "└", right: "│", topRight: "┐", bottomRight: "┘" };
	}
}

export interface ToolBoxFrameOptions {
	top: boolean;
	bottom: boolean;
	left: boolean;
	topChar: string;
	topLeftChar: string;
	leftChar: string;
	bottomChar: string;
	bottomLeftChar: string;
	right?: boolean;
	rightChar?: string;
	topRightChar?: string;
	bottomRightChar?: string;
	paint: (text: string) => string;
}

/** Reserve decoration only when at least one content column can remain. */
export function frameInsets(width: number, left: boolean, right: boolean): { left: number; right: number } {
	const l = left ? Math.min(2, Math.max(0, width - 1)) : 0;
	return { left: l, right: right ? Math.min(2, Math.max(0, width - l - 1)) : 0 };
}

export function borderFrameOptions(
	border: Pick<import("./config.ts").ToolBoxBorderConfig, "style" | "top" | "bottom" | "left" | "right">,
	ascii: boolean, paint: (text: string) => string,
): ToolBoxFrameOptions {
	const glyphs = resolveBorderGlyphs(border.style, ascii);
	return {
		top: border.top.enabled, bottom: border.bottom.enabled, left: border.left.enabled, right: border.right?.enabled ?? false,
		topChar: border.top.char ?? glyphs.top, bottomChar: border.bottom.char ?? glyphs.bottom,
		leftChar: border.left.char ?? glyphs.left, rightChar: border.right?.char ?? glyphs.right,
		topLeftChar: border.style === "custom" && border.top.char ? border.top.char : glyphs.topLeft,
		bottomLeftChar: border.style === "custom" && border.bottom.char ? border.bottom.char : glyphs.bottomLeft,
		topRightChar: border.style === "custom" && border.top.char ? border.top.char : glyphs.topRight,
		bottomRightChar: border.style === "custom" && border.bottom.char ? border.bottom.char : glyphs.bottomRight,
		paint,
	};
}
export class ToolBoxFrame extends Container {
	private inset = 0;
	private rightInset = 0;
	private bodyHeight = 0;
	private hasTop = false;
	private readonly options: ToolBoxFrameOptions;

	constructor(component: Component, options: ToolBoxFrameOptions) {
		super();
		this.options = options;
		this.addChild(component);
	}

	override render(width: number): string[] {
		if (width <= 0) { this.inset = this.rightInset = this.bodyHeight = 0; return []; }
		const { top, bottom, left, right, topChar, topLeftChar, leftChar, bottomChar, bottomLeftChar, paint } = this.options;
		this.hasTop = top;
		const insets = frameInsets(width, left, !!right);
		this.inset = insets.left;
		this.rightInset = insets.right;
		const innerWidth = Math.max(1, width - this.inset - this.rightInset);
		const lines: string[] = [];
		const horizontal = (char: string, start: string, end: string) => {
			const l = this.inset ? start : "";
			const r = this.rightInset ? end : "";
			const available = Math.max(0, width - visibleWidth(l) - visibleWidth(r));
			const unit = Math.max(1, visibleWidth(char));
			return paint(truncateToWidth(l + char.repeat(Math.floor(available / unit)) + " ".repeat(available % unit) + r, width, ""));
		};
		if (top) lines.push(horizontal(topChar, topLeftChar, this.options.topRightChar ?? topChar));
		const prefix = this.inset ? paint(this.inset === 2 ? `${leftChar} ` : leftChar) : "";
		const suffix = this.rightInset ? paint((this.rightInset === 2 ? " " : "") + (this.options.rightChar ?? leftChar)) : "";
		const innerLines = super.render(innerWidth);
		this.bodyHeight = innerLines.length;
		for (const line of innerLines) {
			if (isImageRow(line)) { lines.push(line); continue; }
			const body = truncateToWidth(line, innerWidth, "");
			const pad = this.rightInset ? " ".repeat(Math.max(0, innerWidth - visibleWidth(body))) : "";
			lines.push(truncateToWidth(prefix + body + pad + suffix, width, ""));
		}
		if (bottom) lines.push(horizontal(bottomChar, bottomLeftChar, this.options.bottomRightChar ?? bottomChar));
		return lines;
	}

	override handleMouse(event: TuiMouseEvent) {
		const adjustedY = this.hasTop ? event.y - 1 : event.y;
		const adjustedWidth = Math.max(1, event.width - this.inset - this.rightInset);
		if (adjustedY < 0 || adjustedY >= this.bodyHeight || event.x < this.inset || event.x >= this.inset + adjustedWidth) return undefined;
		return super.handleMouse({ ...event, x: event.x - this.inset, y: adjustedY, width: adjustedWidth });
	}
}

