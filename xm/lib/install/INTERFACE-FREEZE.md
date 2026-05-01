# SkillIR Interface Freeze (PRD v2.1, ADR-001)

**Status**: FROZEN as of 2026-04-30 (multi-tool-install task t6)
**Source of truth**: `xm/lib/install/types.mjs`
**Consensus reference**: planner round 2 (ACCEPT-conditional, condition C1 — required B/C/D/E renderers to share a stable IR before parallel work begins)

## Why this gate exists

Phase B (Cursor), C (Codex), D (Kiro), and E (Antigravity) renderers run in
parallel after Phase A. They all import the same `SkillIR` shape from
`xm/lib/install/types.mjs`. If the shape changes mid-flight, any one renderer
can corrupt the others' work and snapshot tests must be regenerated. We freeze
the interface here and constrain future changes.

## Frozen surface

The following typedefs and constants are FROZEN. Source files are noted next
to each (the docs lens caught a drift where INTERFACE-FREEZE listed types that
existed only in `types.mjs` while renderers actually imported the equivalent
types from `manifest.mjs` — H12 fix).

From `types.mjs`:

- `SkillIR`
- `ReferenceFile`
- `CliCall`
- `HookSpec`
- `SkillSize`
- `RenderContext`
- `RenderOutput`
- `Renderer`
- `TargetTool` (string union; values bound by `TARGET_TOOLS` constant)
- All exported constants (`PLUGIN_NAME_RE`, `SKILL_NAME_RE`, `TARGET_TOOLS`,
  `TARGET_DIR`, `MARKER_BEGIN`, `MARKER_END`, `LOCK_TTL_MS`, `MAX_REF_DEPTH`,
  `MAX_BAK_ROTATION`, `CODEX_AGENTS_MAX_BYTES`, `CURSOR_MDC_MAX_LINES`,
  `SECRET_PATTERNS`, `SHELL_METACHARS_RE`, `PRD_VERSION`)

From `manifest.mjs`:

- `Manifest` (the install manifest produced by `buildManifest()`)
- `ManifestEntry`

## Allowed changes (minor)

A change is **minor** if and only if all of:

1. It adds an *optional* field to an existing typedef (e.g.
   `interface SkillIR { ..., previousField, /* new: */ extraOptional?: T }`).
2. It does **not** alter the type or semantics of any existing field.
3. It does **not** rename or remove any field.
4. It does **not** change the value or type of an existing constant.
5. It is documented in this file under "History" with a date and reason.

Renderers MUST treat optional fields as additive — never depend on their
presence in tests; never throw when they are missing.

## Forbidden changes (until v3)

- Renaming a field.
- Removing a field.
- Narrowing a type (e.g. `string → 'a'|'b'`).
- Changing a constant's value.
- Reordering exports such that consumers break.
- Splitting `SkillIR` into multiple types if any renderer already imports the
  current name.

If a forbidden change is genuinely required, bump PRD version (`PRD_VERSION`)
to `v3.x`, schedule a coordinated freeze-break across all renderers, and amend
this document.

## Audit checklist (each renderer task t9..t16)

Before merging a renderer:

- [ ] All `SkillIR.*` field reads use the names defined here.
- [ ] No `delete` / `Object.defineProperty` mutating the IR.
- [ ] Optional fields (`SkillIR.allowedTools`, `CliCall.file === 'missing'`)
      have a documented fallback path.
- [ ] If the renderer needed an additional field, the field was added as a
      *minor* change above and ALL other renderers' tests still pass.

## History

| Date       | Change                              | Author              |
|------------|-------------------------------------|---------------------|
| 2026-04-30 | Initial freeze (Phase A complete).  | multi-tool-install  |
