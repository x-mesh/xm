---
name: gate
description: Create or extend a project review gate from explicit invariants and reproducible defects, with regression tests and rule-specific mutations. Reuse xm mutate for existing-test detection measurements. Use when a user requests executable invariant checks or gate creation, or review identifies an authorized gate coverage gap. Ordinary mutation measurement belongs to mutate.
---

# Gate authoring

Write project tests, a gate configuration, and its JSON adapter. Do not implement
another mutation-tool runner. Review owns dispatch, verdict, terminal actions,
and the full/fix/delta budget. This skill owns one bounded authoring pass.

## Select the work

- Reuse a gate that already protects the affected invariants. Extend it only for
  a documented coverage gap or a reproducible defect.
- Risk determines whether a gate is needed and how much validation to spend.
  Derive test assertions and mutations from rules, state transitions, and concrete
  counterexamples. A severity label alone cannot define a test oracle.
- Gate creation needs authorization for the exact test, adapter, and configuration
  files. A read-only review request does not authorize new project edits. Preserve
  approval already given in the session rather than asking for it again.
- Run in the current process. Do not invoke the review skill, dispatch reviewers,
  or spawn agents. The `xm review author-gate` reservation below is permitted.

## Reserve once, then author

1. Establish the stable review operation ID with the calling review. Retain it
   through gate authoring, review, fixes, and delta review. Never invent a fresh ID
   or worktree to recover a spent authoring allowance.
2. Read the project specification and affected source and tests. Derive explicit
   invariant IDs and write the existing review context JSON. Record exploration
   bounds, structural checks, integration exclusions, and acceptance checks.

   ```json
   {
     "schema_version": 1,
     "goal": "Commit state before observer effects",
     "invariants": [{"id":"I1","text":"Observers see the committed state"}],
     "constraints": [],
     "non_goals": [],
     "acceptance_checks": [{"id":"C1","description":"Check I1 and its ordering mutation"}]
   }
   ```

   Non-empty `constraints` and `non_goals` also contain `{id,text}` objects, not
   strings. Acceptance checks contain `{id,description}` and an optional `command`
   string. IDs are unique across all sections. Keep this context unchanged after
   reservation; the calling review must use its exact canonical hash.
3. Write a scope JSON object with the exact authorized output paths:

   ```json
   {"files":["test/machine.test.mjs","scripts/machine-gate.mjs","review-gate.json"]}
   ```

4. Before project edits, reserve the one authoring pass:

   ```bash
   xm review author-gate --operation-id OPERATION --context-file CONTEXT --scope-file SCOPE --reason "Concrete coverage gap" --json
   ```

   Save the returned `authoring` record and `run_dir`. This reservation is not a
   review run, a validated baseline, or a terminal receipt. A second reservation,
   an active review, or a completed delta stops authoring. A failure does not refund
   the reservation. New independent operations require the existing explicit
   `--new-operation --approved-by USER --reason TEXT` authorization path.
   The reservation also saves a hash-bound workspace baseline. Before the first
   review freeze, the lifecycle rejects modified, added, or deleted visible files
   outside the approved authoring paths. Pre-existing changes are preserved.
   Review-state files and Git-ignored files are outside that comparison. Subsequent
   review fixes and deltas follow their existing scope and budget rules instead.
   If the saved baseline is absent or changed, stop. Do not rebuild it from the
   current workspace to bypass the check.
5. When general test-detection measurement is needed, use the existing mutate skill
   in the exact project and base already resolved by review:

   ```bash
   xm mutate --diff BASE --json
   ```

   Use task mode through that skill when the caller supplies an x-build task.
   Do not reimplement language detection, external-tool execution, outcome parsing,
   or mutation reporting. Preserve its timeout, installation, and no-auto-retry
   rules. Its report is advisory evidence: survivors are candidates, and unviable
   mutants are not detected defects. If measurement is unavailable, report that
   limitation rather than inventing results or a generic manual-mutant fallback.
6. Generate or extend tests for the authorized rules. For a reported defect, prove
   that the regression test fails on the pre-fix behavior and passes on the intended
   behavior. Do not alter the implementation merely to make the new gate pass.
7. Create the adapter and configuration using the calling review's verification
   gate contract. That contract is `--gate-file` with explicit inputs, baseline and
   mutation commands, expected mutant IDs, invariant IDs, and violation tags.
   Inspect it through the installed review skill before writing an adapter.

   Reuse external tools and existing project mutants where they cover the rule.
   A semantic mutation for commit ordering, reentrancy, or a state transition is
   project-specific and must name its expected invariant violation. Do not relabel
   a generic killed mutant as proof of an unrelated invariant.
8. Validate the original and selected mutations in disposable copies. Reject compile
   errors, timeouts, absent tests, unexpected violations, and failed source restore.
   Never weaken an invariant, delete a surviving mutant, or raise search limits
   repeatedly to obtain a passing gate. Preserve existing gate checks when extending.
9. Save an `authoring-result.json` under the reservation's `run_dir`. Record the
   operation ID, context hash, authored paths, rule-to-test-to-mutant mapping,
   measurement report path/hash when available, regression evidence, remaining
   gaps, and commands actually run. Do not claim full correctness from a passing gate.
10. Return the context and gate paths to review. The calling review freezes the
    resulting files and executes the required gate using the same operation ID.
    A failed authoring pass stops the caller. Do not start review as a fallback,
    generate another gate, or enter an automatic fix loop.

## Separation from mutate

`mutate` measures existing tests and remains observational. This skill creates
tests and rule-specific project artifacts. Only rules explicitly selected by the
caller become required gate checks. Never promote every generic survivor into a
merge blocker. Report equivalent-mutant uncertainty for a human decision.

## Hosts

Claude invokes `/xm:gate`; Codex invokes `$xm:gate` or `$xm-gate` after installation.
These invoke the skill, not an `xm gate` execution CLI. The executable reservation
and gate runtime belong to `xm review`. Keep the authoring pass in the current
agent context and return control to the calling review.
