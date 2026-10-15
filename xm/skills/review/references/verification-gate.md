# Project verification gate

Use a project gate for changes that require executable invariant checks and mutation checks.
Ordinary reviews do not require a gate.

Select a trusted project gate explicitly:

```bash
xm review prepare target.patch --context-file review-context.json --gate-file review-gate.json --json
xm review run target.patch --context-file review-context.json --gate-file review-gate.json --json
```

The gate runs before native worker dispatch or panel dispatch.
The bound review context supplies the invariant IDs.
Put exploration bounds, integration exclusions, and structural rules in that context.
Gate success does not determine LGTM.

## Configuration

List every source, test, manifest, fixture, and adapter file that the commands require.
Paths must be explicit and relative to the repository.
Git metadata, review state, and environment files are excluded.
Symlink and submodule entries from Git are not supported as gate inputs.

```json
{
  "schema_version": 1,
  "files": [
    "src/machine.mjs",
    "test/machine.test.mjs",
    "scripts/review-gate.mjs"
  ],
  "baseline": {
    "argv": ["node", "scripts/review-gate.mjs", "baseline"],
    "timeout_ms": 120000
  },
  "mutation": {
    "argv": ["node", "scripts/review-gate.mjs", "mutation"],
    "timeout_ms": 600000
  },
  "mutants": [
    {
      "id": "commit-after-effects",
      "invariant_id": "I1",
      "violation": "state must commit before effects"
    }
  ]
}
```

Use an installed interpreter for repository scripts.
Command arguments must use relative paths.
Each command has a timeout from 1 to 1800000 milliseconds.
Each output stream has a 4 MiB limit.
No package install occurs unless the selected command requests one.

## Adapter output

Each command must exit with code 0 and write exactly one JSON object to stdout.
Send diagnostic text to stderr.
The baseline must report at least one executed test:

```json
{"schema_version":1,"status":"passed","tests_run":166}
```

The mutation adapter must report every declared mutant exactly once:

```json
{
  "schema_version": 1,
  "mutants": [
    {
      "id": "commit-after-effects",
      "status": "killed",
      "test_executed": true,
      "violation": "state must commit before effects"
    }
  ]
}
```

Report `killed` only after the intended test executes and fails with the expected invariant violation.
Do not count a compile error, timeout, test omission, or unrelated failure as a killed mutant.
The lifecycle rejects any status other than `killed` and any violation that differs from the configuration.
The adapter owns test-runner output interpretation. Review that adapter as part of the declared inputs.
A text-only script such as PR #681's gate requires an adapter that emits this result contract.

## Isolation and evidence

Commands run in a separate directory with copies of the declared frozen files.
Commit reviews use committed bytes. Workspace reviews use the saved workspace bytes.
The process receives PATH, LANG, isolated HOME and TMPDIR, and a Git discovery boundary.
This is file isolation, not an operating-system security sandbox.
Only trusted project commands belong in a gate configuration.

The baseline must preserve declared inputs.
The mutation adapter must restore every declared input before it exits.
The lifecycle compares input hashes and removes its isolated work directory after execution.
It retains command logs and the verification receipt in the review run directory.

The receipt binds target, context, configuration, and input hashes to the baseline and mutation results.
Review prompts include that evidence. Completed results retain it.
Finalization rejects changed configuration or receipt bytes.

If a required gate fails, the lifecycle records an incomplete terminal receipt and stops before reviewer dispatch.
It does not record LGTM or start an automatic fix loop.
Survived mutants require a human decision about test gaps, equivalent mutants, or invalid mutations.
Gate failure consumes the reserved review unit. Use the existing approval rules for further work.

A delta review inherits the gate and executes it against the new frozen inputs.
A different gate requires an explicit full-review exception.
Resume and finalization do not execute a completed gate again.

## Optional mutation measurement

Attach an archived mutate report with an explicit trusted hash:

```json
{"measurement":{"file":"evidence/mutate.json","sha256":"<64 lowercase hex digits>"}}
```

Include that report and every measured input in `files`. The gate checks the report
hash, complete measurement status, stable inputs, and each input against frozen
bytes before baseline execution. An incomplete, stale, or changed report stops the
gate. Generic survivors remain advisory and cannot replace the declared rule
mutations. A delta needs fresh matching evidence if a measured input changes.

The repository example is `x-sync/review-gate.json` with
`x-sync/review-context.json`. It checks seven named sync regressions with actual
clients and an isolated SQLite server. Each mutation must fail its own invariant
assertion. Syntax errors and unrelated failures do not count as detection.
