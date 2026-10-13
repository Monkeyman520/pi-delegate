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
		};
	}
	switch (style) {
		case "bold":
			return { top: "━", topLeft: "┏", left: "┃", bottom: "━", bottomLeft: "┗" };
		case "double":
			return { top: "═", topLeft: "╔", left: "║", bottom: "═", bottomLeft: "╚" };
		case "dashed":
			return { top: "┄", topLeft: "┌", left: "┆", bottom: "┄", bottomLeft: "└" };
		case "single":
		case "custom":
		default:
			return { top: "─", topLeft: "┌", left: "│", bottom: "─", bottomLeft: "└" };
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
	paint: (text: string) => string;
}

export class ToolBoxFrame extends Container {
	private inset = 0;
	private hasTop = false;
	private readonly options: ToolBoxFrameOptions;

	constructor(component: Component, options: ToolBoxFrameOptions) {
		super();
		this.options = options;
		this.addChild(component);
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const { top, bottom, left, topChar, topLeftChar, leftChar, bottomChar, bottomLeftChar, paint } = this.options;
		this.hasTop = top;
		this.inset = left ? Math.min(2, Math.max(0, width - 1)) : 0;
		const innerWidth = Math.max(1, width - this.inset);
		const lines: string[] = [];

		if (top) {
			const corner = left ? topLeftChar : "";
			const cornerWidth = visibleWidth(corner);
			const fillCharWidth = Math.max(1, visibleWidth(topChar));
			const available = Math.max(0, width - cornerWidth);
			const count = Math.floor(available / fillCharWidth);
			const topLine = corner + topChar.repeat(count);
			lines.push(truncateToWidth(paint(topLine), width, ""));
		}

		const prefix = left ? paint(this.inset === 2 ? `${leftChar} ` : this.inset === 1 ? leftChar : "") : "";
		const innerLines = super.render(innerWidth);
		for (const line of innerLines) {
			if (isImageRow(line)) {
				lines.push(line);
			} else {
				lines.push(truncateToWidth(prefix + line, width, ""));
			}
		}

		if (bottom) {
			const corner = left ? bottomLeftChar : "";
			const cornerWidth = visibleWidth(corner);
			const fillCharWidth = Math.max(1, visibleWidth(bottomChar));
			const available = Math.max(0, width - cornerWidth);
			const count = Math.floor(available / fillCharWidth);
			const bottomLine = corner + bottomChar.repeat(count);
			lines.push(truncateToWidth(paint(bottomLine), width, ""));
		}

		return lines;
	}

	override handleMouse(event: TuiMouseEvent) {
		if (this.hasTop && event.y === 0) return undefined;
		if (this.inset > 0 && event.x < this.inset) return undefined;
		const adjustedY = this.hasTop ? event.y - 1 : event.y;
		const adjustedX = event.x - this.inset;
		const adjustedWidth = Math.max(1, event.width - this.inset);
		return super.handleMouse({ ...event, x: adjustedX, y: adjustedY, width: adjustedWidth });
	}
}

