# Billing: caps, timesheets and descriptions

## Weekly arrangements

```bash
traicker week      # progress against every project's commitment
```

A project can declare weekly hours whether or not it produces a timesheet:

```json
"commitment": { "weeklyHours": 10, "kind": "cap" }      // ceiling: don't exceed
"commitment": { "weeklyHours": 20, "kind": "target" }   // commitment: should meet
```

The two are opposite obligations, so they don't share a field. A cap is breached
from above and gets flagged right away. A target is breached from below and is
only judged once the week is basically over. Being at 4 of 20 hours on a Tuesday
isn't a problem, and flagging it would train you to ignore the indicator.

## Timesheets

```bash
traicker timesheet --project acme            # current week
traicker timesheet --project acme --month
traicker timesheet --project acme --csv
```

One line per day: date, rounded hours, and a continuous-text description built
from Claude Code's own session titles, which is the format an hourly client's
form expects. Weeks are grouped and shown against the contractual cap.

The dashboard has the same thing as a panel, with week navigation and per-row
copy buttons. The client's form is already open in another tab, and copying out
of a terminal into a web form is the friction that makes a tracker stop getting
used. The panel only shows up for projects that have billing rules.

The cap is **reported, never enforced**. Going over gets flagged, and the hours
you actually worked are not quietly trimmed to fit a contract.

Billing rules live per project under `projects["<path>"].billing`. Only projects
with a `billing` block appear in the dashboard's timesheet panel. The CLI will
still build one if you ask for it explicitly, using safe defaults.

The range defaults to the current **calendar** week, not a rolling seven days. A
weekly cap is contractual, and a window that straddles two weeks would match
neither.

## Where a description comes from

Four layers, highest first:

1. **Your own note**, from `traicker note --project X --day D --text "..."`. A
   timesheet line is prose a client reads, so you get the last word. `--clear`
   removes it, and the generated text is kept underneath either way.
2. **A rewritten day**, from `traicker summarize --project X --day D`, or the
   **refresh** button on that row in the dashboard.
3. **A cached translation.** Labels come out in whatever language the work
   happened in, which is a problem when the client bills in another one. Set
   `billing.translateTo: "English"` and run `traicker translate --project X`.
4. **The generated text**: task subjects and session titles, joined.

## Why refresh exists

The generated text joins session titles, and Claude Code names a session
**once**, from its opening minutes. A day spent on eight tasks inside one long
session reports the name of the first one. The line isn't wrong, it's just the
beginning of the day standing in for all of it.

Refresh asks a model to read the day instead: the session titles plus every
prompt excerpt from that day, in the order they were typed. **The excerpts are
sent to the API.** They never reach the client, only the sentence written from
them does. The model is told to keep names, addresses, paths and URLs out of the
output, but that's an instruction, not a guarantee, so read the line before you
submit it. Set `promptExcerptChars: 0` if you'd rather no prompt text be stored,
and therefore none be sent. Refresh then falls back to titles alone.

**Nothing here runs during a report.** Translation and refresh are both explicit
actions, and both are stored. A billing line must not reword itself between the
day you read it and the day you submit it, and showing you a number shouldn't
depend on the network. If a call fails (no key, a rate limit, an outage) the
existing line stands and the hours are unaffected.

Model calls go to **OpenRouter**. Put the key in `~/.traicker/.env`:

```
OPENROUTER_API_KEY=sk-or-v1-...
```

The CLI and the dashboard server read it, the hook never does. A real
environment variable overrides the file, so `OPENROUTER_API_KEY=... traicker
translate` works for one run without editing anything. `traicker status` tells
you whether a key was found and where it came from, showing only its last four
characters.

The file lives next to `config.json` instead of in the repository. trAIcker is
installed once and run from wherever you happen to be, so a `.env.local` beside
the source would only be found when you were standing in it. **It holds a
secret.** Keep it out of any repository, and out of backups you wouldn't trust
with a payment credential. Get a key at <https://openrouter.ai/keys>.

`translationModel` takes an OpenRouter slug (provider-prefixed) that supports
[structured outputs](https://openrouter.ai/models?supported_parameters=structured_outputs).
The request pins `require_parameters`, so it's never routed to a provider that
would ignore the schema and answer in prose. The default,
`deepseek/deepseek-v4-flash-0731`, costs about $0.08 per million input tokens.
`anthropic/claude-opus-5` is roughly 60× that. `llmBaseUrl` moves the endpoint,
but change the key with it, since the two travel together.
