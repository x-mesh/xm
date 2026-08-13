# x-review Lens Report Contract

Every Phase 3 lens response is machine-validated before synthesis. The leader appends this
contract after the selected lens prompt, replacing that prompt's presentation-only output
example. Return exactly one JSON object with no Markdown fence, greeting, status preamble, or
trailing prose.

```json
{
  "schema_version": 1,
  "task_id": "{task_id copied exactly from the dispatch}",
  "target_hash": "sha256:{hash copied exactly from the dispatch}",
  "report_id": "{unique report instance copied exactly from the dispatch}",
  "lens": "{lens copied exactly from the dispatch}",
  "status": "complete",
  "checked": ["concrete path, boundary, or behavior examined"],
  "findings": [
    {
      "severity": "Critical|High|Medium|Low",
      "file": "src/example.ts",
      "line": 42,
      "description": "specific defect and reachable consequence",
      "code": "the relevant 3-5 diff lines",
      "why": "the lens severity criterion that applies",
      "fix": "one-line actionable correction"
    }
  ],
  "no_findings_reason": "required only when findings is empty: specific evidence for why the checked paths are sound"
}
```

Rules:

- Echo `task_id`, `target_hash`, `report_id`, and `lens` literally. Do not infer or regenerate them.
- `report_id` identifies one agent execution, not merely a lens. Redundant runs use distinct IDs
  such as `security-1`, `security-2`, and `security-3`.
- `checked` must contain at least one concrete path, branch, boundary, data flow, or behavior.
- A real finding must populate every finding field. `line` is a positive integer.
- With zero findings, return `findings: []` and a specific `no_findings_reason`. An empty response
  or bare "No findings" is not a completed review.
- If the target was unavailable or could not be reviewed, use `status: "failed"`; the leader
  will re-dispatch it. Never claim `complete` without inspecting the supplied target.

## Applies to

Phase 3 single-vendor lens responses. The leader validates them with
`scripts/validate-reports.mjs` before Phase 4.
