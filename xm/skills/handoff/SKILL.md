---
name: handoff
description: Session handoff — save comprehensive session state for cross-session continuity
model: sonnet
---

# x-handoff — Session Handoff (Save)

Save comprehensive session state so the next session can pick up where you left off — including the **conversation narrative** that disk artifacts (git, decisions.json, traces) cannot capture.

## Model Routing

This skill runs **entirely on the leader** (sonnet). It is NOT haiku-eligible, for two reasons:

1. Only the leader has the conversation history needed to compose the narrative (Step 1).
2. MCP tools like `mcp__mem-mesh__*` are frequently unavailable inside a dispatched Agent, and the mem-mesh mirror (Step 3) is an MCP call. A haiku sub-agent silently degrades the skill to file-only.

Run the CLI with Bash directly from the leader. Do **not** delegate this skill to an Agent — the token saving is negligible and it breaks dual-write.

**Guardrail**: never skip Step 1 to save tokens. Without the narrative, `/xm:handon` shows only "what was done," not "why we were doing it" — the next session has to re-derive the working direction from scratch.

## mem-mesh Backend (capability gate)

**Do NOT decide by inspecting your toolset.** MCP tools are often *deferred* — listed by name with no loaded schema — so "is `mcp__mem-mesh__add` in my tools?" reads as "no" even when mem-mesh is fully available. That misread is what silently disabled dual-write.

The gate decides **whether mem-mesh exists for this run** — nothing else. It is resolved BEFORE any `add` is attempted, and never revisited afterwards:

1. If `mcp__mem-mesh__add` is directly callable → **dual-write mode**.
2. If it is listed as a deferred tool → load it first (`ToolSearch` with `select:mcp__mem-mesh__add`) → **dual-write mode**.
3. Only if the tool does not exist at all, or cannot be loaded → **file-only mode**: make ZERO mem-mesh calls and never mention mem-mesh in the output.

**A failed `add` does NOT send you back to file-only.** Once the gate resolves to dual-write, you stay in dual-write for the whole run: the tool existed, you called it, it failed — that is a reportable outcome (`🧠 mem-mesh: FAILED …`), not an absence. Downgrading a failure to file-only would re-hide exactly what step 6 exists to surface, and the mirror would stay `pending` with nobody told.

`.xm/build/SESSION-STATE.json` + `HANDOFF.md` remain the portable source of truth (Codex/Cursor read them). mem-mesh is a mirror — never fail the handoff over it; report and move on.

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

**You do not build this payload.** Step 2's CLI already rendered it — correct schema, tier-2 content, git anchors, and the ≥100-char minimum `add` enforces. Hand-writing it is how the old version failed: it used `type:` (the real key is `category:`) and could fall under the length minimum, so the call was rejected.

When Step 2 printed `🧠 mem-mesh mirror PENDING → <path>`:

1. Read that file.
2. Pass its `.payload` object **verbatim** as the arguments to `mcp__mem-mesh__add`. Add nothing, drop nothing, rename nothing.
3. Record the returned memory id so the mirror stops showing as pending:

```bash
xm build handoff --mirror-done <memory_id>
```

One `add` call per handoff (do NOT create a pin per open question — pin sprawl).

If Step 2 printed `mem-mesh mirror: skipped (no narrative to mirror)` instead, there is no payload — skip Step 3 and say so in the confirmation.

If the `add` call fails, do NOT run `--mirror-done`. Leave it pending (the next `/xm:handon` will surface it) and report the error in the confirmation line.

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

Three files, all written by the CLI:

| File | Role |
|------|------|
| `.xm/build/SESSION-STATE.json` | Primary state (shape below) |
| `.xm/build/HANDOFF.md` | Tool-neutral mirror (Codex/Cursor read this) |
| `.xm/build/memmesh-mirror.json` | Pre-rendered `mcp__mem-mesh__add` payload + mirror status (`pending` → `mirrored`). Absent when there is no narrative to mirror. |

`.xm/build/SESSION-STATE.json`:

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
xm build handoff --mirror-status      # inspect the pending/mirrored payload
xm build handoff --mirror-done <id>   # record a successful mem-mesh add
```

## Execution Checklist

The handoff is **not done at step 3**. A run that stops there has completed exactly half of the dual-write it advertises.

1. **Read this conversation** — identify intent, open questions, rejected alternatives, what the next session must know.
2. **Compose `narrative` JSON** with the four fields. Empty arrays/strings are valid when genuinely nothing applies.
3. **Dispatch via Bash** with `--narrative-json '...'` (leader runs it — do not delegate to an Agent).
4. **Resolve the mem-mesh gate** by attempting, not by inspecting your toolset (see gate above).
5. **Mirror** (dual-write mode): read the pending payload file, pass `.payload` verbatim to `mcp__mem-mesh__add`, then `xm build handoff --mirror-done <memory_id>`.
6. **Confirm.** The 🧠 line is governed by the mode you resolved in step 4 — the two modes never overlap:

   - **file-only mode** — you never entered dual-write. mem-mesh does not exist for this run: no 🧠 line, no mention of mem-mesh anywhere in the output. This is not "omitting a required line"; there is no line to report.
   - **dual-write mode** — the 🧠 line is **MANDATORY**. Print exactly one of the forms below, whichever is true. Silence here is a reporting failure, not a clean run.

   ```
   ✅ Session state saved. Narrative captured: intent ✓, N open Q, N rejected alt.
      🧠 mem-mesh: mirrored (<memory_id>)
      Next session: run /xm:handon to restore.
   ```

   | Situation (dual-write only) | Line |
   |-----------|------|
   | `add` succeeded + `--mirror-done` ran | `🧠 mem-mesh: mirrored (<memory_id>)` |
   | CLI printed `skipped (…)` — no narrative, or too thin to meet the 100-char minimum | `🧠 mem-mesh: skipped (<CLI's reason>)` |
   | CLI printed `NOT WRITTEN` — payload rendered but the file write failed | `🧠 mem-mesh: NOT WRITTEN (payload could not be saved)` |
   | `add` was attempted and failed | `🧠 mem-mesh: FAILED (<error>) — mirror left pending` |
   | mirror file exists but is unreadable | `🧠 mem-mesh: mirror file UNREADABLE — inspect it manually` |

   Read the CLI's own mirror line (step 3 output) and mirror its verdict — do not infer a state it did not report.

## Common Rationalizations (do not skip Step 1)

| Excuse | Reality |
|--------|---------|
| "Git history covers it" | Git shows *what changed*, not *why we chose this direction*. Next session will re-propose ideas you already ruled out. |
| "There were no open questions" | Then write `"open_questions": []` — but verify by scanning the conversation. Most sessions have at least one "let's defer that" moment. |
| "The user can just re-read the chat" | They cannot. `/clear` and `/compact` discard it. Handoff is the only durable cross-session record. |
| "Narrative is subjective" | That's the point. Decisions/commits are objective; narrative is the interpretive layer that makes them legible. |
| "Skipping saves tokens" | The leader composes the narrative inside the turn it is already running. There is no dispatch to save. |

## Common Rationalizations (do not skip Steps 4-6)

Every one of these has actually happened — dual-write shipped, then mirrored **zero** sessions until this was written down.

| Excuse | Reality |
|--------|---------|
| "The file saved, so the handoff worked" | Half of it worked. Dual-write means both halves; the file half is the one that cannot fail, so it proves nothing about the other. |
| "I don't see `mcp__mem-mesh__add` in my tools" | Deferred tools are listed by name with no schema loaded. Load it with `ToolSearch` and try. Not-seen ≠ not-available — this exact misread is why the mirror never fired. |
| "The CLI printed a success checkmark" | The ✅ covers the file write only. The CLI prints `mem-mesh mirror PENDING` right below it precisely because that half is still your job. |
| "Mirroring is best-effort, so skipping is fine" | Best-effort means *attempt, then tolerate failure*. Never attempting is not best-effort; it is a silent no-op. |
| "I'll write the payload myself, it's just JSON" | The old version did, with `type:` instead of `category:` and no length floor — the call would have failed validation. Read the file, pass `.payload` verbatim. |
| "Reporting a mem-mesh failure looks bad" | An unreported failure recurs forever. A reported one gets fixed. Print the FAILED line. |
| "No narrative, so nothing to do" | Correct — and in dual-write mode still print the `skipped` line, so the user can tell "nothing to mirror" from "forgot to mirror." (In file-only mode print nothing; mem-mesh is not part of that run.) |
| "The `add` failed, so mem-mesh is unavailable — file-only it is" | The gate already ran and said dual-write. A failed call is an outcome to report, not a mode change. Print the FAILED line and leave the mirror pending. |

## Red Flags

Stop and correct course if you notice yourself:

- Dispatching this skill to an Agent (`model: haiku`) — MCP tools may not exist there; dual-write silently dies.
- Deciding the gate from what you *see* in your toolset instead of *attempting* the call.
- Typing a `content:` / `type:` payload by hand instead of reading `memmesh-mirror.json`.
- Writing the ✅ confirmation without a 🧠 line while in dual-write mode.
- Running `--mirror-done` after a failed or skipped `add` — that records a mirror that does not exist.
- Treating `HANDOFF.md` or SESSION-STATE.json existing as proof the handoff completed.

## Verification

Before claiming the handoff is done:

1. `.xm/build/SESSION-STATE.json` contains the narrative you composed (not `null`).
2. Your confirmation matches the mode — a 🧠 line in dual-write, no mention of mem-mesh in file-only.
3. In **dual-write mode only**, check the mirror reached its terminal state:

```bash
xm build handoff --mirror-status
```

| Reported status | Verdict |
|---|---|
| `mirrored` (non-null `memory_id`) | Done |
| `none` | Nothing to mirror — valid when the CLI said `skipped` |
| `pending` + you never attempted `add` | **Step 5 did not happen.** Go back and do it |
| `pending` + `add` was attempted and failed | Correct end state — you reported FAILED. Do not retry in a loop |
| `unreadable` | Mirror file is corrupt — report it; do not overwrite it |

In file-only mode skip this check entirely — the mirror status is irrelevant to a run that never entered dual-write.
