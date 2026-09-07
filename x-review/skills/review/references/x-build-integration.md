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

# Then apply only fix_now changes, run quality, and re-review the fix delta once
x-build quality
/xm:review diff <last-result.reviewed_commit>
```

## x-build Verdict-to-Gate Mapping

| x-review Verdict | x-build Action |
|------------------|----------------|
| LGTM | `x-build gate pass "x-review LGTM"` |
| Request Changes | Run Review-Fix Gate, apply only triaged `fix_now` changes, then re-review |
| Block | `x-build gate fail "Critical issues found"` — blocks phase next |

## Bounded Convergence

The initial run reviews the complete target. The Review-Fix Gate permits one bounded fix pass.
One automatic delta review uses that task's saved baseline. Commit reviews use `reviewed_commit` SHAs, and worktree reviews use saved bytes.
Original coverage and byte-bound disposition evidence remain authoritative. Do not run a
native x-panel review after x-review or restart the full PR review after every fix.

If the delta introduces any new finding, stop and report it at every severity.
Do not start another automatic edit, review, or merge. Additional work requires a recorded user approval and reason.

## Review-Fix Gate

`x-build verify-review-fix` prevents the common LLM loop where review feedback turns into an unbounded second implementation pass.

Required sequence:

1. `x-build verify-review-fix --init` first verifies the complete `reviewed_files_all` SHA-256 snapshot, then creates `.xm/review/triage.json` and records the current changed-file baseline. Any target-byte change requires a new x-review.
2. Triage every Medium+ finding:
   - `fix_now` for issues fixed in this loop
   - `backlog` for Medium/Low deferral only
   - `accept_risk` or `false_positive` only with evidence
3. Keep `fix_scope.allowed_files` narrow. Add test files only when they verify a `fix_now` finding.
4. Run `x-build verify-review-fix` before applying fixes to authorize the exact triage. Only the authorized `fix_scope.allowed_files` may then differ from the reviewed snapshot. Editing triage invalidates the authorization and requires a fresh pre-fix gate.
5. After a `fix_now` edit, reverify each finding with `x-build verify-review-fix --reverify <F#|finding_id> --outcome resolved|persistent|regression --evidence <text>`. The byte-bound lifecycle is `open → fix_authorized → fixed → reverified`; later file changes invalidate the receipt, and non-`resolved` outcomes block completion.
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
x-memory save "SQL injection in auth module" --type failure --why "x-review detected SQLi in 3 consecutive reviews" --tags "security,auth,recurring"
```

Condition: Auto-suggested when Critical/High is found 2+ times at the same file/pattern.

## Applies to

Invoked from x-build Verify phase; results feed x-eval scoring, x-memory auto-save, and the Review-Fix Gate.

## Bounded review fixes

The lifecycle reserves `full=1, fix=1, delta=1` for each worktree task.
The first approved fix scope consumes the fix budget. Revalidation of the same approval does not consume another unit.
A new delta finding requires a report and stop at every severity. No additional automatic fix, review, or merge follows.
The Stop hook permits termination. The Review-Fix Gate retains merge restrictions for unresolved blockers.
Use an approved one-time exception with a reason for additional work. Never reset task usage.
