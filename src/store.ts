import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SECRET_DIR_NAME = "omp-ask-secret";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function secretDir(): string {
	return path.join(os.tmpdir(), SECRET_DIR_NAME);
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

export function secretPath(name: string): string {
	const error = validateName(name);
	if (error) throw new Error(error);
	return path.join(secretDir(), name);
}

function notFound(name: string): Error {
	return new Error(`Secret "${name}" not found. Call ask_secret first.`);
}

function isEnoent(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function writeSecret(name: string, value: string): string {
	const file = secretPath(name);
	const dir = secretDir();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
	fs.writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
	if (process.platform !== "win32") fs.chmodSync(file, 0o600);
	return file;
}

export function readSecret(name: string): Buffer {
	try {
		return fs.readFileSync(secretPath(name));
	} catch (err) {
		if (isEnoent(err)) throw notFound(name);
		throw err;
	}
}

export function deleteSecret(name: string): void {
	try {
		fs.unlinkSync(secretPath(name));
	} catch (err) {
		if (isEnoent(err)) throw notFound(name);
		throw err;
	}
}

export function secretExists(name: string): boolean {
	return fs.existsSync(secretPath(name));
}

export function listSecrets(): string[] {
	const dir = secretDir();
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter(entry => entry.isFile() && validateName(entry.name) === undefined)
		.map(entry => entry.name)
		.sort((a, b) => a.localeCompare(b));
}

export type HashAlgorithm = "sha256" | "sha512" | "sha1" | "md5";

/** Length in Unicode code points. */
export function secretLength(buf: Buffer): number {
	return Array.from(buf.toString("utf8")).length;
}

export function secretHash(buf: Buffer, algorithm: HashAlgorithm = "sha256"): string {
	return crypto.createHash(algorithm).update(buf).digest("hex");
}
