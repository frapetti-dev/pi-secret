import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { JSXNode, KeyEvent, UiEvent } from "@oh-my-pi/pi-tui";
import type { Tier } from "../store";
import { bar, button, framed, heading, mount, n, prose, txt } from "./nodes";

export interface RevealItem {
	name: string;
	tier: Tier;
	value: string;
}

const BULLETS = "••••••••";

async function copyText(text: string): Promise<void> {
	try {
		const { copyToClipboard } = await import("@oh-my-pi/pi-coding-agent/utils/clipboard");
		await copyToClipboard(text);
		return;
	} catch {
		// Dynamic import on purpose: if the host subpath fails to resolve, fall back to a local clipboard spawn.
	}
	const candidates: string[][] =
		process.platform === "win32"
			? [["powershell.exe", "-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"]]
			: process.platform === "darwin"
				? [["pbcopy"]]
				: [["wl-copy"], ["xclip", "-selection", "clipboard"]];
	let last: unknown;
	for (const cmd of candidates) {
		try {
			const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
			proc.stdin.write(text);
			await proc.stdin.end();
			if ((await proc.exited) === 0) return;
			last = new Error(`${cmd[0]} exited non-zero`);
		} catch (err) {
			last = err;
		}
	}
	throw last instanceof Error ? last : new Error("no clipboard command available");
}

/** Blocking overlay showing secret values to the user only. Resolves when the user closes it. */
export async function showSecrets(ctx: ExtensionContext, items: RevealItem[]): Promise<void> {
	const revealed = new Set<string>();
	try {
		await ctx.ui.custom<void>(
			(_ui, _theme, _kb, done) =>
				mount(refresh => {
					let cursor = 0;
					let status = "";
					let closed = false;

					const finish = () => {
						if (closed) return;
						closed = true;
						revealed.clear();
						done();
					};
					const toggle = (name: string) => {
						if (!revealed.delete(name)) revealed.add(name);
					};
					const copy = async (name: string) => {
						const item = items.find(i => i.name === name);
						if (!item) return;
						try {
							await copyText(item.value);
							status = `Copied ${name}`;
						} catch (err) {
							status = `Copy failed: ${err instanceof Error ? err.message : String(err)}`;
						}
						if (!closed) refresh();
					};

					return {
						describe(): JSXNode {
							return framed(
								[
									heading("Secrets (visible to you only)"),
									...items.map(i => {
										const shown = revealed.has(i.name);
										return n(
											"col",
											{ gap: "xs" },
											[
												txt(`${i.name} (${i.tier})`, { mono: true } as never),
												txt(shown ? i.value : BULLETS, { mono: true } as never),
												bar(
													[button(shown ? "Hide" : "Show", `toggle:${i.name}`), button("Copy", `copy:${i.name}`)],
													`actions:${i.name}`,
												),
											],
											`row:${i.name}`,
										);
									}),
									bar([prose(status), null, button("Close", "close", "escape")], "footer"),
								],
								"md",
							);
						},
						handleEvent(e: UiEvent): void {
							if (e.type !== "action") return;
							if (e.act === "close") return finish();
							const at = e.act.indexOf(":");
							const act = at < 0 ? e.act : e.act.slice(0, at);
							const name = at < 0 ? "" : e.act.slice(at + 1);
							if (act === "toggle") toggle(name);
							else if (act === "copy") void copy(name);
							refresh();
						},
						handleKey(key: KeyEvent): void {
							const current = items[cursor];
							if (key.id === "escape" || key.id === "q") return finish();
							if (key.id === "up") cursor = Math.max(0, cursor - 1);
							else if (key.id === "down") cursor = Math.min(items.length - 1, cursor + 1);
							else if (current && (key.id === "enter" || key.id === "space")) toggle(current.name);
							else if (current && key.id === "c") void copy(current.name);
							refresh();
						},
					};
				}),
			{ overlay: true },
		);
	} finally {
		revealed.clear();
	}
}
