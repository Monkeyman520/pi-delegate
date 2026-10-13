import { expect, test } from "bun:test";
import { processExited } from "./fixtures/process-exit.ts";

test("process exit requires ESRCH, not an arbitrary failed probe", () => {
	expect(processExited(1, () => true)).toBe(false);
	expect(
		processExited(1, () => {
			throw Object.assign(new Error("absent"), { code: "ESRCH" });
		}),
	).toBe(true);
	for (const error of [
		Object.assign(new Error("denied"), { code: "EPERM" }),
		new RangeError("invalid pid"),
		null,
	]) {
		let observed: unknown = "not thrown";
		try {
			processExited(1, () => {
				throw error;
			});
		} catch (caught) {
			observed = caught;
		}
		expect(observed).toBe(error);
	}
});
