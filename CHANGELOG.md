# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-02

### Added

- `ask_secret` tool: prompts the user with a masked input (TUI mode only; other modes refuse instead of falling back to an unmasked prompt), stores the value verbatim in `<os.tmpdir()>/omp-ask-secret/<name>` and returns only that file's absolute path, so the secret never enters the model context. An existing secret with the same name is silently overwritten.
- Companion tools `get_secret_path`, `secret_length` (Unicode code points), `secret_size` (UTF-8 bytes), `secret_hash` (`sha256` default, `sha512`, `sha1`, `md5`), `delete_secret` and `list_secrets`, all keyed by `name` (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, Windows reserved device names rejected).
- `tool_call` guard: `read`, `grep`, `glob`, `find`, `edit`, `write`, `ast_grep` and `ast_edit` calls that touch the secret store (or, for `grep`/`find`, an ancestor directory, compared on real paths so Windows 8.3 short names and symlinks match) are blocked. `bash` and `eval` are intentionally not guarded so the path can be passed to commands.
- Secrets created by a session are deleted on `session_shutdown`; secrets left by crashed sessions remain until deleted.
- Release pipeline: `ci.yml` (frozen install, typecheck, tests) and `publish.yml` (GitHub Release → tag/version check → typecheck + tests → publish `@frapetti-dev/pi-secret` to GitHub Packages).
