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
  "context_hash": "sha256:{context hash copied exactly for bound runs; omit for absent runs}",
  "report_id": "{unique report instance copied exactly from the dispatch}",
  "lens": "{lens copied exactly from the dispatch}",
  "status": "complete",
  "checked": ["concrete path, boundary, or behavior examined"],
  "checked_files": ["src/example.ts"],
  "findings": [
    {
      "severity": "Critical|High|Medium|Low",
      "file": "src/example.ts",
      "line": 42,
      "description": "specific defect and reachable consequence",
      "code": "the relevant 3-5 source lines; diff markers are optional for diff targets",
      "why": "the lens severity criterion that applies",
      "fix": "one-line actionable correction"
    }
  ],
  "no_findings_reason": "required only when findings is empty: specific evidence for why the checked paths are sound"
}
```

Rules:

- Echo `task_id`, `target_hash`, `report_id`, and `lens` literally. For `context_status: bound`, also echo `context_hash` literally. Omit it for legacy `absent` runs.
- `report_id` identifies one agent execution, not merely a lens. Redundant runs use distinct IDs
  such as `security-1`, `security-2`, and `security-3`.
- For chunked reviews, each `expected_reports[]` entry binds one `chunk_id`, `wave`,
  `target_hash`, and `target_files`. Echo that chunk hash. Coverage is complete only when every
  selected profile returns a valid report for every chunk. The validator compares `profiles`,
  `chunks`, and `expected_reports` as a Cartesian product, so a missing profile/chunk pair fails
  before synthesis.
- `checked` must contain at least one concrete path, branch, boundary, data flow, or behavior.
- `checked_files` must list every frozen target file actually inspected. When `run.json` contains
  `target_files`, the validator rejects paths outside that set and refuses finalization until their
  union covers the target. Multi-file frozen targets must contain one `diff --git` section per file
  and the section file set must exactly equal `target_files`, so finding snippets can be grounded
  in the claimed file. This is source coverage, separate from
  N/N report coverage.
- A real finding must populate every finding field. `line` is a positive integer.
- For diff targets, `code` may include the leading `+`, `-`, or space marker from the frozen
  patch; validation removes one marker from both the target and finding before grounding. For raw
  `file` targets, leading `+` and `-` are source bytes and remain significant.
- With zero findings, return `findings: []` and a specific `no_findings_reason`. An empty response
  or bare "No findings" is not a completed review.
- If the target was unavailable or could not be reviewed, use `status: "failed"`; the validator
  reports it as a single `report_failed` issue and the leader re-dispatches that `report_id`.
  Never claim `complete` without inspecting the supplied target.
- The report must come from your own analysis of the supplied target. Do not invoke a review
  skill/command and do not spawn subagents to produce it — see "Execution Boundary" in the
  universal principles block prepended to this prompt.

## Applies to

Phase 3 single-vendor lens responses. The leader validates them with
`scripts/validate-reports.mjs` before Phase 4.
