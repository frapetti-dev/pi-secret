# pi-secret

omp extension: hand secrets to the agent without their values entering the model context. See `GLOSSARY.md` for the terms used here.

Secrets belong to a **project** (git root of the cwd) and live in one of two **tiers**:

- **ephemeral** (default): memory only, shared with subagents, gone when the main session closes.
- **persistent**: encrypted in `~/.omp/agent/pi-secret/vault.json`. The key comes from Windows Hello on Windows and from the OS keyring (`Bun.secrets`) on macOS/Linux; it is unlocked at most once per omp process. If the key is unavailable, persistent operations fail (no weaker fallback). See `docs/adr/0001-windows-hello-derived-vault-key.md`.

## Use

```
omp -e C:/Users/f.rapetti/git/pi-secret
```

## Tools

| Tool | Result |
| --- | --- |
| `ask_secret(secrets: [{name, prompt?, persistent?}])` | masked prompt per secret (TUI only); Tab flips the tier; reports `stored (<tier>)` / `cancelled` per name |
| `import_secret(name, source, extract?, trim?, persistent?)` | creates a secret from a command, file, HTTP response (`secret_headers` may use other secrets) or env var; reports tier and length |
| `show_secrets(names)` | overlay with Show/Hide/Copy for the **user**; the agent never sees the values |
| `secret_length(name)` | length in Unicode code points |
| `secret_size(name)` | size in bytes (UTF-8) |
| `secret_hash(name, algorithm?)` | hex digest: `sha256` (default), `sha512`, `sha1`, `md5` |
| `delete_secret(name)` | deletes the secret from whichever tier holds it |
| `list_secrets()` | `<name>\t<tier>` for this project |
| `bash(..., secrets?, secret_files?)` | the built-in bash plus bindings: `secrets: {VAR: "name"}` exports the value, `secret_files: {VAR: "name"}` exports the path of a private temp file removed when the command ends |

`/secrets` opens a manager (native Tern picker, ANSI fallback): show, add, edit value, rename, toggle persistence, delete.

## Protection

- Secret values are replaced by `[secret:<name>]` in tool results and in everything sent to the model (`context` hook), including async and pty bash output. Redaction is exact-match; values shorter than 4 characters and deliberately encoded values are not caught. See `docs/adr/0002-wrapped-bash-and-provider-redaction.md`.
- Bindings need a POSIX shell (bash/sh/zsh), not cmd or PowerShell.
- The session file may still contain raw values from async/pty follow-ups.

## Auto-mode gates

With pi-verdict, add the tool names (including `show_secrets` and `import_secret`) to `tools` in `~/.omp/agent/config/pi-verdict.json` to skip the classifier.

## Development

`bun install`, `bun run typecheck`, `bun test`. Releases are published to GitHub Packages as `@frapetti-dev/pi-secret` by `.github/workflows/publish.yml`; see `AGENTS.md`.
