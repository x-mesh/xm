---
name: mutate
description: Run mutation testing on changed lines to check whether existing tests detect small source changes, using cargo-mutants (Rust), StrykerJS (JS/TS), gomutants (Go), and Muter (Swift). Use for /xm:mutate, $xm:mutate, $xm-mutate, mutation testing, surviving mutants, or requests to find test detection gaps. Does not generate test code.
allowed-tools:
  - Bash
  - AskUserQuestion
---

# x-mutate

<Purpose>
Check whether the tests already in a repository detect bounded changes to the lines a branch or an x-build task changed. This skill is a thin interface over `xm mutate` and `xm build mutate`: external tools generate and run every mutant, and the xm engine owns the change set, the report, and the attention ledger.
</Purpose>

<Use_When>
- The user asks for mutation testing, surviving mutants, or whether the tests would catch a bug in changed code.
- The user invokes /xm:mutate, $xm:mutate, or $xm-mutate.
</Use_When>

<Do_Not_Use_When>
- The user wants tests written or generated. This skill only measures existing tests.
- Every changed file is in a language without an adapter. Only rust, javascript (JS/TS), go, and swift are supported.
</Do_Not_Use_When>

## Workflow

1. Read `$ARGUMENTS` as one of two forms. Never interpolate the raw `$ARGUMENTS` string into a shell command.
   - Diff mode: `--diff <base> [--lang <names>] [--timeout-ms N] [--json]`
   - Task mode: `<task-id> [--project NAME] [--base REF] [--lang <names>] [--timeout-ms N] [--json]`, with an optional leading `--task`
2. With no arguments, ask once with AskUserQuestion: diff mode against a base, or an x-build task. For diff mode, offer only branches that `git branch --list main master develop` reports, and let the user name another ref. Do not guess the base.
3. Task mode without a task id: run `xm build mutate --list --json`. This command is read-only and never runs mutations.
   - From `tasks`, prefer `runnable: true` rows and show up to three structured choices. Each choice must include `project/id`, task name, status, and changed files. Use AskUserQuestion once and stop until the user chooses. Do not guess or auto-select, even when there is only one candidate.
   - If no row is runnable, show the returned reasons and offer diff mode instead.
   - If a task id was supplied without a project, still run the read-only list. Filter rows by exact id. Use the sole exact project match, ask the user to choose when multiple projects match, and stop with the returned reason when none is runnable.
4. Validate before running. Project and task use letters, digits, `.`, `_`, `-`, and never `..`. A base must not start with `-`. `--lang` takes a comma list of `rust`, `javascript`, `go`, `swift`. `--timeout-ms` is a positive integer.
5. State that this checks existing tests and does not create tests.
6. Run exactly one command, in the foreground, with each dynamic value passed as a separately shell-quoted argument. Tools can take minutes.
   - Diff mode: `xm mutate --diff <base>` plus only the supplied supported options.
   - Task mode: `xm build mutate --project <project> --task <task-id>` plus only the supplied supported options. Use the exact project/id from the list result.
   - Do not translate the request into arbitrary shell, test, or tool commands.
7. Report per language, then the survivors:
   - `killed`: a test detected the mutant. `survived`: a candidate test gap. `timeout`: the mutant made the tests hang. `unviable`: the mutant did not build, which says nothing about the tests. `no_coverage`: no test executed that code. `skipped` or `error`: the tool produced no verdict.
   - A language with status `unavailable` names the missing tool or configuration and an install command. Relay both.
   - `baseline_failed`, or an `error` whose output tail shows failing tests, means the suite already fails. Report an invalid test setup, not a mutation result.
   - Point to the `Report:` path the command printed.
8. Exit code 1 means at least one language could not run. The results for the other languages are still valid.

## Safety

- Never write mutation logic in this skill or edit source/test files directly.
- Never install a tool, add a dependency, or run `muter init` without the user's approval.
- Never claim that a surviving mutant proves a missing test; it is a focused candidate for inspection.
- Do not retry a timeout, `baseline_failed`, `error`, or `unavailable` language automatically.
- Do not treat survived mutants as a merge-blocking result; the check is observational.
- When Swift ran, mention that Muter leaves `<root>_mutated` next to the project and `muter_logs/` inside it.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The tool is not installed, so I will install it and finish the run." | Installing changes the user's machine or the project's dependencies. Relay the `install` command and let the user decide. |
| "No tool covers this language, so I will mutate the code by hand." | Hand-made mutants skip the build check that separates `unviable` from `killed`. That false confidence is what the external tools replaced. |
| "Only one task is runnable, so I will pick it." | Choosing the target is the user's call, even with one candidate. Ask once. |
| "The base is probably main." | A wrong base mutates the wrong lines, and the report still looks valid. Ask for the base. |
| "These survivors show which tests are missing." | A survivor can be an equivalent mutant that no test could catch. Present survivors as candidates to inspect. |
| "An unviable mutant was stopped, so it counts as caught." | It never ran against the tests. Report it separately from `killed`. |
| "The run timed out, so I will retry with a larger --timeout-ms." | A retry spends minutes of CPU without approval. Report the timeout and name the flag. |
