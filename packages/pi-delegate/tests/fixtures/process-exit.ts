/** Only process absence proves exit; permission/probe errors must fail cleanup checks. */
export function processExited(
	pid: number,
	probe: (pid: number, signal: 0) => unknown = process.kill,
): boolean {
	try {
		probe(pid, 0);
		return false;
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ESRCH"
		)
			return true;
		throw error;
	}
}
