# Persistent secrets are encrypted with a Windows Hello-derived key

Persistent secrets must survive restarts but stay unreadable to malware running as the user, so a plain Credential Manager/DPAPI entry is not enough. The vault is one AES-256-GCM file (`~/.omp/agent/pi-secret/vault.json`, AAD = project + name) whose key is HKDF-SHA256 over a Windows Hello `KeyCredential` ("pi-secret-vault") RSA signature of a stored random challenge, obtained through `powershell.exe` WinRT so the extension needs no native addon. macOS/Linux use the same file with a random key in the OS keyring (`Bun.secrets`), since biometric gating there needs native code.

## Consequences
- Resetting Windows Hello or deleting the "pi-secret-vault" key makes every persistent secret unrecoverable.
- The derived key stays in process memory after the first unlock (one Hello prompt per omp process).
- `Bun.secrets` has no list operation, so names live unencrypted in the vault file; only values are secret.
- Verified on this machine: the RSA signature of a fixed challenge is deterministic (two signings gave identical 256-byte output), so no fallback gate was needed.
