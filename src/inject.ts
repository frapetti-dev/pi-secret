import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function shQuote(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Wrap `command` in a subshell that exports the bindings (and removes the temp dir on exit),
 * so nothing leaks into omp's persistent bash session. `env`/`files` map VAR → value.
 */
export function buildBoundCommand(
	command: string,
	env: Record<string, string>,
	files: Record<string, string>,
): { command: string; tempDir?: string } {
	const lines = ["("];
	let tempDir: string | undefined;
	const fileVars = Object.entries(files);
	if (fileVars.length > 0) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-secret-"));
		if (process.platform !== "win32") fs.chmodSync(tempDir, 0o700);
		lines.push(`trap ${shQuote(`rm -rf -- ${shQuote(tempDir.replaceAll("\\", "/"))}`)} EXIT`);
	}
	for (const [name, value] of Object.entries(env)) lines.push(`export ${name}=${shQuote(value)}`);
	for (const [name, value] of fileVars) {
		const file = path.join(tempDir!, name);
		fs.writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
		lines.push(`export ${name}=${shQuote(file.replaceAll("\\", "/"))}`);
	}
	lines.push(command, ")");
	return { command: lines.join("\n"), tempDir };
}
