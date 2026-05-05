# AskUserQuestion Dark-Theme Rule

Reference for x-build prompts using AskUserQuestion.

**CRITICAL:** The `question` field in AskUserQuestion is invisible on dark terminals.

## Visibility map

| Element | Visible | Use for |
|---------|---------|---------|
| `header` | YES | Short context tag, for example `x-build`, `PRD Review`, or `Phase Gate` |
| `question` | NO | Keep minimal; user may not see this text |
| option `label` | YES | Primary info; must be self-explanatory |
| option `description` | YES | Supplementary detail |

## Required pattern

1. Output all context as regular markdown before calling AskUserQuestion.
2. Put the short visible context in `header`.
3. Keep `question` short.
4. Carry decision-relevant information in option `label` and `description`.

## Anti-pattern

- Wrong: putting all PRD, plan, or phase-gate context in the `question` field.
- Right: print the artifact first, then use `header` and option labels for the interactive choice.

## Applies to

x-build PRD review, plan review, phase gates, and other user confirmation boundaries.
