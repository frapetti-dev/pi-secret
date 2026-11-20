import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { KeyProvider } from "../src/keys";
import { createStore, type SecretStore, secretHash, secretLength, validateName } from "../src/store";
import { useTmp } from "./helpers";

const tmp = useTmp();
const provider = (fill = 7): KeyProvider => ({ id: "keyring", rawKey: async () => Buffer.alloc(32, fill) });
const open = (fill = 7) => createStore({ vaultPath: path.join(tmp.dir(), "vault.json"), keyProvider: provider(fill) });
const at = (s: SecretStore, dir = "p") => s.forProject(path.join(tmp.dir(), dir));

describe("ephemeral tier", () => {
	test("set/get/list/delete", async () => {
		const s = at(open());
		expect(await s.set("a", "dummy-1234")).toBe("ephemeral");
		expect(await s.get("a")).toBe("dummy-1234");
		expect(s.list()).toEqual([{ name: "a", tier: "ephemeral" }]);
		s.delete("a");
		await expect(s.get("a")).rejects.toThrow('Secret "a" not found');
		expect(() => s.delete("a")).toThrow("not found");
	});

	test("projects are isolated", async () => {
		const s = open();
		await at(s, "p1").set("a", "dummy-1111");
		await at(s, "p2").set("a", "dummy-2222");
		expect(await at(s, "p1").get("a")).toBe("dummy-1111");
		expect(await at(s, "p2").get("a")).toBe("dummy-2222");
	});

	test("a subdirectory of a git repo shares the repo's Project", async () => {
		fs.mkdirSync(path.join(tmp.dir(), "repo", ".git"), { recursive: true });
		fs.mkdirSync(path.join(tmp.dir(), "repo", "sub"));
		const s = open();
		await at(s, "repo/sub").set("a", "dummy-1234");
		expect(await at(s, "repo").get("a")).toBe("dummy-1234");
		expect(at(s, "other").tierOf("a")).toBeUndefined();
	});

	test("invalid names are rejected by the view", () => {
		expect(() => at(open()).tierOf("../x")).toThrow("Invalid secret name");
	});
});

describe("persistent tier", () => {
	test("encrypted at rest, readable by a new store, ephemeral gone", async () => {
		const s = at(open());
		await s.set("p1", "dummy-persist-9876", "persistent");
		await s.set("e1", "dummy-eph-5555");
		const file = fs.readFileSync(path.join(tmp.dir(), "vault.json"), "utf8");
		expect(file.includes("dummy-persist-9876")).toBe(false);
		const again = at(open());
		expect(await again.get("p1")).toBe("dummy-persist-9876");
		expect(again.list()).toEqual([{ name: "p1", tier: "persistent" }]);
	});

	test("setTier moves both ways and a name has one tier", async () => {
		const s = at(open());
		await s.set("a", "dummy-1234");
		await s.setTier("a", "persistent");
		expect(s.list()).toEqual([{ name: "a", tier: "persistent" }]);
		await s.setTier("a", "ephemeral");
		expect(s.list()).toEqual([{ name: "a", tier: "ephemeral" }]);
		expect(await s.get("a")).toBe("dummy-1234");
	});

	test("set without tier keeps the current tier", async () => {
		const s = at(open());
		await s.set("a", "dummy-1234", "persistent");
		expect(await s.set("a", "dummy-5678")).toBe("persistent");
		expect(at(open()).tierOf("a")).toBe("persistent");
	});

	test("rename re-encrypts under the new name; onto an existing name throws", async () => {
		const s = at(open());
		await s.set("old", "dummy-1234", "persistent");
		await s.set("other", "dummy-5678");
		await expect(s.rename("old", "other")).rejects.toThrow('Secret "other" already exists.');
		await s.rename("old", "new");
		const again = at(open());
		expect(await again.get("new")).toBe("dummy-1234");
		await expect(again.get("old")).rejects.toThrow("not found");
	});

	test("a different key is rejected", async () => {
		await at(open(7)).set("a", "dummy-1234", "persistent");
		await expect(at(open(8)).get("a")).rejects.toThrow("Vault key mismatch");
	});

	test("an entry copied under another name fails to decrypt (AAD binding)", async () => {
		await at(open()).set("a", "dummy-1234", "persistent");
		const file = path.join(tmp.dir(), "vault.json");
		const vault = JSON.parse(fs.readFileSync(file, "utf8"));
		const entries = Object.values(vault.projects)[0] as Record<string, unknown>;
		entries.b = entries.a;
		fs.writeFileSync(file, JSON.stringify(vault));
		await expect(at(open()).get("b")).rejects.toThrow();
	});

	test("knownValues lists ephemeral and decrypted persistent values", async () => {
		const s = open();
		await at(s).set("e", "dummy-eph-1111");
		await at(s).set("x", "dummy-per-2222", "persistent");
		expect(s.knownValues().get("dummy-per-2222")).toBe("x");
		expect(s.knownValues().get("dummy-eph-1111")).toBe("e");
		s.clearEphemeral();
		expect(s.knownValues().has("dummy-eph-1111")).toBe(false);
	});
});

describe("helpers", () => {
	test("validateName", () => {
		expect(validateName("db.password-1")).toBeUndefined();
		expect(validateName("../x")).toContain("Invalid secret name");
		expect(validateName("-x")).toContain("Invalid secret name");
		expect(validateName("a".repeat(65))).toContain("Invalid secret name");
		expect(validateName("CON")).toContain("reserved");
		expect(validateName("nul.txt")).toContain("reserved");
	});

	test("length counts code points and hash uses UTF-8", () => {
		expect(secretLength("a😀b")).toBe(3);
		expect(secretHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});
