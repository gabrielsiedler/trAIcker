# What gets measured, and how

Focus, agent and occupancy are defined in the
[README](../README.md#why-this-way), and the argument for keeping them apart is
in [Why this way](why.md). This page is what sits underneath them: how a span
ends when nothing announced it, what a hand-logged entry overrides, where a
label comes from, and how a directory becomes a project.

## A span that has not closed yet

An open span is bounded by evidence that the session is still alive, and the two
kinds of span read different evidence on purpose.

- A **main turn** is bounded by the transcript file going quiet. The assistant
  streams into it while it thinks, so silence there really does mean the turn
  ended.
- A **subagent** is bounded by `maxSubagentMinutes` and nothing else. While one
  works, Claude Code writes nothing to the session transcript. The file goes
  quiet *because* an agent is busy. Using that as liveness cut a live
  fifteen-minute agent off two minutes in, and the project read as idle while it
  was the only one working.

An agent that was sent and never stopped is treated as running. The estimate
fixes itself: aggregation rebuilds spans from events on every sync, so the real
duration replaces it as soon as the stop arrives. A session killed mid-agent
holds the span open to the ceiling. Those are marked `open` instead of
`max_span`, so `traicker timeline` can tell an estimate from an observation.

**Descriptions never contain raw prompt text.** Labels come from declared task
subjects or from Claude Code's own `ai-title`. When neither exists, the day
falls back to a neutral "Development and review." instead of pasting something
you typed to an agent onto a client's invoice. Set `billing.allowExcerpts: true`
to opt out of that protection.

## Work off the tools

Meetings, research, a call: anything that emits no events can't be captured
passively, by definition. That's the one place manual input is unavoidable, and
it doesn't weaken the zero-toggle rule. There's still no timer to start or stop
for agent work.

```bash
traicker add --project acme --from 14:00 --to 14:30 --kind meeting --note "sprint planning"
traicker add --project northwind --at 9am --for 45m --kind research
traicker entries --week
traicker rm 3
```

Times accept `14:00`, `1400` or `2pm`. Durations accept `30m`, `1h`, `1h30m`.
Kinds: `meeting`, `research`, `review`, `admin`, `other`.

### What an entry displaces

A hand-logged entry is you, present, on one thing. It overrides what the hooks
recorded, with two different rules.

- **Focus is cut on every project.** Attention is exclusive. If you were in a
  call at 14:10 you were not orchestrating anything else, whatever the prompt
  gaps imply.
- **Agent time is cut only on the entry's own project.** Billing a meeting *and*
  that project's occupancy for the same half hour would charge it twice. But
  four agents building another client's API during your call did real work, and
  erasing that would be a worse distortion than the one you're avoiding.

Overlapping entries are rejected, since you can't be in two meetings at once, so
an overlap is almost always a typo. Pass `--force` when it really isn't.

Entries live in their own table, never in `events`. That table is an append-only
record of what the hooks saw, and aggregation rebuilds from it verbatim. Mixing
authored, editable rows into it would make "reprocess the history" ambiguous.
Deleting an entry restores exactly what it displaced.

## What you were working on

Labels resolve in this order, and the order is the whole design.

1. **`manual`**: the note on a hand-logged entry. You wrote it, so it's safe to
   show a client.
2. **`task`**: the subject of a task open at that moment, from the
   `TaskCreated` and `TaskCompleted` hooks. The only automatic source with
   sub-session granularity, because it's the only one with real boundaries.
3. **`session_title`**: Claude Code's generated `ai-title`, read from the
   transcript. Clean prose, but written once per session and never revised. A
   four-hour session that moved through three jobs reports as one topic.
4. **`prompt_excerpt`**: a truncated slice of what you typed. Finest
   granularity, worst prose, and blocked from client timesheets.

Session title beats the excerpt on purpose. Labelling topics per prompt turns
twenty prompts into twenty "topics", which is a prompt log, not a picture of the
day. If you switch jobs inside one session and want that reflected, **use the
task list**. That's what makes the boundary visible.

```bash
traicker topics --week            # grouped by task or session title
traicker topics --today --detail  # one row per prompt, finest view
```

## Projects

A project is resolved from the working directory of each event, in this order:

1. **Declared roots**: any path with a `projects` entry in config. The longest
   match wins, and subdirectories roll up into it.
2. **Marker detection**: the nearest ancestor holding `.git`, `.claude`,
   `package.json`, `go.mod`, `Cargo.toml` or `pyproject.toml`.
3. The directory itself.

Declaring beats detection because detection alone misattributes work. A client
directory with no marker of its own, sitting inside a workspace that has one,
bills to the workspace. The walk also stops at your home directory, since
`~/.claude` exists on every install, and without that guard every unmarked
project would collapse into one named after you.

A declared path that **contains other declared paths is a workspace**, not a
project. Declaring `C:/dev` alongside `C:/dev/acme` doesn't make everything
under `C:/dev` bill to `dev`. The workspace resolves only for work done directly
in it, and what sits inside it is a project in its own right, declared or not,
marker or not.

`ignorePaths` matches a path and everything below it, **except declared projects
and the contents of a declared workspace**. That's what makes
`"ignorePaths": ["C:/dev"]` safe: bare sessions started in the workspace stop
becoming a project, while everything inside it keeps tracking. To drop a whole
tree instead, ignore a path you haven't declared as a workspace.

After adding or changing a project in config:

```bash
traicker reproject      # re-attributes history, then rebuilds
```

Project id is the one derived value stored on the event log, so config changes
don't otherwise reach work that was already recorded.

## Idle, and why it is capped

`idleAttributionCapMinutes` (default 120) bounds how much of a single gap can be
reported as idle. Without it, the hours between Monday evening and Tuesday
morning get recorded as "idle" and swamp the interruptions the number exists to
show.
