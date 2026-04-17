# Auto-Route (Natural Language → Strategy)

When the user provides text that doesn't match any strategy keyword, auto-detect the best strategy.

## Signal detection table

| Signal Pattern | Detected Intent | Recommended Strategy | Confidence |
|---------------|----------------|---------------------|------------|
| "리뷰", "review", "check", "검토", "코드 리뷰" | Code quality check | **review** | high |
| "보안", "security", "취약점", "vulnerability", "XSS", "injection" | Security audit | **red-team** | high |
| "vs", "비교", "compare", "어떤 게 나아", "which is better" | Comparison/decision | **debate** | high |
| "아이디어", "idea", "브레인스토밍", "brainstorm", "방법 없을까" | Idea generation | **brainstorm** | high |
| "왜", "why", "원인", "root cause", "디버그", "debug" | Root cause analysis | **hypothesis** | high |
| "조사", "investigate", "분석", "analyze", "알아봐" | Deep investigation | **investigate** | high |
| "개선", "improve", "다듬", "refine", "더 좋게" | Iterative improvement | **refine** | high |
| "설계", "design", "아키텍처", "architecture", "구조" | Design decision | **council** | medium |
| "합의", "consensus", "의견 모아", "다 같이" | Multi-perspective agreement | **council** | high |
| "분해", "break down", "나눠", "쪼개" | Problem decomposition | **decompose** | high |
| "조합", "combine", "파이프라인", "순서대로" | Multi-strategy pipeline | **compose** | medium |
| "모니터", "watch", "감시", "지켜봐" | Continuous monitoring | **monitor** | high |
| "관점", "perspective", "입장", "stakeholder" | Multi-perspective analysis | **persona** | high |
| "질문", "socratic", "탐구", "명확하게" | Requirement clarification | **socratic** | medium |
| File/dir path detected (e.g., `src/`, `*.ts`) | Code target → review or red-team | **review** | medium |

## Priority rules

**Compound signal boost:** 2+ signals → +confidence. E.g., "보안 리뷰" = security + review → **red-team** (security takes priority over review).

**Priority rules when multiple signals match:**
1. Security signals always win → **red-team**
2. Explicit comparison ("vs", "비교") → **debate**
3. Code/file target → **review** (unless security signal present)
4. Question/why → **hypothesis**
5. Fallback → **refine** (safe default for improvement tasks)

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
/x-op "이 API 설계 괜찮은지 봐줘"
  → Signal: "봐줘" (review) + implicit code context
  → Recommended: review
  → Executes: /x-op review "이 API 설계 괜찮은지 봐줘"

/x-op "Redis vs Memcached"
  → Signal: "vs" (compare)
  → Recommended: debate
  → Executes: /x-op debate "Redis vs Memcached"

/x-op "왜 이 테스트가 자꾸 실패하지"
  → Signal: "왜" (root cause)
  → Recommended: hypothesis
  → Executes: /x-op hypothesis "왜 이 테스트가 자꾸 실패하지"

/x-op "결제 시스템 보안 점검"
  → Signal: "보안" (security) + "점검" (check)
  → Recommended: red-team
  → Executes: /x-op red-team "결제 시스템 보안 점검"

/x-op "새 기능 아이디어 좀 내보자"
  → Signal: "아이디어" (idea generation)
  → Recommended: brainstorm
  → Executes: /x-op brainstorm "새 기능 아이디어 좀 내보자"
```

## Applies to

x-op (routing layer only)
