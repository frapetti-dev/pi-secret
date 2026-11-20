/** Replace known secret values with `[secret:<name>]`, longest value first. `undefined` when nothing is redactable. */
export function createRedactor(known: ReadonlyMap<string, string>): ((s: string) => string) | undefined {
	// shortcut: values < 4 chars are not redacted (would mangle normal text); revisit if short secrets matter
	const entries = [...known].filter(([value]) => Array.from(value).length >= 4).sort((a, b) => b[0].length - a[0].length);
	if (entries.length === 0) return undefined;
	return s => {
		let out = s;
		for (const [value, name] of entries) if (out.includes(value)) out = out.split(value).join(`[secret:${name}]`);
		return out;
	};
}

/** Rewrite every string inside plain arrays/objects; other values pass through untouched. */
export function redactDeep<T>(value: T, redact: (s: string) => string): { value: T; changed: boolean } {
	let changed = false;
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") {
			const r = redact(v);
			if (r !== v) changed = true;
			return r;
		}
		if (Array.isArray(v)) return v.map(walk);
		if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
			return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
		}
		return v;
	};
	const out = walk(value) as T;
	return { value: changed ? out : value, changed };
}
