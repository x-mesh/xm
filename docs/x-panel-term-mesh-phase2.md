# x-panel ↔ term-mesh Integration — Phase 2 Plan

Status: **implemented, split across two PRs.** Owner side: xm (this repo is the contract source
of truth, mirroring the Phase 1 pattern). Counterpart doc: `term-mesh/docs/xk-panel-phase2.md`.

> **PR split.** This PR carries **Track A** (real-time telemetry: tm-events publisher,
> `status --follow`, dashboard SSE, preflight TTL cache) and **Track C** (the gated `--backend tm`
> experiment). **Track B — round-2 session reuse (t0 + t5)** was split into its own PR
> (`feature/panel-session-reuse` → `main`) because it is term-mesh-independent and pays off on
> its own. The task table and requirements below still describe the full Phase 2 plan; the
> Progress markers say where each task actually landed.

Phase 2 themes, as requested: **실시간성 개선 (real-time)** and **에이전트 효율화 (agent
efficiency)** for x-panel runs executed inside a term-mesh session.

---

## 0. Goal

One sentence: an x-panel run inside term-mesh is observable in real time (sub-second, push)
and costs measurably fewer tokens/seconds per round (session reuse), without changing panel
semantics or breaking non-term-mesh usage.

## 1. Where we are (ground truth, verified 2026-07-07)

| Surface | Today |
|---|---|
| x-panel progress | `.xm/panel/<run>/status.json` + `.xm/cross/<run>/status.json`, throttled flush + 2s tick (`runRound` in `x-panel/lib/x-panel-cli.mjs`) |
| Consumers | `xm panel status --watch` (file poll), x-dashboard server (`collectPanelRuns` reads status/verdict files) + `app.js` HTTP `setInterval` poll |
| Provider spawn | One-shot cold subprocess per model per round (`BUILTIN` in `adapters.mjs`: `claude -p`, `codex exec`, …) |
| Round 2 (refute) | Re-sends target + own findings + others' findings to a **fresh** cold process |
| Codex resume | `buildCodexResumeArgs()` exists in `adapters.mjs` — **no consumer yet** |
| term-mesh daemon | `events.publish` / `events.subscribe` JSONL bus exists (`daemon/term-meshd/src/socket.rs`), but publishable kinds are hardcoded to `task_status` \| `reply` |
| Phase 1 | term-mesh branch `claude/xkit-term-mesh-integration-rie8ws` (**unmerged**): `tm-agent xk-bridge` (daemon reply/task_status → `.xm/` tasks/trace/metrics writeback), contract-pointer docs |

Latency picture: a panel viewer inside term-mesh today sees updates at
*(x-panel flush throttle ~2s)* + *(dashboard file scan)* + *(browser HTTP poll interval)* —
worst case ~5–7s behind, all polling. Round-2 refute re-pays the full target context per model.

## 2. Non-goals (decide what NOT to build first)

- **No Swift/GUI code changes.** GUI visibility comes free via task-board mirroring (B3);
  a native panel widget is Phase 3 material.
- **No event persistence/replay in the daemon.** `status.json` files remain the durable
  source of truth; the event bus is an *accelerator layer only*. Poll fallback must always work.
- **No resume support for cursor / kiro / agy.** Stateless argv unchanged; claude + codex only.
- **No change to panel verdict semantics, JSON contracts, or the consensus/diversity model.**
- **No cross-machine (peer-federation) event forwarding.**
- **No new runtime dependencies in x-panel.** `adapters.mjs` stays a zero-import leaf;
  the event publisher uses `node:net` only.

## 3. Architecture

```
x-panel run (review/cross)
  ├─ status.json flush (unchanged, authoritative)         ← poll fallback, dashboards
  └─ tm-events publisher (NEW, best-effort)               ← Track A
        │  JSONL over $TERMMESH_SOCKET (daemon socket)
        ▼
term-meshd event bus  ── events.subscribe kinds:["xk_run"] ──▶  xm panel status --follow (A3)
        │                                                    ▶  x-dashboard SSE bridge (A4)
        ▼
tm-agent xk-bridge (Phase 1, extended)                       ▶  task board entry per run (B3)
```

Provider efficiency (Track B) is orthogonal: round-2 resumes the round-1 provider session
(claude `--resume`, codex `exec resume`) so the refute prompt carries only the delta.

## 4. Contract: `XK-EVENTS-v1` (new, owned by this doc)

Event published by x-panel to term-meshd `events.publish`, and streamed to
`events.subscribe` clients that **opt in** with `kinds:["xk_run"]`:

```jsonc
{
  "kind": "xk_run",            // fixed
  "v": 1,                      // contract version — bump on breaking change
  "source": "x-panel",         // producer id (future: x-op, x-build …)
  "run": "20260707-1030-ab12", // run id == .xm/{panel|cross}/<run>/ dir name
  "run_kind": "review",        // "review" | "cross"
  "phase": "round1",           // "starting"|"round1"|"round2"|"judging"|"done"|"failed"
  "model": "codex",            // per-model events; "" for run-level phase events
  "state": "running",          // "spawned"|"running"|"ok"|"failed"|"timeout"
  "elapsed_ms": 41200,
  "tail": "…last output…",     // OPTIONAL, redacted, ≤256 chars (same redaction as status.json)
  "title": "diff HEAD~1",      // run-level events only
  "ts_ms": 1783334400000
}
```

Rules (both sides MUST enforce):

1. **Best-effort, never blocking.** Publisher connect timeout 50ms, write timeout 100ms;
   any failure disables publishing for the rest of the run and warns **once** on stderr
   (L6: visible, not spammy). A panel run MUST NOT fail or slow down because the socket died.
2. **Coalescing at the publisher.** ≤1 event per (run, model) per second, except state
   transitions (`spawned`/`ok`/`failed`/`timeout`) and phase changes, which always flush.
3. **Opt-in at the subscriber.** The daemon MUST NOT deliver `xk_run` to default-filter
   subscribers (`tm-agent wait` etc. stay noise-free).
4. **Size cap.** Daemon rejects events > 4 KiB; `tail` > 512 bytes is truncated server-side.
5. **Versioning.** Consumers ignore events with unknown `v` (log at debug). Field additions
   are non-breaking; renames/removals bump `v`.
6. `status.json` stays authoritative — every consumer must survive on files alone when the
   socket is absent (non-term-mesh shells, daemon down).

## 5. Requirements

| R# | Requirement | Success criterion (binary) |
|----|-------------|---------------------------|
| R1 | x-panel publishes `xk_run` events when a term-mesh socket is detected | Stubbed run inside a fake socket harness produces ≥1 `starting`, ≥1 per-model, and 1 `done` event; run without socket produces none and no warnings |
| R2 | Publishing is best-effort | Killing the socket mid-run: run completes with identical verdict.json; exactly one stderr warning |
| R3 | `xm panel status --follow` uses subscribe when available | Update latency < 1s in follow mode (vs ≥2s poll); daemon kill mid-follow → visible fallback to polling |
| R4 | Round-2 session reuse for claude & codex | verdict.json `usage` shows round-2 input tokens < 50% of round-1 for resumed providers on the standard bench target; on resume failure, `resume:"fallback"` recorded and findings unchanged |
| R5 | Panel run visible on term-mesh task board | `tm-agent task list` shows the run task transitioning pending→in_progress→completed as the run progresses (requires Phase 1 merge) |
| R6 | Preflight cache | Second `xm panel preflight` within TTL performs 0 live model calls and says so |
| R7 | Zero regression outside term-mesh | Full existing x-panel test suite green; a run with no socket byte-identical in behavior |

## 6. Tasks

Owner `xm` = this repo; `tm` = term-mesh repo (detailed in its counterpart doc).
Risk-first ordering: the two unknowns (t5 resume spike, T1 daemon kind) go first.

| id | Task (one verb) | Owner | Deps | done_criteria (verifiable) |
|----|-----------------|-------|------|---------------------------|
| t0 | Spike: verify `claude -p --session-id/--resume` and `codex exec resume` round-trip on current CLI versions | xm | — | Script under `x-panel/test/` proving a 2-turn resumed conversation per provider; findings recorded in this doc's Assumptions |
| t1 | Freeze `XK-EVENTS-v1` (this §4) and mirror the pointer in term-mesh docs | xm+tm | — | Both repos reference the same version string |
| T1 | Add `xk_run` kind to term-meshd publish/subscribe (opt-in filter, size caps) | tm | t1 | `cargo test` round-trip; default subscribers receive none |
| t2 | Implement `x-panel/lib/x-panel/tm-events.mjs` publisher (socket detect, coalesce, warn-once) | xm | t1 | Unit tests against a fake UNIX-socket server; R2 satisfied |
| t3 | Wire publisher into review + cross status-flush points | xm | t2, T1 | R1 satisfied via e2e stub run |
| t4 | Add subscribe mode to `xm panel status --follow` with poll fallback | xm | t3 | R3 satisfied |
| t5 | Implement round-2 session reuse (claude session-id; codex via `buildCodexResumeArgs`) with loud stateless fallback | xm | t0 | R4 satisfied; fallback unit test |
| t6 | Cache preflight results per model id with TTL (default 30min, `panel.preflight_ttl_s`) | xm | — | R6 satisfied |
| T2 | Extend `xk-bridge` to mirror `xk_run` → task board task per run | tm | T1, Phase-1 merge | R5 satisfied |
| t7 | (stretch) Dashboard SSE: server subscribes to daemon, exposes `/api/events`; app.js `EventSource` + poll fallback | xm | t3 | Panel card updates < 1s after event with daemon up; identical behavior with daemon down |
| t8 | (experiment) `--backend tm` provider adapter: route a model call to an idle matching term-mesh pane via task capsule, JSON written to the run dir by the agent | xm | T2 | Gated: adopt only if bench (tm-bench methodology) shows ≥20% p50 wall-clock improvement with 0 JSON-validity regressions; otherwise document rejection |

Parallelism: {t0, t1, t6} → {t2 ∥ T1} → t3 → {t4 ∥ t7}; t5 after t0 only; T2 after Phase-1 merge.

Progress: **t0 done** (claude PASS / codex pending a machine with the CLI — see §9.1) ·
**t1 done** (this §4 + term-mesh pointer doc) · **T1 done** (`xk_run` kind + opt-in filter +
caps + unit tests in `daemon/term-meshd/src/socket.rs`, phase2 branch) · **t2 done**
(`x-panel/lib/x-panel/tm-events.mjs` — status-snapshot diff publisher; unit tests vs a fake
UNIX-socket daemon) · **t3 done** (wired into review + cross `flushStatus`; `--tm-events`/
`--no-tm-events` flags + `panel.tm_events` config, default on; e2e stub runs prove R1/R2 in
`test/tm-events.test.mjs`) · **t4 done** (`subscribeXkRun` + `xm panel status --watch`/
`--follow` push accelerator: xk_run events re-render within ~150ms between polls, loud
poll-only fallback on daemon death; R3 latency measured live in T4's VM e2e once available) ·
**t6 done** (preflight TTL cache — only `ok` verdicts cached, default 1800s via
`panel.preflight_ttl_s`, `--fresh` bypass; `test/preflight-cache.test.mjs` proves the 0-live-
call second run by swapping the provider for a broken command) · **t0 + t5 (session reuse) —
SPLIT OUT TO PR #2** (`feature/panel-session-reuse`, base `main`): the round-2 session-resume
work (the target never travels twice) lands independently there because it is term-mesh-free;
the codex banner-capture path was verified live on the real CLI. This Phase-2 branch (PR #1)
now carries **Tracks A & C only** — see the banner under §0 · **t7 done** (dashboard SSE: `/api/events` holds ONE daemon subscription and fans xk_run out
to SSE clients — <1s relay proven in `x-dashboard/test/sse.test.mjs`; app.js refreshes the
current panel view on push, 2s polling stays authoritative; endpoint serves hello+keepalives
without a daemon) · **t8 mechanics done, GATE PENDING** (`--backend tm` + `panel.tm_agents`
map routes providers to panes via TM-PROTOCOL-v1 capsule + file handoff — never socket text
(1500-char truncation would corrupt JSON); tm entries skip t5 session logic (panes are already
persistent); unmapped/unavailable ⇒ loud subprocess fallback; `test/tm-backend.test.mjs`
covers the mechanics. **Adoption decision NOT made**: run
`x-panel/test/bench-tm-backend.mjs` inside a live term-mesh team and record the p50/JSON
table here — default stays subprocess until the ≥20%+0-regression gate passes) ·
**T2 done** (xk-bridge mirrors runs onto the task board — the Phase-1 branch was merged
into term-mesh's phase2 branch to provide the bridge; main-merge still the user's call) ·
**T4 done** (`tests_v2/test_daemon_xk_run_events.py`; PASSED against a live term-meshd in
the dev container, including a full-chain check: a stubbed panel run pushed 12 events
through the real daemon to a subscriber with the exact starting/round1/round2/done
sequence — R3's <1s latency observed live).

### Why t8 is an experiment, not a commitment

A warm pane only saves CLI cold-start (~1–3s) while the model call dominates (30–120s), and
interactive panes cannot guarantee clean JSON on stdout (1500-char socket truncation forces a
file handoff). The honest expectation is a small win at high complexity — so it ships behind a
flag with a measurement gate (Lesson L9: thresholds from measurement, not judgment), and the
default backend remains the subprocess spawn.

## 7. Risks

| Risk | L×I | Mitigation |
|------|-----|-----------|
| Phase-1 branch (`xk-bridge`) never merges | M×M | Only T2/R5 depend on it; Track A and t5/t6 land independently. Flag the merge decision to the user before starting T2 |
| `claude -p` resume unsupported / drifts across CLI versions | M×H | t0 spike first; runtime fallback to stateless with `resume:"fallback"` in status.json + verdict |
| Event flood → daemon broadcast lag (`lagged by n events` path) | L×M | Publisher coalescing (§4.2) + opt-in filter + 4 KiB cap |
| Two-repo schema drift | M×M | `v` field, single contract section (§4), term-mesh doc is a pointer not a copy |
| tm backend contaminates panel JSON | M×H | t8 gated experiment, file-based handoff, off by default |

## 8. Boundaries

**Always:** keep `status.json` authoritative; publish best-effort with warn-once; version
every event; record any fallback (resume, follow→poll) somewhere inspectable.
**Ask first:** merging the Phase-1 term-mesh branch; changing the default panel backend;
any Swift/GUI work; adding event kinds beyond `xk_run`.
**Never:** block or fail a panel run on socket I/O; silently reuse a session whose resume
failed; add non-builtin deps to x-panel; deliver `xk_run` to default subscribers.

## 9. Named assumptions (below high confidence — validate before build)

1. `claude -p --session-id <uuid>` then `claude -p --resume <uuid>` works in print mode on
   current CLI versions (term-mesh's headless-resume contract relies on the stream-json
   variant; the print-mode variant is unverified) → **t0**.
   **t0 result (2026-07-07, `x-panel/test/spike-resume.mjs`):** claude **PASS** on CLI
   2.1.202 — a resumed print-mode session recalled a codeword said only in turn 1
   (t1 6.4s, t2 5.3s, `--model haiku`). codex **SKIP** — CLI not installed in the spike
   environment; re-run the script on a machine with codex before building the codex leg
   of t5 (the claude leg is unblocked).
2. The daemon socket is discoverable from the panel's environment (`TERMMESH_SOCKET`, else
   `/tmp/term-mesh*.sock` glob — same detection contract as the OMC override) → asserted in t2 tests.
3. This repo (`x-mesh/xm`) is the "x-kit" repo referenced by the Phase-1 docs (post-rename).
   If x-kit is actually a separate repo, §4 must move there and this doc becomes a pointer.

## 10. Out-of-scope follow-ups (Phase 3 candidates)

Native term-mesh panel widget (Swift) fed by `xk_run`; resume for cursor/kiro; event replay
API; cross-machine event forwarding over peer-federation; per-model cost live ticker in GUI.
