# Command: classify

Classify problem type and recommend optimal solver strategy (with optional x-op alternative).

1. Run: `$XMS classify`
2. Parse JSON output (`action: "classify"`)
3. **Step-Back (check higher-level pattern):** Before classifying, step back and ask — "What kind of problem is this, fundamentally?"
   - Is it a code bug, a design problem, a process problem, or an environment problem?
   - If the answer differs from the rule-based recommendation, force LLM fallback.
   - Example: signal is "error" but step-back determines "design problem" → recommend constrain instead of iterate
4. **Confidence check**:

### High confidence (≥ 0.7)
Use the rule-based result as-is:
- Show the result to the user (recommended strategy, confidence, reasoning)
- AskUserQuestion for strategy selection

### Low confidence (< 0.7) — LLM Fallback
When rules alone are insufficient, delegate classification to an agent:

delegate (foreground, sonnet):
```
"## Problem Classification

Problem description:
{description}

Context:
{context items summary}

Constraints:
{constraints list}

Rule-based pre-analysis:
- Detected signals: {signals summary}
- Pre-recommendation: {recommended} (confidence: {confidence}%)

Choose the most suitable strategy for this problem and explain why:
1. decompose — Break complex problems into sub-problems
2. iterate — Hypothesis → Test → Refine loop (bugs, performance)
3. constrain — Constraint-based candidate evaluation (design decisions)
4. pipeline — Auto-routing

Additionally, suggest if any of these x-op strategies would be more suitable:
- hypothesis: Hypothesis → Refutation → Adoption (diagnosis)
- socratic: Question-based deep exploration (unclear requirements)
- persona: Multi-perspective analysis (diverse stakeholders)
- red-team: Security attack/defense (security issues)

Format:
Strategy: [name]
Confidence: [0-100]%
Reasoning: [one line]
x-op Alternative: [name if applicable, otherwise 'none']
"
```

Parse the agent result:
- If `Strategy` is an x-solver strategy → `$XMS strategy set <chosen>`
- If `x-op Alternative` exists → Suggest the x-op strategy to the user as well

4. **AskUserQuestion (REQUIRED)** for final strategy selection:
   - Recommended strategy (rule-based or LLM)
   - x-op alternative (if any)
   - Alternative strategies
   - Example: AskUserQuestion("전략 **{strategy}**를 추천합니다 (신뢰도 {confidence}%). 진행할까요? 다른 전략을 선택하려면 알려주세요.")
5. After selection: `$XMS strategy set <chosen>`

### Enhanced Signal Detection

classify detects signals via text pattern matching:

| Signal | Detection target | Example |
|--------|-----------------|---------|
| `has_error` | error, bug, crash, leak | "There's a memory leak" |
| `has_stack_trace` | stack trace, file:line | Contains `.js:42` |
| `has_code_context` | code block, code-type context | ``` block |
| `has_performance` | slow, latency, optimize, bottleneck | "The API is slow" |
| `has_security` | vulnerability, injection, XSS, security | "SQL injection concern" |
| `has_infra` | deploy, docker, k8s, scale, infrastructure | "Scaling strategy" |
| `has_design_question` | should, which, how to, design | "Which DB should I use" |
| `has_tradeoff` | vs, tradeoff, pros/cons | "Redis vs Memcached" |

### Composite Signal Boost

When 2+ signals are detected simultaneously, confidence gets a bonus:
- 2 signals: +5%
- 3+ signals: +10%

### x-op Strategy Recommendation

classify suggests relevant x-op strategies alongside its result:

| Signal combination | x-op strategy | Reasoning |
|-------------------|---------------|-----------|
| Error + complex | `hypothesis` | Diagnose root cause via hypothesis → refutation |
| Design question (no tradeoff) | `socratic` | Clarify requirements via question-based exploration |
| Design + multi-dimensional | `persona` | Multi-perspective stakeholder analysis |
| Security | `red-team` | Security attack/defense simulation |
| Performance | `hypothesis` | Validate performance bottleneck hypotheses |
| Infra + tradeoff | `debate` | Pros/cons debate on infrastructure choices |

## Applies to
Runs automatically after `init`, or invoked manually. Output drives strategy selection AskUserQuestion.
