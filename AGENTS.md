# Repository Guidelines

## Project Overview
`pi-secret` is an omp (oh-my-pi) extension that lets the user hand a secret to the agent **without the value entering the model context**. Secrets live in a Project-scoped store with two Tiers: **ephemeral** (module-scope memory, shared with subagents, cleared on main `session_shutdown`) and **persistent** (AES-256-GCM vault at `~/.omp/agent/pi-secret/vault.json`, key derived per ADR-0001). The agent uses values only through `bash` Bindings; Redaction runs on `tool_result` and `context` (ADR-0002). See `GLOSSARY.md` for terms, `docs/adr/` for decisions and `README.md` for the user-facing tool table.

## Architecture & Data Flow
Layered, bottom-up; each layer only depends on the ones above it in this list.

Host-agnostic, bun-tested (**no `@oh-my-pi/*` imports**, so `bun test` runs standalone; keep it that way):
1. `src/store.ts`: tiers, vault, `validateName`, `secretLength`/`secretHash`, `knownValues`.
2. `src/keys.ts`: `KeyProvider` (`windowsHello`, `keyring`).
3. `src/project.ts`: `projectKey`.
4. `src/binding.ts`: `createBinder` (`bind`, `release`, `releaseAll`); validates Bindings, resolves values, writes temp files, owns their removal.
5. `src/import.ts`: `readSource`, `extractValue`.
6. `src/redact.ts`: `createRedactor`, `redactDeep`.

Host-only (need the omp host/TUI):
- `src/ui/nodes.ts` (TSP helpers), `src/ui/secret-prompt.ts` (`createSecretPrompt`, `askSecrets`), `src/ui/reveal.ts` (`showSecrets`), `src/ui/manager.ts` (`pickSecret`).
- `src/index.ts`: extension factory `piSecret(pi)`. Registers 9 tools (`ask_secret`, `list_secrets`, `secret_length`, `secret_size`, `secret_hash`, `delete_secret`, `show_secrets`, `import_secret`, `bash`), the `/secrets` command, the `pi-verdict:collect` contribution and the `tool_result` / `context` / `session_shutdown` hooks.

Flow: `ask_secret` / `import_secret` / `/secrets` → `store.set`. The agent then calls `bash` with `secrets` / `secret_files` → `binder.bind` resolves values from the store and wraps the command in a subshell → native bash runs it → `binder.release` removes temp files. Output and context pass through Redaction, which replaces known values with `[secret:<name>]`.

### Patterns to preserve
- **Module-scope `store` and `binder` on purpose**: shared with subagents (one per omp process). Only main-agent `session_shutdown` clears ephemeral secrets and calls `binder.releaseAll()`.
- **Never leak the value**: it must not appear in any tool `content`, `details`, log or notify. Only names, tiers, lengths, sizes and hashes leave the process (except the Binding into the command, which Redaction covers).
- **Error path**: tools return `fail(text)` (`{ content, isError: true }`); `guarded(name, fn)` validates `name` via `validateName` first and converts store errors (`Secret "x" not found.`) into `fail`. Add new per-secret tools through `guarded`.
- **TUI only**: `ask_secret`, `show_secrets` and `/secrets` refuse when `ctx.mode !== "tui"` (no unmasked fallback).
- **Approval**: `import_secret` escalates to `exec` for `command` sources and for `http` with `secret_headers`.
- **Bindings** need a POSIX shell (checked in the `bash` tool, because it needs host-only `pi-utils`). Temp dirs go through `Binder.release` / `releaseAll`; `bind` throws after removing anything it created.
- **pi-tui duplicate-instance pitfall**: the extension loads its own copy of `@oh-my-pi/pi-tui`, whose global theme/keybinding singletons are never initialised. Importing `@oh-my-pi/pi-tui/chrome/*` (`OverlayPanel`, `formTheme`, ...) crashes with `undefined is not an object (evaluating 'theme.fg')`. Use only root exports (`TextFormField`) and style from the host `theme` argument passed to the `ctx.ui.custom` factory.
- **Windows paths**: `projectKey` uses `fs.realpathSync.native`, lowercased on win32, so 8.3 short paths and case do not split a Project.

## Key Directories
- `src/`: extension source (modules above); `src/ui/`: host-only TUI.
- `test/`: `bun:test` unit tests for the host-agnostic modules.
- `docs/adr/`: architecture decision records.
- `.github/workflows/`: `ci.yml` (verify) and `publish.yml` (release publish).

## Development Commands
```bash
bun install                                # dev deps (types only; `bun.lock` is committed)
bun run typecheck                          # tsc --noEmit over src/ and test/
bun test                                   # unit tests
omp -e C:/Users/f.rapetti/git/pi-secret    # run omp with the extension (TUI)
omp -e . -p "Call list_secrets and report the tool result verbatim."   # print-mode smoke
```
There is no build, lint or format step.

## Code Conventions
- TypeScript ES modules (`"type": "module"`), tab indentation, double quotes, semicolons, `node:` prefixed imports (`import * as fs from "node:fs"`).
- Import types from `@oh-my-pi/pi-coding-agent` with `import type` (erased by Bun). Use `pi.zod` (not a `zod` import) for tool schemas.
- Tool names are `snake_case`. Tools use the default `loadMode` (discoverable: the agent reads `xd://<tool>` before first use); set `loadMode: "essential"` only if always-on is wanted.
- Secret names: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, not a Windows reserved device name (`validateName`). Always validate through it.
- Semantics: length = Unicode code points, size = UTF-8 bytes, hash algorithms `sha256 | sha512 | sha1 | md5`; same-name writes overwrite.
- Prefer inlining one-expression helpers; extract only when reused (3+ call sites) or a stable domain concept.

## Important Files
- `package.json`: `omp.extensions: ["./src/index.ts"]` is what omp loads; `files` whitelist controls what is published; no runtime dependencies (`@oh-my-pi/*`, including `pi-utils` and `pi-wire`, is resolved by the host at runtime and only present as a dev dependency for types).
- `src/index.ts`: tool registration and hooks.
- `src/store.ts`: tiers, vault and name validation.
- `src/binding.ts`: Bindings and temp-file lifecycle.
- `GLOSSARY.md`, `docs/adr/`: vocabulary and decisions.
- `README.md`: user docs; update its tool table when tools change.

## Runtime/Tooling Preferences
- Bun is the package manager and test runner (`bun.lock` committed); TypeScript is used only for typechecking (`tsconfig.json`); Node 22 is used only in `publish.yml` for `npm publish`.
- Target OS is Windows (git-bash shell), so keep win32 and POSIX behaviour both correct (`chmod` only on non-win32).
- Extensions run inside the omp host; imports of `@oh-my-pi/*` only resolve there. A standalone `bun run` of a file importing pi-tui fails (native addon not found), so keep testable logic in the host-agnostic modules.
- pi-verdict: `index.ts` contributes the read-only tools on `pi-verdict:collect`; `bash` and `import_secret` stay gated. Do not edit `~/.omp/agent/config/pi-verdict.json`.

## Release
- Published as `@frapetti-dev/pi-secret` to GitHub Packages (`https://npm.pkg.github.com`).
- Sequence: move `CHANGELOG.md` `## [Unreleased]` entries under `## [X.Y.Z] - date`, bump `package.json` `version` (keep `bun.lock` in sync), commit `chore(release): bump version to X.Y.Z`, create annotated tag `vX.Y.Z`, push commit and tag, then `gh release create vX.Y.Z --notes ...`.
- Publishing is automated: Release published → `publish.yml` requires the tag to equal `v` + `package.json` version and HEAD to be the tag commit, runs typecheck + tests, then `npm publish` with `GITHUB_TOKEN`.
- `ci.yml` runs frozen install, typecheck and tests on pushes to `main` and on PRs.
- User-visible changes go in `CHANGELOG.md` under `## [Unreleased]` (Keep a Changelog sections Added/Changed/Removed/Fixed).

## Testing & QA
- Framework: `bun:test` (`test/store`, `binding`, `import`, `project`, `redact` `.test.ts`) plus `test/helpers.ts` (`useTmp`, `findBash`; command tests skip without Git bash on Windows).
- Isolation: `useTmp()` points `TMP/TEMP/TMPDIR` at a private dir so `os.tmpdir()` is private; never write into the real tmp or vault. Store tests pass `vaultPath` inside the tmp dir and use a fake `KeyProvider`.
- Not unit-tested: `src/index.ts` and `src/ui/*` (need the omp host/TUI). Verify manually, with dummy values only:
  1. Print mode: `ask_secret` returns "needs the interactive TUI".
  2. `import_secret` with an env source, then `bash` with `secrets` / `secret_files`: output shows `[secret:<name>]`, never the value.
  3. TUI (`omp -e .`): masked prompt with bullets, Tab flips the tier, Esc cancels, `/secrets` manager actions work, `show_secrets` overlay works.
