---
name: mutate
description: Run mutation testing for an existing x-build task to check whether current tests detect bounded source changes. Use for /xm:mutate, $xm:mutate, $xm-mutate, mutation testing, surviving mutants, or requests to find test detection gaps. Does not generate test code.
allowed-tools:
  - Bash
  - AskUserQuestion
---

# x-mutate

This is a thin interface over `xm build mutate`; the x-build engine remains the only mutation, timeout, restore, report, and ledger implementation.

## Workflow

1. Read `$ARGUMENTS` as `<task-id> [--project NAME] [--max-mutants N] [--timeout-ms M] [--json]`. Accept an optional leading `--task`.
2. If the task id is missing, run `xm build mutate --list --json`. This command is read-only and never runs mutations.
3. From `tasks`, prefer `runnable: true` candidates and show up to three structured choices. Each choice must include `project/id`, task name, status, and target files. Use AskUserQuestion once and stop until the user chooses. Do not guess or auto-select, even when there is only one candidate.
4. If no runnable candidate exists, show the returned reasons. Explain that mutation testing needs an x-build task with a worktree artifact, supported target files, and a test command; do not run mutation testing.
5. After selection, pass both `--project <project>` and `--task <id>` so duplicate task IDs cannot select the wrong project.
6. State that this checks existing tests and does not create tests.
7. Run exactly one mutation command after selection: `xm build mutate --project <project> --task <task-id>` plus only the supplied supported options. Do not translate the request into arbitrary shell or test commands.
8. Report the counts and explain: `killed` means a test detected the mutation; `survived` means a test gap candidate; `timeout` means the configured test exceeded its limit; `skipped` means the wall budget or interruption prevented execution.
9. Surface `baseline` failure as an invalid test setup, not a successful mutation result. Point to `.xm/review/mutate-<task-id>.json` when a report was written.

## Safety

- Never write mutation logic in this skill or edit source/test files directly.
- Never claim that a surviving mutant proves a missing test; it is a focused candidate for inspection.
- Do not retry a timeout or baseline failure automatically.
- Do not treat survived mutants as a merge-blocking result; v1 is observational.
