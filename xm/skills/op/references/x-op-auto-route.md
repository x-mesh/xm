# Auto-Route (Natural Language → Strategy)

When the user provides text that doesn't match any strategy keyword, auto-detect the best strategy.

> The authoritative signal table is now inlined in `SKILL.md` (Auto-Route section) so it loads at runtime. Keep this copy in sync; this file additionally documents the execution flow and worked examples.

## Signal detection table

| Signal Pattern | Detected Intent | Recommended Strategy | Confidence |
|---------------|----------------|---------------------|------------|
| "리뷰", "review", "check", "검토", "코드 리뷰" | Code quality check | **review** | high |
| "보안", "security", "취약점", "vulnerability", "XSS", "injection" | Security audit | **red-team** | high |
| "vs", "비교", "compare", "어떤 게 나아", "which is better" | Comparison/decision | **debate** | high |
| "아이디어", "idea", "브레인스토밍", "brainstorm", "방법 없을까" | Idea generation | **brainstorm** | high |
| "왜", "why", "원인", "root cause" — explanation only, no fix expected | Root cause analysis | **hypothesis** | high |
| "버그", "디버그", "고쳐줘", "안 돼", "debug", "fix this bug", "failing test" | Diagnose **and fix** | **→ x-solver iterate** | high |
| "조사", "investigate", "분석", "analyze", "알아봐" | Deep investigation | **investigate** | high |
| "개선", "improve", "다듬", "refine", "더 좋게" | Iterative improvement | **refine** | high |
| "설계", "design", "아키텍처", "architecture" (whole-system) | Design decision | **council** | medium |
| "합의", "consensus", "의견 모아", "다 같이" | Multi-perspective agreement | **council** | high |
| "분해", "break down", "나눠", "쪼개" | Problem decomposition | **decompose** | high |
| "조합", "combine", "파이프라인", "순서대로" | Multi-strategy pipeline | **compose** | medium |
| "모니터", "watch", "감시", "지켜봐" | Continuous monitoring | **monitor** | high |
| "관점", "perspective", "입장", "stakeholder" | Multi-perspective analysis | **persona** | high |
| "질문", "socratic", "탐구", "명확하게" | Requirement clarification | **socratic** | medium |
| "경쟁", "compete", "best of", "제일 나은 거 골라", "후보 채택" | Competitive selection | **tournament** | high |
| "단계별", "순차", "차례대로", "step by step", "A 다음 B" | Sequential pipeline | **chain** | high |
| "병렬로 나눠", "동시에 처리", "독립 작업 분배" | Parallel split | **distribute** | high |
| "모듈 구조 잡고 구현", "scaffold", "구조 잡고 만들어" | Structured build | **scaffold** | medium |
| File/dir path detected (e.g., `src/`, `*.ts`) | Code target → review or red-team | **review** | medium |
| "그냥", "간단히", "한 줄로", "just", "quickly" — short (≤ ~15 words), one target, no other signal | Single well-specified task | **direct** | medium |

## Hand-off to x-solver

**Use `x-solver iterate` when the run must end in an applied, execution-proven fix — or may need more
than one round of state carried across turns; use `x-op hypothesis` when a single pass that names and
refutes causes is the whole deliverable.**

`hypothesis` ends at a recommended verification method — it never applies a fix or proves one.
`x-solver iterate` records a reproduction before touching anything, refutes its own confirmed
hypothesis with an independent agent, applies the fix, and re-runs the recorded command to show the
failure marker is gone. It also persists that state, so a diagnosis survives across turns.

Worked example — "로그인이 가끔 실패해, 고쳐줘":
- Repair is expected and the failure is intermittent → hand off. Offer it as the default option:
  `1) x-solver iterate (권장 — 재현·진단·수정·증명) 2) hypothesis (원인만) 3) Other`
- "로그인이 왜 가끔 실패하지?" with no repair expected stays with `hypothesis`.

## Priority rules

**Compound signal boost:** 2+ signals → +confidence. E.g., "보안 리뷰" = security + review → **red-team** (security takes priority over review).

**Priority rules when multiple signals match:**
1. Security signals always win → **red-team**
2. Explicit comparison ("vs", "비교") → **debate**
3. Code/file target → **review** (unless security signal present)
4. Question/why → **hypothesis**
5. Still multiple matches → pick the highest-confidence row; tie → ask.
6. `direct` never wins a tie against another signal — it is the recommendation only when nothing else fires. It is a leaf, not a bypass: confirm it with AskUserQuestion like any other strategy.

**Worked example (direct):** "그냥 이 함수 이름만 camelCase로 바꿔줘" — one target, one acceptable
answer, no compare/why/security signal → recommend `direct` (`1) direct (Recommended) 2) refine 3) Other`).
If the user picks refine anyway, run refine; the recommendation is advice, the user decides.

No signal matches → show top 3 with AskUserQuestion (see Execution flow below); do not silently fall back to refine.

## Execution flow

1. Parse input text against signal table
2. If high confidence match → show recommendation and confirm:

   **Developer mode:**
   ```
   🎯 Auto-detected: "{input}" → strategy: {recommended}
   Reason: {matched signals}

   1) {recommended} (Recommended)
   2) {alternative_1}
   3) {alternative_2}
   4) Other — choose manually
   ```

   **Normal mode:**
   ```
   🎯 자동 감지: "{input}" → 전략: {recommended}
   이유: {matched signals 한국어}

   1) {recommended} (추천)
   2) {alternative_1}
   3) {alternative_2}
   4) 직접 선택
   ```

3. If low/medium confidence or no match → show top 3 suggestions with AskUserQuestion
4. **Call AskUserQuestion to confirm strategy selection before executing.** (See Interaction Protocol)
5. After user confirms → execute the selected strategy with the original text as topic

## Examples

```
/xm:op "이 API 설계 괜찮은지 봐줘"
  → Signal: "봐줘" (review) + implicit code context
  → Recommended: review
  → Executes: /xm:op review "이 API 설계 괜찮은지 봐줘"

/xm:op "Redis vs Memcached"
  → Signal: "vs" (compare)
  → Recommended: debate
  → Executes: /xm:op debate "Redis vs Memcached"

/xm:op "왜 이 테스트가 자꾸 실패하지"
  → Signal: "왜" (root cause)
  → Recommended: hypothesis
  → Executes: /xm:op hypothesis "왜 이 테스트가 자꾸 실패하지"

/xm:op "결제 시스템 보안 점검"
  → Signal: "보안" (security) + "점검" (check)
  → Recommended: red-team
  → Executes: /xm:op red-team "결제 시스템 보안 점검"

/xm:op "새 기능 아이디어 좀 내보자"
  → Signal: "아이디어" (idea generation)
  → Recommended: brainstorm
  → Executes: /xm:op brainstorm "새 기능 아이디어 좀 내보자"
```

## Applies to

x-op (routing layer only)
