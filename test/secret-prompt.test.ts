import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { captureSecrets } from "../src/ui/secret-prompt";

const key = (id: string, text?: string) => ({ id, text, kind: "press", raw: "" }) as never;

test("secret prompt: masks, rejects empty, Tab flips tier, stores on Enter", async () => {
	const stored: unknown[] = [];
	const secrets = { set: async (name: string, value: string, tier: string) => (stored.push([name, value, tier]), tier) };
	const ctx = {
		ui: {
			custom: (factory: (...a: unknown[]) => UiNode) =>
				new Promise<void>(resolve => {
					const root = factory({ requestRender() {} }, {}, {}, resolve);
					const press = (id: string, text?: string) => root.handlers.onKey!(key(id, text));
					press("enter");
					const content = () => JSON.stringify(root.children()[0]!.children().map(c => c.props()));
					expect(content()).toContain("A secret is required.");
					press("a", "a");
					root.handlers.onPaste!({ text: "bc" });
					expect(content()).toContain("•••");
					expect(content()).not.toContain("abc");
					press("tab");
					press("enter");
				}),
		},
	} as unknown as ExtensionContext;
	const res = await captureSecrets(ctx, secrets as never, [{ name: "T", persistent: false }]);
	expect(stored).toEqual([["T", "abc", "persistent"]]);
	expect(res[0]!.status).toBe("stored");
});
