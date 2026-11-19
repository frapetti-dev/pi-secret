import * as fs from "node:fs";
import * as path from "node:path";

/** Git root of `cwd` (`.git` dir or worktree file), else `cwd` itself; real path, lowercased on win32. */
export function projectKey(cwd: string): string {
	const start = path.resolve(cwd);
	let root = start;
	for (let dir = start; ; ) {
		if (fs.existsSync(path.join(dir, ".git"))) {
			root = dir;
			break;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	try {
		root = fs.realpathSync.native(root);
	} catch {}
	return process.platform === "win32" ? root.toLowerCase() : root;
}
