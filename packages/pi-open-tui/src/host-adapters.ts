import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { OpenTuiConfig } from "./config.ts";
import { installCursorOutput, type CursorOutput } from "./cursor-output.ts";
import { installUserMessageLayout } from "./user-message-layout.ts";

/** Own the cursor-inner/User-outer wrapper order and its reverse-order release. */
export function installHostAdapters(tui: TUI, cursorUnavailable: () => void, userLayout?: {
	getConfig(): OpenTuiConfig;
	getTheme(): Theme;
	unavailable(): void;
}) {
	let cursor: CursorOutput | undefined;
	let users: ReturnType<typeof installUserMessageLayout> | undefined;
	let active = true;
	const cleanup = () => {
		if (!active) return;
		active = false;
		users?.cleanup();
		cursor?.cleanup();
	};
	try {
		// Remove the outer User wrapper before the inner cursor wrapper changes.
		cursor = installCursorOutput(tui, cursorUnavailable, () => users?.releaseRenderer());
		if (!cursor) cursorUnavailable();
		if (userLayout) users = installUserMessageLayout(tui, userLayout.getConfig, userLayout.getTheme,
			userLayout.unavailable, () => cursor?.refresh());
	} catch (error) {
		cleanup();
		throw error;
	}
	return {
		refresh(): void {
			if (!active) return;
			// Rebind before the first frame, including transcript exit without start().
			// Mounted-tree discovery belongs to doRender, not editor/workline refreshes.
			users?.refresh(false);
			cursor?.refresh();
		},
		cleanup,
	};
}
