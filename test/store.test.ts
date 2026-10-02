import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	deleteSecret,
	listSecrets,
	readSecret,
	secretDir,
	secretHash,
	secretLength,
	validateName,
	writeSecret,
} from "../src/store";

let tmp: string;
const saved = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-secret-test-"));
	process.env.TMP = process.env.TEMP = process.env.TMPDIR = tmp;
});

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("validateName", () => {
	test("accepts", () => {
		expect(validateName("gh_token")).toBeUndefined();
		expect(validateName("a.b-c")).toBeUndefined();
	});
	test("rejects", () => {
		for (const bad of ["", "../x", "a/b", "a\\b", ".hidden", "a".repeat(65), "CON", "nul.txt"]) {
			expect(validateName(bad)).toBeString();
		}
	});
});

describe("store", () => {
	test("store dir honours the isolated tmpdir", () => {
		expect(secretDir().startsWith(tmp)).toBe(true);
	});

	test("roundtrip, overwrite, delete", () => {
		const value = "pässwörd";
		const file = writeSecret("s", value);
		expect(path.isAbsolute(file)).toBe(true);
		const buf = readSecret("s");
		expect(secretLength(buf)).toBe(8);
		expect(buf.byteLength).toBe(10);
		expect(secretHash(buf)).toBe(crypto.createHash("sha256").update(value).digest("hex"));

		writeSecret("s", "x");
		expect(readSecret("s").toString("utf8")).toBe("x");

		deleteSecret("s");
		expect(() => readSecret("s")).toThrow('Secret "s" not found. Call ask_secret first.');
	});

	test("listSecrets", () => {
		expect(listSecrets()).toEqual([]);
		writeSecret("b", "1");
		writeSecret("a", "2");
		fs.mkdirSync(path.join(secretDir(), "sub"));
		fs.writeFileSync(path.join(secretDir(), ".junk"), "x");
		expect(listSecrets()).toEqual(["a", "b"]);
	});
});
