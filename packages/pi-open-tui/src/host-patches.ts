import type { TUI } from "@earendil-works/pi-tui";

export type HostRenderer = TUI & { doRender(): void };

/** Resolve Pi's forwarding reference to the live instance, never its proxy target. */
export function resolveRenderer(tui: TUI): HostRenderer {
	const probe = Symbol("open-tui-renderer");
	let renderer: HostRenderer | undefined;
	try {
		if (!Reflect.set(tui, probe, function (this: HostRenderer) { return this; })) {
			throw new Error("TUI reference is not writable");
		}
		renderer = Reflect.get(tui, probe).call(tui);
		if (!renderer || typeof renderer.doRender !== "function") throw new Error("Unsupported TUI renderer");
		return renderer;
	} finally {
		Reflect.deleteProperty(renderer ?? tui, probe);
	}
}

/** Restore only our own instance patch; a later wrapper retains its ownership. */
export function patch(target: object, key: string, value: unknown): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, {
		configurable: true, enumerable: descriptor?.enumerable ?? false, writable: true, value,
	});
	return () => {
		if (Reflect.get(target, key) !== value) return;
		if (descriptor) Object.defineProperty(target, key, descriptor);
		else Reflect.deleteProperty(target, key);
	};
}
