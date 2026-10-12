import { Container, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

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

