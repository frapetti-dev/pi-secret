import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { KeyProvider } from "../src/keys";
import { createStore, secretHash, secretLength, validateName } from "../src/store";
import { useTmp } from "./helpers";

const tmp = useTmp();
const provider = (fill = 7): KeyProvider => ({ id: "keyring", rawKey: async () => Buffer.alloc(32, fill) });
const open = (fill = 7) => createStore({ vaultPath: path.join(tmp.dir(), "vault.json"), keyProvider: provider(fill) });

describe("ephemeral tier", () => {
	test("set/get/list/delete", async () => {
		const s = open();
		expect(await s.set("p", "a", "dummy-1234")).toBe("ephemeral");
		expect(await s.get("p", "a")).toBe("dummy-1234");
		expect(s.list("p")).toEqual([{ name: "a", tier: "ephemeral" }]);
		s.delete("p", "a");
		await expect(s.get("p", "a")).rejects.toThrow('Secret "a" not found');
		expect(() => s.delete("p", "a")).toThrow("not found");
	});

	test("projects are isolated", async () => {
		const s = open();
		await s.set("p1", "a", "dummy-1111");
		await s.set("p2", "a", "dummy-2222");
		expect(await s.get("p1", "a")).toBe("dummy-1111");
		expect(await s.get("p2", "a")).toBe("dummy-2222");
	});
});

describe("persistent tier", () => {
	test("encrypted at rest, readable by a new store, ephemeral gone", async () => {
		const s = open();
		await s.set("p", "p1", "dummy-persist-9876", "persistent");
		await s.set("p", "e1", "dummy-eph-5555");
		const file = fs.readFileSync(path.join(tmp.dir(), "vault.json"), "utf8");
		expect(file.includes("dummy-persist-9876")).toBe(false);
		const again = open();
		expect(await again.get("p", "p1")).toBe("dummy-persist-9876");
		expect(again.list("p")).toEqual([{ name: "p1", tier: "persistent" }]);
	});

	test("setTier moves both ways and a name has one tier", async () => {
		const s = open();
		await s.set("p", "a", "dummy-1234");
		await s.setTier("p", "a", "persistent");
		expect(s.list("p")).toEqual([{ name: "a", tier: "persistent" }]);
		await s.setTier("p", "a", "ephemeral");
		expect(s.list("p")).toEqual([{ name: "a", tier: "ephemeral" }]);
		expect(await s.get("p", "a")).toBe("dummy-1234");
	});

	test("set without tier keeps the current tier", async () => {
		const s = open();
		await s.set("p", "a", "dummy-1234", "persistent");
		expect(await s.set("p", "a", "dummy-5678")).toBe("persistent");
		expect(open().tierOf("p", "a")).toBe("persistent");
	});

	test("rename re-encrypts under the new name; onto an existing name throws", async () => {
		const s = open();
		await s.set("p", "old", "dummy-1234", "persistent");
		await s.set("p", "other", "dummy-5678");
		await expect(s.rename("p", "old", "other")).rejects.toThrow('Secret "other" already exists.');
		await s.rename("p", "old", "new");
		const again = open();
		expect(await again.get("p", "new")).toBe("dummy-1234");
		await expect(again.get("p", "old")).rejects.toThrow("not found");
	});

	test("a different key is rejected", async () => {
		await open(7).set("p", "a", "dummy-1234", "persistent");
		await expect(open(8).get("p", "a")).rejects.toThrow("Vault key mismatch");
	});

	test("an entry copied under another name fails to decrypt (AAD binding)", async () => {
		await open().set("p", "a", "dummy-1234", "persistent");
		const file = path.join(tmp.dir(), "vault.json");
		const vault = JSON.parse(fs.readFileSync(file, "utf8"));
		vault.projects.p.b = vault.projects.p.a;
		fs.writeFileSync(file, JSON.stringify(vault));
		await expect(open().get("p", "b")).rejects.toThrow();
	});

	test("knownValues lists ephemeral and decrypted persistent values", async () => {
		const s = open();
		await s.set("p", "e", "dummy-eph-1111");
		await s.set("p", "x", "dummy-per-2222", "persistent");
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
