# Phase 0: Project Environment Detection

Toolchain detection rules for writing `done_criteria` and quality checks. Consult before any task that names a test/lint/build command.


Before writing PRD `done_criteria` or any task involving test/lint/build commands, detect the project's toolchain. Never hardcode `npm test` or `main` — derive from the project.

### Package manager / runner

| Lockfile / manifest found | Package manager | Test / lint / build prefix |
|--------------------------|-----------------|----------------------------|
| `bun.lockb` | bun | `bun test` / `bun run lint` / `bun run build` |
| `pnpm-lock.yaml` | pnpm | `pnpm test` / `pnpm lint` / `pnpm build` |
| `yarn.lock` | yarn | `yarn test` / `yarn lint` / `yarn build` |
| `package-lock.json` | npm | `npm test` / `npm run lint` / `npm run build` |
| `pyproject.toml` + `uv.lock` | uv | `uv run pytest` / `uv run ruff check` |
| `pyproject.toml` (no uv) | pip / poetry | `pytest` / `ruff check` |
| `Cargo.toml` | cargo | `cargo test` / `cargo clippy` / `cargo build` |
| `go.mod` | go | `go test ./...` / `go vet ./...` / `go build ./...` |

Probe once per project (via Bash `ls` or `test -f`) and reuse the result across the session.

### Base branch

Never hardcode `main`. Detect via:

```bash
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' \
  || git remote show origin 2>/dev/null | awk '/HEAD branch/ {print $NF}' \
  || echo main
```

Store as `{base_branch}` and use it for all branch comparisons in PRD / plan / tasks.

### Validation scripts

For Node projects, read `package.json` scripts once to discover available entries (`type-check`, `typecheck`, `tsc`, `lint`, `lint:fix`, `test`, `test:unit`, `build`) and prefer them over generic defaults.

Task and group checks are offline by default. `x-build` removes known live AI-provider credentials such as `GROQ_API_KEY` from the check process and stops each command after 600 seconds. A project that intentionally runs live-provider integration checks must opt in explicitly:

```json
{
  "build": {
    "allow_live_provider_checks": true,
    "check_timeout_ms": 600000
  }
}
```

Set this under the `build` object in either supported config layer:

```json
{ "build": { "check_timeout_ms": 600000 } }
```

Project shared: `.xm/config.json`. Build-local override: `.xm/build/config.json`.
Putting `check_timeout_ms` at the top level is invalid and has no effect.

Keep deterministic unit checks as the default. Put live-provider coverage behind the explicit opt-in.

### When to use

- Writing `done_criteria` in tasks (Plan phase): pull commands from detection, not memory
- Writing Verify-phase quality checks: same
- When a user's goal mentions tests/lint/build without specifying commands: detect and confirm

If detection is ambiguous (multiple lockfiles, unknown manifest), ask the user via AskUserQuestion rather than guessing.
