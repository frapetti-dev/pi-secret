import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateName } from "./store";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** Binding maps: environment variable → secret name. */
export interface Bindings {
	env: Record<string, string>;
	files: Record<string, string>;
}

export interface Bound {
	/** `command` wrapped in a subshell that exports the bindings. */
	command: string;
	/** Remove this binding's temp dir now. Idempotent; a no-op without file bindings. */
	release(): void;
}

export interface Binder {
	bind(command: string, bindings: Bindings, resolve: (name: string) => Promise<string>): Promise<Bound>;
	/** Remove every temp dir not yet released (async jobs; session shutdown). */
	releaseAll(): void;
}

const rm = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });

export function createBinder(): Binder {
	const live = new Set<string>();

	return {
		/**
		 * Wrap `command` in a subshell that exports the bindings (and removes the temp dir on exit),
		 * so nothing leaks into omp's persistent bash session. Throws after removing anything it created.
		 */
		async bind(command, { env, files }, resolve) {
			const envVars = Object.entries(env);
			const fileVars = Object.entries(files);
			for (const [envVar, name] of [...envVars, ...fileVars]) {
				if (!ENV_NAME_RE.test(envVar)) throw new Error(`Invalid environment variable name "${envVar}".`);
				const invalid = validateName(name);
				if (invalid) throw new Error(invalid);
			}
			// Resolve before touching the filesystem: a missing secret leaves nothing behind.
			const [envValues, fileValues] = await Promise.all([
				Promise.all(envVars.map(([, name]) => resolve(name))),
				Promise.all(fileVars.map(([, name]) => resolve(name))),
			]);

			const lines = ["("];
			let tempDir: string | undefined;
			try {
				if (fileVars.length > 0) {
					tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-secret-"));
					live.add(tempDir);
					if (process.platform !== "win32") fs.chmodSync(tempDir, 0o700);
					lines.push(`trap ${shQuote(`rm -rf -- ${shQuote(tempDir.replaceAll("\\", "/"))}`)} EXIT`);
				}
				envVars.forEach(([envVar], i) => lines.push(`export ${envVar}=${shQuote(envValues[i]!)}`));
				fileVars.forEach(([envVar], i) => {
					const file = path.join(tempDir!, envVar);
					fs.writeFileSync(file, fileValues[i]!, { encoding: "utf8", mode: 0o600 });
					lines.push(`export ${envVar}=${shQuote(file.replaceAll("\\", "/"))}`);
				});
			} catch (err) {
				if (tempDir) {
					rm(tempDir);
					live.delete(tempDir);
				}
				throw err;
			}
			lines.push(command, ")");

			return {
				command: lines.join("\n"),
				release() {
					if (!tempDir || !live.has(tempDir)) return;
					rm(tempDir);
					live.delete(tempDir);
				},
			};
		},
		releaseAll() {
			for (const dir of live) rm(dir);
			live.clear();
		},
	};
}
