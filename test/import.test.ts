import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractValue, readSource } from "../src/import";
import { findBash, useTmp } from "./helpers";

const tmp = useTmp();
const bash = findBash();
const base = (shell = { shell: bash ?? "bash", args: ["-c"], env: {} }) => ({
	cwd: tmp.dir(),
	shell,
	resolveSecret: async (n: string) => (n === "tok" ? "dummy-token" : Promise.reject(new Error("nope"))),
});

describe("extractValue", () => {
	test("json path with array index", () => {
		expect(extractValue('{"a":[{"b":"dummy-1"}]}', { json: "a.0.b" }, true)).toBe("dummy-1");
		expect(extractValue('{"n":42}', { json: "n" }, true)).toBe("42");
	});
	test("regex group and whole match", () => {
		expect(extractValue("key=dummy-2;", { regex: "key=([^;]+)" }, true)).toBe("dummy-2");
		expect(extractValue("abcd", { regex: "b.d" }, true)).toBe("bcd");
	});
	test("trim", () => {
		expect(extractValue("  x y \n", undefined, true)).toBe("x y");
		expect(extractValue("  x ", undefined, false)).toBe("  x ");
	});
	test("errors never echo the content", () => {
		expect(() => extractValue("not json dummy-3", { json: "a" }, true)).toThrow("Source output is not valid JSON.");
		expect(() => extractValue('{"a":{}}', { json: "a" }, true)).toThrow('JSON path "a" did not resolve');
		expect(() => extractValue("abc", { regex: "z" }, true)).toThrow("Regex did not match.");
		expect(() => extractValue("   ", undefined, true)).toThrow("Imported value is empty.");
	});
});

describe("readSource", () => {
	test("file and missing file", async () => {
		fs.writeFileSync(path.join(tmp.dir(), "f.txt"), "dummy-file-5678");
		expect(await readSource({ type: "file", path: "f.txt" }, base())).toBe("dummy-file-5678");
		await expect(readSource({ type: "file", path: "missing.txt" }, base())).rejects.toThrow("File not found");
	});

	test("env", async () => {
		process.env.PI_SECRET_TEST_VAR = "dummy-env-1234";
		try {
			expect(await readSource({ type: "env", variable: "PI_SECRET_TEST_VAR" }, base())).toBe("dummy-env-1234");
		} finally {
			delete process.env.PI_SECRET_TEST_VAR;
		}
		await expect(readSource({ type: "env", variable: "PI_SECRET_NOPE" }, base())).rejects.toThrow("is not set");
	});

	test.skipIf(!bash)("command and non-zero exit", async () => {
		expect(await readSource({ type: "command", command: "printf dummy-cmd-1234" }, base())).toBe("dummy-cmd-1234");
		await expect(readSource({ type: "command", command: "echo dummy-leak; exit 3" }, base())).rejects.toThrow(
			"Command exited with code 3.",
		);
	});

	describe("http", () => {
		let server: ReturnType<typeof Bun.serve>;
		beforeAll(() => {
			server = Bun.serve({
				port: 0,
				fetch: req =>
					new URL(req.url).pathname === "/fail"
						? new Response("body-dummy", { status: 500 })
						: new Response(req.headers.get("authorization") ?? "none"),
			});
		});
		afterAll(() => server.stop(true));

		test("secret_headers with prefix", async () => {
			const out = await readSource(
				{ type: "http", url: `http://localhost:${server.port}/`, secret_headers: { Authorization: { secret: "tok", prefix: "Bearer " } } },
				base(),
			);
			expect(out).toBe("Bearer dummy-token");
		});
		test("non-2xx gives status only; non-http is refused", async () => {
			await expect(readSource({ type: "http", url: `http://localhost:${server.port}/fail` }, base())).rejects.toThrow(
				/^HTTP 500/,
			);
			await expect(readSource({ type: "http", url: "file:///etc/passwd" }, base())).rejects.toThrow(
				"Only http(s) URLs are supported.",
			);
		});
	});
});
