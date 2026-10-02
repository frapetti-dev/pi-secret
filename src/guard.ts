import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SECRET_DIR_NAME, secretDir } from "./store";

const GUARDED_TOOLS = new Set(["read", "grep", "glob", "find", "edit", "write", "ast_grep", "ast_edit"]);
const RECURSIVE_READERS = new Set(["grep", "find"]);
const MARKER = SECRET_DIR_NAME.toLowerCase();

function norm(p: string): string {
	return process.platform === "win32" ? p.toLowerCase() : p;
}

/** Resolve symlinks and Windows 8.3 short names on the deepest existing ancestor, keeping the missing tail. */
function canon(p: string): string {
	let head = p;
	let tail = "";
	for (;;) {
		try {
			return norm(path.join(fs.realpathSync.native(head), tail));
		} catch {
			const parent = path.dirname(head);
			if (parent === head) return norm(p);
			tail = path.join(path.basename(head), tail);
			head = parent;
		}
	}
}

/** True when a tool call would read or modify the secret store (bash/eval are intentionally not guarded). */
export function touchesSecretStore(toolName: string, input: Record<string, unknown>, cwd: string): boolean {
	if (!GUARDED_TOOLS.has(toolName)) return false;

	if (JSON.stringify(input).toLowerCase().replaceAll("\\\\", "/").includes(MARKER)) return true;

	if (RECURSIVE_READERS.has(toolName) && typeof input.path === "string") {
		const dir = canon(secretDir());
		for (const raw of input.path.split(";")) {
			let entry = raw.trim();
			if (!entry || entry.includes("://")) continue;
			if (entry === "~" || entry.startsWith("~/") || entry.startsWith("~\\")) {
				entry = path.join(os.homedir(), entry.slice(1));
			}
			const p = canon(path.resolve(cwd, entry));
			if (dir === p || dir.startsWith(p.endsWith(path.sep) ? p : p + path.sep)) return true;
		}
	}
	return false;
}
