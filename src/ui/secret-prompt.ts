import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { JSXNode, KeyEvent } from "@oh-my-pi/pi-tui";
import type { ProjectSecrets, Tier } from "../store";
import { LineInput } from "./line-input";
import { heading, mount, n, prose, txt } from "./nodes";

export interface AskEntry {
	name: string;
	prompt?: string;
	persistent: boolean;
}
export interface Entered {
	name: string;
	value: string;
	persistent: boolean;
}

/** One dialog, entries asked one at a time; Tab flips the entry's tier. Esc cancels the current and all remaining entries. */
async function askSecrets(
	ctx: ExtensionContext,
	entries: AskEntry[],
	signal?: AbortSignal,
): Promise<{ entered: Entered[]; cancelled: string[] }> {
	const entered: Entered[] = [];
	const settle = () => ({ entered, cancelled: entries.slice(entered.length).map(e => e.name) });
	if (signal?.aborted) return settle();
	try {
		await ctx.ui.custom<void>((_ui, _theme, _kb, done) =>
			mount(refresh => {
				const flags = entries.map(e => e.persistent);
				let input = new LineInput("", { masked: true });
				let error: string | undefined;
				let index = 0;
				let finished = false;

				const finish = () => {
					if (finished) return;
					finished = true;
					signal?.removeEventListener("abort", finish);
					done();
				};
				signal?.addEventListener("abort", finish, { once: true });

				const storageLine = () =>
					flags[index]
						? "Storage: persistent (Tab: make ephemeral)"
						: "Storage: ephemeral (Tab: make persistent)";

				return {
					describe(): JSXNode {
						const entry = entries[Math.min(index, entries.length - 1)]!;
						return n("col", { gap: "sm" }, [
							heading(`Secret ${index + 1}/${entries.length}: ${entry.name}`),
							...(entry.prompt ? [prose(entry.prompt)] : []),
							input.node({ key: "value", focused: true }),
							...(error ? [txt([{ t: error, s: "error" }])] : []),
							prose(storageLine()),
							txt([{ t: "Enter submit · Esc cancel · Tab persistence", s: "muted" }]),
						]);
					},
					handleKey(key: KeyEvent): void {
						if (finished) return;
						if (key.id === "tab") flags[index] = !flags[index];
						else if (key.id === "enter") {
							if (!input.value) error = "A secret is required.";
							else {
								entered.push({ name: entries[index]!.name, value: input.value, persistent: flags[index]! });
								input = new LineInput("", { masked: true });
								error = undefined;
								if (++index >= entries.length) return finish();
							}
						} else if (key.id === "escape") return finish();
						else if (input.handleKey(key)) error = undefined;
						refresh();
					},
					handlePaste(text: string): void {
						input.paste(text);
						refresh();
					},
				};
			}),
		);
	} catch {
		// Dialog rejection/abort: everything not yet entered counts as cancelled.
	}
	return settle();
}

export interface Captured {
	name: string;
	status: "stored" | "cancelled" | "failed";
	tier?: Tier;
	/** Store error message (never contains the value). */
	error?: string;
}

/** Prompt for `entries`, then store each entered value in its chosen tier. Store failures are reported per entry, never thrown. */
export async function captureSecrets(
	ctx: ExtensionContext,
	secrets: ProjectSecrets,
	entries: AskEntry[],
	signal?: AbortSignal,
): Promise<Captured[]> {
	const { entered, cancelled } = await askSecrets(ctx, entries, signal);
	const results: Captured[] = [];
	for (const e of entered) {
		try {
			results.push({ name: e.name, status: "stored", tier: await secrets.set(e.name, e.value, e.persistent ? "persistent" : "ephemeral") });
		} catch (err) {
			results.push({ name: e.name, status: "failed", error: err instanceof Error ? err.message : String(err) });
		}
	}
	for (const name of cancelled) results.push({ name, status: "cancelled" });
	return results;
}
