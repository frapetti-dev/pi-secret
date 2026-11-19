# The agent uses secrets through a re-registered `bash`, with redaction at the provider boundary

Rewriting tool input in the `tool_call` hook persists and displays the rewritten input, which would leak values; `pi.exec` has no env support; and the native bash tool accepts no env. So the extension re-registers `bash` with `secrets`/`secret_files` bindings, prepends `export`s in a subshell, and delegates through `ctx.invokeTool`, whose arguments are never persisted. Because `async`/`pty` output arrives outside the tool result, values are also redacted in the `context` event (everything sent to the model) and in `tool_result` (what is stored and shown).

## Consequences
- The bash card loses omp's built-in renderer (the host only uses it for unshadowed built-ins).
- Redaction is exact-match only: a deliberately encoded value (base64, split) is not caught; values under 4 characters are not redacted.
- The session file can still contain raw values from async/pty follow-ups; only the model view is guaranteed clean.
