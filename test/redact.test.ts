import { expect, test } from "bun:test";
import { createRedactor, redactDeep } from "../src/redact";

test("longest value first", () => {
	const r = createRedactor(new Map([["abcd1234", "short"], ["abcd1234xyz", "long"]]))!;
	expect(r("a abcd1234xyz b abcd1234")).toBe("a [secret:long] b [secret:short]");
});

test("values under 4 chars are not redacted; nothing known gives undefined", () => {
	expect(createRedactor(new Map([["abc", "x"]]))).toBeUndefined();
	expect(createRedactor(new Map())).toBeUndefined();
});

test("deep walk rewrites nested strings and flags change", () => {
	const r = createRedactor(new Map([["hunter22", "pw"]]))!;
	const input = { a: ["x hunter22", { b: "hunter22" }], n: 3 };
	const out = redactDeep(input, r);
	expect(out.changed).toBe(true);
	expect(out.value).toEqual({ a: ["x [secret:pw]", { b: "[secret:pw]" }], n: 3 });
	expect(redactDeep({ a: "clean" }, r).changed).toBe(false);
});
