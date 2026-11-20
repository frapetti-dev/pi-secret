import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { getShellConfig, isCmdShell, isPowerShell } from "@oh-my-pi/pi-utils/procmgr";
import { type Extract, extractValue, readSource, type ImportSource } from "./import";
import { buildBoundCommand, ENV_NAME_RE } from "./inject";
import { platformKeyProvider } from "./keys";
import { projectKey } from "./project";
import { createRedactor, redactDeep } from "./redact";
import {
	createStore,
	defaultVaultPath,
	type HashAlgorithm,
	secretHash,
	secretLength,
	type Tier,
	validateName,
} from "./store";
import { pickSecret } from "./ui/manager";
import { showSecrets } from "./ui/reveal";
import { askSecrets } from "./ui/secret-prompt";

// Module scope on purpose: ephemeral secrets are shared with subagents (one store per omp process).
const store = createStore({ vaultPath: defaultVaultPath(), keyProvider: platformKeyProvider() });
const tempDirs = new Set<string>();

function text(value: string, details?: unknown) {
	return { content: [{ type: "text" as const, text: value }], ...(details === undefined ? {} : { details }) };
}

function fail(value: string) {
	return { content: [{ type: "text" as const, text: value }], isError: true };
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Validate `name`, then run `fn`; store errors become tool errors. Secret values never pass through here. */
async function guarded(name: string, fn: () => Promise<ReturnType<typeof text>>) {
	const invalid = validateName(name);
	if (invalid) return fail(invalid);
	try {
		return await fn();
	} catch (err) {
		return fail(message(err));
	}
}

const tierOfFlag = (persistent: boolean | undefined): Tier | undefined =>
	persistent === undefined ? undefined : persistent ? "persistent" : "ephemeral";

export default function piSecret(pi: ExtensionAPI) {
	const z = pi.zod;
	pi.setLabel("Secrets");

	const nameParam = z.string().describe("Secret name: 1-64 chars [A-Za-z0-9._-].");
	const nameOnly = z.object({ name: nameParam });

	const askParams = z.object({
		secrets: z
			.array(
				z.object({
					name: nameParam,
					prompt: z.string().optional().describe("Why the secret is needed; shown to the user"),
					persistent: z
						.boolean()
						.optional()
						.describe("Suggest keeping it across sessions (encrypted vault). Default false; the user can change it."),
				}),
			)
			.min(1),
	});

	pi.registerTool({
		name: "ask_secret",
		label: "Ask Secret",
		approval: "write",
		description: [
			"Ask the user for one or more secrets (password, token, API key) through a masked input prompt.",
			"Values are NEVER returned to you: the result only reports which names were stored and in which tier.",
			"Secrets are ephemeral (memory only, gone when the session closes) unless you suggest `persistent` (encrypted vault, kept across sessions); the user can change this in the prompt.",
			'Use a secret through the bash tool: `secrets: {ENV_VAR: "name"}` exports it as an environment variable, `secret_files: {ENV_VAR: "name"}` gives a private temp file path.',
			"Validate a value without seeing it with secret_length, secret_size and secret_hash. An existing secret with the same name is overwritten.",
		].join(" "),
		parameters: askParams,
		async execute(_id, { secrets }: (typeof askParams)["_output"], signal, _onUpdate, ctx) {
			const seen = new Set<string>();
			for (const { name } of secrets) {
				const invalid = validateName(name);
				if (invalid) return fail(invalid);
				if (seen.has(name)) return fail(`Duplicate secret name "${name}".`);
				seen.add(name);
			}
			if (ctx.mode !== "tui") {
				return fail(`ask_secret needs the interactive TUI for masked input (current mode: ${ctx.mode}).`);
			}
			const project = projectKey(ctx.cwd);
			const { entered, cancelled } = await askSecrets(
				ctx,
				secrets.map(s => ({ name: s.name, prompt: s.prompt, persistent: s.persistent ?? false })),
				signal,
			);
			const results: { name: string; status: "stored" | "cancelled" | "failed"; tier?: Tier }[] = [];
			const lines: string[] = [];
			for (const e of entered) {
				try {
					const tier = await store.set(project, e.name, e.value, e.persistent ? "persistent" : "ephemeral");
					results.push({ name: e.name, status: "stored", tier });
					lines.push(`${e.name}: stored (${tier})`);
				} catch (err) {
					results.push({ name: e.name, status: "failed" });
					lines.push(`${e.name}: failed: ${message(err)}`);
				}
			}
			for (const name of cancelled) {
				results.push({ name, status: "cancelled" });
				lines.push(`${name}: cancelled`);
			}
			lines.push('Use them through bash with secrets: {ENV_VAR: "<name>"}.');
			const body = text(lines.join("\n"), { results });
			return results.some(r => r.status === "stored") ? body : { ...body, isError: true };
		},
	});

	pi.registerTool({
		name: "list_secrets",
		label: "List Secrets",
		approval: "read",
		description: "List the names and tiers (ephemeral/persistent) of this project's stored secrets, never their values.",
		parameters: z.object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const secrets = store.list(projectKey(ctx.cwd));
			if (secrets.length === 0) return text("No secrets stored for this project.", { secrets });
			return text(secrets.map(s => `${s.name}\t${s.tier}`).join("\n"), { secrets });
		},
	});

	pi.registerTool({
		name: "secret_length",
		label: "Secret Length",
		approval: "read",
		description: "Length of a stored secret in characters (Unicode code points), without revealing it.",
		parameters: nameOnly,
		async execute(_id, { name }, _signal, _onUpdate, ctx) {
			return guarded(name, async () => {
				const value = await store.get(projectKey(ctx.cwd), name);
				return text(`Secret "${name}" length: ${secretLength(value)} characters (Unicode code points).`);
			});
		},
	});

	pi.registerTool({
		name: "secret_size",
		label: "Secret Size",
		approval: "read",
		description: "Size of a stored secret in bytes (UTF-8), without revealing it.",
		parameters: nameOnly,
		async execute(_id, { name }, _signal, _onUpdate, ctx) {
			return guarded(name, async () => {
				const value = await store.get(projectKey(ctx.cwd), name);
				return text(`Secret "${name}" size: ${Buffer.byteLength(value, "utf8")} bytes (UTF-8).`);
			});
		},
	});

	pi.registerTool({
		name: "secret_hash",
		label: "Secret Hash",
		approval: "read",
		description:
			"Hex digest of a stored secret's UTF-8 bytes (sha256 by default), to compare it with a known value without revealing it.",
		parameters: z.object({
			name: nameParam,
			algorithm: z.enum(["sha256", "sha512", "sha1", "md5"]).optional().describe("Hash algorithm, default sha256"),
		}),
		async execute(_id, { name, algorithm }, _signal, _onUpdate, ctx) {
			return guarded(name, async () => {
				const algo: HashAlgorithm = algorithm ?? "sha256";
				const value = await store.get(projectKey(ctx.cwd), name);
				return text(`Secret "${name}" ${algo}: ${secretHash(value, algo)}`);
			});
		},
	});

	pi.registerTool({
		name: "delete_secret",
		label: "Delete Secret",
		approval: "write",
		description: "Delete a stored secret (either tier).",
		parameters: nameOnly,
		async execute(_id, { name }, _signal, _onUpdate, ctx) {
			return guarded(name, async () => {
				store.delete(projectKey(ctx.cwd), name);
				return text(`Secret "${name}" deleted.`);
			});
		},
	});

	pi.registerTool({
		name: "show_secrets",
		label: "Show Secrets",
		approval: "read",
		description:
			"Show secret values to the USER in an overlay (Show/Hide/Copy per secret). The values are not shared with you; the tool returns when the user closes the dialog.",
		parameters: z.object({ names: z.array(nameParam).min(1) }),
		async execute(_id, { names }: { names: string[] }, _signal, _onUpdate, ctx) {
			for (const name of names) {
				const invalid = validateName(name);
				if (invalid) return fail(invalid);
			}
			if (ctx.mode !== "tui") return fail("show_secrets needs the interactive TUI.");
			const project = projectKey(ctx.cwd);
			const missing = names.filter(n => store.tierOf(project, n) === undefined);
			if (missing.length > 0) return fail(`Secret(s) not found: ${missing.join(", ")}.`);
			try {
				const items = [];
				for (const name of names) {
					items.push({ name, tier: store.tierOf(project, name)!, value: await store.get(project, name) });
				}
				await showSecrets(ctx, items);
			} catch (err) {
				return fail(message(err));
			}
			return text(`Displayed ${names.join(", ")} to the user. The values were not shared with you.`);
		},
	});

	const importParams = z.object({
		name: nameParam,
		persistent: z.boolean().optional().describe("Keep across sessions (encrypted vault). Default: keep the current tier, else ephemeral."),
		source: z.union([
			z.object({ type: z.literal("command"), command: z.string(), cwd: z.string().optional() }),
			z.object({ type: z.literal("file"), path: z.string() }),
			z.object({
				type: z.literal("http"),
				url: z.string(),
				method: z.string().optional(),
				headers: z.record(z.string(), z.string()).optional(),
				secret_headers: z
					.record(z.string(), z.object({ secret: z.string(), prefix: z.string().optional() }))
					.optional(),
				body: z.string().optional(),
			}),
			z.object({ type: z.literal("env"), variable: z.string() }),
		]),
		extract: z.object({ json: z.string().optional(), regex: z.string().optional() }).optional(),
		trim: z.boolean().optional().describe("Trim whitespace around the value (default true)"),
	});

	pi.registerTool({
		name: "import_secret",
		label: "Import Secret",
		// Commands run arbitrary code and secret_headers send stored secrets to a model-chosen URL: both need the exec tier, like bash.
		approval: (args: unknown) => {
			const source = (args as { source?: { type?: string; secret_headers?: Record<string, unknown> } } | undefined)?.source;
			if (source?.type === "command") return { tier: "exec", reason: "runs a shell command" };
			if (source?.type === "http" && source.secret_headers && Object.keys(source.secret_headers).length > 0) {
				return { tier: "exec", reason: "sends stored secrets to a URL" };
			}
			return "write";
		},
		description: [
			"Create a secret from an automatic source without its value passing through you: a command's stdout, a file, an HTTP response or an environment variable.",
			"Optional `extract` pulls a value out of the source (`json`: dot path, numeric segments index arrays; `regex`: group 1 or the whole match); the result is trimmed unless `trim` is false.",
			"HTTP `secret_headers` take the value of another stored secret (with an optional prefix such as \"Bearer \").",
			"The value is never returned; the result reports tier and length only.",
		].join(" "),
		parameters: importParams,
		async execute(_id, { name, persistent, source, extract, trim }: (typeof importParams)["_output"], signal, _onUpdate, ctx) {
			return guarded(name, async () => {
				const project = projectKey(ctx.cwd);
				const shell = getShellConfig();
				const raw = await readSource(source as ImportSource, {
					cwd: ctx.cwd,
					signal,
					shell: { shell: shell.shell, args: shell.args, env: shell.env },
					resolveSecret: n => store.get(project, n),
				});
				const value = extractValue(raw, extract as Extract | undefined, trim ?? true);
				const tier = await store.set(project, name, value, tierOfFlag(persistent));
				return text(`Imported secret "${name}" (${tier}, ${secretLength(value)} characters).`);
			});
		},
	});

	// Re-registers the built-in bash: same schema plus secret bindings, delegating to the native tool.
	let nativeDescription = "Execute a shell command.";
	try {
		nativeDescription = pi.getAllTools().find(t => t.name === "bash")?.description || nativeDescription;
	} catch {}

	const bashParams = z.object({
		command: z.string(),
		timeout: z
			.number()
			.optional()
			.describe("timeout in seconds; 0 disables the command deadline; nonzero values are clamped to 1-3600"),
		cwd: z.string().optional(),
		pty: z.boolean().optional(),
		async: z.boolean().optional(),
		notify: z.string().optional(),
		name: z
			.string()
			.optional()
			.describe(
				"starts a long-lived supervised service under this name; omit for finite commands, async jobs included. 1-48 of [A-Za-z0-9._-]",
			),
		ready: z
			.object({
				log: z.string().optional().describe("regex an output line matches once the service is ready"),
				port: z.number().optional().describe("TCP port the service accepts connections on once ready"),
				host: z.string().optional().describe("host for the port probe; default localhost (127.0.0.1 and ::1)"),
				timeout: z.number().optional().describe("seconds to wait for readiness; default 30"),
			})
			.optional()
			.describe("service readiness; needs log or port"),
		secrets: z.record(z.string(), z.string()).optional(),
		secret_files: z.record(z.string(), z.string()).optional(),
	});

	pi.registerTool({
		name: "bash",
		label: "Bash",
		description: `${nativeDescription}\n\nBind stored secrets without seeing them: secrets: {ENV_VAR: "secret-name"} exports each value as an environment variable for this command only; secret_files: {ENV_VAR: "secret-name"} writes each value to a private temp file that is deleted when the command ends and exports its path. Use them as "$ENV_VAR". Secret values in any output are replaced by [secret:<name>]. Never echo, encode or transform a secret into output.`,
		parameters: bashParams,
		async execute(_id, params: (typeof bashParams)["_output"], signal, onUpdate, ctx) {
			if (!ctx.invokeTool) return fail("pi-secret: native bash delegation unavailable in this omp version.");
			const { secrets = {}, secret_files: files = {}, ...rest } = params;
			const invoke = (args: Record<string, unknown>) => ctx.invokeTool!(args, { signal, onUpdate: onUpdate as never });
			if (Object.keys(secrets).length === 0 && Object.keys(files).length === 0) return invoke(rest);

			for (const [envVar, name] of [...Object.entries(secrets), ...Object.entries(files)]) {
				if (!ENV_NAME_RE.test(envVar)) return fail(`Invalid environment variable name "${envVar}".`);
				const invalid = validateName(name);
				if (invalid) return fail(invalid);
			}
			const shell = getShellConfig().shell;
			if (isCmdShell(shell) || isPowerShell(shell)) return fail("Secret bindings need a POSIX shell (bash/sh/zsh).");

			const project = projectKey(ctx.cwd);
			let bound: ReturnType<typeof buildBoundCommand>;
			try {
				const resolve = async (map: Record<string, string>) =>
					Object.fromEntries(await Promise.all(Object.entries(map).map(async ([v, n]) => [v, await store.get(project, n)])));
				bound = buildBoundCommand(rest.command, await resolve(secrets), await resolve(files));
			} catch (err) {
				return fail(message(err));
			}
			if (bound.tempDir) tempDirs.add(bound.tempDir);
			try {
				return await invoke({ ...rest, command: bound.command });
			} finally {
				// Async jobs outlive this call: they rely on the shell trap plus shutdown cleanup.
				if (bound.tempDir && !rest.async) {
					fs.rmSync(bound.tempDir, { recursive: true, force: true });
					tempDirs.delete(bound.tempDir);
				}
			}
		},
	});

	// pi-verdict (if installed) asks at every session start; listed tools then skip its classifier. bash and import_secret run commands, so they stay gated.
	pi.events.on("pi-verdict:collect", () =>
		pi.events.emit("pi-verdict:contribute", {
			source: "pi-secret",
			tools: ["ask_secret", "list_secrets", "secret_length", "secret_size", "secret_hash", "delete_secret", "show_secrets"],
		}),
	);

	// What is stored and shown.
	pi.on("tool_result", e => {
		const redact = createRedactor(store.knownValues());
		if (!redact) return;
		const content = redactDeep(e.content, redact);
		const details = redactDeep((e as { details?: unknown }).details, redact);
		return content.changed || details.changed ? { content: content.value, details: details.value } : undefined;
	});

	// Provider boundary: everything sent to the model, including async/pty output that bypasses tool results.
	pi.on("context", e => {
		const redact = createRedactor(store.knownValues());
		if (!redact) return;
		const messages = redactDeep(e.messages, redact);
		return messages.changed ? { messages: messages.value } : undefined;
	});

	pi.on("session_shutdown", (_e, ctx) => {
		if (ctx.agent.kind !== "main") return;
		store.clearEphemeral();
		for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
		tempDirs.clear();
	});

	pi.registerCommand("secrets", {
		description: "Manage this project's secrets (add, show, edit, rename, toggle persistence, delete)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") return ctx.ui.notify("/secrets needs the interactive TUI.", "error");
			const project = projectKey(ctx.cwd);
			let last: string | undefined;
			for (;;) {
				const choice = await pickSecret(ctx, project, store.list(project), last);
				if (!choice || choice.act === "close") return;
				const { act, name } = choice;
				last = name ?? last;
				try {
					if (act === "add") {
						const entered = (await ctx.ui.input("New secret name"))?.trim();
						if (!entered) continue;
						const invalid = validateName(entered);
						if (invalid) {
							ctx.ui.notify(invalid, "error");
							continue;
						}
						const existing = store.tierOf(project, entered);
						if (existing && !(await ctx.ui.confirm("Overwrite secret?", `"${entered}" already exists (${existing}).`))) continue;
						const { entered: got } = await askSecrets(ctx, [{ name: entered, persistent: existing === "persistent" }]);
						if (got[0]) await store.set(project, entered, got[0].value, got[0].persistent ? "persistent" : "ephemeral");
						last = entered;
						continue;
					}
					if (name === undefined) continue;
					const tier = store.tierOf(project, name);
					if (!tier) throw new Error(`Secret "${name}" not found.`);
					if (act === "show") {
						await showSecrets(ctx, [{ name, tier, value: await store.get(project, name) }]);
					} else if (act === "edit") {
						const { entered: got } = await askSecrets(ctx, [{ name, persistent: tier === "persistent" }]);
						if (got[0]) await store.set(project, name, got[0].value, got[0].persistent ? "persistent" : "ephemeral");
					} else if (act === "rename") {
						const to = (await ctx.ui.input(`Rename "${name}" to`, name))?.trim();
						if (!to || to === name) continue;
						const invalid = validateName(to);
						if (invalid) {
							ctx.ui.notify(invalid, "error");
							continue;
						}
						await store.rename(project, name, to);
						last = to;
					} else if (act === "tier") {
						const next: Tier = tier === "persistent" ? "ephemeral" : "persistent";
						await store.setTier(project, name, next);
						ctx.ui.notify(`"${name}" is now ${next}.`, "info");
					} else if (act === "delete") {
						if (await ctx.ui.confirm("Delete secret?", `"${name}" (${tier}) will be removed.`)) store.delete(project, name);
					}
				} catch (err) {
					ctx.ui.notify(message(err), "error");
				}
			}
		},
	});
}
