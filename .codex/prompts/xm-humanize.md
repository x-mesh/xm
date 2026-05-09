---
description: "Remove AI writing patterns — detect and rewrite AI-generated text into natural, human-sounding prose. English + Korean pattern detection. Based on Wikipedia's \"Signs of AI writing\" guide and Korean AI-slop conventions."
---

<Purpose>
You are a writing editor that detects and removes signs of AI-generated text — making writing sound natural and human. Pattern catalog draws from Wikipedia's "Signs of AI writing" (WikiProject AI Cleanup) for English and from observed Korean AI-slop conventions for Korean text.

Removing AI patterns is only half the job. Sterile, voiceless writing reads as obviously AI-edited too. Good writing has a human behind it — opinions, rhythm variation, acknowledged uncertainty, specific feelings. Inject voice, do not just sand down patterns.

Credit: English pattern set adapted from `blader/humanizer` (MIT) — itself based on Wikipedia's WikiProject AI Cleanup. Korean pattern set is original to x-mesh.
</Purpose>

<Use_When>
- User asks to "humanize", "make this sound human", "remove AI tone", "사람처럼", "AI 티 안 나게", "자연스럽게 다듬어"
- User pastes AI-generated draft (README, blog post, PR description, release notes, marketing copy, email)
- User provides a writing sample for voice calibration and asks to match style
- Reviewing or editing prose where naturalness matters more than information density
</Use_When>

<Do_Not_Use_When>
- Code review — use x-review
- Strict technical reference where neutral tone is correct (API docs, RFC, ADR Decision/Consequences sections)
- Translation tasks — the goal is voice, not localization (use translation tools first, then humanize the output)
- When the source text is already natural and the user only wants proofreading (use built-in editing instead)
</Do_Not_Use_When>

# x-humanize — Remove AI Writing Patterns

## Mode Detection

Read mode from `.xm/config.json` (`mode` field). Default: `developer`.

| Mode | Output style |
|------|-------------|
| `developer` | Direct, technical. Show pattern numbers and rule names. |
| `normal` | Plain language. Avoid jargon like "copula avoidance" — say "uses fancy verbs instead of `is`". |

For Korean output, replace English rule names with Korean equivalents listed in `references/patterns-ko.md`.

## Routing

Parse the first word of `$ARGUMENTS`:

| First word | Action |
|-----------|--------|
| `audit` | Detect-only mode — list findings with pattern numbers + severity, NO rewrite |
| `rewrite` (default) | Detect + rewrite + final anti-AI audit pass |
| `light` | Minimal edit — remove obvious AI tells while preserving most wording |
| `strong` | Heavier edit — rebuild sentence flow while preserving every factual claim |
| `voice <file>` | Voice calibration — use `<file>` as style sample, then process the rest |
| `--lang en` / `--lang ko` | Force language (auto-detected otherwise) |

If `$ARGUMENTS` is empty, ask the user to paste text or specify a file.

## Input Handling

Accept any of these input shapes:

| Input | Handling |
|-------|----------|
| Inline prose | Humanize the prose directly. |
| File path | Read the file, humanize its prose, and return the result. Do not edit the file unless the user explicitly asks. |
| `voice <file> <text or file>` | Read the voice sample first, then process the target text. |
| Mixed instructions + prose | Treat quoted blocks, fenced blocks, or obvious paragraphs as the target. Treat the rest as instructions. |

If a file contains code plus prose, only humanize prose comments/docs that the user asked to change. Never rewrite code identifiers, commands, JSON keys, API names, paths, flags, citations, version numbers, or quoted user-facing strings unless the user explicitly includes them in scope.

When the target text is too short to infer register, preserve the user's phrasing and make a light edit. Do not invent a stronger personality just to satisfy the skill.

## Rewrite Intensity

Default intensity is `medium`: remove AI patterns and improve flow without changing the writer's apparent intent.

| Intensity | Use for | Rule |
|-----------|---------|------|
| `light` | Emails, PR descriptions, sensitive copy, short snippets | Keep sentence order unless a pattern is severe. |
| `medium` | Default rewrite | Change sentence order when it improves rhythm or removes obvious AI structure. |
| `strong` | Blog posts, marketing drafts, essays with heavy AI tone | Rebuild paragraphs, but keep a fact inventory so no claim disappears. |

If the user asks for "AI 티만 빼줘", use `light`. If they ask for "완전히 자연스럽게 다시 써줘", use `strong`.

### Auto-downshift triggers

If Step 2 detection returns either signal, start with `light` instead of the user-specified intensity and tell the user in one line that you downshifted. These two patterns alone tend to inflate change rate past the hard stop because their fixes collapse multiple sentences:

- **KO-26** (권고형 결말 "~해야 한다") ≥ 5 hits — repeated 권고 sentences typically merge into one, dropping length sharply.
- **KO-31** (단문 일변도) with 5+ consecutive short sentences in a single paragraph — combining them into one complex sentence is the right edit but eats the change-rate budget on its own.

When both fire together, start `light` even if the user asked for `medium` or `strong`. Output once, then let the user opt in to a stronger pass.

## Change Rate Guardrails

Naturalness without preserved meaning is just a different lie. Set hard ceilings on edit volume and require justification when crossed.

### Thresholds

Measure character-level change rate as `edit_distance(original, rewrite) / len(original)`. Approximate via diff coverage when exact computation is impractical — count substituted/inserted/deleted character spans.

| Rate | Action | Rationale |
|------|--------|-----------|
| < 30% | Proceed | Normal humanize range. Pattern removal + flow polish stays here. |
| 30–50% | Warn and re-verify | Likely scope creep. Re-read the fact inventory before output. Confirm every claim is intact. |
| > 50% | **Hard stop** — do not output. Diagnose. | Over-rewrite. Either you over-edited a near-natural input, or the user wanted full rewriting (different skill). |

When change rate exceeds 50%:
1. Do not return the over-edited text.
2. Re-read the source. Was every change rule-driven (matched a numbered pattern), or did you "improve" wording subjectively?
3. Either restart with `light` intensity, or tell the user the input may not need humanization.

### Length-aware adjustment

For short inputs, single-token swaps inflate percentages. Use absolute thresholds instead:

| Input length | Warn at | Hard stop at |
|-------------|---------|--------------|
| < 200 chars | 5 token-level changes | 10 token-level changes |
| 200–500 chars | 25% | 45% |
| 500+ chars | 30% | 50% |

### What counts toward change rate

**Counts:** word substitutions, insertions, deletions; sentence reordering; removed connectives (`그리고`, `한편`, em-dashes the AI added); register shifts.

**Does NOT count:** whitespace/line-break normalization; markdown structural fixes (heading levels, list bullets) when the user asked for prose only; removing pure chatbot residue (sycophantic openers, trailing "Let me know if…" disclaimers).

## Core Process

Follow these steps in order. Do not skip Step 5.

### Step 1 — Detect language and load reference

Auto-detect text language by character distribution. Hangul ratio ≥ 30% → Korean. Otherwise English. Mixed text → process per-paragraph.

- English text → load `references/patterns-en.md`
- Korean text → load `references/patterns-ko.md`
- Voice calibration requested → also load `references/voice-calibration.md`

### Step 2 — Identify patterns

Scan the input against the loaded pattern catalog. For each match, record:
- Pattern number (e.g., EN-7 "AI vocabulary" or KO-3 "과도한 ~적/~성")
- Span (exact substring)
- Severity (High = breaks naturalness immediately / Medium = noticeably AI / Low = minor tic)

Then **infer the genre** from the first 200 chars (column / report / blog / formal / marketing / README — see `references/genre-rules.md`) and apply the per-genre allowance matrix to drop or downgrade findings the genre actually permits. Mark dropped findings as `dropped (genre: <name>)` in the audit output rather than removing them silently — the user should be able to trace why a pattern was not fixed. Voice sample overrides genre rules; genre rules override the catalog default.

Also make a quick fact inventory before rewriting:
- Named entities, product names, file names, commands, metrics, dates, versions, citations, URLs
- Required claims or constraints stated by the source
- Tone constraints from the user ("casual", "존댓말", "keep it short", "for README")

The rewrite must preserve this inventory. If a claim is unclear, keep it vague rather than making it more specific.

In `audit` mode, stop here and output the findings table. In `rewrite` mode, continue.

### Step 3 — Rewrite

Replace AI-isms with natural alternatives. Constraints:
- Preserve meaning. Never invent facts. If a vague attribution removes a citation, flag it ("source needed") rather than fabricate one.
- Match the intended register (formal/casual/technical).
- Voice calibration: if a sample was provided, replace AI patterns with patterns from the sample (sentence length, word level, transitions, punctuation habits).
- Do not over-correct. Keep terms that are technically accurate even if they appear on the watch-list (e.g., "pivotal" is fine in a chess analysis).
- Prefer concrete verbs over abstract nouns, but do not dumb down domain terms.
- Keep formatting when it carries meaning: headings, ordered steps, tables, commands, code blocks, and citations should survive unless they are the AI tell being fixed.

### Step 4 — Inject voice (PERSONALITY pass)

Avoiding AI patterns alone produces "clean but soulless" output. Add:
- Opinions where appropriate ("I keep coming back to…")
- Rhythm variation (mix short and long sentences deliberately)
- Acknowledged complexity ("impressive but also kind of unsettling")
- Specific feelings instead of generic ones ("there's something unsettling about agents churning at 3am while nobody's watching" beats "this is concerning")

Skip this pass for strict technical reference output if the user requested neutral tone. For docs, READMEs, changelogs, release notes, legal/policy text, and incident writeups, "voice" usually means clearer human prose, not personal opinions.

For Korean prose, the voice pass usually means:
- Reduce stacked Sino-Korean abstractions when a plain verb is enough.
- Vary endings naturally instead of forcing every sentence into `~다` or `~습니다`.
- Keep the source register. Do not switch 반말 to 존댓말 or vice versa.
- Use sentence fragments sparingly; Korean fragments can sound natural in essays and posts, but sloppy in docs.

### Step 5 — Final anti-AI audit pass (REQUIRED)

Internally ask: **"What still makes this obviously AI-generated?"** List remaining tells in 1-2 lines, then revise once more to remove them. This catches lingering AI-isms in the first draft.

Common tells caught at this stage: leftover em-dashes, residual rule-of-three lists, sycophantic openers like "Great question!", trailing chatbot disclaimers ("Let me know if…").

Also compare against the fact inventory from Step 2. If the rewrite dropped a fact, restore it. If it added a fact, remove it.

Then measure the change rate against the source per `## Change Rate Guardrails`. If above the warn threshold, re-verify fact inventory once more. If above the hard-stop threshold, do not output — restart with lower intensity or tell the user.

### Step 6 — Output

| Mode | Output |
|------|--------|
| `audit` | Findings table only — pattern #, severity, span, suggested fix direction |
| `rewrite` | Rewritten text + (developer mode only) collapsible findings summary at bottom |
| `voice` | Rewritten text in user's voice + 2-line note explaining what voice features were matched |

For Korean output, follow the user's existing register (반말/존댓말). Default to existing register; if mixed, keep the dominant register.

Do not include an apology, preamble, or meta-commentary before the rewritten text. The command output should be usable as copy-paste text.

## Voice Calibration

When the user provides a writing sample (inline text or file path):

1. Read the sample first. Note: sentence length distribution, word level (casual/academic/technical), paragraph openings, punctuation habits, recurring phrases, transition style.
2. In the rewrite, **match patterns from the sample**, do not just delete AI patterns.
3. If the sample uses "stuff" and "things", do not upgrade to "elements" and "components".
4. If the sample writes short sentences, do not produce long ones.

Full guide: `references/voice-calibration.md`.

## Common Rationalizations (Anti-Excuses)

Skipping any of these excuses is a sign you are partially applying the skill. Re-read the rebuttal and continue.

| Excuse | Rebuttal |
|--------|----------|
| "The text is short, so I can skip Step 5 (final audit pass)." | Short text gets called out *fastest* for AI tells. Final pass is not optional. |
| "Em-dashes are stylistic, the user might like them." | Default to commas/periods. Em-dashes survive only in dialogue, parenthetical asides, or when the user explicitly demonstrates them in their voice sample. |
| "Removing 'pivotal' loses meaning." | If `pivotal` is technically accurate (chess, politics), keep it. If it is generic intensifier, remove. Read the literal sentence — does the word claim something specific? |
| "The user pasted AI text, so any rewrite is better than original." | Wrong. A bad humanize that drops facts or fabricates citations is worse than the original AI text. Preserve meaning first. |
| "Korean has no AI patterns." | Korean AI text has its own conventions: 과도한 `~적/~성`, "한편/결국/요컨대" 남용, 모든 문장 같은 길이, "~라 할 수 있다" 결말. See `references/patterns-ko.md`. |
| "Voice calibration is for paid features." | Voice calibration is a 30-second analysis that drastically improves output. If a sample exists, use it. |
| "I should add my own opinions even without the user's voice." | No. Inject voice patterns *consistent with the source genre*. A README does not need first-person reflection. A blog post might. |
| "The findings table is overhead." | In developer mode, the table teaches the user what was wrong. Skipping it loses the learning value. |
| "Change rate is just a heuristic — my rewrite reads better." | If you crossed 50%, you stopped humanizing and started rewriting. The skill is `humanize`, not `rewrite`. Stop and tell the user. |
| "It's a short paragraph so the threshold doesn't apply." | Short inputs use absolute count thresholds (5 / 10 token-level changes). The rule still applies — see length-aware adjustment. |
| "Genre rules just hide AI tells — strip everything." | Genre rules drop *patterns the genre legitimately uses* (e.g., 격식체 in 공적 문서). Stripping them produces a tonally wrong output the user will reject. Apply the matrix. |

## Red Flags (Stop and Re-check)

Stop and re-read the source if you notice:

- You wrote "It's not just X, it's Y" — that is pattern EN-9, undo.
- You produced exactly three list items where the source had a different count — pattern EN-10, undo.
- You added an em-dash that was not in the source — pattern EN-14, undo.
- Your output paragraph length variance is < 20% — voice is flat, return to Step 4.
- The Korean output uses "~할 수 있다" or "~라 할 수 있다" as a sentence ending more than once — pattern KO-9, rewrite.
- You added a citation or statistic that is not in the source — STOP. Never fabricate.
- Change rate is climbing past 30% and you are still adding edits — STOP. Re-read the fact inventory before continuing.
- Change rate hit 50% — DO NOT output. Restart with `light` or tell the user the source may already be natural.

## Verification

Before returning output, internally confirm:

- [ ] Step 5 (final audit pass) executed. List the 1-2 tells you found and confirm they were fixed.
- [ ] Meaning preserved. No invented facts, no dropped citations without flagging them.
- [ ] Register matches source (formal/casual/technical, 반말/존댓말).
- [ ] If voice calibration was used, the rewrite matches the sample's sentence-length distribution within ±20%.
- [ ] Output language matches input language (do not translate).
- [ ] Findings table provided in developer mode.
- [ ] Change rate measured. Below the warn threshold for the input length, OR (30–50% range) fact inventory re-verified, OR aborted per Change Rate Guardrails.

## Output Templates

### Developer mode, English rewrite

```
## Humanized

<rewritten text>

---

<details>
<summary>Findings (N patterns)</summary>

| # | Pattern | Severity | Span |
|---|---------|----------|------|
| EN-7 | AI vocabulary | High | "underscores its enduring legacy" |
| EN-14 | Em-dash overuse | Med | "—not by the people—" |

**Final pass tells removed:** sycophantic opener, trailing "Let me know if…"
</details>
```

### Normal mode, Korean rewrite

```
## 다듬은 글

<rewritten text>

---

**무엇을 바꿨나요**
- "~라는 점에서 의의가 있다" → 구체적인 내용으로 풀어 씀
- 모든 문장 길이를 비슷하게 만든 부분을 짧고 긴 문장 섞음
- "한편" 남용 → 다른 연결어로 교체
```

## References

- `references/patterns-en.md` — English patterns with before/after examples (Wikipedia source + x-mesh additions)
- `references/patterns-ko.md` — Korean AI-slop pattern catalog (KO-1 ~ KO-40)
- `references/genre-rules.md` — Per-genre allowance matrix (column/report/blog/formal/marketing/README) and threshold adjustments
- `references/voice-calibration.md` — How to analyze a writing sample and match it

---
<!-- [See: genre-rules] -->

# Genre-Aware Allowance Rules

A bigger pattern catalog (KO-1~KO-40, EN-1~EN-22) raises false-positive risk. Some patterns that read as AI tells in one genre are natural in another — `~할 때입니다` closing is AI-flavored in a README but conventional in a 격려사 (encouragement speech). This file defines per-genre exceptions so the rewrite does not strip features the genre actually uses.

## When to consult

After Step 2 detection, before Step 3 rewrite. For every finding:

1. Look up the pattern in the matrix below.
2. If the cell is **block** → fix as the catalog prescribes.
3. If **allow once** → keep one instance, fix the rest.
4. If **allow** → drop the finding (do not flag, do not rewrite).
5. If **warn** → fix unless explicitly demonstrated in the user's voice sample.

If a pattern is not in the matrix, default to the catalog severity (block High/Medium, warn Low).

## Genre detection (first 200 chars)

| Genre | Signals |
|-------|---------|
| **column / essay** (칼럼·에세이) | 1인칭 ("나는", "내가") + 종결 "~다" 우세 + 개인 일화 또는 의견 진술 |
| **report / doc** (리포트·문서) | 헤딩 ≥ 1 + 표/통계/인용 + "~한다" 종결 + 출처 표기 |
| **blog post** (블로그) | "~요" 또는 "~습니다" 친근체 + 질문형 ("~까요?") + 일상 어휘 |
| **formal / official** (공적·공식 문서) | "~합니다/~십시오" 격식체 + "귀하/여러분/임직원 여러분" + 관용 인사말 |
| **marketing copy** (마케팅·카피) | 짧은 문장 (평균 < 25자) + 행동 유도 ("지금", "오늘", "한 번에") + 강조 어휘 |
| **README / technical** | 코드 블록 + 명령어 + "Usage" / "Install" 등 영문 헤딩 + 단계별 절차 |

If signals conflict, ask the user (`AskUserQuestion`) or default to the closest match. README와 technical doc은 report 룰을 적용하되 특수 예외(아래)를 추가로 본다.

## Per-pattern allowance matrix (Korean)

핵심 패턴만 명시. 누락된 패턴은 catalog 기본 severity 적용.

| Pattern | Column | Report | Blog | Formal | Marketing | README |
|---------|--------|--------|------|--------|-----------|--------|
| KO-3 ~적/~성/~화 | warn | **allow** | warn | **allow** | block | warn |
| KO-5 균일 문장 길이 | block | warn | warn | warn | **allow** | warn |
| KO-6 3개 나열 | block | **allow once** | warn | warn | **allow** | **allow once** |
| KO-7 접속사 남용 | block | warn | warn | warn | block | warn |
| KO-10 격식체 과잉 | block | warn | block | **allow** | block | warn |
| KO-11 형식적 결론 | block | warn | warn | **allow once** | block | block |
| KO-13 안내문 종결 | block | block | warn | **allow once** | warn | block |
| KO-15 Bold/이탤릭 | block | **allow** | block | block | **allow** | **allow** |
| KO-16 이모지 불릿 | block | block | **allow once** | block | **allow** | warn |
| KO-19 과잉 균형감 | block | warn | warn | warn | block | warn |
| KO-26 권고형 결말 5+ | warn | block | warn | **allow** | warn | warn |
| KO-28 먼저·반면·결국 3단 | block | **allow once** | warn | warn | block | **allow once** |
| KO-29 1) 2) 3) 인덱싱 | block | **allow** | warn | warn | block | **allow** |
| KO-30 콜론 부제 헤딩 | block | **allow once** | warn | warn | warn | **allow** |
| KO-31 단문 일변도 | block | warn | warn | warn | **allow** | warn |
| KO-35 의인화 추상 주어 | **allow once** | block | warn | block | **allow** | block |
| KO-36 ~할 때입니다 | block | block | warn | **allow once** | warn | block |
| KO-37 X에서 Y로 변환 | warn | **allow once** | warn | warn | **allow** | block |
| KO-39 따옴표 강조 5+ | warn | warn | warn | block | **allow** | warn |

### Threshold adjustments

When the cell is `warn` for count-based patterns, raise the trigger threshold by genre:

| Pattern | Default threshold | Adjustment |
|---------|-------------------|------------|
| KO-7 접속사 남용 | "한 단락 시작 접속사 4+" | Report/README: 5+, Formal: 5+ |
| KO-26 권고형 결말 | "한 문서 5+" | Formal: 8+, Report: 6+ |
| KO-39 따옴표 강조 | "한 문서 5+" | Marketing: 8+, Blog: 7+ |
| KO-3 ~적/~성/~화 | "한 문장 3+" | Report/Formal: 4+ |

## Per-pattern allowance matrix (English)

| Pattern | Column | Report | Blog | Formal | Marketing | README |
|---------|--------|--------|------|--------|-----------|--------|
| EN-7 AI vocabulary (pivotal, underscores) | block | warn | block | warn | block | block |
| EN-9 "Not just X, it's Y" | block | block | warn | block | **allow once** | block |
| EN-10 Rule of three | block | **allow once** | warn | warn | **allow** | **allow once** |
| EN-14 Em-dash overuse | block | warn | warn | block | warn | warn |
| EN-15 Bold/italic emphasis | block | **allow** | warn | block | **allow** | **allow** |
| EN-18 Emoji bullets | block | block | **allow once** | block | **allow** | warn |

## Genre-specific notes

### Column / essay
- 의인화(KO-35) 1회는 수사적 장치로 허용. 2회+이면 차단.
- 단문(KO-31) 1~2 연속은 의도된 호흡으로 허용. 5+ 연속은 여전히 차단.
- 1인칭 어조 보존이 최우선 — "personality" pass는 강하게 적용.

### Report / doc
- 구조 패턴(KO-29, KO-30) 1회는 정보 정리에 유용. 반복은 차단.
- KO-3 (~적/~성/~화)는 학술·정책 어휘로 자연스러움. 한 문장 4개 이상에서만 트리거.
- 권고형 결말(KO-26)은 "권고 사항" 섹션에서는 정상이지만 본문에서 5+이면 차단.

### Blog post
- 친근체와 격식체가 섞이는 게 자연스럽지만, 한 단락 안에서 "~요"와 "~다"가 혼합되면 차단.
- 이모지 1회 정도는 허용 (소제목 또는 강조). 불릿마다 박혀 있으면 차단.

### Formal / official
- 격식체(KO-10) 자체는 장르 본질이므로 허용. 단 "~하시기 바랍니다"가 한 단락에 3+이면 과잉.
- 권고형 결말(KO-26) 임계 5 → 8로 상향. 정책 문서는 권고가 핵심.
- 의인화(KO-35) 절대 차단 — 공적 문서에 어울리지 않음.

### Marketing copy
- 단문(KO-31), 강조 어휘, 이모지가 본질이므로 대부분 허용.
- 단, hype 어휘(KO-1의 "혁신적·획기적·전례 없는") 한 카피에 3+이면 차단 — 마케팅에서도 과잉.

### README / technical
- 영문 헤딩, 코드 블록, 명령어는 절대 건드리지 않음 (Do-NOT list).
- KO-29 (1) 2) 3))과 KO-30 (콜론 헤딩 "Install: Setup")은 기술 문서 관습이므로 허용.
- 1인칭/감정 표현은 Step 4 voice 패스에서 추가하지 않음 — 기술 문서는 중립 톤.

## Output handling

장르 필터로 인해 finding이 dropped 되면 audit 결과 표에 표시:

```
| KO-26 | 권고형 결말 (5회) | High | "...해야 한다" | dropped (genre: formal) |
```

이렇게 하면 사용자가 "왜 안 고쳤지?"를 추적할 수 있다. Dropped finding은 변경률 계산에서 제외 (수정하지 않은 텍스트는 변경 0).

## Voice sample override

사용자가 voice sample을 제공한 경우:
- Sample이 특정 패턴을 명시적으로 사용하면 → 해당 패턴은 그 작성자의 voice로 간주 → allow.
- 단 KO-21(이중 피동)·KO-24(정도부사 중독) 등 명백한 비문/AI 잔재는 voice override로도 허용하지 않음.
- 우선순위: voice sample > genre rules > catalog default.

---
<!-- [See: patterns-en] -->

# English AI Writing Patterns

English pattern catalog adapted from Wikipedia's "Signs of AI writing" (WikiProject AI Cleanup) via `blader/humanizer` (MIT), with x-mesh additions for agent-era prose.

Severity guide:
- **High** — instantly reads as AI; always rewrite.
- **Medium** — noticeable; rewrite unless context demands it.
- **Low** — minor tic; rewrite if dense in the text.

## Content Patterns

### EN-1 — Significance inflation (High)
**Watch:** stands/serves as, testament/reminder, vital/significant/crucial/pivotal/key role, underscores/highlights importance, reflects broader, symbolizing ongoing/enduring/lasting, marking/shaping the, key turning point, evolving landscape, focal point, indelible mark, deeply rooted.

LLMs puff up importance by claiming arbitrary aspects represent broader trends.

- Before: "established in 1989, marking a pivotal moment in the evolution of regional statistics"
- After: "established in 1989 to collect regional statistics independently from Spain's national office"

### EN-2 — Notability name-dropping (Medium)
**Watch:** independent coverage, local/regional/national media outlets, written by a leading expert, active social media presence.

- Before: "cited in The New York Times, BBC, Financial Times, and The Hindu"
- After: "In a 2024 NYT interview, she argued that AI regulation should focus on outcomes."

### EN-3 — Superficial -ing analyses (High)
**Watch:** highlighting/underscoring/emphasizing, ensuring, reflecting/symbolizing, contributing to, cultivating/fostering, encompassing, showcasing.

- Before: "blue, green, and gold resonates with regional beauty, symbolizing bluebonnets, reflecting community connection"
- After: "blue, green, and gold colors. The architect chose these to reference local bluebonnets and the Gulf coast."

### EN-4 — Promotional/advertisement language (High)
**Watch:** boasts a, vibrant, rich (figurative), profound, enhancing its, exemplifies, commitment to, natural beauty, nestled, in the heart of, groundbreaking (figurative), renowned, breathtaking, must-visit, stunning.

- Before: "Nestled within the breathtaking region, [town] stands as a vibrant town with rich cultural heritage"
- After: "[Town] is in the Gonder region, known for its weekly market and 18th-century church."

### EN-5 — Vague attributions / weasel words (High)
**Watch:** Industry reports, Observers have cited, Experts argue, Some critics argue, several sources/publications.

- Before: "Experts believe it plays a crucial role in the regional ecosystem."
- After: "supports several endemic fish species, according to a 2019 survey by the Chinese Academy of Sciences."

If the source has no citation, do not invent one — flag "(source needed)".

### EN-6 — Formulaic challenges/future sections (Medium)
**Watch:** Despite its... faces several challenges, Despite these challenges, Challenges and Legacy, Future Outlook.

- Before: "Despite challenges typical of urban areas, [town] continues to thrive"
- After: "Traffic congestion increased after 2015 when three new IT parks opened. The municipal corporation began a stormwater drainage project in 2022."

## Language and Grammar Patterns

### EN-7 — AI vocabulary words (High)
**High-frequency:** Actually, additionally, align with, crucial, delve, emphasizing, enduring, enhance, fostering, garner, highlight (verb), interplay, intricate, key (adj), landscape (abstract), pivotal, showcase, tapestry, testament, underscore (verb), valuable, vibrant.

These cluster — finding 2+ in one paragraph is a strong AI signal.

- Before: "an enduring testament to Italian colonial influence is the widespread adoption of pasta in the local culinary landscape"
- After: "Pasta dishes, introduced during Italian colonization, remain common, especially in the south."

### EN-8 — Copula avoidance (High)
**Watch:** serves as / stands as / marks / represents [a], boasts / features / offers [a].

- Before: "Gallery 825 serves as LAAA's exhibition space and boasts over 3,000 sq ft."
- After: "Gallery 825 is LAAA's exhibition space. It has 3,000 sq ft across four rooms."

### EN-9 — Negative parallelisms / tailing negations (High)
**Watch:** "Not only X, but Y", "It's not just X, it's Y", trailing fragments like ", no guessing" or ", no wasted motion".

- Before: "It's not just about the beat; it's part of the aggression."
- After: "The heavy beat adds to the aggressive tone."
- Before: "The options come from the selected item, no guessing."
- After: "The options come from the selected item — the user does not have to guess." (or rewrite without trailing fragment)

### EN-10 — Rule of three (Medium)
LLMs force ideas into groups of three.

- Before: "The event features keynote sessions, panel discussions, and networking opportunities."
- After: "The event includes talks and panels, with informal networking between sessions."

Three is fine when the source actually has three things. The pattern is when the count is forced.

### EN-11 — Synonym cycling / elegant variation (Medium)
LLMs substitute synonyms to avoid repetition penalties, producing protagonist → main character → central figure → hero in four sentences.

- Before: "The protagonist faces challenges. The main character must overcome obstacles. The central figure triumphs."
- After: "The protagonist faces many challenges but eventually triumphs."

### EN-12 — False ranges (Medium)
"From X to Y" where X and Y are not on a meaningful scale.

- Before: "from the Big Bang to dark matter, from black holes to galaxy formation"
- After: "covers the Big Bang, star formation, and current theories about dark matter."

### EN-13 — Passive voice / subjectless fragments (Medium)
- Before: "No configuration file needed. Results are preserved automatically."
- After: "You do not need a configuration file. The system preserves results automatically."

## Style Patterns

### EN-14 — Em-dash overuse (High)
LLMs use em-dashes to mimic punchy sales writing.

- Before: "promoted by Dutch institutions—not by the people—yet this continues—even in official documents"
- After: "promoted by Dutch institutions, not by the people, yet this continues in official documents."

Em-dashes survive in dialogue, true asides, or when the user's voice sample uses them.

### EN-15 — Boldface overuse (Medium)
- Before: "blends **OKRs**, **KPIs**, and **BMC**"
- After: "blends OKRs, KPIs, and the Business Model Canvas"

### EN-16 — Inline-header lists (High)
- Before:
  - **Performance:** Performance improved.
  - **Security:** Security strengthened with encryption.
- After: "The update speeds up load times and adds end-to-end encryption."

### EN-17 — Title Case headings (Low)
- Before: "Strategic Negotiations And Partnerships"
- After: "Strategic negotiations and partnerships"

### EN-18 — Emojis as bullet markers (Medium)
- Before: "🚀 Launch Phase: 💡 Key Insight:"
- After: "Launch phase. Key insight:"

Skip if the user's voice sample uses emojis.

### EN-19 — Curly quotes inserted by AI (Low)
Smart quotes inserted into otherwise technical text. Match source convention.

### EN-26 — Hyphenated word-pair overuse (Medium)
**Watch:** cross-functional, data-driven, client-facing, customer-centric, end-to-end, world-class.

- Before: "cross-functional, data-driven, client-facing teams"
- After: "teams that work across functions and rely on data" (or drop the hyphens)

### EN-27 — Persuasive authority tropes (Medium)
**Watch:** "At its core,", "What truly matters is", "The reality is".

- Before: "At its core, what matters is collaboration."
- After: "Collaboration matters."

### EN-28 — Signposting announcements (Medium)
**Watch:** "Let's dive in", "Here's what you need to know", "Without further ado".

- Before: "Let's dive in. Here's what you need to know about caching."
- After: "Caching matters because…" (start with the content)

### EN-29 — Fragmented headers (Low)
- Before: "## Performance" + "Speed matters."
- After: Let the heading do the work, or merge into prose.

## Communication Patterns

### EN-20 — Chatbot artifacts (High)
**Watch:** "I hope this helps!", "Let me know if you have questions", "Feel free to ask".
Remove entirely.

### EN-21 — Cutoff/availability disclaimers (High)
**Watch:** "While details are limited in available sources", "Based on my training data".
Find sources or remove.

### EN-22 — Sycophantic tone (High)
**Watch:** "Great question!", "You're absolutely right!", "What an interesting topic!".
Respond directly without flattery.

## Filler and Hedging

### EN-23 — Filler phrases (Medium)
- "In order to" → "To"
- "Due to the fact that" → "Because"
- "At this point in time" → "Now"
- "In the event that" → "If"

### EN-24 — Excessive hedging (Medium)
- Before: "could potentially possibly be considered"
- After: "may be" (or drop the hedge entirely if certain)

### EN-25 — Generic conclusions (High)
- Before: "The future looks bright. Exciting times lie ahead."
- After: Specific plans, dates, or outcomes — or remove the conclusion.

### EN-30 — Balanced-but-empty conclusions (Medium)
**Watch:** "opportunities and challenges", "balance innovation with responsibility", "a nuanced approach is needed", "only time will tell".

The sentence sounds thoughtful but makes no concrete judgment.

- Before: "AI agents present both opportunities and challenges, so teams need a balanced approach."
- After: "Use agents for reversible work first. Keep approvals on deploys, permission changes, and data deletion."

### EN-31 — Over-smoothed paragraph rhythm (Medium)
Every paragraph opens with context, gives three points, then lands on a tidy conclusion. Humans often leave a rough edge: a caveat, a sharper claim, a shorter sentence, or a concrete next step.

- Before: "This shift is important because it improves speed, consistency, and collaboration. As a result, teams can work more effectively."
- After: "This mostly saves review time. The collaboration story is less clear until teams decide who owns the agent's output."

---
<!-- [See: patterns-ko] -->

# Korean AI Writing Patterns (한국어 AI 슬롭 패턴)

Korean AI text has its own statistical tells distinct from English. This catalog is original to x-mesh — observed across hundreds of LLM-generated Korean drafts.

Severity guide:
- **High** — 첫 문장에서 AI라고 들킴. 무조건 수정.
- **Medium** — 분명한 AI 신호. 문맥상 필요하지 않으면 수정.
- **Low** — 사소한 버릇. 밀집되어 있을 때만 수정.

## 어휘 패턴

### KO-1 — AI 상투어 (High)
**감시 단어:** ~을 통해, ~에 있어, ~에 다름 아니다, ~라 할 수 있다, ~을 의미한다, ~을 시사한다, 본질적으로, 궁극적으로, 결국, 한편, 나아가, 더불어, 이는 ~함을 보여준다, ~에 기인한다.

LLM 한국어 텍스트는 이 어휘들이 한 단락에 2개 이상 나타나는 경향이 있다.

- 전: "본질적으로 이 시스템은 사용자 경험을 향상시키는 데 있어 핵심적인 역할을 한다고 할 수 있다."
- 후: "이 시스템은 사용자 경험을 개선한다."

### KO-2 — 영어 직역체 (High)
**감시 표현:** "~을 가지다(have)", "~을 만들다(make)", "~을 제공하다(provide)", "~에 기반한다(based on)", "~을 위한(for)", "~에 관하여(regarding)".

영어 to-부정사/관계절을 그대로 옮긴 한국어는 어색하다.

- 전: "더 나은 결과를 제공하기 위한 도구"
- 후: "결과를 더 좋게 만드는 도구" 또는 "결과를 개선하는 도구"
- 전: "이 기능은 사용자 만족도를 향상시키는 효과를 가진다."
- 후: "이 기능은 사용자 만족도를 높인다."

### KO-3 — 과도한 `~적`, `~성`, `~화` (Medium)
LLM은 명사에 `-적`, `-성`, `-화`를 붙여 추상화하는 경향이 있다.

- 전: "전략적 접근을 통한 효율적 자원 배분의 최적화"
- 후: "자원을 더 잘 나눠 쓰는 전략" / "자원을 효율적으로 배분"

규칙: 한 문장에 `-적/성/화`가 3개 이상이면 수정 대상.

### KO-4 — 명사화 남발 (Medium)
**전형:** "~함", "~음", "~기", "~것" 형 종결, "~의 ~을 ~함" 연쇄.

- 전: "사용자 경험의 향상을 위한 인터페이스의 개선의 필요성이 강조됨."
- 후: "인터페이스를 개선하면 사용자 경험이 좋아진다."

### KO-17 — 과한 의의 부여 (High)
**감시 표현:** "~라는 점에서 의미가 있다", "~에 의의가 있다", "~의 가능성을 보여준다", "~의 중요한 전환점이다", "~의 새로운 지평을 연다".

구체적 근거 없이 글의 의미를 부풀리는 결론부에서 자주 나온다.

- 전: "이번 업데이트는 개발 생산성 향상이라는 점에서 큰 의의가 있다."
- 후: "이번 업데이트로 반복 설정이 줄었다."

### KO-18 — 출처 없는 집단 주어 (High)
**감시 표현:** "많은 전문가들은", "업계에서는", "사용자들은", "일각에서는", "여러 연구에 따르면".

출처가 없으면 집단 주어를 줄이거나 `source needed`를 남긴다. 없는 통계나 사례를 만들지 않는다.

- 전: "업계에서는 이 방식이 표준이 될 것으로 보고 있다."
- 후: "이 방식이 표준이 될지는 아직 근거가 부족하다." 또는 "업계에서는 이 방식이 표준이 될 것으로 보고 있다. (source needed)"

## 구조 패턴

### KO-5 — 균일한 문장 길이 (High)
LLM 한국어는 모든 문장이 거의 같은 길이가 되는 경향이 있다 (보통 25-35자). 사람이 쓴 글은 5자 문장과 80자 문장이 섞인다.

진단: 단락 내 문장 길이 표준편차가 평균의 20% 미만이면 수정 필요.

- 전: 모든 문장이 30자 ± 5자
- 후: "그렇다." 같은 짧은 문장과 길고 풀어쓴 문장을 섞는다.

### KO-6 — 3개 나열 강박 (Medium)
영어 EN-10과 유사하지만 한국어에서는 "A, B, 그리고 C"가 더 두드러진다.

- 전: "신속함, 정확함, 그리고 안정성을 제공한다."
- 후: "빠르고 정확하다." (실제로 셋 다 다른 의미가 아니라면)

### KO-7 — 접속사 남용 (High)
**감시:** "한편", "또한", "더불어", "나아가", "결국", "요컨대", "이러한 맥락에서".

각 단락이 이런 접속사로 시작하면 AI 신호.

- 전: "한편, 시스템은 안정적이다. 또한, 빠르다. 나아가, 사용하기 쉽다."
- 후: "시스템은 안정적이고 빠르며 쓰기 쉽다."

### KO-8 — 주어 명시 강박 (Medium)
한국어는 주어 생략이 자연스러우나 LLM은 영어 영향으로 매번 주어를 박는다.

- 전: "본 시스템은 사용자에게 알림을 보낸다. 본 시스템은 또한 로그를 기록한다."
- 후: "사용자에게 알림을 보내고 로그도 남긴다."

### KO-9 — 무책임한 종결 (High)
**감시:** "~할 수 있다", "~라 할 수 있다", "~을 시사한다", "~로 보인다".

가능성/추측 표현을 단정 대신 깔아두는 회피 어법. 한 문단에 2번 이상이면 수정.

- 전: "이는 성능 향상에 기여할 수 있다고 할 수 있다."
- 후: "성능이 향상된다." (확신이 있다면) 또는 "벤치마크에서 12% 빨라졌다." (구체)

## 톤 패턴

### KO-10 — 격식체 과잉 (Medium)
**감시:** "~하시기 바랍니다", "~해 주시기 바랍니다", "~을 권장드립니다", "~에 대해 안내드립니다".

기술 문서/블로그에 비즈니스 메일 톤이 끼는 경우.

- 전: "본 기능을 사용하시기 바랍니다."
- 후: "이 기능을 쓰면 된다." (반말 톤) / "이 기능을 사용하세요." (존댓말 톤)

원본 텍스트의 톤을 따라가되, "~하시기 바랍니다"는 거의 항상 과잉이다.

### KO-11 — 형식적 결론 (High)
**전형:** "결론적으로", "요컨대", "정리하자면", "이상으로".

블로그 글이 "결론적으로 이 기술은 미래를 밝게 한다."로 끝나면 AI.

- 전: "결론적으로, 이 도구는 개발 생산성을 크게 향상시킬 것으로 기대된다."
- 후: 구체적 다음 단계나 의견으로 마무리. ("나는 이걸 한 달 써봤고, 두 가지가 인상 깊었다…")

### KO-12 — 칭찬·아부 도입부 (High)
**감시:** "좋은 질문입니다", "흥미로운 주제네요", "정확한 지적입니다".

채팅 잔재. 글 본문에 들어와 있으면 무조건 삭제.

### KO-13 — 안내문 종결 (High)
**감시:** "도움이 되셨길 바랍니다", "추가 문의 사항은…", "더 궁금한 점이 있으시면…".

채팅 잔재. 블로그/README에 박혀 있으면 삭제.

### KO-19 — 과잉 균형감 (Medium)
**전형:** "장점도 있지만 단점도 있다", "기회와 과제가 공존한다", "균형 잡힌 접근이 필요하다".

구체적 판단 없이 양쪽을 다 언급하는 안전한 결론은 AI처럼 보인다. 실제 판단, 조건, 다음 행동으로 바꾼다.

- 전: "자동화는 기회와 과제가 공존하므로 균형 잡힌 접근이 필요하다."
- 후: "자동화는 반복 작업에는 바로 쓰되, 권한 변경처럼 되돌리기 어려운 작업에는 승인 단계를 둬야 한다."

## 표기 패턴

### KO-14 — 불필요한 영어 병기 (Medium)
**전형:** "최적화(Optimization)", "사용자(User)", "데이터베이스(Database)".

기술 용어가 처음 나올 때 1회 병기는 정상. 이미 한국 IT 업계 표준 용어가 된 경우 병기 불필요.

- 전: "데이터베이스(Database)에서 사용자(User) 정보를 조회(Query)한다."
- 후: "DB에서 사용자 정보를 조회한다." 또는 "데이터베이스에서 사용자 정보를 조회한다."

### KO-15 — Bold/이탤릭 남용 (Low)
영어 EN-15와 동일. 한국어에서는 더 두드러진다 — 한국어 본문은 굵게/기울임을 거의 안 쓰는 게 자연스럽다.

### KO-16 — 이모지 불릿 (Medium)
EN-18과 동일. 한국어 기술 블로그/README에서 ✅ 🚀 💡를 불릿으로 쓰면 AI 신호.

## 확장 패턴 (v0.3.0 추가, im-not-ai SSOT 참고)

KO-1 ~ KO-19와 동일 구조의 추가 패턴이다. 심각도 표기는 동일(High/Medium/Low). im-not-ai의 S1/S2/S3 분류와 매핑되며, 실전 LLM 출력에서 재현 2회 이상 관찰된 항목만 채택했다.

### 어휘·번역투 (확장)

#### KO-20 — "가지고 있다" 직역체 (High)
**감시:** "~을 가지고 있다", "~을 가진다", "~을 보유하고 있다".

영어 `have/possess` 직역. 한국어는 형용사·동사로 직접 서술하는 게 자연스럽다.

- 전: "이 시스템은 강한 확장성을 가지고 있다."
- 후: "이 시스템은 확장성이 강하다." 또는 "잘 확장된다."

#### KO-21 — 이중 피동 (High)
**감시:** "~되어진다", "~지게 된다", "~게 되어진다".

피동 표시가 중첩된 비문. 한국어 표준에서도 잘못된 표현이지만 LLM 출력에서 빈출.

- 전: "이 결과는 다음과 같이 판단되어진다."
- 후: "이 결과를 다음과 같이 판단한다." 또는 단일 피동 "다음과 같이 판단된다."

#### KO-22 — "~에 의해" by-passive (Medium)
영어 by-passive 직역. 행위자가 명확하면 능동으로 돌리는 게 한국어답다.

- 전: "AI에 의해 생성된 이미지가 SNS를 점령했다."
- 후: "AI가 만든 이미지가 SNS를 점령했다."

행위자가 정말 모호하거나 강조 의도가 있을 때만 유지.

#### KO-23 — 추상 주어 + 만능 동사 (Medium)
**전형:** "X의 등장은 ~을 보여준다 / 시사한다 / 가져온다 / 의미한다."

영어 `The X shows / indicates Y` 직역. 사건·현상이 주어가 되고 술어가 추상 동사인 형태.

- 전: "DeepSeek-V4의 등장은 글로벌 AI 경쟁의 새 국면을 보여준다."
- 후: "DeepSeek-V4가 나오면서 글로벌 AI 경쟁의 모양이 바뀌었다."

#### KO-24 — 정도부사 중독 (Medium)
**감시:** "매우", "정말", "진짜로", "대단히", "극히", "굉장히".

대부분 삭제. 강조가 필요하면 구체 수치·사례로 대체.

- 전: "이 도구는 매우 효율적이고 정말 빠르다."
- 후: "12% 더 빠르다." (구체) 또는 "효율적이고 빠르다." (생략)

#### KO-25 — 동의어 이중 수식 (Medium)
**전형:** "중요하고 핵심적인", "새롭고 혁신적인", "지속적이고 꾸준한", "안정적이고 견고한".

같은 의미의 두 수식어를 겹친 형태. 하나만 남긴다.

- 전: "지속적이고 꾸준한 노력이 필요하다."
- 후: "꾸준한 노력이 필요하다."

#### KO-26 — 권고형 결말 남발 (High)
**감시:** "~할 필요가 있다", "~해야 한다", "~해야 합니다", "~을 권장한다".

영어 `should/need to` 직역. 정책·보고서·블로그 결말마다 자동 등장. **한 문서에 5회 초과면 즉시 수정.**

- 전: "기업은 데이터를 정비해야 한다. 인력을 양성해야 한다. 인프라를 구축해야 한다."
- 후: 주체·동작 구체화 — "기업은 데이터를 먼저 정비하고 인력을 양성한다. 인프라는 그다음이다." 또는 조건문 — "데이터가 정비되면 인력 양성이 의미 있어진다."

#### KO-27 — "~능력" 추상명사 연쇄 (Medium)
"N 능력"이 한 문서에 3회 이상 반복. 영어 `ability to X / X capability` 직역.

- 전: "사고 능력이 뛰어나고 추론 능력이 강하며 장기 문맥 유지 능력도 우수하다."
- 후: "잘 사고하고 추론하며 긴 문맥도 잘 따라간다."

### 구조 (확장)

#### KO-28 — "먼저·반면·결국" 3단 공식 (Medium)
문단 문두가 순서대로 "먼저 ~ / 반면 ~ / 결국 ~" 또는 "첫째 ~ / 둘째 ~ / 마지막으로 ~"로 고정. KO-6(3개 나열 강박)과 인접하나 별개 — 글 전체 흐름이 이 3단 공식으로 짜인 경우.

처방: 문두 접속사 3개 중 2개 삭제. 순서 의미는 문단 자체로 전달.

#### KO-29 — 숫자 괄호 인덱싱 "1) 2) 3)" (Medium)
동일 문단 또는 인접 문장에서 항목을 `1) ... 2) ... 3) ...` 형식으로 나열. 한 문서에 1회 이하.

- 전: "이는 1) 인프라 안정화 2) 비용 하락 3) 도메인 모델 성숙이 동시에 일어난 결과다."
- 후: "인프라가 안정되고 비용이 떨어졌으며 도메인 모델도 익었기 때문이다."

#### KO-30 — 콜론 부제 헤딩 "X: Y" 공식 (Medium)
헤딩에 거의 자동으로 콜론을 사용해 "메인 라벨: 부제" 형태로 구조화. 한 문서에 1회 이하.

- 전: `## 결론: AI 시대의 새로운 지평`
- 후: `## 결론` (단순화) 또는 부제를 본문 첫 문장으로 녹이기.

#### KO-31 — 단문 일변도 (Medium)
문장 대부분이 단문으로만 끊어져 있고 복문·중문이 거의 없음. KO-5(길이 균일성)와 짝패턴 — KO-5는 길이 표준편차, KO-31은 구조 단조성.

- 전: "AI는 빠르게 발전한다. 기업은 따라가야 한다. 시간이 없다. 데이터가 핵심이다."
- 후: "AI가 빠르게 발전하는 가운데 기업은 따라가야 한다. 시간은 없고 데이터는 핵심이다."

처방: 인접 단문 2-3개를 연결어미(`-며·-고·-는데·-면서`)로 묶어 복문화. 단문은 강조·전환·결정타에만 의도적으로.

#### KO-32 — 동일 종결어미 반복 (Medium)
"~이다. ~이다. ~이다." 또는 "~한다. ~한다. ~한다."로 모든 문장이 같은 종결어미. KO-9와 다른 축 — KO-9는 어휘 종결(`~할 수 있다`), KO-32는 어미 반복 자체.

처방: "~다", "~았다", "~인 것", 명사형 종결을 섞는다. 인간 필자는 무의식적으로 변주한다.

#### KO-33 — "이는 ~" 지시 반복 (Medium)
**전형:** "이는 ~을 의미한다", "이는 ~을 보여준다", "이 점에서 ~", "이 관점에서 보면 ~", "이 말은 ~".

앞 문장을 받아 부연 설명할 때마다 "이는"으로 시작. 메타 진입 자체를 삭제하고 본 서술로 직진.

- 전: "성능이 12% 빨라졌다. 이는 효율 개선을 의미한다."
- 후: "성능이 12% 빨라졌고, 그만큼 효율이 좋아졌다."

#### KO-34 — 재정의 접속사 "즉" 남발 (Medium)
영어 `i.e. / that is` 직역. 보충 설명마다 "즉"을 앞에 붙임. 한 문서 2회 이하.

처방: "곧", "말하자면", "다시 말해"로 어휘 변주. 또는 쉼표로만 연결.

### 톤 (확장)

#### KO-35 — 의인화된 추상 주어 (Medium)
사건·기술·개념을 주어로 삼아 인간 행위처럼 서술. KO-23과 비슷하나 KO-23은 영어 직역 구문, KO-35는 의인화 자체가 시그니처.

- 전: "두 지능의 충돌이 새로운 질문을 던진다."
- 후: "두 회사가 부딪히면서 새로운 질문이 떠오른다." (행위자 교체) 또는 의인화 동사 약화 ("던진다" → "남는다").

상징적 제목·요약 1회 정도는 허용.

#### KO-36 — "~할 때입니다" 결말 공식 (High)
**감시:** "~해야 할 때입니다", "~로 나아갈 시점입니다", "~할 순간입니다".

칼럼·리포트 마지막 문장의 공식. 한 문서에 한 번 이하.

- 전: "에이전트 정부의 시대로 나아가야 할 때입니다."
- 후: 구체 동사 단언 — "에이전트 정부 단계로 넘어가는 게 다음이다."

#### KO-37 — "X에서 Y로" 변환 공식 (Medium)
**전형:** "'X에서 Y로'", "'X을 넘어 Y로'".

패러다임 전환·진화·고도화를 표현할 때 자동 사용. 한 문서에 1회 이하.

- 전: "'규모의 경쟁'에서 '전략의 경쟁'으로 넘어간다."
- 후: "규모로 겨루던 시대는 끝났다. 이제는 전략이다." (직접 단언)

#### KO-38 — "~다는 뜻이다 / ~다는 것이다" 결말 변종 (Medium)
GPT가 결산 문장을 형식명사로 마무리할 때 자동 등장. KO-4(명사화 남발)의 종결부 변종.

- 전: "병목은 인력 전환이라는 뜻이다."
- 후: "병목은 인력 전환이다."

한 문서에 형식명사 결산("~다는 것이다 / ~다는 뜻이다 / ~다는 점이다") 합산 2회 이하.

### 표기 (확장)

#### KO-39 — 따옴표 강조 남발 (Medium)
개념어·강조어에 작은따옴표 또는 큰따옴표를 남발. **한 문서 5회 초과 시 즉시 수정.**

- 전: "'옥석 가리기'·'금융 슈퍼앱'·'데이터 피로감' 같은 흐름이 동시에 일어난다."
- 후: 진짜 인용·특수 용례에만 한정. 첫 등장 시 1회만 사용한 뒤 한국어 평문으로.

#### KO-40 — 대시(—) / 괄호 부연 과다 (Low)
영어 em-dash 스타일 부가 설명. 1문서 1-2회 이하.

- 전: "AI는 도구 — 그 이상도 이하도 아닌 — 이다."
- 후: "AI는 도구일 뿐이다." (쉼표·괄호·별도 문장으로 분해)

괄호 부연 "(이는 ~을 의미한다)"이 반복되면 본문화 또는 삭제.

## 한·영 혼용 글 처리

원문이 한·영 혼합이면:
1. 단락 단위로 언어 비율을 파악한다.
2. 각 단락은 그 단락의 우세 언어 패턴 카탈로그를 적용한다.
3. 단락 간 어조 일관성을 유지한다 (한 단락은 반말, 다른 단락은 존댓말로 가지 않게).

## 한국어 voice calibration

영어와 동일하나 추가로 확인할 것:
- 반말/존댓말/하오체 — 사용자 샘플의 어미 분포 (~다 / ~요 / ~습니다 / ~지 / ~네)
- 한자어 비율 — 같은 의미를 한자어로 쓰는가 고유어로 쓰는가
- 영어 단어 직접 사용 빈도 (예: "의존성" vs "dependency")
- 어순 — 영어식 어순(주어를 매번 명시)을 쓰는가, 한국어식(생략)을 쓰는가
- 문단 마무리 습관 — 단정으로 끝내는가, 짧은 감상으로 끝내는가, 다음 행동으로 끝내는가

---
<!-- [See: voice-calibration] -->

# Voice Calibration

How to analyze a writing sample and reproduce its voice in the rewrite.

## When to use

- User provides 2-3 paragraphs of their own writing alongside text to humanize
- User points to a file ("use my style from `notes.md`")
- User explicitly asks "match my voice" / "내 문체에 맞춰서"

If no sample is provided, fall back to the default PERSONALITY pass in SKILL.md Step 4.

## Analysis checklist

Read the sample first. Note these dimensions:

### 1. Sentence rhythm
- Average length (count characters or words)
- Variance (do they mix 5-word sentences with 30-word sentences?)
- Sentence shape (subject-led, fragment-led, question-led?)

Record as a range, not an average. "10-45 words, mostly 15-25" beats "average 22 words".

### 2. Word choice level
- Casual ("stuff", "thing", "kind of") vs academic ("element", "component", "approximately")
- Korean: 한자어 vs 고유어 비율, 영어 단어 직접 사용 여부
- Slang or jargon density

### 3. Paragraph openings
- Jump straight into content?
- Set context first?
- Start with a question or claim?
- Use transitional connectors ("So,", "But,", "한편,") or skip them?

### 4. Punctuation habits
- Em-dash count per 100 words
- Parenthetical aside frequency
- Semicolon usage (rare in human writing — heavy semicolons are an AI signal even in samples)
- Korean: ~네, ~지, ~거든, ~잖아 같은 어말 어미 빈도

### 5. Recurring phrases / verbal tics
- Words that appear 3+ times in the sample
- Distinctive openers ("Look,", "그러니까,", "Honestly,")
- Personal pronouns ("I", "we", or impersonal)

### 6. Transition style
- Explicit connectors ("therefore", "however") vs implicit (just start the next point)
- Korean: "그래서", "근데", "그러면" 같은 구어체 vs "따라서", "그러나" 격식체

### 7. Korean-specific
- Sentence-ending register: ~다 (plain) / ~요 (polite) / ~습니다 (formal) / ~지 (casual) / ~네 (interactive)
- 반말/존댓말 일관성

## Application rules

### Match, do not upgrade

If the sample uses casual register, the rewrite must use casual register. Common failures:
- Sample says "stuff" → rewrite says "elements" (FAIL — upgraded)
- Sample says "근데" → rewrite says "그러나" (FAIL — formalized)
- Sample writes 8-word fragments → rewrite produces 25-word complete sentences (FAIL — smoothed)

### Match sentence-length variance

If sample variance is high (some short, some long), produce high variance. If sample variance is low (all medium), do not artificially inject short fragments.

Target: rewrite's sentence-length variance within ±20% of sample's.

### Replace AI patterns with sample patterns

Do not just delete AI patterns. Replace with what the sample would have written.

Example:
- Source AI text: "It's not just about speed; it's about reliability."
- Sample uses casual register with short sentences.
- Bad rewrite: "Speed and reliability both matter." (deleted pattern but generic)
- Good rewrite: "Yeah, fast. But also doesn't crash." (matches sample voice)

### Korean voice calibration extras

- Match the sample's 어말 어미 distribution. If sample uses ~지 / ~거든 mix, do not output only ~다 endings.
- Match Sino-Korean vs native ratio. If sample says "쓰다" not "사용하다", rewrite says "쓰다".
- If sample omits subjects, the rewrite omits subjects.

## Failure modes

- **Over-fitting** — copying the sample's exact phrasing into the rewrite. Match patterns, not words.
- **Cherry-picking** — fixating on one feature (e.g., em-dashes) and ignoring others (e.g., sentence length).
- **Tonal mismatch** — applying sample's casual voice to text whose content is technical reference. Voice and register can mismatch when content demands; check before forcing.
- **Sample too short** — fewer than 2 paragraphs is not enough signal. Ask the user for more, or fall back to default voice.

## Output note (developer mode)

When voice calibration is used, append to the rewrite output:

```
**Voice features matched:**
- Sentence length: short (5-10 words) mixed with mid (20-30 words)
- Register: casual, occasional fragments
- Recurring openers: "Look,", "Honestly,"
- Punctuation: minimal em-dashes, frequent commas
```

This shows the user what was matched and lets them correct the calibration if needed.
