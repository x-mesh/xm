# Subcommand: flow

**Run large fan-out work through the deterministic Workflow tool instead of manual Agent-tool calls.**

`flow` is the high-parallelism backend for x-agent: it decomposes a goal into independent leaves, fans them out (up to ~10–16 concurrent, queued), forces structured per-leaf output, and merges — all in a background Workflow. Use it when "send the same kind of work to many agents and combine" is the whole task.

## Overview

```
flow "<goal>" [--agents N] [--op <preset>] [--model sonnet|opus|haiku] [--no-merge]
```

| vs primitive | flow adds |
|---|---|
| fan-out / broadcast (Agent tool) | queue past the per-message limit (1000 total), JSON-schema-forced merge, dependency levels, background + resume |

`flow` does NOT replace x-op strategies that gate on `AskUserQuestion` mid-run — those stay on the Agent tool. flow is for unattended diverge→merge.

## When to Use

- N independent (or dependency-leveled) sub-tasks over one target: lens review, multi-angle research, per-hypothesis verification, per-module scaffold.
- The user said "as many agents as possible", "in parallel", "fan this out wide".
- You want structured, mergeable results, not N text blobs to hand-stitch.

## Do Not Use When

- The work needs a human decision *between* phases → use `/xm:op` (interactive strategies).
- 1–2 agents suffice → use `delegate` / `fan-out`.
- Leaves must mutate the same files in parallel → those are not independent; rethink the split (or run sequentially).

## Decompose modes — pick one per run

| Mode | Use when | How |
|------|----------|-----|
| **(a) inline-scout** | The split itself needs reasoning (sub-problem boundaries, research angles). | YOU (leader) decompose first, show the plan, then pass `cfg.leaves` to the engine. Keeps a human-checkable plan before any spend. **Default for generic `flow "<goal>"`.** |
| **(b) in-script roster** | The leaf set is computable from args + a fixed table (lens roster, judge roster, file list). | Pass `cfg.decompose.prompt`; the engine's first agent emits the leaf list. Default for `--op` presets. |

Routing rule: leaf set computable from a static table → (b). Leaf set requires LLM reasoning over the target → (a).

## Core Process (leader steps)

> **⚠ The Workflow tool can only be invoked by you (the leader). This skill instructs you to call it — that is the explicit opt-in the Workflow tool requires.**

1. **Parse** `$ARGUMENTS`: goal, `--agents` (target leaf count, advisory), `--op`, `--model`, `--no-merge`.
2. **Decompose.**
   - (a): produce `leaves[]` yourself — each `{ id, role, prompt, deps:[], model }`. `prompt` must be self-contained (the leaf agent sees only it + dep results). Show the plan to the user.
   - (b): build `cfg.decompose.prompt` (reuse an existing decomposer — see Reuse table). Leave `cfg.leaves` empty.
3. **Read the engine** `flow/flow-template.mjs` (resolve path — see below). Do not author a script from scratch.
4. **Invoke Workflow** with the engine as an inline `script` and your config as `args`:
   ```
   Workflow({ script: "<contents of flow-template.mjs>", args: { op, topic, created_at, leaves|decompose, merge } })
   ```
   `created_at` MUST be an ISO8601 string you stamp now (the sandbox cannot call Date.now()).
5. **On return**, the engine gives `{ op, topic, created_at, options, level_ids, leaf_results, merge }`. Stamp `completed_at`, compute `self_score` (per `../op/references/self-score-protocol.md` shape), and **persist** to `.xm/flow/` (see Persist).
6. **Present + gate.** Show the merge + per-leaf summary to the user. Because flow dropped the mid-run gates, end with a single post-run approval — never auto-act on Critical/High findings.

### Resolve the engine path

```bash
ls -d ~/.claude/plugins/cache/xm/{agent,xm}/*/skills/agent/flow/flow-template.mjs 2>/dev/null | sort -V | tail -1
# fallback (running inside this repo): x-agent/skills/agent/flow/flow-template.mjs
```
Read that file; pass its full contents as the Workflow `script`.

## args config shape

```jsonc
{
  "op": "review",                 // preset name or "generic"; also the persist filename prefix
  "topic": "<what the user asked>",
  "created_at": "2026-06-14T10:00:00.000Z",   // YOU stamp this
  "leaves": [                     // pattern (a) — omit for (b)
    { "id": "L1", "role": "security", "prompt": "...self-contained...", "deps": [], "model": "sonnet" }
  ],
  "decompose": {                  // pattern (b) — omit for (a)
    "prompt": "Decompose <goal> into independent leaves. Output {leaves:[{id,prompt,deps,role,model}]}.",
    "model": "opus"
  },
  "merge": { "prompt": "Synthesize... resolve conflicts... state verdict.", "model": "opus" },
  "no_merge": false               // true => skip synthesis, return raw leaf_results (--no-merge)
}
```

Engine behavior (do not reimplement): args-string guard → optional decompose (null/invalid plan throws) → Kahn topo-batch (no dep = same level, levels sequential, each level `parallel()`) → per-leaf `LEAF_SCHEMA` (a thrown/null leaf becomes a `status:"failed"` leaf, never lost). The return carries top-level `status` (`completed`/`partial`) and `failed_count`. `no_merge:true` returns `{...,merge:null}`; otherwise the merge agent runs and a null merge **throws** (never returned silently). Cycle / unknown dep id throws.

## Reuse table (do not write these prompts fresh)

| Need | Source |
|------|--------|
| sub-problem decomposer | `../solver/commands/solve.md` (decompose delegate + JSON) |
| dependency-tree decomposer | `../op/strategies/decompose.md` (lines 9–21) |
| review lens leaves | `../review/lenses/*.md` (one leaf per file, verbatim) |
| judge leaves | `../eval/judges/*.md` |
| red-team attack/defend | `../op/strategies/red-team.md` |
| output quality contract (prepend to every leaf + merge) | `../op/references/agent-output-contract.md` |
| role presets | `references/role-presets.md` |

## Persist

`mkdir -p .xm/flow/`, write `.xm/flow/{op}-{YYYY-MM-DD}-{slug}.json`. Map the engine return to the canonical dashboard schema (`../op/references/x-op-result-persistence.md`) — these keys are the contract or the dashboard renders `—`:

| Canonical key | From |
|---|---|
| `topic` | `ret.topic` |
| `created_at` / `completed_at` | `ret.created_at` / stamp on return |
| `options.agents` | `ret.options.agents` |
| `self_score` | you compute |
| `rounds_summary[i].findings[]` | preserve `ret.leaf_results` bodies — `outcome.summary` is a digest only, never a replacement |
| `outcome.verdict` / `summary` | from `ret.merge` |
| `status` | `ret.status` (`completed`/`partial`); if `ret.failed_count > 0`, surface it to the user before persisting |

## Worked examples

**(a) generic** — `flow "리팩터링이 토큰 캡처 경로에 미치는 영향 분석"`
1. You decompose into e.g. L1 cost-engine, L2 tasks.update, L3 run-contract (deps: []), L4 synthesis (deps: [L1,L2,L3]).
2. Show the 4-leaf plan. `args.leaves = [...]`, `merge.prompt = "..."`.
3. Run engine → L1–L3 in level 1 (parallel), L4 in level 2 → merge.

**(b) review** — `flow --op review --target <diff>`
1. `cfg.leaves` empty; `cfg.decompose.prompt` = "emit one leaf per lens in `../review/lenses/`, each prompt = that lens file + the diff, deps []".
2. Engine decomposes → fans out lenses in one level → merge applies the verdict threshold table.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll just author a fresh Workflow script inline" | That reintroduces the args-serialization bug and re-derives topo/merge every time. The engine already guards `typeof args === 'string'` and batches deps. Read it, don't rewrite it. |
| "I'll let the planner decompose and skip showing the user" | Pattern (b) with no gate spends N agents on a possibly-wrong split. For ambiguous goals use (a) and show the plan first. |
| "deps are a hassle, I'll flatten everything into one level" | Flattening dependent leaves makes later leaves run without their inputs → garbage merge. Declare `deps`; the engine levels them. |
| "I'll collapse leaf bodies into outcome.summary to save space" | The dashboard needs `rounds_summary[].findings[]` bodies to show diverge→merge. Summary-only persists as `—`. |
| "flow can replace x-op strategies" | x-op gates on AskUserQuestion mid-run by design. flow has no mid-run gate. Porting an interactive strategy silently drops its human checks. |
| "It failed once, I'll just retry the same script" | The first failure was `args` arriving as a string. If you hand-author, add the guard; if you use the engine, it's already there. |

## Red Flags — stop if you catch yourself

- Writing `Workflow({ script: "export const meta...` by hand instead of reading `flow-template.mjs`.
- Passing `args` as a JSON-encoded string (pass the real object).
- Leaves that edit the same file → not independent.
- No `created_at` stamped → dashboard date shows `—`.
- Auto-acting on Critical/High merge findings with no user approval.

## Verification

Before claiming done:
1. `ret.options.agents` equals the leaf count you intended.
2. Every `leaf_results[i].status === "completed"` (investigate any `failed`).
3. `.xm/flow/{op}-*.json` exists and has `topic`, `created_at`, `completed_at`, `options.agents`, `self_score`, `status`, and non-empty `rounds_summary[].findings`.
4. The merge verdict is consistent with the leaf findings (no claim in the verdict that no leaf supports).
