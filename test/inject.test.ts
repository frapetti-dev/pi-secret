import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { buildBoundCommand } from "../src/inject";
import { findBash, useTmp } from "./helpers";

useTmp();
const bash = findBash();

async function run(command: string): Promise<string> {
	const p = Bun.spawn([bash!, "-c", command], { stdout: "pipe", stderr: "pipe" });
	const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return out;
}

test.skipIf(!bash)("env binding survives quotes, $ and newlines", async () => {
	const value = "it's $HOME `x`\nline2";
	const { command } = buildBoundCommand('printf %s "$V"', { V: value }, {});
	expect(await run(command)).toBe(value);
});

test.skipIf(!bash)("file binding has exact contents and the temp dir is removed on exit", async () => {
	const value = "it's $HOME\nline2";
	const { command, tempDir } = buildBoundCommand('cat "$F"; echo; echo "$F"', {}, { F: value });
	expect(tempDir).toBeDefined();
	const out = await run(command);
	expect(out.startsWith(`${value}\n`)).toBe(true);
	expect(fs.existsSync(tempDir!)).toBe(false);
});
