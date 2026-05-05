# AskUserQuestion Dark-Theme Rule

Reference for x-solver prompts using AskUserQuestion.

**CRITICAL:** The `question` field in AskUserQuestion is invisible on dark terminals.

## Visibility map

| Element | Visible | Use for |
|---------|---------|---------|
| `header` | YES | Short context tag, for example `x-solver`, `Strategy`, or `Verify` |
| `question` | NO | Keep minimal; user may not see this text |
| option `label` | YES | Primary info; must be self-explanatory |
| option `description` | YES | Supplementary detail |

## Required pattern

1. Output all context as regular markdown before calling AskUserQuestion.
2. Put the short visible context in `header`.
3. Keep `question` short.
4. Carry decision-relevant information in option `label` and `description`.

## Anti-pattern

- Wrong: putting classification reasoning, solve results, or verification evidence in the `question` field.
- Right: print the result first, then use `header` and option labels for the interactive choice.

## Applies to

x-solver strategy selection, solve phase boundaries, verification confirmation, and close decisions.
