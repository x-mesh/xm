---
name: local-fix
description: Prepare and execute an audited fix in another registered project on the same host. Use when a bug belongs to a locally available project and the user wants it fixed now in an isolated target worktree while retaining toss/inbox and mem-mesh history; use toss instead for remote or asynchronous handoff.
---

# x-local-fix — Same-Host Cross-Project Fix

Use this only for a registered project available on the same machine. It keeps
the `toss` audit contract but replaces the waiting period with a target-owned
worktree.

## Flow

1. Capture and create the target worktree from the sender project:

   ```bash
   xm local-fix <project> "<title>" --command "<repro command>" --output "<actual output>" --fix "<concrete direction>" --json
   ```

   The command writes the sender's `.xm/outbox/<id>.json`, resolves the exact
   registered target, and runs `GK_AGENT=1 git-kit worktree acquire`. It does
   not call mem-mesh, edit code, commit, push, or open a PR.

2. Deliver `mcp_calls.pin_add` and `mcp_calls.add` from the JSON output
   verbatim to `mcp__mem-mesh__pin_add` and `mcp__mem-mesh__add`. They carry
   `tags=["inbox", "local-fix"]`, so the target project's existing mem-mesh
   hook and later history can identify this as an immediate local repair.
   Record the returned ids in the **sender** worktree:

   ```bash
   xm inbox record <item_id> --pin-id <pin id> --memory-id <memory id> --json
   ```

3. In `target_worktree`, materialize and take the same item. This makes the
   target project own its `.xm/inbox/<id>.json` record:

   ```bash
   xm inbox materialize --content '<memory content JSON>' --memory-id <memory id> --pin-id <pin id> --json
   xm inbox take <item_id>
   ```

4. Read the target worktree's instructions, fix only the reported issue, and
   run its discovered checks. Report the worktree path, changed files, and
   exact checks.

5. Leave the change in the worktree by default. Do not commit, push, merge,
   or open a PR unless the user explicitly requests that action. For a remote
   target, unavailable registry entry, or delayed ownership transfer, stop
   after `toss` instead.

## Guardrails

- Address the target only by its exact registry id; never guess a path.
- Treat a failed worktree acquisition as a partial result: the sender outbox
  remains valid, but no target code was touched.
- Preserve `mcp_calls` verbatim. `pin_add.content` starts with the toss id so
  the inbox can find its durable JSON memory precisely.
- Do not work in the target's main checkout. Use only `target_worktree`.
- Do not claim the target inbox exists until materialize succeeds.
