# Subcommand: score

N judge agents independently score content against a rubric. Usage: `/xm:eval score <content> --rubric <name> [--judges N] [--grounded]`.

## Subcommand: score

**N judge agents independently score content against a rubric.**

### Parsing

From `$ARGUMENTS`:
- After `score` = content to evaluate (quoted text or file path)
- `--rubric <name>` = rubric name or criteria (comma-separated custom criteria)
- `--judges N` = number of judge agents (default 3)
- `--model` = judge model (default sonnet)
- `--run-id <id>` = caller-provided execution ID, copied into the result JSON
- `--source-plugin <name>` = caller identifier, e.g. `x-op`
- `--source-strategy <name>` = caller strategy name when scoring x-op output
- `--source-result <path>` = originating result file, e.g. `.xm/op/{file}.json`

If content is a file path, read the file and pass its contents.
If `--rubric` is empty, use the `general` rubric.
- `--grounded` = enable Agent-as-Judge mode (judges use Read/Bash/Grep tools to verify claims)
- `--assert "<statement>"` = add a binary outcome assertion (repeatable; evaluated after rubric scoring)

### Judge Count

Judge count is specified via `--judges N`, or uses the agent_max_count value (default 4).

`--judges N` overrides agent_max_count when specified.

### Judge Panel Composition (Bias Mitigation)

**N judges from the same model = N copies of the same bias.** The judge panel must diversify its biases.

**Default 3-judge composition:**

| Judge | Model | Role | Purpose |
|-------|-------|------|---------|
| Judge 1 | sonnet | Standard Judge | Standard rubric scoring |
| Judge 2 | sonnet | Standard Judge | Independent scoring (same prompt) |
| Judge 3 | sonnet | **Adversarial Judge** | Defect detection specialist — separate prompt below |

**5+ judge composition (--judges 5 or more):**

| Judge | Model | Role |
|-------|-------|------|
| Judge 1-2 | sonnet | Standard Judge |
| Judge 3 | opus | Standard Judge (different model perspective) |
| Judge 4 | sonnet | Adversarial Judge |
| Judge 5 | haiku | Fast Judge (cost-efficient cross-validation) |

### Judge Prompts

**Standard Judge Prompt** — Invoke via Agent tool (`run_in_background: true`):

See `judges/evaluation.md` — scores each criterion 1–10 with justification, computes weighted average as Final Score.

**Adversarial Judge Prompt** — Assign to the last judge:

See `judges/adversarial.md` — actively finds fabrications, severity inflation, unverified claims; scores lower when found.

Each judge scores independently. No identifiers beyond role are assigned to prevent order bias.

### Assertion Mode (`--assert`)

When one or more `--assert "<statement>"` flags are provided:

1. After the rubric judge panel completes, launch a dedicated **Assertion Judge** (see `judges/assertion.md`) via Agent tool.
2. The assertion judge evaluates each statement as PASS or FAIL based solely on evidence in the content.
3. Aggregate across all assertion-judge instances (same judge count as rubric):
   - **HARD FAIL**: majority (≥ ⌈N/2⌉ judges) mark FAIL → forces `passed = false` regardless of rubric score
   - **UNCERTAIN**: minority fail → warning printed, `passed` unaffected
   - **PASS**: all judges pass → no impact
4. Print assertion table above the rubric criterion table.
5. Record `assertion_results` in the result JSON (see `references/storage-layout.md`).

**Key rule:** Assertions are mandatory requirements. A rubric score of 9/10 with a HARD FAIL assertion is still a failure. The rubric measures quality; assertions enforce constraints.

**Example:**
```
/xm:eval score my_solution.py --rubric code-quality \
  --assert "function handles head=None" \
  --assert "no global mutable state" \
  --assert "iterative, not recursive"
```

### Executable Assertions (`--assert-cmd` / `--assert-file` / `--assert-grep` / `--assert-json`)

Choose the evaluation method by what settles the question, not by habit:

| Question | Method |
|---|---|
| A command can answer it (tests pass, build succeeds, file exists, pattern absent) | **executable assertion** — `xm eval assert` |
| Qualitative, needs reading and judgment | rubric judge panel |
| A statement no command can settle ("handles head=None gracefully") | `--assert` (judge-evaluated, see `judges/assertion.md`) |
| Gating decisions | executable assertions + a rubric whose `calibrate` result is current |

Executable assertions run **before** the judge panel, through the dispatcher (never a shell string):

> **⚠ Call `xm eval assert` directly. Claude Code's Bash tool starts a fresh shell on every invocation — shell functions defined in one call do NOT persist to the next. Never define a helper across calls; always use the dispatcher.**
>
> **Fallback** (only when `xm` is not in PATH — rare; `${CLAUDE_PLUGIN_ROOT}` is NOT exported to Bash subprocesses, so don't rely on it bare):
> ```bash
> XMEV_CLI=$(ls -d ~/.claude/plugins/cache/xm/{eval,xm}/*/lib/x-eval-cli.mjs 2>/dev/null | sort -V | tail -1)
> node "$XMEV_CLI" assert [args]
> ```
>
> **Forbidden:** `XMEV="node ..."; $XMEV assert` — zsh treats the quoted string as a single command and fails.

```bash
xm eval assert --cmd 'tests=bun test test/auth.test.mjs' \
  --file 'migration=exists=db/migrations/0042_auth.sql' \
  --grep 'no-eval=!eval\(:src/auth.ts' \
  --json-eq 'strict=compilerOptions.strict=true:tsconfig.json' --json
# → {"results":[{"name","kind","result":"PASS"|"HARD_FAIL","exit_code","duration_ms","command_sha256",...}],"passed":bool,"source":"executable"}
```

Rules:
1. Assertions run without a shell: quote arguments, no `| ; & $ > <`. A pipeline belongs in a script; assert the script.
2. Any executable `HARD_FAIL` forces `passed = false`, exactly like a judge-majority FAIL. Exit code 1 from `xm eval assert` is that signal; exit 2 is a usage error (fix the flag, do not treat as FAIL).
3. Copy every result row into `assertion_results[]` with `source: "executable"` (schema in `references/storage-layout.md`). Never paste command output into the result file — the runner does not return it, and the judge must not see it either.
4. Print the assertion table above the rubric table, executable rows first.

### Grounded Mode (`--grounded`)

When `--grounded` is specified, judges switch from text-only reasoning to **tool-assisted verification**.

**Grounded Standard Judge Prompt** — replaces the standard prompt when `--grounded`:

See `judges/grounded.md` — tool-assisted verification (Read/Grep/Bash); falsified claims score 1, unverifiable = neutral.

**Grounded Adversarial Judge Prompt** — replaces the adversarial prompt when `--grounded`:

See `judges/grounded-adversarial.md` — tool-assisted disproof of claims; falsified file:line caps criterion score at 3.

**When NOT `--grounded`:** Use the original text-only prompts above (default behavior preserved).

**Result schema addition:** When `--grounded`, append to result JSON:
```json
{
  "grounded": true,
  "evidence_sources": { "tool_call": N, "reasoning_only": M },
  "verified_ratio": N / (N + M)
}
```

### Reusable Judge Prompt (Standard Prompt)

This prompt is reused across the xm ecosystem whenever a judge panel is needed:
- **x-build prd-gate**: PRD scoring (rubric: plan-quality or prd-gate's 5-criteria rubric)
- **x-op --verify**: Strategy result scoring (rubric: see strategy-rubric mapping table)
- **x-eval score**: General scoring (rubric: user-specified or built-in)

Callers only need to substitute `{rubric_name}`, `{criteria_list}`, and `{content}`.
If weights are not specified, equal weights are assigned to all criteria.

### Consensus Assessment (sigma-based + bias check)

| sigma | Consensus | Action |
|---|------|------|
| < 0.8 | High agreement | **Shared bias risk — compare against Adversarial Judge score.** If adversarial is 2+ points lower, standard judges are sharing bias. Apply adversarial score with extra weight (1.5x). |
| 0.8–1.5 | Medium | Use scores, flag with caution. Show Adversarial Judge opinion separately. |
| > 1.5 | Low — genuine disagreement | Summon 1 additional judge (different model). If σ > 1.5 after re-scoring, mark as "no verdict". |

**Key principle: Low σ means "needs verification", not "certainty".**

When the same model converges on the same prompt, this may not be a signal of accuracy — it may just be repeating the model's mode. The Adversarial Judge is the only cross-validation mechanism.

**Adversarial divergence interpretation:**

| Standard avg | Adversarial | Gap | Interpretation |
|---|---|---|---|
| 8.0 | 7.5 | 0.5 | Normal — difference in perspective |
| 8.0 | 5.0 | 3.0 | **Shared bias detected** — adversarial caught defects that standard judges missed. Final score = (standard × 0.6 + adversarial × 0.4) |
| 8.0 | 2.0 | 6.0 | **Serious quality issue** — looks good on the surface but has fundamental flaws. Final score = adversarial score takes priority |

### Result Aggregation and Output

After all judges complete, aggregate:

```
📊 [eval] Score: 7.2/10 (3 judges — 2 standard + 1 adversarial)
Rubric: code-quality

| Criterion       | J1 (std) | J2 (std) | J3 (adv) | Avg  |
|-----------------|----------|----------|----------|------|
| Correctness     |  9       |  8       |  5       | 7.3  |
| Readability     |  7       |  8       |  7       | 7.3  |
| Maintainability |  8       |  7       |  7       | 7.3  |
| Security        |  6       |  7       |  3       | 5.3  |
| Test Coverage   |  8       |  9       |  8       | 8.3  |

Standard avg: 7.7/10 | Adversarial: 5.8/10 | Gap: 1.9
Bias check: ⚠ Gap > 1.5 — 표준 judge가 놓친 결함 있음. Adversarial 가중 반영.
Adjusted score: 7.2/10

Adversarial findings:
- Correctness: "2 of 6 findings reference files not confirmed in diff"
- Security: "CORS finding lacks credential-mode evidence"

Notable: Adversarial judge가 정확도 문제를 잡음 — 표준 judge만으로는 놓쳤을 편향.
```

**Score calculation:**
- σ < 0.8 between standard judges (high agreement) → check for shared bias
- Adversarial gap > 1.5 → adjusted score = standard × 0.6 + adversarial × 0.4
- Adversarial gap ≤ 1.5 → adjusted score = simple average (all judges)

**N/A criterion handling:**
- If a judge scores a criterion `N/A`, exclude it from that judge's weighted average (renormalize remaining weights per `judges/reusable.md`)
- Per-criterion aggregate: compute avg only over judges who provided a numeric score (skip N/A judges for that criterion)
- If ALL judges score a criterion `N/A`, omit it entirely from the output table and annotate: `(criterion skipped — insufficient context)`
- Record `na_criteria: ["security"]` in the result JSON for auditability
- Do NOT default N/A to 5 or any numeric value — silent substitution defeats the purpose

### Cross-Vendor Judges (`--cross-vendor`)

Replaces the same-model judge panel with one judge per model VENDOR. Resolution:
`--cross-vendor` / `--no-cross-vendor` flag → `.xm/config.json` `cross_vendor.eval` ??
`cross_vendor.default` ?? false.

> **⚠ Call `xm panel …` directly via the dispatcher (Bash) — never import, never define shell helpers.**

1. **Probe** — `xm panel detect --auth --json`. Fewer than 2 ready vendors → fall back to the
   standard single-vendor panel above and SAY SO (loud, L6): "cross-vendor requested but only N
   vendor(s) ready (<list>) — running single-vendor; `xm panel doctor` to fix auth."
2. **Announce** — vendor set + rough cost (vendors × 1 judge call) BEFORE spending.
3. **Judge** — write ONE judge prompt file (the standard Evaluation Judge prompt from
   `judges/evaluation.md`, verbatim — same strict `Criterion: <name> | Score: <N> | Reason:` output
   contract so parsing is unchanged), then a single call fans it to every vendor:
   ```bash
   xm panel cross --models "<ready-vendors>" --prompt-file <judge-prompt> --json \
     --source eval:judge --title "<what is being judged>"
   ```
4. **Composition change (intentional)** — there is NO separate adversarial judge in cross-vendor
   mode: genuinely different model families replace the adversarial role, and cross-vendor
   disagreement IS the bias check. The leader still applies the fabrication sanity check from
   `judges/adversarial.md` to the aggregate (flag unverifiable claims; do not score them).
5. **Aggregate** — parse each vendor's `Criterion/Final` lines. Report per-criterion mean AND
   **cross-vendor σ** (spread across vendors). σ > 1.5 on a criterion = real cross-model
   disagreement → surface that criterion for human review instead of hiding it in the mean.
   Name every vendor that failed/was excluded (a 2/4 panel is not a 4/4 panel). A vendor whose
   output does not contain parseable `Criterion:` lines counts as FAILED (excluded + named),
   never silently coerced.
6. **Provenance (REQUIRED)** — the saved result JSON must carry
   `cross_vendor: { requested, effective, failed[], run_ref: ".xm/cross/<run>/", per_vendor_raw[] }`
   (same contract as x-op's cross-vendor persistence rule) so each vendor-attributed score is
   auditable against its raw output. `judges` becomes the vendor list, not a count alone.

### Storage

Save results to `.xm/eval/results/{timestamp}-score.json`.

When x-op invokes `score` through `--verify` or `eval.auto`, it must pass `--run-id`, `--source-plugin x-op`, `--source-strategy`, and `--source-result`. The saved result JSON then includes those fields so `.xm/op/{file}.json` and `.xm/eval/results/{file}.json` can be joined by `run_id`.

**Transcript preservation:** When `eval.persist_transcripts` (default `true`) is on, write each judge's per-criterion reasoning into `judge_rationales` on the result JSON (see `references/storage-layout.md` score schema). This powers `report --sample-transcript` so reviewers can audit scores, not just trust aggregates. Setting `eval.persist_transcripts: false` in `.xm/config.json` skips the field for users with storage concerns.

**Pass marker:** record `pass_threshold` (resolved from the rubric at evaluation time) and `passed = (overall >= pass_threshold)` on every score result. `bench` consumes these to compute pass@k / pass^k without re-reading rubrics.

## Applies to
Invoked via `/xm:eval score ...`. See Subcommand: list in SKILL.md for all available commands.
