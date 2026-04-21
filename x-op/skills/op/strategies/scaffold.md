# Strategy: scaffold

Structure design → module distribution → parallel implementation → integration.

## Phase 1: DESIGN
> 🏗️ [scaffold] Phase 1: Design

delegate (foreground, opus recommended):
```
"## Scaffold Design: {TOPIC}
Design the overall structure:
- List of modules/components and their responsibilities
- Interfaces between modules (inputs/outputs)
- Dependency order
Each module must be independently implementable. Verify scope-clarity, dependency-minimality, and interface-completeness per Dimension Anchors. 400 words max."
```

**Call AskUserQuestion to confirm before Phase 2. Show phase results first.**

## Phase 2: DISPATCH
> 🏗️ [scaffold] Phase 2: Dispatch

fan-out matching the number of modules from the design:
```
"## Scaffold Module: {module name}
Overall structure:
{Phase 1 design result}

Your assigned module: {module name}
Responsibility: {module description}
Interface: {input/output spec}

Implement this module. Do not assume other modules' internal implementation — use interfaces only."
```

**Call AskUserQuestion to confirm before Phase 3. Show phase results first.**

## Phase 3: INTEGRATE
> 🏗️ [scaffold] Phase 3: Integrate

delegate (foreground):
```
"## Scaffold Integration
Overall design:
{Phase 1 result}

Per-module implementation results:
{Phase 2 each agent result}

Integrate the modules:
- Verify interface compatibility
- Resolve omissions/conflicts
- Output the final integrated result"
```

## Final Output
```
🏗️ [scaffold] Complete — {N} modules

## Structure
{module diagram}

## Module Status
| Module | Agent | Status |
|--------|-------|--------|
| {module name} | agent-{n} | ✅ |

## Integration Result
{final result}
```

## Final Step: Persist (REQUIRED)

After emitting the Final Output above and the Self-Score block, MUST save the result to `.xm/op/` (see `references/x-op-result-persistence.md`):

1. `mkdir -p .xm/op/` (Bash)
2. Filename: `scaffold-{YYYY-MM-DD}-{slug}.json` (slug from topic, ≤ 40 chars, lowercase, hyphens)
3. Write JSON per the result schema (include `outcome.verdict="{N} modules"`, `outcome.summary` with module structure, `self_score`, `rounds_summary`)
4. Surface path: `💾 Saved: .xm/op/{filename}`

Do not end the strategy until the file is written and the path is shown.
