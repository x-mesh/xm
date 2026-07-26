# x-review — x-build Integration

How x-review is consumed as a quality gate in x-build's Verify phase, with x-eval scoring and x-memory persistence.

## Usage From x-build

Used as a quality gate in x-build's Verify phase:

```
# Full diff review in the Verify phase
/xm:review diff HEAD~{step_count}

# If Request Changes / Block:
x-build verify-review-fix --init
# edit .xm/review/triage.json
x-build verify-review-fix

# Then apply only fix_now changes, run quality, and re-review
x-build quality
/xm:review diff
```

## x-build Verdict-to-Gate Mapping

| x-review Verdict | x-build Action |
|------------------|----------------|
| LGTM | `x-build gate pass "x-review LGTM"` |
| Request Changes | Run Review-Fix Gate, apply only triaged `fix_now` changes, then re-review |
| Block | `x-build gate fail "Critical issues found"` — blocks phase next |

## Review-Fix Gate

`x-build verify-review-fix` prevents the common LLM loop where review feedback turns into an unbounded second implementation pass.

Required sequence:

1. `x-build verify-review-fix --init` creates `.xm/review/triage.json` from `.xm/review/last-result.json` and records the current changed-file baseline.
2. Triage every Medium+ finding:
   - `fix_now` for issues fixed in this loop
   - `backlog` for Medium/Low deferral only
   - `accept_risk` or `false_positive` only with evidence
3. Keep `fix_scope.allowed_files` narrow. Add test files only when they verify a `fix_now` finding.
4. Run `x-build verify-review-fix` before and after applying fixes.
5. Any new changed file outside `fix_scope.allowed_files` after the baseline fails the gate.
6. Capture unrelated, non-blocking findings with `x-build later add` instead of editing them in the review-fix loop.

Critical/High findings cannot be moved to `backlog`; they must be fixed, accepted with evidence, or marked false-positive with evidence.

## x-eval Scoring Integration

After review completion, findings can be auto-scored via x-eval:

```
/xm:eval score ".xm/review/last-result.json" --rubric review-quality
```

`review-quality` rubric criteria:
- **coverage** (0.30): Were all perspectives sufficiently covered
- **actionability** (0.30): Are findings specific and fixable
- **accuracy** (0.25): Are there no false positives
- **severity-calibration** (0.15): Are severity levels appropriate

## x-memory Integration

Recurring Critical/High findings are auto-saved to x-memory:
```
x-memory save --type failure --title "SQL injection in auth module"
  --why "x-review detected SQLi in 3 consecutive reviews"
  --tags "security,auth,recurring"
```

Condition: Auto-suggested when Critical/High is found 2+ times at the same file/pattern.

## Applies to

Invoked from x-build Verify phase; results feed x-eval scoring, x-memory auto-save, and the Review-Fix Gate.
