import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { projectKey } from "../src/project";
import { useTmp } from "./helpers";

const tmp = useTmp();
const canon = (p: string) => {
	const r = fs.realpathSync.native(p);
	return process.platform === "win32" ? r.toLowerCase() : r;
};

test("git root of a nested cwd", () => {
	const repo = path.join(tmp.dir(), "repo");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(path.join(repo, "a", "b"), { recursive: true });
	expect(projectKey(path.join(repo, "a", "b"))).toBe(canon(repo));
});

test("worktree .git file counts", () => {
	const repo = path.join(tmp.dir(), "wt");
	fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
	fs.writeFileSync(path.join(repo, ".git"), "gitdir: elsewhere");
	expect(projectKey(path.join(repo, "sub"))).toBe(canon(repo));
});

test("no .git up the tree falls back to the cwd", () => {
	const dir = path.join(tmp.dir(), "plain", "x");
	fs.mkdirSync(dir, { recursive: true });
	expect(projectKey(dir)).toBe(canon(dir));
});
