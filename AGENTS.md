# Repository Guidelines

## Project Overview
`pi-secret` is an omp (oh-my-pi) extension that lets the user hand a secret to the agent **without the value entering the model context**. `ask_secret` shows a masked prompt, writes the value to `<os.tmpdir()>/omp-ask-secret/<name>` and returns only that file's absolute path. Companion tools validate the secret without disclosing it. See `README.md` for the user-facing tool table.

## Architecture & Data Flow
Layered, bottom-up; each layer only depends on the ones above it in this list:

1. `src/store.ts`: pure filesystem layer (name validation, write/read/delete/list, length/hash helpers). **No `@oh-my-pi/*` imports**, so `bun test` runs standalone. Keep it that way.
2. `src/guard.ts`: `touchesSecretStore(toolName, input, cwd)` decides whether a built-in tool call touches the store. Also host-agnostic.
3. `src/secret-prompt.ts`: `createSecretPrompt(theme, title, description, onSubmit, onCancel)` returns a masked `TextFormField`.
4. `src/index.ts`: extension factory `piSecret(pi)`: registers 7 tools, the `tool_call` guard hook and the `session_shutdown` cleanup hook.

Flow: `ask_secret` → `ctx.ui.custom(...)` masked prompt → `writeSecret` → result text is **exactly the path** (usable verbatim). Other tools take `name`, validate it, then read/hash/stat the file. A `tool_call` handler blocks `read|grep|glob|find|edit|write|ast_grep|ast_edit` calls that touch the store (JSON-stringified input contains `omp-ask-secret`, or for `grep`/`find` the `path` is an ancestor of the store). `bash`/`eval` are deliberately **not** guarded so the agent can pass the path to commands.

### Patterns to preserve
- **Per-session state in the factory closure**: `const created = new Set<string>()` lives inside `piSecret`, not at module scope (module globals are shared with subagents). `session_shutdown` deletes only secrets in `created`; secrets from crashed sessions remain.
- **Never leak the value**: the secret must not appear in any tool `content`, `details`, log or notify. Only paths, lengths, sizes and hashes leave the process.
- **Error path**: tools return `fail(text)` (`{ content, isError: true }`); `guarded(name, fn)` validates `name` via `validateName` first and converts store errors (`Secret "x" not found. Call ask_secret first.`) into `fail`. Add new per-secret tools through `guarded`.
- **TUI only**: `ask_secret` refuses when `ctx.mode !== "tui"` (no unmasked fallback). Dialog rejection/abort and `undefined` both report "was cancelled".
- **pi-tui duplicate-instance pitfall**: the extension loads its own copy of `@oh-my-pi/pi-tui`, whose global theme/keybinding singletons are never initialised. Importing `@oh-my-pi/pi-tui/chrome/*` (`OverlayPanel`, `formTheme`, ...) crashes with `undefined is not an object (evaluating 'theme.fg')`. Use only root exports (`TextFormField`) and style from the host `theme` argument passed to the `ctx.ui.custom` factory.
- **Windows paths**: `os.tmpdir()` can return an 8.3 short path (`C:\Users\F2C91~1.RAP\...`). `guard.ts` compares via `fs.realpathSync.native` (`canon`), lowercased on win32; the marker check normalises `\\` to `/`.

## Key Directories
- `src/`: extension source (4 files above).
- `test/`: `bun:test` unit tests for `store` and `guard` only.
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
- Tool names are `snake_case`; `approval: "read"` for inspection tools, `"write"` for `ask_secret`/`delete_secret`. Tools use the default `loadMode` (discoverable: the agent reads `xd://<tool>` before first use); set `loadMode: "essential"` only if always-on is wanted.
- Secret names: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, not a Windows reserved device name (`validateName`). `secretPath` throws on invalid names, which is what prevents path traversal: always go through it.
- Semantics: length = Unicode code points, size = UTF-8 bytes on disk, hash algorithms `sha256 | sha512 | sha1 | md5`. Value is stored verbatim, no trailing newline; same-name writes silently overwrite.
- Prefer inlining one-expression helpers; extract only when reused (3+ call sites) or a stable domain concept.

## Important Files
- `package.json`: `omp.extensions: ["./src/index.ts"]` is what omp loads; `files` whitelist (`src`, `README.md`, `LICENSE`) controls what is published; the package has no runtime dependencies (`@oh-my-pi/*` is resolved by the host at runtime and only present as a dev dependency for types).
- `src/index.ts`: tool registration and hooks.
- `src/store.ts`: `SECRET_DIR_NAME`, `secretDir()`, all fs operations.
- `src/guard.ts`: `GUARDED_TOOLS`, `RECURSIVE_READERS`.
- `README.md`: user docs; update its tool table and protection section when tools or guard rules change.

## Runtime/Tooling Preferences
- Bun is the package manager and test runner (`bun.lock` committed); TypeScript is used only for typechecking (`tsconfig.json`); Node 22 is used only in `publish.yml` for `npm publish`.
- Target OS is Windows (git-bash shell), so keep win32 and POSIX behaviour both correct (`chmod` only on non-win32).
- Extensions run inside the omp host; imports of `@oh-my-pi/*` only resolve there. A standalone `bun run` of a file importing pi-tui fails (native addon not found), so keep testable logic in `store.ts`/`guard.ts`.
- With the pi-verdict auto-mode classifier, new tool names must be added to `tools` in `~/.omp/agent/config/pi-verdict.json` or calls go through the classifier. The user owns that file; do not edit it unprompted.

## Release
- Published as `@frapetti-dev/pi-secret` to GitHub Packages (`https://npm.pkg.github.com`).
- Sequence: move `CHANGELOG.md` `## [Unreleased]` entries under `## [X.Y.Z] - date`, bump `package.json` `version` (keep `bun.lock` in sync), commit `chore(release): bump version to X.Y.Z`, create annotated tag `vX.Y.Z`, push commit and tag, then `gh release create vX.Y.Z --notes ...`.
- Publishing is automated: Release published → `publish.yml` requires the tag to equal `v` + `package.json` version and HEAD to be the tag commit, runs typecheck + tests, then `npm publish` with `GITHUB_TOKEN`.
- `ci.yml` runs frozen install, typecheck and tests on pushes to `main` and on PRs.
- User-visible changes go in `CHANGELOG.md` under `## [Unreleased]` (Keep a Changelog sections Added/Changed/Removed/Fixed).

## Testing & QA
- Framework: `bun:test` (`test/store.test.ts`, `test/guard.test.ts`).
- Isolation: `beforeEach` creates `fs.mkdtempSync(...)` and sets `process.env.TMP/TEMP/TMPDIR` to it so `os.tmpdir()` (and thus `secretDir()`) is private; `afterEach` restores env and removes the dir. Reuse this pattern for any test touching the store; never write into the real store.
- Not unit-tested: `src/index.ts` and `src/secret-prompt.ts` (need the omp host/TUI). Verify them manually:
  1. Print mode: `ask_secret` must return "needs the interactive TUI"; with a dummy file `<tmpdir>/omp-ask-secret/demo` containing `hunter22`, `list_secrets`/`secret_length`/`secret_size`/`secret_hash` work and a `read` of the path is "Blocked by pi-secret". The output must never contain the value.
  2. TUI (`omp -e .`): masked prompt shows bullets, empty Enter shows "A secret is required.", Esc cancels, submit returns the path, `delete_secret` removes it, exiting omp removes remaining session secrets.
- Use dummy values only; delete test secrets afterwards.
