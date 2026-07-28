# Subcommand: replay

Creates a deterministic replay artifact for a recorded span of a given trace.

## Subcommand: replay

### Parsing

From `$ARGUMENTS`:
- After `replay` = trace id (required)
- `--span <id>` = recorded agent span id (required)
- `--model <model>` = optional model override recorded in the manifest
- `--prompt-override <file>` = optional regular file under the worktree
- `--result <file>` = optional provider-result metadata JSON (`output_sha256`,
  `output_bytes`, `tokens`, `cost_usd`, `quality_score`, `rubric`). Raw output
  text is rejected and never stored.
- `--promote-to-eval` = write an idempotent x-eval replay case under
  `.xm/eval/cases/`.

### Execution

1. Validate that trace/span identifiers cannot escape `.xm/traces/`, then read
   the JSONL trace. A malformed trace fails closed.
2. Persist `replay_manifest.json` with `replay_of`, deterministic `seed`, and
   explicit `overrides`; it also freezes the recorded span context.
3. Create a per-trace safe filesystem archive from regular, in-worktree files.
   Symlinks, path escapes and replay artifacts are excluded. A structured
   `snapshot_size_over_10mb` warning is recorded before/after archive creation.
4. Atomically reserve one fork point. Each trace allows at most three forks,
   including concurrent CLI invocations.
5. Emit a four-axis metadata diff: output hash/length, input/output tokens,
   cost, and rubric quality. Missing replay measurements remain `null`; the
   command never invents a quality score.
6. With `--promote-to-eval`, atomically create a deterministic x-eval case.
   Repeating the same trace/span promotion returns the existing case instead of
   overwriting it.

### Output

```
[trace] Replay artifact created: .xm/traces/feature-auth-20260325/replays/fork-.../replay_manifest.json
  replay_of: feature-auth-20260325
  seed: 4f9c...
  snapshot: feature-auth-20260325/fs/fork-....tar.gz (83422 bytes)
```

The current JSONL schema does not retain provider credentials, full prompt text,
or tool I/O, so this command does not claim to invoke an agent. It creates the
auditable deterministic input needed by a provider adapter instead.

## Applies to
Invoked via `xm trace replay <trace-id> --span <span-id> [--model M] [--prompt-override FILE] [--result FILE] [--promote-to-eval]`.
