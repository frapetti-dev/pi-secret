import type { ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import { type DescribeContext, type FormFieldTheme, type NativeNode, TextFormField } from "@oh-my-pi/pi-tui";
import { Memo, n, prose } from "./nodes";
import type { ProjectSecrets, Tier } from "../store";

/**
 * Masked single-field prompt: the typed value is rendered as bullets and never echoed.
 *
 * Only the root `@oh-my-pi/pi-tui` export is used and styling comes from the host's `theme`
 * argument: the extension loads its own copy of pi-tui, whose global theme/chrome singletons
 * are never initialised (importing `chrome/*` fails with `undefined is not an object (theme.fg)`).
 */
export function createSecretPrompt(
	theme: Theme,
	title: string,
	description: string | undefined,
	onSubmit: (value: string) => void,
	onCancel: () => void,
): TextFormField {
	const formTheme: FormFieldTheme = {
		label: text => theme.bold(theme.fg("accent", text)),
		description: text => theme.fg("muted", text),
		error: text => theme.fg("error", text),
		hint: text => theme.fg("dim", text),
	};
	return new TextFormField({
		theme: formTheme,
		label: title,
		description,
		secret: true,
		empty: "reject",
		emptyError: "A secret is required.",
		hint: "Enter submit  Esc cancel",
		leadingSpace: true,
		onSubmit,
		onCancel,
	});
}

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
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const flags = entries.map(e => e.persistent);
			const memo = new Memo();
			let index = 0;
			let version = 0;
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

			let field = makeField();

			function makeField() {
				const entry = entries[index]!;
				const f = createSecretPrompt(
					theme,
					`Secret ${index + 1}/${entries.length}: ${entry.name}`,
					entry.prompt,
					value => {
						entered.push({ name: entry.name, value, persistent: flags[index]! });
						if (++index >= entries.length) return finish();
						field = makeField();
						version++;
						tui.requestRender();
					},
					finish,
				);
				f.focused = true;
				return f;
			}

			return {
				describe(cx: DescribeContext): NativeNode {
					return memo.get([version, index, flags[index], cx.dark], () =>
						n("col", { gap: "sm" }, [field, prose(storageLine())]),
					);
				},
				handleInput(data: string): void {
					if (data === "\t") {
						flags[index] = !flags[index];
						version++;
					} else field.handleInput(data);
					tui.requestRender();
				},
				render(width: number): readonly string[] {
					return [...field.render(width), theme.fg("muted", storageLine())];
				},
				invalidate(): void {
					field.invalidate();
				},
			};
		});
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
