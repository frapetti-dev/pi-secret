import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { JSXNode, KeyEvent, UiEvent } from "@oh-my-pi/pi-tui";
import type { SecretInfo } from "../store";
import { mount, n } from "./nodes";

export type ManagerAct = "show" | "add" | "edit" | "rename" | "tier" | "delete" | "close";
export interface ManagerResult {
	act: ManagerAct;
	name?: string;
}

const KEYS: [string, ManagerAct][] = [
	["ctrl+n", "add"],
	["ctrl+e", "edit"],
	["ctrl+r", "rename"],
	["ctrl+y", "tier"],
	["delete", "delete"],
];

/** Native `picker` sheet listing one project's secrets with per-secret actions. */
export async function pickSecret(
	ctx: ExtensionContext,
	project: string,
	secrets: SecretInfo[],
	selected?: string,
): Promise<ManagerResult | undefined> {
	return ctx.ui.custom<ManagerResult | undefined>(
		(_ui, _theme, _kb, done) =>
			mount(refresh => {
				let current = secrets.find(s => s.name === selected)?.name ?? secrets[0]?.name;
				const none = secrets.length === 0;

				const move = (d: number) => {
					if (none) return;
					const i = Math.max(0, secrets.findIndex(s => s.name === current));
					current = secrets[Math.min(secrets.length - 1, Math.max(0, i + d))]!.name;
				};
				const pick = (act: ManagerAct) => {
					if (act === "close") return done({ act });
					if (act === "add") return done({ act });
					if (current !== undefined) done({ act, name: current });
				};

				return {
					describe(): JSXNode {
						return n("picker", {
							title: "Secrets",
							subtitle: project,
							noun: "secret",
							preview: "none",
							items: secrets.map(s => ({ id: s.name, label: s.name, detail: s.tier, mono: true })),
							selected: current ?? "",
							total: secrets.length,
							empty: "No secrets for this project. Press ctrl+n to add one.",
							actions: [
								{ id: "show", label: "Show", keys: ["enter"], primary: true, disabled: none },
								{ id: "add", label: "Add", keys: ["ctrl+n"] },
								{ id: "edit", label: "Edit value", keys: ["ctrl+e"], disabled: none },
								{ id: "rename", label: "Rename", keys: ["ctrl+r"], disabled: none },
								{ id: "tier", label: "Toggle persistence", keys: ["ctrl+y"], disabled: none },
								{ id: "delete", label: "Delete", keys: ["delete"], danger: true, disabled: none },
								{ id: "close", label: "Close", keys: ["escape"], end: true },
							],
						} as never);
					},
					handleEvent(e: UiEvent): void {
						if (e.type === "select") current = e.item;
						else if (e.type === "activate") return done({ act: "show", name: e.item });
						else if (e.type === "action") return pick(e.act as ManagerAct);
						refresh();
					},
					handleKey(key: KeyEvent): void {
						if (key.id === "escape") return done(undefined);
						if (key.id === "up") move(-1);
						else if (key.id === "down") move(1);
						else if (key.id === "enter") return pick("show");
						else {
							const hit = KEYS.find(([id]) => key.id === id);
							if (hit) return pick(hit[1]);
							return;
						}
						refresh();
					},
				};
			}),
		{ overlay: true },
	);
}
