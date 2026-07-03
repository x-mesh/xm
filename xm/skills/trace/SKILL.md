---
name: trace
description: Agent execution tracing — timeline, token/cost tracking, replay, and diff for multi-agent observability
model: opus
---

<Purpose>
x-trace tracks xm tool executions across two artifacts:
- **Per-session traces** in `.xm/traces/*.jsonl` — agent call trees, estimated tokens, cost, elapsed time, and a git snapshot per session. These power the timeline / cost / replay / diff views, which the LLM renders by parsing JSONL.
- **A cross-tool activity ledger** in `.xm/last.json` — which tool last ran, on which commit, and how far HEAD has moved since. This is maintained by the `x-trace` CLI (`record` / `last` / `status` / `since` / `doctor`), not by LLM parsing.
No external dependencies.
</Purpose>

<Use_When>
- User wants to trace or observe multi-agent execution
- User says "trace", "execution log", "check cost", "token usage", "show timeline"
- User wants to compare two runs ("diff", "compare before and after")
- User wants to replay a previous execution ("replay", "reproduce")
- Other xm skills want to record agent calls for observability
</Use_When>

<Do_Not_Use_When>
- Simple single-step tasks with no agent fan-out
- Cost tracking for non-xm workflows
- Real-time monitoring (x-trace is post-hoc, not live)
</Do_Not_Use_When>

# x-trace — Agent Execution Tracing

## Model Routing

| Subcommand | Model | Reason |
|------------|-------|--------|
| `show`, `list`, `cost`, `diff` | **haiku** (Agent tool) | Read-only log parsing and display |
| `record`, `last`, `status`, `since`, `doctor` | **haiku** (Agent tool) | Deterministic CLI output — script decides, model relays |
| `replay` | **sonnet** | Requires agent re-execution |

For haiku-eligible commands, delegate via: `Agent tool: { model: "sonnet", prompt: "Run: [command]" }` <!-- managed-model: explorer -->

Two command families:
- **LLM-rendered views** (`show` / `cost` / `diff` / `list` / `start` / `stop` / `clean`) — the LLM reads `.xm/traces/*.jsonl` with the Bash/Read tools and renders the output described in each subcommand file.
- **CLI-backed ledger ops** (`record` / `last` / `status` / `since` / `doctor`) — run `x-trace-cli.mjs` through the `xm` dispatcher; the LLM only relays what the script prints. See [Activity Ledger (CLI)](#activity-ledger-cli).

No external dependencies. Works as long as the `.xm/` directory exists.

## Mode Detection

Read mode from `.xm/config.json` (`mode` field). Default: `developer`.

**Developer mode**: Use technical terms (trace, timeline, token, replay, diff, JSONL). Concise.

**Normal mode**: Use plain Korean for guidance.
- "trace" → "실행 기록", "timeline" → "시간순 보기", "token" → "토큰", "replay" → "다시 보기"
- "diff" → "비교", "cost" → "비용"
- Use "~하세요" sentence style; lead with the most important information first

### Korean output style (avoid AI-slop)

Universal (both modes) — these read as machine-generated in any register:
- Drop empty intensifiers ("매우 / 완벽하게 / 강력한 / 원활하게 / 혁신적인") unless they carry a specific, real claim.
- No forced rule-of-three or "~뿐만 아니라 ~까지" balance that adds no fact.
- No hedged non-conclusions ("결국 상황에 따라 다르다 / 균형이 필요하다"). End on a concrete fact, number, or next action.

Developer mode: terse and direct — lead with the result; state findings/actions without a 권고형 결말 pile-up ("~해야 한다" sentence after sentence).
Easy/normal mode: accessible Korean is the goal — polite guidance ("~해 보세요"), one line of context for non-experts. Keep commands, flags, paths, and proper nouns in English; on first use write a domain term as Korean(original), e.g. 결론(verdict). Still apply the universal rules; accessible ≠ padded or vague.

## Arguments

User provided: $ARGUMENTS

## Routing

Determine the subcommand from the first word of `$ARGUMENTS`:

- `record`, `last`, `status`, `since`, `doctor` → [Activity Ledger (CLI)] — run `xm trace <subcommand>` and relay its output
- `start` → [Subcommand: start]
- `stop` → [Subcommand: stop]
- `show` → [Subcommand: show]
- `cost` → [Subcommand: cost]
- `replay` → [Subcommand: replay]
- `diff` → [Subcommand: diff]
- `list` → [Subcommand: list]
- `clean` → [Subcommand: clean]
- Empty input or `help` → [Subcommand: help]
- Anything else → `show` (display latest session)

---

## Subcommand: help

See `subcommands/help.md` — command reference and usage examples.

---

## Subcommand: start

See `subcommands/start.md` — starts a new named trace session and writes the `.active` pointer.

---

## Subcommand: stop

See `subcommands/stop.md` — stops the active session and writes session_end entry.

---

## Subcommand: show

See `subcommands/show.md` — renders ASCII timeline with token/cost totals.

---

## Subcommand: cost

See `subcommands/cost.md` — per-agent cost table with token rates and totals.

---

## Subcommand: replay

See `subcommands/replay.md` — re-executes agents from a given step with user confirmation.

---

## Subcommand: diff

See `subcommands/diff.md` — side-by-side metric comparison of two sessions with delta.

---

## Subcommand: list

See `subcommands/list.md` — tabular listing of all saved sessions with duration and cost.

---

## Subcommand: clean

See `subcommands/clean.md` — finds old trace files and deletes with confirmation.

---

## Activity Ledger (CLI)

`record` / `last` / `status` / `since` / `doctor` are backed by `x-trace-cli.mjs`, which reads and writes `.xm/last.json` — a per-tool "last activity" pointer map, distinct from the per-session `.xm/traces/*.jsonl` files. Run them through the `xm` dispatcher and relay the output; do not re-implement their logic in Bash.

> **⚠ Call `xm trace <command>` directly (or the `xm last` / `xm status` shortcuts). Claude Code's Bash tool starts a fresh shell on every invocation — shell functions (`xmt()`) defined in one call do NOT persist to the next, causing `command not found: xmt`. Never define a helper across calls; always use the dispatcher.**
>
> **Fallback** (only when `xm` is not in PATH — rare; `${CLAUDE_PLUGIN_ROOT}` is NOT exported to Bash subprocesses, so don't rely on it bare):
> ```bash
> XMT_CLI=$(ls -d ~/.claude/plugins/cache/xm/{trace,xm}/*/lib/x-trace-cli.mjs 2>/dev/null | sort -V | tail -1)
> node "$XMT_CLI" last [args]
> ```
>
> **Forbidden:** `XMT="node ..."; $XMT last` — zsh treats the quoted string as a single command and fails.

| Command | What it does |
|---------|-------------|
| `xm trace record <tool> [--ref R] [--status S] [--note N] [--artifact A] [--session S]` | Write a tool's latest-activity pointer. Best-effort: an omitted `--ref` defaults to the current git HEAD; a lock contention or unknown tool name warns but still exits 0. |
| `xm last [tool] [--json]` | One line per tool (ref, status, relative age), or the raw map with `--json`. Shortcut: `xm last`. |
| `xm status [--json]` | Commits on HEAD since each tool last acted. Shortcut: `xm status`. |
| `xm trace since <ref>` | Tools + trace sessions recorded after `<ref>`'s commit time. |
| `xm trace doctor [--rebuild]` | Validate `last.json`; `--rebuild` reconstructs it from traces that recorded a git head. |

A record auto-chains `base` to the tool's previous head. If that base is unreachable (rebase / force-push), the record is flagged `chain_broken` and shown with `⚠ chain broken` — a signal to re-establish the tool's baseline.

### Coverage — what the ledger catches

The ledger is honest about its blind spots: it only knows about activity that ran through the dispatcher or an explicit `record`.

| Activity | In `last.json`? | Why |
|----------|:---------------:|-----|
| Mutating `xm <plugin> <cmd>` (e.g. `xm build tasks update`) | ✅ as `dispatcher` | The dispatcher's EXIT trap records after every mutating command. |
| Explicit `xm trace record <tool>` | ✅ as `<tool>` | Direct ledger write — e.g. x-review's mandatory record contract. |
| Read-only / meta `xm` commands (`help`, `version`, `last`, `status`, `trace`, `dashboard`, `init`, `update`, `doctor`, `which`) | ❌ | Deliberately excluded — no mutating activity to attribute. |
| Read-only sub-ops (`… list` / `… get` / `… show`) | ❌ | Excluded at the `$1`/`$2` verb position to avoid logging queries. |
| Direct `node x-*-cli.mjs …` (bypassing `xm`) | ❌ | Skips the dispatcher EXIT trap entirely. |
| LLM-only skill reasoning with no CLI call (an x-op strategy, x-review's analysis) | ❌ unless it calls `xm trace record` | Nothing runs through the dispatcher. |
| `session_start` / `session_end` in `.xm/traces/` | ✅ (traces) | Written by the trace-session hook; `doctor --rebuild` can reconstruct `last.json` from the git-bearing ones. |

When ledger output is empty or partial, the CLI appends a coverage note (`activity may exist that was never recorded`). Surface it — do not present the ledger as a complete record.

---

## Data Model

### Storage path

```
.xm/traces/
├── {session-name}-{YYYYMMDD-HHMMSS}.jsonl   # Per-session trace file
├── {session-name}-{YYYYMMDD-HHMMSS}.jsonl   # ...
└── .active                                   # Current active session file path
```

### JSONL entry schema

Each line is an independent JSON object:

```json
{
  "id": "t-001",
  "timestamp": "2026-03-25T12:00:00Z",
  "type": "agent_call",
  "parent_id": null,
  "agent": {
    "role": "security",
    "model": "sonnet"
  },
  "input_tokens_est": 2500,
  "output_tokens_est": 800,
  "duration_ms": 12000,
  "status": "completed",
  "source": "x-op:review",
  "step": 1
}
```

### Entry types (type field)

| type | Description | Required fields |
|------|------|-----------|
| `session_start` | Session start | `session`, `status` |
| `session_end` | Session end | `status`, `total_entries` |
| `agent_call` | Agent invocation | `agent`, `step`, `source` |
| `fan_out` | Parallel agent group start | `count`, `source` |
| `synthesize` | Result aggregation step | `parent_id`, `step` |
| `checkpoint` | Manual recording point | `label` |

### Status values (status field)

| status | Icon | Description |
|--------|--------|------|
| `completed` | ✅ | Completed successfully |
| `failed` | ❌ | Failed |
| `running` | 🔵 | Running |
| `skipped` | ⏭️ | Skipped |
| `active` | 🟢 | Session active |

---

## Integration with other xm tools

x-trace can be used by other xm skills to record entries before and after agent calls.

### x-op integration example

When executing x-op's `review` strategy:

```bash
# Record fan-out start
echo '{"id":"fo-001","timestamp":"...","type":"fan_out","count":4,"source":"x-op:review","step":1}' >> .xm/traces/.active-file

# Record after each agent completes
echo '{"id":"t-001","timestamp":"...","type":"agent_call","parent_id":"fo-001","agent":{"role":"security","model":"sonnet"},...}' >> .xm/traces/.active-file
```

### x-build integration example

Automatically records each task agent call when x-build's `run` command executes.

---

## Auto-recording event guide

Events each xm plugin should record:

### x-op strategy execution
| Event | Trace type | When to record |
|--------|-----------|----------|
| Strategy start | `session_start` | Immediately after `/xm:op {strategy}` is called |
| Fan-out call | `fan_out` | When N agents are invoked concurrently (includes agents[], prompt) |
| Delegate call | `agent_call` | When a single agent is invoked (role, model, prompt) |
| Round synthesis | `synthesize` | When the leader synthesizes results (round, summary) |
| Checkpoint save | `checkpoint` | When saving a checkpoint for `--resume` |
| Strategy complete | `session_end` | When final output + Self-Score is complete (total_cost, duration) |

### x-build task execution
| Event | Trace type | When to record |
|--------|-----------|----------|
| Run start | `session_start` | When `x-build run` is called (step_id, task_count) |
| Agent spawn | `agent_call` | When each task agent is spawned (task_id, role, model) |
| Task complete | `agent_call` + `status: done` | On `tasks update --status completed` callback |
| Task failure | `agent_call` + `status: failed` | On failure, includes error_message |
| Step complete | `checkpoint` | When all tasks in the current step are complete |

### x-review review
| Event | Trace type | When to record |
|--------|-----------|----------|
| Review start | `session_start` | When `/xm:review diff` is called |
| Per-lens review | `fan_out` | When per-agent review is invoked (lens, model) |
| Final verdict | `synthesize` | When verdict is determined (findings_count, verdict) |

## Cost alert rules

Warn when cumulative cost exceeds thresholds during trace recording:

| Threshold | Action |
|--------|------|
| `budget × 50%` | `💡 50% of budget used: $X / $Y` (info) |
| `budget × 80%` | `⚠ 80% of budget used: $X / $Y` (warning) |
| `budget × 100%` | `🚨 Budget exceeded: $X / $Y — continue?` (confirmation required) |

Budget is read from `budget.max_usd` in `.xm/config.json`. No alerts if unset.

Automatic cost summary on session end:
```
📊 Session cost: $0.42 (input: 180K, output: 45K tokens)
   Budget: $0.42 / $5.00 (8.4%)
```

---

## Trace Directive Template for Skills

All xm skills MUST record trace entries during execution. This is the standard template — each skill's SKILL.md includes a customized version.

### Automatic Checkpoints (hook-based — no LLM action needed)

`session_start` and `session_end` are recorded automatically by `.claude/hooks/trace-session.mjs`.
The hook fires on Skill tool PreToolUse/PostToolUse for any `xm:x-*` skill.

- **session_start**: mkdir -p .xm/traces, generate session ID, write entry, set .xm/traces/.active
- **session_end**: read .active, calculate duration, count agent_steps, write entry, delete .active

Skills do NOT need to emit session_start/session_end manually. If detected in SKILL.md trace sections, those instructions are redundant and can be removed.

### Best-Effort Entries (SHOULD — LLM records when possible)

**Session ID** — read from `.xm/traces/.active` (written by hook at session start):
```bash
SESSION_ID=$(cat .xm/traces/.active 2>/dev/null)
```

**Per agent call** — append agent_step after each agent completes:
```bash
echo '{"type":"agent_step","session_id":"SESSION_ID","ts":"TIMESTAMP","v":1,"id":"step-NNN","parent_id":PARENT_OR_NULL,"role":"ROLE","model":"MODEL","tokens_est":{"input":N,"output":N,"precision":"estimate"},"duration_ms":N,"status":"success","error":null}' >> .xm/traces/SESSION_ID.jsonl
```

### Session ID Format

Format: `{skill}-{YYYYMMDD}-{HHMMSS}-{4hex}`
Example: `x-op-20260404-153000-a3f1`

Generated automatically by the hook. Read via `.xm/traces/.active` during execution.

### Rules
1. session_start and session_end are **automatic** — handled by hook, never emit manually
2. agent_step is **SHOULD** — best-effort, LLM records when possible
3. Trace entries contain **metadata only** — never include LLM output, verdicts, or generated content
4. `tokens_est` values are estimates (±30-50%) — always mark `"precision":"estimate"`
5. If trace write fails (e.g., disk full), log to stderr and continue — NEVER block skill execution
6. Each skill session writes to its own file — no concurrent writes to the same file

---

## Natural Language Mapping

| User says | Command |
|-----------|---------|
| "start trace", "start recording" | `start` |
| "stop trace", "stop recording" | `stop` |
| "show timeline", "show execution log" | `show` |
| "how much did it cost", "how many tokens used" | `cost` |
| "redo the previous run", "reproduce it" | `replay` |
| "compare before and after", "compare two runs" | `diff` |
| "session list", "trace list" | `list` |
| "delete old ones", "clean up" | `clean` |

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll skip session_start, nobody reads traces anyway" | Session boundaries are how you correlate events later. Without them, traces are uncorrelated noise and you've lost attribution. |
| "Recording agent_step slows things down" | agent_step writes are append-only JSON lines — milliseconds, metadata only. The real slowdown is blind debugging later when the trail doesn't exist. |
| "I'll put the output in the trace for easier debugging" | Output in traces = PII risk + disk bloat + search degradation. Metadata only. Session logs exist for output inspection. |
| "If trace write fails, I should bubble the error up" | No. Trace failure must not block execution — traces are observability, not a gating mechanism. Fail silently and continue. |
| "Traces are only for failures" | Traces are for attribution — cost, time, agent count, session shape. Success traces are the baseline you need to diagnose the failure ones. |
| "One global trace file is simpler than per-session" | Per-session traces are correlatable and atomic. One global file is a race condition waiting to happen. |
