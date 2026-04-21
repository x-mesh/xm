# Agent Output Quality Contract

All agent prompts in x-op strategies implicitly reference this contract. The leader enforces it during synthesis.

## Output Quality Criteria

Every argument, finding, or position an agent produces must be:
1. **Evidence-based** — Cites a specific fact, example, or mechanism. "It's better" → FAIL. "Reduces latency by eliminating N+1 queries" → PASS.
2. **Falsifiable** — States a claim that could be proven wrong. "This might help" → FAIL. "This approach fails when concurrent users exceed 1K" → PASS.
3. **Dimension-tagged** — Labels which dimension it addresses. Two arguments on the same dimension must be merged.

## Dimension Anchors by Strategy Category

See `references/dimension-anchors.md` — per-category dimension pools (Code, Ideation, Argument/Analysis, Task Decomposition).

## Judge/Evaluator Rubric

When a strategy includes a judge, evaluator, or voting phase:
- Score each argument on **strength** (evidence + logic, 1-10) and **coverage** (dimensions addressed, 1-10)
- Verdict must cite dimension scores, not just declare a winner

## Evidence Standards (Strict)

Every factual claim in an agent's output must be backed by one of the Valid evidence types. The leader rejects findings whose only support is Invalid evidence during synthesis.

| Valid Evidence | Invalid Evidence |
|----------------|------------------|
| `file.ts:123` with the actual code snippet quoted | "likely includes...", "probably because...", "may be" |
| Output from a command the agent actually ran (grep, test, diff) | Logical deduction without code proof |
| A test executed whose result proves the behavior | General explanation of how a technology works |
| Cited URL + quoted passage (not just a link) | Bare URL with no quoted content |
| Another agent's output referenced by ID/phase | "It is well known that…" / appeal to common practice |

Rejection rule: when an agent submits a finding with no Valid evidence, the leader either (a) drops it from synthesis, or (b) returns it to the agent for evidence before counting it.

## Good vs Bad Agent Output

Good: `[feasibility] Requires only stdlib — no new deps, deploys on existing infra. Fails if payload exceeds 1MB (no streaming). Evidence: src/server/upload.ts:42 uses Buffer.concat with no size guard.`
Bad: `This approach is more practical and easier to implement.`

## Applies to

x-op (all strategies), x-review (finding quality enforcement), x-eval (output scoring rubric)
