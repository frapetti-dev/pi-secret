import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { createBinder } from "../src/binding";
import { findBash, useTmp } from "./helpers";

const tmp = useTmp();
const bash = findBash();

const values = new Map([
	["quoted", "it's $HOME `x`\nline2"],
	["plain", "dummy-value"],
]);
const resolve = async (n: string) => {
	const v = values.get(n);
	if (v === undefined) throw new Error(`Secret "${n}" not found.`);
	return v;
};
const tempDirs = () => fs.readdirSync(tmp.dir()).filter(n => n.startsWith("pi-secret-"));

async function run(command: string): Promise<string> {
	const p = Bun.spawn([bash!, "-c", command], { stdout: "pipe", stderr: "pipe" });
	const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return out;
}

test.skipIf(!bash)("env binding survives quotes, $, backticks and newlines", async () => {
	const { command } = await createBinder().bind('printf %s "$V"', { env: { V: "quoted" }, files: {} }, resolve);
	expect(await run(command)).toBe(values.get("quoted")!);
});

test.skipIf(!bash)("file binding has exact contents and the temp dir is removed on exit", async () => {
	const { command } = await createBinder().bind('cat "$F"; echo; echo "$F"', { env: {}, files: { F: "quoted" } }, resolve);
	const out = await run(command);
	expect(out.startsWith(`${values.get("quoted")}\n`)).toBe(true);
	expect(tempDirs()).toEqual([]);
});

test("release() removes the temp dir and is idempotent", async () => {
	const bound = await createBinder().bind("true", { env: {}, files: { F: "plain" } }, resolve);
	expect(tempDirs()).toHaveLength(1);
	bound.release();
	expect(tempDirs()).toEqual([]);
	expect(() => bound.release()).not.toThrow();
});

test("releaseAll() removes every unreleased temp dir", async () => {
	const binder = createBinder();
	await binder.bind("true", { env: {}, files: { F: "plain" } }, resolve);
	await binder.bind("true", { env: {}, files: { G: "plain" } }, resolve);
	expect(tempDirs()).toHaveLength(2);
	binder.releaseAll();
	expect(tempDirs()).toEqual([]);
});

test("invalid env var or secret name is rejected without leaving a temp dir", async () => {
	const binder = createBinder();
	await expect(binder.bind("true", { env: { "1BAD": "plain" }, files: {} }, resolve)).rejects.toThrow(
		'Invalid environment variable name "1BAD".',
	);
	await expect(binder.bind("true", { env: {}, files: { F: "../x" } }, resolve)).rejects.toThrow("Invalid secret name");
	expect(tempDirs()).toEqual([]);
});

test("a missing secret for a file binding propagates and leaves no temp dir", async () => {
	await expect(createBinder().bind("true", { env: {}, files: { F: "missing" } }, resolve)).rejects.toThrow(
		'Secret "missing" not found.',
	);
	expect(tempDirs()).toEqual([]);
});
