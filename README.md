# pi-secret

omp extension: hand a secret to the agent without it entering the model context.

`ask_secret` shows a masked prompt, stores the value in `<tmpdir>/omp-ask-secret/<name>` and returns only that file's absolute path.

## Use

```
omp -e C:/Users/f.rapetti/git/pi-secret
```

## Tools

| Tool | Result |
| --- | --- |
| `ask_secret(name, prompt?)` | absolute path of the secret file (TUI only; silently overwrites an existing name) |
| `get_secret_path(name)` | absolute path |
| `secret_length(name)` | length in Unicode code points |
| `secret_size(name)` | size in bytes (UTF-8) |
| `secret_hash(name, algorithm?)` | hex digest: `sha256` (default), `sha512`, `sha1`, `md5` |
| `delete_secret(name)` | deletes the file |
| `list_secrets()` | every stored secret, `<name>\t<path>` |

## Protection

- The agent's `read`, `grep`, `glob`, `find`, `edit`, `write`, `ast_grep` and `ast_edit` calls that touch the store (or, for `grep`/`find`, an ancestor directory) are blocked. `bash` is not guarded, so the path can be passed to commands.
- Secrets created by a session are deleted on session shutdown. Secrets of crashed sessions remain until deleted.

## Auto-mode gates

With pi-verdict, add the tool names to `tools` in `~/.omp/agent/config/pi-verdict.json` to skip the classifier.

## Development

`bun install`, `bun run typecheck`, `bun test`. Releases are published to GitHub Packages as `@frapetti-dev/pi-secret` by `.github/workflows/publish.yml`; see `AGENTS.md`.
