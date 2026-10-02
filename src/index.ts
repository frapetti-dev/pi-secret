import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { touchesSecretStore } from "./guard";
import { createSecretPrompt } from "./secret-prompt";
import {
	deleteSecret,
	type HashAlgorithm,
	listSecrets,
	readSecret,
	secretDir,
	secretExists,
	secretHash,
	secretLength,
	secretPath,
	validateName,
	writeSecret,
} from "./store";

function text(value: string, details?: unknown) {
	return { content: [{ type: "text" as const, text: value }], ...(details === undefined ? {} : { details }) };
}

function fail(value: string) {
	return { content: [{ type: "text" as const, text: value }], isError: true };
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export default function piSecret(pi: ExtensionAPI) {
	const z = pi.zod;
	pi.setLabel("Secrets");

	// Per session binding; module globals would be shared with subagents.
	const created = new Set<string>();

	const nameParam = z
		.string()
		.describe("Secret name; also the file name in the temp secret store. 1-64 chars [A-Za-z0-9._-].");
	const nameOnly = z.object({ name: nameParam });

	/** Validate `name`, then run `fn`; store errors become tool errors. Secret values never pass through here. */
	function guarded(name: string, fn: () => ReturnType<typeof text>) {
		const invalid = validateName(name);
		if (invalid) return fail(invalid);
		try {
			return fn();
		} catch (err) {
			return fail(message(err));
		}
	}

	pi.registerTool({
		name: "ask_secret",
		label: "Ask Secret",
		approval: "write",
		description: [
			"Ask the user for a secret (password, token, API key) through a masked input prompt.",
			"The secret is stored in a temp file named after `name` and NEVER returned to you: the tool output is the absolute path of that file.",
			"An existing secret with the same name is silently overwritten.",
			"Never read or print the file. Pass the path to the command that needs it, e.g. a `--password-file` flag, `curl -H @<path>`, or `$(cat \"<path>\")` inside a command whose output does not echo it.",
			"Use secret_length, secret_size and secret_hash to validate the value without seeing it. The file is deleted when the session ends.",
		].join(" "),
		parameters: z.object({
			name: nameParam,
			prompt: z.string().optional().describe("Why the secret is needed; shown to the user"),
		}),
		async execute(_id, { name, prompt }, signal, _onUpdate, ctx) {
			const invalid = validateName(name);
			if (invalid) return fail(invalid);
			if (ctx.mode !== "tui") {
				return fail(`ask_secret needs the interactive TUI for masked input (current mode: ${ctx.mode}).`);
			}
			const cancelled = `Secret entry for "${name}" was cancelled.`;
			let value: string | undefined;
			try {
				value = await ctx.ui.custom<string | undefined>(
					(_tui, theme, _kb, done) =>
						createSecretPrompt(
							theme,
							`Secret: ${name}`,
							prompt,
							v => done(v),
							() => done(undefined),
						),
					{ signal },
				);
			} catch {
				return fail(cancelled);
			}
			if (value === undefined) return fail(cancelled);
			try {
				const file = writeSecret(name, value);
				created.add(name);
				return text(file, { name, path: file });
			} catch (err) {
				return fail(message(err));
			}
		},
	});

	pi.registerTool({
		name: "get_secret_path",
		label: "Get Secret Path",
		approval: "read",
		description: "Return the absolute file path of a stored secret (never its value).",
		parameters: nameOnly,
		async execute(_id, { name }) {
			return guarded(name, () => {
				if (!secretExists(name)) throw new Error(`Secret "${name}" not found. Call ask_secret first.`);
				const file = secretPath(name);
				return text(file, { name, path: file });
			});
		},
	});

	pi.registerTool({
		name: "secret_length",
		label: "Secret Length",
		approval: "read",
		description: "Length of a stored secret in characters (Unicode code points), without revealing it.",
		parameters: nameOnly,
		async execute(_id, { name }) {
			return guarded(name, () =>
				text(`Secret "${name}" length: ${secretLength(readSecret(name))} characters (Unicode code points).`),
			);
		},
	});

	pi.registerTool({
		name: "secret_size",
		label: "Secret Size",
		approval: "read",
		description: "Size of a stored secret in bytes (UTF-8, as stored on disk), without revealing it.",
		parameters: nameOnly,
		async execute(_id, { name }) {
			return guarded(name, () => text(`Secret "${name}" size: ${readSecret(name).byteLength} bytes (UTF-8).`));
		},
	});

	pi.registerTool({
		name: "secret_hash",
		label: "Secret Hash",
		approval: "read",
		description:
			"Hex digest of the stored secret's bytes (default sha256), to compare against a known value without revealing it.",
		parameters: z.object({
			name: nameParam,
			algorithm: z.enum(["sha256", "sha512", "sha1", "md5"]).optional().describe("Default sha256"),
		}),
		async execute(_id, { name, algorithm }) {
			const alg: HashAlgorithm = algorithm ?? "sha256";
			return guarded(name, () => text(`Secret "${name}" ${alg}: ${secretHash(readSecret(name), alg)}`));
		},
	});

	pi.registerTool({
		name: "delete_secret",
		label: "Delete Secret",
		approval: "write",
		description: "Delete a stored secret file.",
		parameters: nameOnly,
		async execute(_id, { name }) {
			return guarded(name, () => {
				deleteSecret(name);
				created.delete(name);
				return text(`Secret "${name}" deleted.`);
			});
		},
	});

	pi.registerTool({
		name: "list_secrets",
		label: "List Secrets",
		approval: "read",
		description:
			"List every stored secret (including those created by other sessions) as `<name>\\t<absolute path>` lines. Never shows values.",
		parameters: z.object({}),
		async execute() {
			try {
				const names = listSecrets();
				if (names.length === 0) return text("No secrets stored.");
				const secrets = names.map(name => ({ name, path: secretPath(name) }));
				return text(secrets.map(s => `${s.name}\t${s.path}`).join("\n"), { secrets });
			} catch (err) {
				return fail(message(err));
			}
		},
	});

	pi.on("tool_call", (event, ctx) =>
		touchesSecretStore(event.toolName, event.input as Record<string, unknown>, ctx.cwd)
			? {
					block: true,
					reason: `Blocked by pi-secret: files in ${secretDir()} must not be read or modified by the agent. Use get_secret_path and pass the path to the command that needs it.`,
				}
			: undefined,
	);

	pi.on("session_shutdown", () => {
		for (const name of created) {
			try {
				deleteSecret(name);
			} catch {
				// already gone
			}
		}
		created.clear();
	});
}
