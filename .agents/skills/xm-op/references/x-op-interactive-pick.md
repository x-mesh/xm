# x-op — Empty-Input Interactive Pick

**Entry:** empty `$ARGUMENTS` routed from `## Routing` in `SKILL.md`.

**Purpose:** empty input means the user invoked `/xm:op` without deciding — show them the catalog and collect a concrete strategy + topic in the same turn. Replaces the previous spec (empty → catalog only), which left users stuck at the next turn and caused the skill to re-fire against empty args (observed failure mode, 2026-04-23).

## Flow

1. **Render the catalog.** Output the same block as `## Subcommand: list` (strategy table + options + examples) first, so the user can see everything before picking.

2. **Call AskUserQuestion (mandatory).** Single tool call, NOT plain text. The tool accepts 2–4 options and **auto-appends "Other"** (do NOT include Other yourself). Use exactly these 4 common strategies:

   | Label | Description | Maps to |
   |-------|-------------|---------|
   | `refine` | 반복 개선 — 설계/문서/API 다듬기 | refine |
   | `tournament` | N개 제안 경쟁 — 최적안 선정 | tournament |
   | `review` | 코드 리뷰 — 보안/품질/성능 다각도 | review |
   | `brainstorm` | 아이디어 발산 — 투표 기반 수렴 | brainstorm |

   Auto-injected "Other" covers the other 13 strategies — the user types the full `/xm:op <strategy> <topic>` in the Other free-text field or in their next message.

3. **After the user picks:**
   - `Other` (auto-injected) → stop. Do not dispatch. Wait for the user's next message (they will respecify the strategy).
   - One of the 4 → call AskUserQuestion a second time to collect the topic:
     - question: `"{strategy}"의 대상 또는 주제는?`
     - 2 options: `Type topic` (description: "자유 텍스트 입력"), `Cancel` (description: "중단하고 대기")
     - The user's free-text via Other is the topic string.
   - Then dispatch the chosen strategy with the provided topic as `$ARGUMENTS`.

## Anti-patterns

- ❌ Plain-text question like "어떤 작업을 도와드릴까요?" — not a real turn boundary, causes skill to re-fire against empty args.
- ❌ Skip the catalog and jump straight to AskUserQuestion — user loses context for the `other` escape.
- ❌ Silently pick a strategy for the user — empty input means they haven't decided.
- ❌ More than 2 AskUserQuestion calls in the pick flow — cap at (strategy, topic).

## Explicit `list` vs empty input

| Invocation | Behavior |
|------------|----------|
| `/xm:op list` | Catalog only. No AskUserQuestion. User is browsing. |
| `/xm:op` (empty args) | Catalog + AskUserQuestion(strategy) + AskUserQuestion(topic). User needs guidance. |
