### Step 3: Plan (Plan Phase)

#### Memory Recall (before PRD generation)

Before generating the PRD, recall relevant prior context so the plan does not repeat recorded mistakes or re-litigate settled decisions. Best-effort — skip silently if x-memory is unavailable:

```
/xm:memory recall "{goal keywords}"
```

Fold any returned decisions / patterns / failures into the PRD-generation prompt alongside the research artifacts. This mirrors x-build's own `decisions inject` (see `references/plugin-integration.md`).

#### PRD Generation (first step of Plan phase)

Before task decomposition, the leader generates a PRD. Based on research artifacts (CONTEXT.md, REQUIREMENTS.md, ROADMAP.md).

**IMPORTANT: Check mode from `.xm/config.json` before generating.**
- `developer` mode → Write PRD in English (technical terms, concise)
- `normal` mode → Write PRD content in Korean (section titles remain in English, body in Korean). Inject this instruction into the agent prompt: `"모든 섹션의 내용을 한국어로 작성하세요. 섹션 제목(Goal, Success Criteria 등)은 영문 유지. 기술 용어는 원어 유지."`

#### PRD Size Tiers

Determine PRD size based on task count expectation or `--size` flag:

| Tier | Condition | PRD Sections |
|------|-----------|-------------|
| **small** | ≤5 expected tasks or `--size small` | 1.Goal, 2.Success Criteria, 3.Constraints, 5.Requirements Traceability, 7.Risks, 8.Architecture, 12.Acceptance Criteria (7 sections) |
| **medium** | 6-15 tasks (default) | Above + 4.NFR, 6.Out of Scope, 7.5 Failure Modes & Adversarial Inputs, 9.Key Scenarios (11 sections) |
| **large** | 15+ tasks or `--size large` | All sections including 7.5 Failure Modes & Adversarial Inputs (current full template) |

**Rationale for small tier change:** Previous small tier (5 sections) omitted Risks and Architecture, producing PRDs that lacked actionable context for executors. Every project has risks and structure — even small ones.

When generating the PRD, include only the sections for the determined tier. The delegate prompt should specify: "Generate PRD with {tier} tier — include only sections: {section list}."

delegate (foreground, `model` = `prd_writer.model` from the `plan`/`next --json` output — never hardcode):
```
"## PRD Generation: {project_name}
{IF mode === 'normal': '언어: 한국어로 작성. 섹션 제목은 영문 유지, 내용은 한국어. 기술 용어는 원어 유지.'}
Research artifacts:
- CONTEXT: {CONTEXT.md summary}
- REQUIREMENTS: {REQUIREMENTS.md full text}
- ROADMAP: {ROADMAP.md summary (if available)}

Read `references/prd-template.md` for the full PRD structure (Section 0 Assumptions + Sections 1-13) and per-section quality criteria before generating. Fill in every section without omission.
"
```

**MANDATORY: Save PRD to file IMMEDIATELY after generation.** This is not optional — the PRD must exist as a file before review.
```bash
$XMB save plan --content "{PRD content}"
```
If `save plan` is not called, the PRD will not appear in the dashboard and will be lost on session end.

After saving, proceed to PRD Review.

#### PRD Review (user review and revision)

After PRD generation, **the leader MUST output the full PRD text to the user**. This is non-negotiable — the user cannot review what they cannot see.

**Output protocol:**
1. **Print the entire PRD as text output** — every section, every table, every diagram. Do NOT summarize. Do NOT say "PRD가 생성되었습니다" without showing the content.
2. **After the full text output**, call AskUserQuestion for review.

Anti-patterns:
- ❌ Save PRD to file → immediately ask for review without showing content
- ❌ Show only section titles or a summary instead of the full PRD
- ✅ Output full PRD text → then AskUserQuestion for review

1. **Show full PRD**: Output the ENTIRE PRD.md content as text (mandatory — not a file reference)
2. **Request feedback**: Collect review results via AskUserQuestion:
   ```
   Please review the PRD:
   1) Approve — proceed as-is
   2) Needs revision — tell me what to change
   3) Quality review — Judge Panel scores first; if score < 7.0, auto-escalates to Consensus Review
   4) Rewrite — regenerate the PRD from scratch
   ```
3. **Action per selection**:
   - "Approve" → proceed to task decomposition
   - "Needs revision" → revise PRD with user feedback, then show again (repeat)
   - "Quality review" → run [PRD Quality Gate]; if score < 7.0, automatically run [Consensus Loop] with judge feedback as context
   - "Rewrite" → re-run PRD Generation from scratch

4. **Re-save on revision**:
   ```bash
   $XMB save plan --content "{revised PRD content}"
   ```

5. **Record PRD confirmation**:
   ```
   ✅ PRD reviewed and approved by user.
   Proceeding to task decomposition.
   ```

> Important: The PRD Review loop repeats until the user selects "Approve". Cannot be auto-skipped.
> Loop limit: The entire PRD Review loop (including revisions + rewrites + quality checks + consensus reviews) repeats at most 5 times.
> On reaching 5: Show the current PRD and offer only 2 options: "Approve" or "Abort project".

#### PRD Quality Gate (on-demand)

Runs only when the user selects "Quality check". Not triggered automatically.

```bash
$XMB prd-gate [--threshold N] [--judges N]
```

Read `rubric`, `prd`, `requirements` from the output JSON and perform the following:

1. **Summon Judge Panel** (default 3 agents, adjustable via `--judges`):
   - Rubric: Use the `rubric` array from JSON (completeness, feasibility, atomicity, clarity, risk-coverage)
   - Each judge scores the PRD independently (using x-eval Reusable Judge Prompt)

2. **Display results** (no auto-judgment/regeneration — information only for the user):
   ```
   📋 PRD Quality: {score}/10 (plan-quality rubric)
   | Criterion      | Score | Feedback          |
   |----------------|-------|-------------------|
   | completeness   | 8     | ...               |
   | actionability  | 7     | ...               |
   | scope-fit      | 8     | ...               |
   | risk-coverage  | 6     | ...               |
   ```

3. **Score-based guidance message**:
   - Score >= 7.0 → `"💡 Quality is good — consider approving."`
   - Score 5.0–6.9 → **Auto-escalate to Consensus Review** with judge feedback as context
   - Score < 5.0 → **Auto-escalate to Consensus Review** with judge feedback as context

4. **Record PRD score in project metadata**:
   ```bash
   $XMB save plan --content "PRD Score: {score}/10"
   ```

5. **Return to PRD Review options** — Judge results are provided as reference; the final decision is the user's.

> Call limit: Quality check can run at most 2 times within the same PRD Review session. Resets on "Rewrite".
> After 2 attempts: `"⚠ Quality check limit reached. Select 'Approve', 'Needs revision', or 'Consensus review'."`

#### Consensus Loop (consensus review)

When the user selects "Consensus review", 4 agents review the PRD from multiple perspectives and auto-revise until consensus.

```bash
$XMB consensus [--round N] [--max-rounds N]
```

Read `agents`, `prd`, `round` from the output JSON and perform the following. Spawn each agent with its `agents[n].model` from the JSON — models are resolved from `model_profile`/`model_overrides`, never hardcode. (`--cross-vendor` replaces the executor per references/cross-vendor-consensus.md but keeps the same roles.)

**Round 1: broadcast (4 agents)**
```
Agent 1 (architect): "Review the PRD from an architecture perspective.

Principles:
1. Simplest architecture that meets constraints wins. More components = more failure modes.
2. Module boundaries should align with team boundaries and deployment boundaries.
3. Missing interfaces between modules are more dangerous than missing features.

Evaluate:
- Could this be built with fewer components/services/layers?
- Are the boundaries between modules at natural seams (data ownership, deployment unit, team)?
- Are cross-module interfaces defined, or left implicit?

Good OBJECT: 'PRD implies 3 services but only 1 deployment target. Simplify to monolith with module boundaries.'
Bad OBJECT: 'Architecture could be better.'

Conclusion: AGREE or OBJECT + specific feedback. 200 words max."

Agent 2 (critic): "Find weaknesses in the PRD.

Principles:
1. The most dangerous assumption is the one nobody questioned.
2. A contradiction between two requirements is better found now than during implementation.
3. 'We'll figure it out later' is a risk, not a plan.

Evaluate:
- What assumption, if wrong, would invalidate this entire plan?
- Are there contradictions between requirements, constraints, or success criteria?
- Where does the PRD say 'TBD' or imply deferred decisions?
- Does every risk-domain requirement enumerate its failure modes (pathological inputs, unbounded loops, performance blow-ups)? Flag any that don't.

Good OBJECT: '[R3] requires real-time sync but [C2] prohibits WebSocket — contradiction.'
Bad OBJECT: 'Some requirements seem incomplete.'

Conclusion: AGREE or OBJECT + specific feedback. 200 words max."

Agent 3 (planner): "Evaluate the feasibility of the PRD.

Principles:
1. If a task can't be explained in one sentence starting with a verb, it's too big or too vague.
2. Parallel tasks should have zero shared state. If they share a file, they're not parallel.
3. Done criteria that require human judgment ('code is clean') are not done criteria.

Evaluate:
- Can each implied task be completed in one session by one agent?
- Are success criteria measurable without subjective judgment?
- Is the implicit task ordering fail-fast? (highest risk first)

Good OBJECT: '[SC2] says performance is acceptable — not measurable. Needs p95 latency target.'
Bad OBJECT: 'Success criteria need work.'

Conclusion: AGREE or OBJECT + specific feedback. 200 words max."

Agent 4 (security): "Evaluate the security/risk aspects of the PRD.

Principles:
1. Security requirements are constraints, not features. They don't get 'nice to have' priority.
2. Every data flow that crosses a trust boundary needs explicit handling in the plan.
3. 'We'll add auth later' means 'we'll rebuild everything later.'

Evaluate:
- Are auth, authz, and data protection explicitly addressed (not assumed)?
- Do data flows crossing trust boundaries have handling specified?
- Are security risks listed with specific mitigations (not 'follow best practices')?
- Are adversarial inputs and resource-exhaustion failure modes (e.g. ReDoS-class) specified with verification?

Good OBJECT: 'No mention of API rate limiting — [R1] public endpoint is DoS-vulnerable without it.'
Bad OBJECT: 'Security could be improved.'

Conclusion: AGREE or OBJECT + specific feedback. 200 words max."
```

**Consensus judgment:**
- **All AGREE** → Consensus reached; show results to user, return to PRD Review options
- **1+ OBJECT** → Leader synthesizes OBJECT feedback to revise PRD → broadcast again (max 3 rounds)
- **No consensus after 3 rounds** → Summarize key disagreements for the user, request user judgment

> Re-entry limit: Consensus Loop can run at most 2 times within the same PRD Review session.
> After 2 attempts: "⚠ Consensus review limit reached. Select 'Approve' or 'Needs revision'."

**Consensus result output:**
```
🏛️ [consensus] PRD Review — Round {n}/{max}

| Agent | Role | Verdict | Key Feedback |
|-------|------|---------|-------------|
| 1 | architect | ✅ AGREE | Structure is sound |
| 2 | critic | ❌ OBJECT | [R3] Missing test strategy |
| 3 | planner | ✅ AGREE | Decomposable |

→ Incorporating critic feedback to revise PRD...
```

After consensus, return to PRD Review options — user must give final "Approve" to proceed.

**Cross-Vendor Mode (opt-in):** when the user requests cross-vendor consensus
(`consensus --cross-vendor`, or "review the PRD with different models"), assign the 4 roles to
DIFFERENT model vendors via `xm panel cross` instead of 4 Claude personas — genuine cross-model
PRD critique that escapes single-model groupthink. Probe with `xm panel detect --auth` and fall
back loudly to single-vendor if fewer than 2 vendors are ready (installed + authenticated;
`xm panel doctor` diagnoses). Full flow:
`references/cross-vendor-consensus.md`. The consensus judgment logic (all AGREE / 1+ OBJECT
revise / 3-round limit) is unchanged — only who executes each role differs.

---

Create tasks informed by research artifacts:

1. Run: `$XMB plan "goal"`
2. Parse JSON output — it now includes `context_summary`, `requirements_summary`, `roadmap_summary`
3. Decompose into 5-10 tasks based on REQUIREMENTS.md:
   - Each task references requirement IDs in its name (e.g., "Implement JWT auth [R1]")
   - Concrete, actionable names (start with verb)
   - **Every task MUST carry a `--desc` (1-3 sentences: WHAT it does + WHY it exists).** The name is a compressed title; the description is the text the executor actually reads to understand scope and intent. Do not register a task whose intent is not obvious from its name alone without a description.
   - **Size by single-agent session, not calendar time:** `small` = part of one session, `medium` = ≈ one session, `large` = at the limit of one session (prefer to split it). Avoid full-day tasks — if a task cannot finish in one agent session, decompose it into smaller tasks. `plan-check` flags every `large` task as a split candidate.
   - Dependencies: what must complete first

4. **CONTEXT.md Quality Bar → Task Injection (automatic)**

   Before registering tasks, read CONTEXT.md and extract commitments from these sections:

   | CONTEXT.md Section | Auto-generated task/criteria |
   |--------------------|-----------------------------|
   | **Quality Bar → Testing** | Task: "Write {test_type} tests" + done_criteria from interview spec |
   | **Quality Bar → Documentation** | Task: "Generate {doc_type}" (e.g., OpenAPI spec) |
   | **Quality Bar → Error Handling** | done_criteria injected into relevant endpoint tasks |
   | **Scope → Out of Scope** | Scope guard: plan-check warns if a task name matches an out-of-scope item |
   | **Timeline → Phasing** | If MVP phasing specified, tag tasks as `phase:mvp` or `phase:hardening` |

   Example — if CONTEXT.md says:
   ```
   ## Quality Bar
   ### Testing
   - Integration tests required (happy path + error paths)
   ### Documentation
   - OpenAPI spec required
   ```

   Auto-inject:
   ```bash
   $XMB tasks add "Write integration tests [QA]" --size medium --deps t1,t2
   $XMB tasks update t{last} --done-criteria "happy path + primary error path per endpoint"
   $XMB tasks add "Generate OpenAPI spec [DOC]" --size small --deps t1,t2
   $XMB tasks update t{last} --done-criteria "valid spec, all endpoints documented"
   ```

   Tags: `[QA]` for quality tasks, `[DOC]` for documentation tasks, `[R1]` for requirement tasks. This makes CONTEXT.md → task traceability visible.

5. Register all tasks (requirement-derived + quality-derived). Pass `--desc` on every task:
   ```bash
   $XMB tasks add "Implement JWT auth [R1]" --size medium \
     --desc "Issue and verify JWTs for the login flow so protected routes can authenticate requests. Covers signing, expiry, and refresh-token rotation."
   $XMB tasks add "Create CRUD endpoints [R2]" --deps t1 --size medium \
     --desc "Expose REST endpoints for the core resource so the client can read/write data. Every mutation is gated by the auth from t1."
   # ... plus auto-injected [QA] and [DOC] tasks from step 4
   ```
   After registering all tasks, derive **done criteria** for each task from the PRD's Section 8 (Acceptance Criteria) and Section 5 (Requirements Traceability):
   ```bash
   $XMB tasks done-criteria
   ```
   This generates `done_criteria` for each task — a checklist of verifiable conditions that define "done."
   Quality Bar items from CONTEXT.md are injected into relevant task done_criteria automatically.
   If auto-generation is insufficient, manually set criteria:
   ```bash
   $XMB tasks update t1 --done-criteria "JWT issue/verify works, refresh token rotation implemented"
   ```

6. Validate the plan:
   ```bash
   $XMB plan-check
   ```
   This checks 11 dimensions: atomicity, dependencies, coverage, granularity, completeness, context, naming, tech-leakage, scope-clarity, risk-ordering, overall. Fix any errors.

6. **(Conditional) Strategic critique** — auto-skip when task count ≤ 5 (small project):
   ```bash
   $XMB discuss --mode critique
   ```
   - Reviews approach fitness, risk ordering, dependency structure, missing tasks, done-criteria quality, scope creep
   - If `verdict === "revise"`: apply action items, then re-run critique (`--round 2`)
   **Auto-skip rule**: If `tasks.length <= 5`, skip critique and proceed directly to step 7 (steps compute). Show: `"💡 Small project (≤5 tasks) — skipping strategic critique."` Critique is most valuable for complex plans (6+ tasks, cross-cutting dependencies).
   - If `verdict === "approve"`: proceed to step review

7. Compute steps + forecast:
   ```bash
   $XMB steps compute
   $XMB forecast
   ```
8. **Plan Review** — Show task list + DAG + forecast to the user and AskUserQuestion:
   ```
   Please review the plan:
   1) Approve — proceed to Execute
   2) Needs revision — add/remove/change tasks
   3) Consensus review — 4 agents review the full plan (PRD + tasks + DAG)
   4) Re-plan — start over from plan
   ```
   - "Approve" → gate pass
   - "Needs revision" → apply user feedback then re-run plan-check
   - "Consensus review" → run [Consensus Loop] against the full plan (PRD + tasks + DAG)
   - "Re-plan" → restart from PRD Review
9. Advance: `$XMB gate pass` → `$XMB phase next`

