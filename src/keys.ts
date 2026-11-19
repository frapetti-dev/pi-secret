import * as crypto from "node:crypto";

export interface KeyProvider {
	readonly id: "windows-hello" | "keyring";
	rawKey(challenge: Buffer): Promise<Buffer>;
}

export const HELLO_PS = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Security.Credentials.KeyCredentialManager,Windows.Security.Credentials,ContentType=WindowsRuntime]
$null=[Windows.Security.Cryptography.CryptographicBuffer,Windows.Security.Cryptography,ContentType=WindowsRuntime]
$asTask=[System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'}|select -First 1
function Await($op,[Type]$t){ $task=$asTask.MakeGenericMethod($t).Invoke($null,@($op)); $task.Wait(); $task.Result }
$KCM=[Windows.Security.Credentials.KeyCredentialManager]
$RR=[Windows.Security.Credentials.KeyCredentialRetrievalResult]
$r=Await ($KCM::OpenAsync('pi-secret-vault')) $RR
if($r.Status -eq 'NotFound'){ $r=Await ($KCM::RequestCreateAsync('pi-secret-vault',[Windows.Security.Credentials.KeyCredentialCreationOption]::FailIfExists)) $RR }
if($r.Status -ne 'Success'){ [Console]::Out.Write('ERR:'+$r.Status); exit 2 }
$buf=[System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer([Convert]::FromBase64String($env:PI_SECRET_CHALLENGE))
$s=Await ($r.Credential.RequestSignAsync($buf)) ([Windows.Security.Credentials.KeyCredentialOperationResult])
if($s.Status -ne 'Success'){ [Console]::Out.Write('ERR:'+$s.Status); exit 2 }
$enc=[Windows.Security.Cryptography.CryptographicBuffer].GetMethod('EncodeToBase64String').Invoke($null,@($s.Result))
[Console]::Out.Write('OK:'+$enc)
`;

const KEYRING_ID = { service: "pi-secret", name: "vault-key" };

export const windowsHello: KeyProvider = {
	id: "windows-hello",
	async rawKey(challenge) {
		const encoded = Buffer.from(HELLO_PS, "utf16le").toString("base64");
		const proc = Bun.spawn(
			["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
			{
				env: { ...process.env, PI_SECRET_CHALLENGE: challenge.toString("base64") },
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		const text = out.trim();
		if (text.startsWith("OK:")) return Buffer.from(text.slice(3), "base64");
		if (text === "ERR:UserCanceled") throw new Error("Windows Hello unlock was cancelled.");
		if (text.startsWith("ERR:")) throw new Error(`Windows Hello unlock failed: ${text.slice(4)}.`);
		throw new Error(`Windows Hello is not available (powershell.exe exit code ${code}).`);
	},
};

export const keyring: KeyProvider = {
	id: "keyring",
	async rawKey() {
		try {
			const existing = await Bun.secrets.get(KEYRING_ID);
			if (existing) return Buffer.from(existing, "base64");
			const fresh = crypto.randomBytes(32);
			await Bun.secrets.set({ ...KEYRING_ID, value: fresh.toString("base64") });
			return fresh;
		} catch (err) {
			throw new Error(`OS keyring unavailable: ${err instanceof Error ? err.message : String(err)}`);
		}
	},
};

export function platformKeyProvider(): KeyProvider {
	return process.platform === "win32" ? windowsHello : keyring;
}
