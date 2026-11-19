import * as fs from "node:fs";
import * as path from "node:path";

export type ImportSource =
	| { type: "command"; command: string; cwd?: string }
	| { type: "file"; path: string }
	| {
			type: "http";
			url: string;
			method?: string;
			headers?: Record<string, string>;
			secret_headers?: Record<string, { secret: string; prefix?: string }>;
			body?: string;
	  }
	| { type: "env"; variable: string };

export interface Extract {
	json?: string;
	regex?: string;
}

export interface ShellSpec {
	shell: string;
	args: string[];
	env: Record<string, string>;
}

const TIMEOUT_MS = 60_000;

export async function readSource(
	source: ImportSource,
	o: {
		cwd: string;
		signal?: AbortSignal;
		shell: ShellSpec;
		resolveSecret: (name: string) => Promise<string>;
	},
): Promise<string> {
	const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
	switch (source.type) {
		case "command": {
			const proc = Bun.spawn([o.shell.shell, ...o.shell.args, source.command], {
				cwd: path.resolve(o.cwd, source.cwd ?? "."),
				env: { ...process.env, ...o.shell.env },
				stdout: "pipe",
				stderr: "ignore",
				signal,
			});
			const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			if (code !== 0) throw new Error(`Command exited with code ${code}.`);
			return out;
		}
		case "file": {
			const file = path.resolve(o.cwd, source.path);
			try {
				return fs.readFileSync(file, "utf8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`File not found: ${file}`);
				throw err;
			}
		}
		case "http": {
			let url: URL;
			try {
				url = new URL(source.url);
			} catch {
				throw new Error("Only http(s) URLs are supported.");
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs are supported.");
			const headers: Record<string, string> = { ...source.headers };
			for (const [header, { secret, prefix }] of Object.entries(source.secret_headers ?? {})) {
				headers[header] = (prefix ?? "") + (await o.resolveSecret(secret));
			}
			const res = await fetch(url, { method: source.method ?? "GET", headers, body: source.body, signal });
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			return await res.text();
		}
		case "env": {
			const value = process.env[source.variable];
			if (value === undefined) throw new Error(`Environment variable ${source.variable} is not set.`);
			return value;
		}
	}
}

export function extractValue(raw: string, extract: Extract | undefined, trim: boolean): string {
	let value = raw;
	if (extract?.json !== undefined) {
		let node: unknown;
		try {
			node = JSON.parse(value);
		} catch {
			throw new Error("Source output is not valid JSON.");
		}
		for (const segment of extract.json.split(".").filter(Boolean)) {
			node = node !== null && typeof node === "object" ? (node as Record<string, unknown>)[segment] : undefined;
		}
		if (typeof node !== "string" && typeof node !== "number" && typeof node !== "boolean") {
			throw new Error(`JSON path "${extract.json}" did not resolve to a string, number or boolean.`);
		}
		value = String(node);
	}
	if (extract?.regex !== undefined) {
		const m = new RegExp(extract.regex).exec(value);
		if (!m) throw new Error("Regex did not match.");
		value = m[1] ?? m[0];
	}
	if (trim) value = value.trim();
	if (value === "") throw new Error("Imported value is empty.");
	return value;
}
