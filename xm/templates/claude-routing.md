## xm routing (proactive triggers)

Reaching xm skills only through explicit `/xm:...` slash commands breaks flow. When the intents below appear in conversation, invoke or offer the matching skill via the Skill tool **without waiting for a slash command** — but scale the handling by cost, since agents burn tokens. The user may always invoke `/xm:...` explicitly.

### Tier 1 — auto-invoke (read-only, cheap)
Run immediately when the intent is clear:
- "이 가정/전제 맞아?", "만들 가치 있어?", doubting a premise → **xm:probe**
- "전에 어떻게 했지", "지난번 결정", recalling past context → **xm:recall**, or the recall workflow in **xm:memory**
- Asking about the quality of a just-produced answer or artifact → **xm:eval** (limited to that artifact)

### Writing — invoke on explicit request
The user already asked for the document, so run the skill without a separate proposal. It asks once before it publishes a PR or an issue.
- Opening or revising a PR ("PR 올려줘", "PR 본문 정리", "open a PR") → **xm:write** in `pr` mode before drafting the title or body. Do not run `gh pr create` or `gh pr edit` outside that skill.
- Writing an issue, release notes, a changelog entry, or a README ("이슈 만들어줘", "릴리스 노트", "README 정리") → **xm:write**

### Tier 2 — propose, then confirm (moderate cost)
Propose the fitting strategy in **one line** and run only after the user confirms. Never run unprompted:
- Reviewing a PR, diff, or code → propose **xm:review**. For a quick review, inspect in the current process.
- "여러 관점/시각으로", "토론·비교·경쟁시켜", "브레인스토밍" → propose **xm:op** with a fitting strategy
- "차근차근 분해해서 풀어", structured problem solving → propose **xm:solver**
- "왜 안 됐는지 같이 돌아보자", failure retrospective → propose **xm:humble**

### Tier 3 — explicit request only (expensive, billed)
Never auto-trigger. Even on explicit request, **show the decomposition plan and get approval first**:
- "병렬로 많이 돌려", "대량 동시 분석", "에이전트 많이 띄워" → **xm:agent** flow (Workflow backend)
- Large fan-out / multi-agent orchestration in general

### Shared rules
- Anything that spawns agents (spends tokens): **tell the user what will run and how many, before running.** If ambiguous, ask instead of auto-running.
- If the trigger is unclear, point to the explicit slash command. Do not fire a heavy strategy on a guess.
