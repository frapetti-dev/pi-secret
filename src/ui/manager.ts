import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui";
import type { SecretInfo } from "../store";
import { fit, isKey, Memo, n } from "./nodes";

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

/** Native `picker` sheet (ANSI twin included) listing one project's secrets with per-secret actions. */
export async function pickSecret(
	ctx: ExtensionContext,
	project: string,
	secrets: SecretInfo[],
	selected?: string,
): Promise<ManagerResult | undefined> {
	return ctx.ui.custom<ManagerResult | undefined>(
		(tui, _theme, _kb, done) => {
			let current = secrets.find(s => s.name === selected)?.name ?? secrets[0]?.name;
			let version = 0;
			const memo = new Memo();
			const none = secrets.length === 0;

			const bump = () => {
				version++;
				tui.requestRender();
			};
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
				nativeSheet: (cx: DescribeContext) => cx.supports("picker"),
				describe(_cx: DescribeContext): NativeNode {
					return memo.get([version], () =>
						n("picker", {
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
						} as never),
					);
				},
				handleNativeEvent(e: NativeUiEvent): void {
					if (e.type === "select") current = e.item;
					else if (e.type === "activate") return done({ act: "show", name: e.item });
					else if (e.type === "action") {
						current = current ?? undefined;
						return pick(e.act as ManagerAct);
					}
					bump();
				},
				handleInput(data: string): void {
					if (isKey(data, "escape")) return done(undefined);
					if (isKey(data, "up")) move(-1);
					else if (isKey(data, "down")) move(1);
					else if (isKey(data, "enter")) return pick("show");
					else {
						const hit = KEYS.find(([key]) => isKey(data, key));
						if (hit) return pick(hit[1]);
						return;
					}
					bump();
				},
				render(width: number): readonly string[] {
					return [
						`Secrets · ${project}`,
						...(none ? ["  (none)"] : secrets.map(s => `${s.name === current ? ">" : " "} ${s.name}  (${s.tier})`)),
						"↑↓ select · enter show · ctrl+n add · ctrl+e edit · ctrl+r rename · ctrl+y persistence · del delete · esc close",
					].map(l => fit(l, width));
				},
				invalidate(): void {},
			};
		},
		{ overlay: true },
	);
}
