import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { KeyProvider } from "./keys";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export type Tier = "ephemeral" | "persistent";
export interface SecretInfo {
	name: string;
	tier: Tier;
}

export function validateName(name: string): string | undefined {
	if (!NAME_RE.test(name)) {
		return `Invalid secret name "${name}": use 1-64 chars of letters, digits, ".", "_", "-", starting with a letter or digit.`;
	}
	if (RESERVED_RE.test(name)) {
		return `Invalid secret name "${name}": reserved device name.`;
	}
	return undefined;
}

export type HashAlgorithm = "sha256" | "sha512" | "sha1" | "md5";

/** Length in Unicode code points. */
export function secretLength(value: string): number {
	return Array.from(value).length;
}

export function secretHash(value: string, algorithm: HashAlgorithm = "sha256"): string {
	return crypto.createHash(algorithm).update(value, "utf8").digest("hex");
}

export function defaultVaultPath(): string {
	return path.join(os.homedir(), ".omp", "agent", "pi-secret", "vault.json");
}

export interface SecretStore {
	list(project: string): SecretInfo[];
	tierOf(project: string, name: string): Tier | undefined;
	get(project: string, name: string): Promise<string>;
	set(project: string, name: string, value: string, tier?: Tier): Promise<Tier>;
	delete(project: string, name: string): void;
	rename(project: string, from: string, to: string): Promise<void>;
	setTier(project: string, name: string, tier: Tier): Promise<void>;
	/** value → name for all ephemeral secrets and every persistent secret decrypted so far. */
	knownValues(): Map<string, string>;
	clearEphemeral(): void;
}

interface Blob {
	iv: string;
	data: string;
}
interface Vault {
	version: 1;
	provider: KeyProvider["id"];
	challenge: string;
	salt: string;
	check: Blob;
	projects: Record<string, Record<string, Blob>>;
}

function assertName(name: string): void {
	const error = validateName(name);
	if (error) throw new Error(error);
}

function notFound(name: string): Error {
	return new Error(`Secret "${name}" not found. Call ask_secret or import_secret first.`);
}

function encrypt(key: Buffer, aad: string, plain: string): Blob {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(aad, "utf8"));
	const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
	return { iv: iv.toString("base64"), data: ct.toString("base64") };
}

function decrypt(key: Buffer, aad: string, blob: Blob): string {
	const raw = Buffer.from(blob.data, "base64");
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
	decipher.setAAD(Buffer.from(aad, "utf8"));
	decipher.setAuthTag(raw.subarray(raw.length - 16));
	return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8");
}

export function createStore(opts: { vaultPath: string; keyProvider: KeyProvider }): SecretStore {
	const { vaultPath, keyProvider } = opts;
	const ephemeral = new Map<string, Map<string, string>>();
	const cache = new Map<string, string>();
	const cacheKey = (project: string, name: string) => `${project}\0${name}`;
	const aad = (project: string, name: string) => `${project}\0${name}`;
	let keyPromise: Promise<Buffer> | undefined;

	function readVault(): Vault | undefined {
		let raw: string;
		try {
			raw = fs.readFileSync(vaultPath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw err;
		}
		const vault = JSON.parse(raw) as Vault;
		if (vault.version !== 1) throw new Error(`Unsupported vault version ${vault.version}.`);
		return vault;
	}

	// shortcut: read-modify-write without a lock; two omp processes writing at the same instant can drop one change; add a lockfile if that shows up.
	function writeVault(vault: Vault): void {
		const dir = path.dirname(vaultPath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tmp = `${vaultPath}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(vault, null, "\t"), { encoding: "utf8", mode: 0o600 });
		if (process.platform !== "win32") fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, vaultPath);
	}

	/** Read the vault, creating the in-memory skeleton if missing. Needs `key` only to build `check`. */
	async function loadForWrite(): Promise<{ vault: Vault; key: Buffer }> {
		let vault = readVault();
		if (!vault) {
			const challenge = crypto.randomBytes(32).toString("base64");
			const salt = crypto.randomBytes(16).toString("base64");
			// Key derivation for a fresh vault happens with its own challenge/salt.
			const key = await deriveKey(Buffer.from(challenge, "base64"), Buffer.from(salt, "base64"));
			vault = {
				version: 1,
				provider: keyProvider.id,
				challenge,
				salt,
				check: encrypt(key, "check", "pi-secret"),
				projects: {},
			};
			keyPromise = Promise.resolve(key);
			return { vault, key };
		}
		return { vault, key: await unlock(vault) };
	}

	async function deriveKey(challenge: Buffer, salt: Buffer): Promise<Buffer> {
		const raw = await keyProvider.rawKey(challenge);
		return Buffer.from(crypto.hkdfSync("sha256", raw, salt, "pi-secret vault v1", 32));
	}

	function unlock(vault: Vault): Promise<Buffer> {
		keyPromise ??= (async () => {
			if (vault.provider !== keyProvider.id) {
				throw new Error(`Vault was created with ${vault.provider}; this platform uses ${keyProvider.id}.`);
			}
			const key = await deriveKey(Buffer.from(vault.challenge, "base64"), Buffer.from(vault.salt, "base64"));
			try {
				decrypt(key, "check", vault.check);
			} catch {
				throw new Error("Vault key mismatch: the vault cannot be decrypted with this key.");
			}
			return key;
		})();
		keyPromise.catch(() => {
			keyPromise = undefined;
		});
		return keyPromise;
	}

	function persistentNames(project: string): string[] {
		return Object.keys(readVault()?.projects[project] ?? {});
	}

	function tierOf(project: string, name: string): Tier | undefined {
		assertName(name);
		if (ephemeral.get(project)?.has(name)) return "ephemeral";
		if (readVault()?.projects[project]?.[name]) return "persistent";
		return undefined;
	}

	function dropEphemeral(project: string, name: string): boolean {
		const map = ephemeral.get(project);
		const had = map?.delete(name) ?? false;
		if (map?.size === 0) ephemeral.delete(project);
		return had;
	}

	function dropPersistent(project: string, name: string): boolean {
		const vault = readVault();
		const entries = vault?.projects[project];
		if (!vault || !entries?.[name]) return false;
		delete entries[name];
		if (Object.keys(entries).length === 0) delete vault.projects[project];
		writeVault(vault);
		cache.delete(cacheKey(project, name));
		return true;
	}

	async function set(project: string, name: string, value: string, tier?: Tier): Promise<Tier> {
		assertName(name);
		const target = tier ?? tierOf(project, name) ?? "ephemeral";
		if (target === "persistent") {
			const { vault, key } = await loadForWrite();
			(vault.projects[project] ??= {})[name] = encrypt(key, aad(project, name), value);
			writeVault(vault);
			cache.set(cacheKey(project, name), value);
			dropEphemeral(project, name);
		} else {
			let map = ephemeral.get(project);
			if (!map) ephemeral.set(project, (map = new Map()));
			map.set(name, value);
			dropPersistent(project, name);
		}
		return target;
	}

	async function get(project: string, name: string): Promise<string> {
		assertName(name);
		const eph = ephemeral.get(project)?.get(name);
		if (eph !== undefined) return eph;
		const vault = readVault();
		const blob = vault?.projects[project]?.[name];
		if (!vault || !blob) throw notFound(name);
		const cached = cache.get(cacheKey(project, name));
		if (cached !== undefined) return cached;
		const value = decrypt(await unlock(vault), aad(project, name), blob);
		cache.set(cacheKey(project, name), value);
		return value;
	}

	return {
		list(project) {
			const out: SecretInfo[] = [
				...[...(ephemeral.get(project)?.keys() ?? [])].map(name => ({ name, tier: "ephemeral" as const })),
				...persistentNames(project).map(name => ({ name, tier: "persistent" as const })),
			];
			return out.sort((a, b) => a.name.localeCompare(b.name));
		},
		tierOf,
		get,
		set,
		delete(project, name) {
			assertName(name);
			const a = dropEphemeral(project, name);
			const b = dropPersistent(project, name);
			if (!a && !b) throw notFound(name);
		},
		async rename(project, from, to) {
			assertName(from);
			assertName(to);
			if (tierOf(project, to)) throw new Error(`Secret "${to}" already exists.`);
			const tier = tierOf(project, from);
			if (!tier) throw notFound(from);
			const value = await get(project, from);
			await set(project, to, value, tier);
			dropEphemeral(project, from);
			dropPersistent(project, from);
		},
		async setTier(project, name, tier) {
			assertName(name);
			const current = tierOf(project, name);
			if (!current) throw notFound(name);
			if (current === tier) return;
			await set(project, name, await get(project, name), tier);
		},
		knownValues() {
			const out = new Map<string, string>();
			for (const map of ephemeral.values()) for (const [name, value] of map) out.set(value, name);
			for (const [key, value] of cache) out.set(value, key.slice(key.indexOf("\0") + 1));
			return out;
		},
		clearEphemeral() {
			ephemeral.clear();
		},
	};
}
