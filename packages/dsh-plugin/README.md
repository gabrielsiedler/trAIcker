# @traicker/dsh-plugin

DeepSeek Harness plugin for [trAIcker](https://github.com/gabrielsiedler/trAIcker) —
passive time tracking for AI-agent orchestration.

## What it does

Captures DeepSeek Harness session activity into trAIcker's NDJSON spool, so the
same `traicker report`, dashboard, and timesheet pipeline works for DSH sessions
the same way it works for Claude Code sessions.

**Token cost is exact.** Unlike Claude Code (where trAIcker parses session
transcripts to approximate usage), the DSH publishes real `inputTokens`,
`outputTokens`, `cacheReadTokens` and `cacheWriteTokens` on every
`assistant/message` event. The plugin writes them directly to `model_usage`.

## Install

```bash
# 1. Install the plugin
npm install -g @traicker/dsh-plugin

# 2. Add it to your DSH profile
dsh plugin --profile web add @traicker/dsh-plugin

# 3. (optional) Verify
dsh --profile web --dump-config | grep traicker
```

## Configure

The plugin reads trAIcker's config automatically. If you need to override:

```yaml
# In your DSH profile's cordis.patch.yml
- insert:
    - id: traicker
      name: '@traicker/dsh-plugin'
      config:
        spoolDir: /home/user/.traicker/spool
        dbPath: /home/user/.traicker/time.db
        promptExcerptChars: 80
```

## Events captured

| DSH event | trAIcker event | Source |
|---|---|---|
| `user/message` (direct prompt) | `UserPromptSubmit` | prompt length + excerpt |
| `assistant/message` with `usage` | `model_usage` | exact token cost |
| `hook/result` → `UserPromptSubmit` | `UserPromptSubmit` | fallback |
| `hook/result` → `PostToolUse` + `Task` | `PostToolUse` | subagent run with duration |
| `hook/result` → `Stop` | `Stop` | turn stop |
| `turn/start` (first turn) | `SessionStart` | session opened |
| `turn/end` | `SessionEnd` | session/cycle closed |
| `session/created` | `SessionStart` | session created |

## Build from source

```bash
cd /path/to/traicker
npm run build:dsh-plugin
cd packages/dsh-plugin
npm link
```