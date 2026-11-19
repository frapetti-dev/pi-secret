import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "bun:test";

/** Private tmp dir per test; TMP/TEMP/TMPDIR point at it so os.tmpdir() never touches the real one. */
export function useTmp(): { dir: () => string } {
	let dir = "";
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-secret-test-"));
		for (const k of ["TMP", "TEMP", "TMPDIR"]) {
			saved[k] = process.env[k];
			process.env[k] = dir;
		}
	});
	afterEach(() => {
		for (const k of ["TMP", "TEMP", "TMPDIR"]) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	return { dir: () => dir };
}

/** A POSIX bash; on Windows `Bun.which("bash")` is WSL's launcher, so prefer Git for Windows. */
export function findBash(): string | undefined {
	if (process.platform === "win32") {
		const git = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
		return fs.existsSync(git) ? git : undefined;
	}
	return Bun.which("bash") ?? undefined;
}
