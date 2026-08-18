# How it works inside

## How the data flows

<div align="center">
  <img src="images/pipeline.svg" width="880" alt="The pipeline: a Claude Code hook appends to an NDJSON spool, ingestion writes an append-only SQLite event log, spans are derived from it, and reports are read from the spans.">
</div>

The hook does one thing: append a ~200 byte line and exit. It never opens the
database, never blocks, and always exits 0.

**Why a spool and not a direct write.** With several sessions and their
subagents running at once, concurrent SQLite writers mean lock contention on the
path that gates your prompt. Appending gets around it. Files are sharded by
session id, so separate sessions never touch the same file, and `O_APPEND` makes
each write atomic for the parallel-subagent case that's left. Tested at 16
concurrent writers on one file: 400 lines written, 400 intact.

That atomicity only holds for small writes, which is why the raw hook payload is
never stored. `prompt` and `last_assistant_message` are tens of kilobytes. Only
metadata plus Claude Code's own session title is kept, so no client prompt text
ever reaches the database.

**Reprocessing is always safe.** Ingestion consumes only complete lines (up to
the last `\n`) and keeps a byte offset per file, so a file a live session is
still appending to is safe to read. Aggregation is a pure function of the event
log, rebuilt per day inside a transaction. Every event has a UNIQUE content
hash. Run any of it as many times as you like.

## Hooks used

`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`,
`SubagentStop`, `Stop`, `CwdChanged`, `TaskCreated`, `TaskCompleted`, and
`PostToolUse` matched to `Task`. Each one is registered with a 5 second timeout
(Claude Code's default is 600) and the hook kills itself after 2.

**Subagents are measured from `PostToolUse`, not from Start/Stop.**
`SubagentStart` never fires in current builds, verified at 0 events against 16
`SubagentStop`, so a pair can never be formed. Every subagent span was silently
missing, which made agent effort come out identical to agent wall-clock and
erased all parallelism from the reports. `PostToolUse` carries `duration_ms`, so
the span comes from the tool call itself and there's nothing to pair. The `Task`
matcher keeps it off the hot path: it fires once per subagent run, not once per
tool call.

**The hook filters nothing.** It records and exits, and ingestion decides what
counts. Filtering at capture time can't be undone, and an `ignorePaths` prefix
match once silently dropped an hour of a client's work before anyone noticed.

Remove them all with `uninstall-hooks`, which strips only trAIcker's entries.

### Verifying capture

```bash
traicker doctor
```

Writes a probe through the real hook binary and checks that it reached the
spool. The hook is built to fail silently so it can never wedge a session, which
also means a broken hook looks exactly like an idle afternoon. This is the
counterweight.

## The desktop shell

The Electron app doesn't talk to a separate dashboard. The Express app and the
SQLite handle live in the same process, so launching the app is the whole setup:
no `traicker serve` to remember, nothing to restart after a reboot. The window is
a view onto that server over http, exactly like a browser tab, which is why
reaching it from a phone over Tailscale keeps working. It's the same process
answering both.

The CLI is untouched and still runs standalone against the same database.
`busy_timeout` is what makes the overlap safe: a CLI `sync` that runs while the
app holds the database waits instead of failing.

Packaging is `npm run desktop:dist` (nsis on Windows, dmg on macOS, AppImage on
Linux). Two things in `electron-builder.yml` are load-bearing and easy to break,
and neither failure shows up in `npm run desktop`, which runs unpacked:
`better-sqlite3` is unpacked from the asar, because a native module can't be
dlopen'd from inside the archive, and `npmRebuild` stays on, because the
prebuilds shipped in the package are keyed to Node's ABI and Electron's is
different.

## Development

```bash
npm test                # aggregation + pipeline suites
npm run typecheck       # server and web
npm run dev:server      # backend on :4317, from source, restarts on change
npm run dev             # Vite on :4318, proxying /api to :4317
npm run dev:desktop     # the Electron shell, wired to Vite (see below)
npm run build
```

`dev:server` and `dev` are two separate processes, so run both to work on the
app. `npm run serve` runs the compiled `dist/` instead, which only picks up
changes after `npm run build`.

### Working on the desktop shell

`npm run desktop` builds and then runs, so every edit costs a rebuild and a
relaunch. `npm run dev:desktop` is the loop to use instead. It starts Vite, a
`tsc --watch`, and Electron pointed at the dev server rather than at its own
bundle, so a change under `src/web` shows up in the open window without a
reload, and a change under `src/server` or `src/desktop` relaunches the shell by
itself.

The API doesn't change. Vite proxies `/api` back to the server embedded in that
same Electron process, on whatever `serverPort` your config sets. Quit any
trAIcker already sitting in the tray first, because the single-instance lock
makes a second one exit on the spot.
