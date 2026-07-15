---
name: handoff
description: Session handoff — save comprehensive session state for cross-session continuity
model: haiku
---

# x-handoff — Session Handoff (Save)

Save comprehensive session state so the next session can pick up where you left off — including the **conversation narrative** that disk artifacts (git, decisions.json, traces) cannot capture.

## Model Routing

This skill is **hybrid**:

| Step | Model | Role | Why |
|------|-------|------|-----|
| 1. Compose narrative | **leader** (current model, typically sonnet) | narrator | Only the leader has the conversation history needed to summarize intent / open questions / rejected alternatives |
| 2. Save state to disk | **haiku** (Agent tool) | writer | Mechanical JSON write — no reasoning |

```
Agent tool: { model: "haiku", description: "x-handoff", prompt: "Run: xm build handoff --full --narrative-json '<JSON>' \"$ARGUMENTS\"" } <!-- managed-model: writer -->
```

**Guardrail**: never skip Step 1 to save tokens. Without the narrative, `/xm:handon` shows only "what was done," not "why we were doing it" — the next session has to re-derive the working direction from scratch.

## mem-mesh Backend (capability gate)

Check ONCE at skill start whether `mcp__mem-mesh__*` tools are in your available toolset.

- **Present** → **dual-write mode**: write `.xm/build/SESSION-STATE.json` + `HANDOFF.md` exactly as below AND mirror the narrative digest to mem-mesh (Step 3 below).
- **Absent** → **file-only mode**: run exactly as documented, make ZERO mem-mesh calls, never mention mem-mesh.

`.xm/build/SESSION-STATE.json` + `HANDOFF.md` remain the portable source of truth (Codex/Cursor read them). mem-mesh is a mirror; if a mem-mesh call errors, log it and continue — never fail the handoff over it. The **leader** makes the mem-mesh call (the haiku writer may lack the MCP tools).

## When to Use
- End of a work session
- Before `/clear` or context compaction
- When switching to a different project/branch

## Step 1 — Compose the Narrative (leader, MANDATORY)

Handoff is **2-tier**. Compose both from **this conversation**:

- **Tier 1 — `narrative` (compact, ALWAYS auto-injected on restore).** Headlines only. Keep it tight.
- **Tier 2 — `session_log` (detailed, retrieval-only).** The full story. `handon` does NOT load this by default — it only reports the count and loads it on demand (`handon --log`), so length here costs nothing on every restore. Include it whenever the session had real depth.

**The governing rule is NOT a line count — it is a reconstruction test.** For each sentence ask: *"Does git diff / decisions.json / the commit messages already capture this?"*
- Yes → drop it. It is auto-collected (`where`, `what_done`, `decisions`, `context`).
- No → keep it. Whatever length that takes. The reasoning behind a choice, an approach you abandoned, a preference the user revealed — none of that survives `/clear`, and none of it is in any diff.

### Tier 1 — `narrative` (four fields, all required; `[]`/`""` when genuinely empty)

| Field | Type | Content |
|-------|------|---------|
| `intent` | string | One sentence: *why* the user started this session. |
| `open_questions` | string[] | Decisions not yet made, ambiguities flagged but unresolved, "later" follow-ups. |
| `rejected_alternatives` | string[] | One-line each: `"alternative — why rejected"`. (Full reasoning goes in tier 2.) |
| `next_session_should_know` | string[] | Non-obvious context: user preferences, discovered constraints, surprising findings. |

### Tier 2 — `session_log` (optional object; each key a `string[]`, omit or `[]` when empty)

| Field | Content |
|-------|---------|
| `rejected` | Rejected alternatives **with full reasoning** — the argument, not just the verdict. |
| `open_forks` | Open questions **plus the branches considered** for each. |
| `constraints_prefs` | Constraints and user preferences that surfaced mid-session and shape future work. |
| `attempts` | What was tried and why — successes **and failures**, so the next session doesn't hit the same wall. |

Tier 1 is the searchlight; tier 2 is the archive behind it. A trivial session → tier 1 only. A multi-hour session with abandoned approaches and unresolved forks → a full tier 2, and that is correct.

**Still forbidden in BOTH tiers:** step-by-step recap of what you did (the diff says that), and anything already in `what_done` / `decisions`.

## Step 2 — Dispatch the Save

Build the CLI command:

> **⚠ Call `xm build handoff` directly. Never use a repo-relative path like `node x-build/lib/x-build-cli.mjs` — that path only exists inside the x-kit repo itself and fails with `Cannot find module` in every other project.**
>
> **Fallback** (only when `xm` is not in PATH):
> ```bash
> XMB_CLI=$(ls -d ~/.claude/plugins/cache/xm/{build,xm}/*/lib/x-build-cli.mjs 2>/dev/null | sort -V | tail -1)
> node "$XMB_CLI" handoff --full --narrative-json '<JSON>' "$ARGUMENTS"
> ```

```bash
xm build handoff --full \
  --narrative-json '{"intent":"...","open_questions":[...],"rejected_alternatives":[...],"next_session_should_know":[...],"session_log":{"rejected":[...],"open_forks":[...],"constraints_prefs":[...],"attempts":[...]}}' \
  "$ARGUMENTS"
```

`session_log` is optional — omit the key entirely for a trivial session. When present, the CLI persists it into SESSION-STATE.json and renders it into HANDOFF.md, but `handon --json` strips it to a count so it never bloats a restore.

`$ARGUMENTS` is used as the `why_stopped` reason. If empty, auto-generates from the last commit message.

**JSON escaping**: pass the narrative as a single-quoted shell argument so double-quoted JSON strings inside don't conflict with the shell. Escape any literal single quotes inside string values as `'\''`.

## Step 3 — Mirror to mem-mesh (dual-write mode only)

Only in dual-write mode (gate above). After the CLI writes SESSION-STATE.json, the leader mirrors **one thick entry** to mem-mesh — the full tier-2 archive, not a thin digest. mem-mesh is the retrieval home for detail: search fetches it later without loading a file, so store richly.

```
mcp__mem-mesh__add(
  content:
    "<intent>\nStopped: <why_stopped>\n\n"
    + "## Open questions & forks\n<open_forks or open_questions>\n\n"
    + "## Rejected (with reasoning)\n<session_log.rejected>\n\n"
    + "## Constraints & preferences\n<session_log.constraints_prefs>\n\n"
    + "## What was tried & why\n<session_log.attempts>",
  project_id: <basename of cwd>,
  type: idea
)
```

One `add` call per handoff (do NOT create a pin per open question — pin sprawl). Include whatever tier-2 sections exist; fall back to the tier-1 narrative when `session_log` is empty. Use the tool's own schema; attach `anchors` from `git rev-parse HEAD`. On error, log and move on — the JSON file already succeeded.

## What it Collects (automatic)

| Source | Data | Method |
|--------|------|--------|
| git | branch, last 5 commits, uncommitted files, ahead/behind | `git log`, `git status` |
| x-build | active projects, phase, tasks, pending work | `.xm/build/projects/*/manifest.json` |
| decisions | from all active projects (last 10) | `decisions.json` / `decisions.md` |
| traces | last 5 skill executions | `.xm/traces/*.jsonl` |
| eval | quality scores | `.xm/eval/results/` |
| tests | pass/fail status | `bun test` (cached) |
| key files | most changed files | `git diff --stat` |
| **narrative** (tier 1) | **leader-composed (Step 1)** | **`--narrative-json` flag** |
| **session_log** (tier 2) | **leader-composed (Step 1), retrieval-only** | **`--narrative-json` flag** |

## Output

Saves to `.xm/build/SESSION-STATE.json`:

```json
{
  "v": 1,
  "saved_at": "2026-04-11T...",
  "where": { "branch": "develop", "last_commits": [...], "uncommitted_files": [...] },
  "what_done": ["commit1", "commit2"],
  "what_remains": { "active_projects": [...], "uncommitted": [...], "ideas": [] },
  "decisions": [{ "what": "...", "why": "..." }],
  "context": { "current_focus": "...", "test_status": "...", "quality_scores": {} },
  "narrative": {
    "intent": "User wanted to add conversation-level context to /xm:handoff because git artifacts alone lose the 'why'.",
    "open_questions": ["Whether narrative.intent should be auto-summarized from the last 20 turns if leader leaves it empty"],
    "rejected_alternatives": ["MEMORY auto-indexing — too broad for handoff scope"],
    "next_session_should_know": ["Leader must run at sonnet+ for narrative quality; haiku-only handoff is now disallowed"]
  },
  "session_log": {
    "rejected": ["mem-mesh-only tier 2 — rejected because file-only users would lose the archive; dual-write keeps .xm portable"],
    "open_forks": ["Line-count cap vs reconstruction test — chose the reconstruction test so detail scales with session complexity"],
    "constraints_prefs": ["User wants handoff 'as detailed as possible' but context cost on restore must stay flat → 2-tier split"],
    "attempts": ["Considered a separate SESSION-LOG.md file → dropped for a session_log field that handon selectively withholds"]
  },
  "why_stopped": "reason"
}
```

`session_log` is present only when the leader composed one. `handon --json` replaces it with a `session_log_summary` count; `handon --log` prints the full archive.

## Usage

```
/xm:handoff                           # leader composes narrative, auto-generated reason
/xm:handoff "dashboard 개선 완료"      # leader composes narrative + explicit reason
```

## Execution Checklist

1. **Read this conversation** — identify intent, open questions, rejected alternatives, what the next session must know.
2. **Compose `narrative` JSON** with the four fields. Empty arrays/strings are valid when genuinely nothing applies.
3. **Dispatch via Bash** (or haiku Agent) with `--narrative-json '...'`.
4. **Confirm**:
   ```
   ✅ Session state saved. Narrative captured: intent ✓, N open Q, N rejected alt.
      Next session: run /xm:handon to restore.
   ```

## Common Rationalizations (do not skip Step 1)

| Excuse | Reality |
|--------|---------|
| "Git history covers it" | Git shows *what changed*, not *why we chose this direction*. Next session will re-propose ideas you already ruled out. |
| "There were no open questions" | Then write `"open_questions": []` — but verify by scanning the conversation. Most sessions have at least one "let's defer that" moment. |
| "The user can just re-read the chat" | They cannot. `/clear` and `/compact` discard it. Handoff is the only durable cross-session record. |
| "Narrative is subjective" | That's the point. Decisions/commits are objective; narrative is the interpretive layer that makes them legible. |
| "Skipping saves haiku tokens" | Leader composes narrative at no extra agent dispatch — only one haiku Agent call regardless. There is no token saving. |
