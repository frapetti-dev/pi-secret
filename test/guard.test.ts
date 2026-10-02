import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { touchesSecretStore } from "../src/guard";
import { secretDir } from "../src/store";

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

describe("touchesSecretStore", () => {
	const cwd = process.cwd();

	test("blocks direct paths, forward and backslash", () => {
		expect(touchesSecretStore("read", { path: `${secretDir()}/x` }, cwd)).toBe(true);
		expect(touchesSecretStore("read", { path: `${secretDir()}\\x`.replaceAll("/", "\\") }, cwd)).toBe(true);
	});

	test("blocks recursive readers rooted at an ancestor", () => {
		expect(touchesSecretStore("grep", { path: os.tmpdir() }, cwd)).toBe(true);
		expect(touchesSecretStore("find", { path: `src;${os.tmpdir()}` }, cwd)).toBe(true);
	});

	test("matches an ancestor given in a different path form (8.3 short name / symlink)", () => {
		expect(touchesSecretStore("grep", { path: fs.realpathSync.native(os.tmpdir()) }, cwd)).toBe(true);
	});

	test("allows unrelated calls", () => {
		expect(touchesSecretStore("grep", { path: "src" }, cwd)).toBe(false);
		expect(touchesSecretStore("bash", { command: `cat ${secretDir()}/x` }, cwd)).toBe(false);
		expect(touchesSecretStore("glob", { path: os.tmpdir() }, cwd)).toBe(false);
	});
});
