import * as fs from "node:fs";
import * as path from "node:path";
import { type ProjectSecrets, secretLength, type Tier, validateName } from "./store";

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

/** Approval tier for an `import_secret` call: commands run code and secret_headers send stored secrets to a model-chosen URL, so both need exec, like bash. */
export function importApproval(args: unknown): "write" | { tier: "exec"; reason: string } {
	const source = (args as { source?: { type?: string; secret_headers?: Record<string, unknown> } } | undefined)?.source;
	if (source?.type === "command") return { tier: "exec", reason: "runs a shell command" };
	if (source?.type === "http" && source.secret_headers && Object.keys(source.secret_headers).length > 0) {
		return { tier: "exec", reason: "sends stored secrets to a URL" };
	}
	return "write";
}

export interface ImportRequest {
	name: string;
	/** undefined: keep the current tier, else ephemeral. */
	persistent?: boolean;
	source: ImportSource;
	extract?: Extract;
	/** Default true. */
	trim?: boolean;
}

/** Validate the name, read the source, extract, store. Returns tier and length only, never the value. */
export async function importSecret(
	secrets: ProjectSecrets,
	req: ImportRequest,
	o: { cwd: string; signal?: AbortSignal; shell: ShellSpec },
): Promise<{ tier: Tier; length: number }> {
	// Before reading: an invalid name must never run a command or make a request.
	const invalid = validateName(req.name);
	if (invalid) throw new Error(invalid);
	const raw = await readSource(req.source, { ...o, resolveSecret: n => secrets.get(n) });
	const value = extractValue(raw, req.extract, req.trim ?? true);
	const tier = await secrets.set(
		req.name,
		value,
		req.persistent === undefined ? undefined : req.persistent ? "persistent" : "ephemeral",
	);
	return { tier, length: secretLength(value) };
}
