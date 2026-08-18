# x-review Data Directory

State persistence layout and JSON/MD schemas for review artifacts.

## Directory Layout

Review state is stored in `.xm/review/`.

```
.xm/review/
├── last-result.json                    # Latest review result (JSON)
├── last-result.md                      # Latest review result (Markdown, human-readable)
├── triage.json                         # Review-fix decisions and allowed scope
├── review-fix-gate.json                # Exact authorization / completion receipt
├── finding-lifecycle.json              # Byte-bound per-finding lifecycle and evidence
├── runs/{task-id}/
│   ├── run.json                        # Expected task, target hash, and report instances
│   ├── validation.json                 # Machine-readable coverage gate receipt
│   └── reports/{report-id}.json        # Raw structured agent response
└── history/
    └── {YYYY-MM-DD}-{ref-slug}.md      # Past review reports
```

## Review Result MD Save (MANDATORY)

After every fully-covered review completes, save the Phase 4 final output as an MD file under `.xm/review/`. **This step cannot be skipped.** `runs/{task-id}/validation.json` must have `ok: true` first. An incomplete run keeps only its run/report/validation diagnostics and must not replace `last-result.*` or append history.

1. `last-result.md` — latest review result (overwrite)
2. `history/{YYYY-MM-DD}-{ref-slug}.md` — preserve history

**ref-slug generation:**
- `diff HEAD~1` → `head-1`
- `pr 142` → `pr-142`
- `diff main..HEAD` → `main-head`
- `full` → `full`
- `file src/auth.ts` → `file-src-auth-ts`

**MD file content:** Save Phase 4 final output (verdict, findings, summary table, observations) as-is.
Prepend metadata at the top of the file:
```markdown
# x-review: {target} — {verdict}
- Date: {YYYY-MM-DD HH:MM}
- Branch: {branch}
- Lenses: {lenses}
- Agents: {N}
- Findings: {count} (Critical: {n}, High: {n}, Medium: {n}, Low: {n})

---
{Phase 4 output}
```

## last-result.json Schema

```json
{
  "timestamp": "ISO8601",
  "target": { "type": "diff|pr|file", "ref": "HEAD~1|142|src/auth.ts" },
  "lenses": ["security", "logic", "perf", "tests"],
  "agents": 4,
  "coverage": { "expected": 4, "valid": 4, "complete": true },
  "target_coverage": { "expected": 12, "checked": 12, "complete": true, "missing_files": [] },
  "execution": {
    "mode": "adaptive-fast",
    "waves": 1,
    "backend": "current-runtime|panel",
    "models": ["resolved model labels"],
    "duration_ms": 84000,
    "retries": 0,
    "escalation_reasons": []
  },
  "task_id": "review-20260812T120000Z-123-456",
  "target_hash": "sha256:...",
  "reviewed_commit": "full HEAD commit SHA at Phase 1",
  "reviewed_files_all": ["src/auth.ts"],
  "reviewed_file_snapshots": [
    { "file": "src/auth.ts", "exists": true, "sha256": "64 lowercase hex characters" }
  ],
  "verdict": "LGTM|Request Changes|Block",
  "findings": [
    {
      "severity": "Critical|High|Medium|Low",
      "file": "src/auth.ts",
      "line": 42,
      "description": "SQL injection via unsanitized user input",
      "fix": "Use parameterized query",
      "lenses": ["security", "logic"],
      "sources": ["security", "logic"],
      "source_count": 2,
      "confidence": "corroborated",
      "consensus": true
    }
  ],
  "summary": {
    "security": { "total": 2, "critical": 1, "high": 1, "medium": 0, "low": 0 },
    "logic":    { "total": 1, "critical": 0, "high": 1, "medium": 0, "low": 0 },
    "perf":     { "total": 1, "critical": 0, "high": 0, "medium": 1, "low": 0 },
    "tests":    { "total": 0, "critical": 0, "high": 0, "medium": 0, "low": 0 }
  }
}
```

`reviewed_commit` is required: `x-build verify-review-fix` anchors triage freshness on it and fails closed when it is missing.
`reviewed_files_all` is the complete Phase-1 target file set, including files with no findings.
`coverage` measures valid reviewer responses; `target_coverage` measures frozen target files
actually inspected. Both must be complete before LGTM.
At Phase 1, hash each current file's raw bytes with SHA-256 and persist it in
`reviewed_file_snapshots`; deleted/absent target files use `{ "exists": false, "sha256": null }`.
These snapshots bind the later review-fix gate to the bytes the agents actually reviewed. Do not
compute them at Phase 4: a file that changes while agents are running must make the review stale.

For diff/PR targets, derive `reviewed_files_all` from the resolved target's changed-file list. For
file targets, use the explicit file set; for `full`, use the collected full-review file set. A
Request Changes / Block result without complete snapshots is not eligible for review-fix and must
be reviewed again.

`finding-lifecycle.json` gives every finding a stable content-derived `finding_id` while retaining
the positional `F#` compatibility ID. A `fix_now` finding moves through
`open → fix_authorized → fixed → reverified`. Reverification stores `resolved`, `persistent`, or
`regression`, its evidence, and the current file snapshot; changing those bytes invalidates it.

## Applies to

Phase 4 finalization writes `.xm/review/last-result.{md,json}` + appends to history only after the lens report coverage validator passes.
