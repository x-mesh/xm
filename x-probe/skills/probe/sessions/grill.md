# Session: grill

Adversarial rehearsal — a panel of persona interviewers grills the USER on a decision they
must defend, then diagnoses where their answers held, wobbled, or collapsed.

## Applies to
Called by x-probe routing when `$ARGUMENTS` starts with `grill`. The target is the user's own
decision / understanding / readiness — NOT an idea's go/no-go viability (that is `session probe`).

> **Scope guard (run FIRST).** grill is for defending a decision already made or an understanding
> the user must stand behind ("내 마이그레이션 결정 방어 리허설", "이 설계 왜 이렇게 했는지 캐물어줘").
> If the input instead reads as "should we build this?" / "is this worth it?" / "~만들까" / "~할 가치 있나"
> (a not-yet-decided idea), do NOT grill — output one line:
> `"신규 아이디어 타당성은 /xm:probe \"{idea}\" 가 낫습니다. grill은 이미 내린 결정을 방어 연습할 때 쓰세요."`
> and stop. Only proceed when the subject is a stance the user is committed to.

---

## grill Thinking

Embedded in every persona interviewer prompt.

```
## grill Thinking

You are an interviewer, not a helper. The user has to defend this decision to a real
audience soon (a design review, a PR, a stakeholder). Your job is to find the question
they CANNOT answer well — before that audience does.

1. Attack the answer, not the person. "What happens to in-flight sessions during the
   cutover?" beats "your plan is weak."
2. One sharp question is worth ten soft ones. Target the load-bearing assumption — the
   one that, if it cracks, the whole decision wobbles.
3. Follow the flinch. A vague answer is a signal: chain "and then what?" until it's
   concrete or it collapses.
4. No teaching mid-grill. You ask; the user answers. Diagnosis comes after, not during.
5. Reward a strong answer by escalating, not conceding. If they hold, raise the stakes.
```

---

## Options

- `--personas "a,b,c"` — interviewer roster (default: `security,skeptical-senior,pm`)
- `--rounds N` — max questions asked to the user (default 6; ~2 per persona)

Built-in persona lenses (extend freely via `--personas`):

| Persona | Attacks |
|---------|---------|
| `security` | failure modes, rollback, blast radius, abuse surface |
| `skeptical-senior` | operations, maintenance cost, who-owns-it, on-call reality |
| `pm` | value vs cost, priority, what we're NOT doing instead |
| `architect` | coupling, reversibility, what breaks when this scales |
| `user-advocate` | does the user actually feel this, migration pain |

---

## Session: grill

4-phase adversarial rehearsal. Phases 2-3 are interactive — every question to the user MUST
go through AskUserQuestion (see SKILL.md Interaction Protocol: ONE call per turn, it is the LAST
action of the turn, no text after it).

### Phase 1: SCOPE — What is being defended, and by whom?

Restate the subject in one sentence, pick the interviewer roster, and surface the likely
attack surface so the user can correct the framing before the grilling starts.

**delegate** (foreground, opus):
```
{grill_thinking}

## Defense Scoping

Subject the user must defend: {user_input}

1. Restate the decision in ONE neutral sentence (no judgement).
2. List the 3-5 load-bearing claims this decision rests on — the points an interviewer
   will push hardest. For each: the claim + which persona ({personas}) would attack it.
3. Name the single most likely "gotcha" — the question most people fail to prepare for.

Output a short scoping brief. Do not ask the questions yet.
```

Show the scoping brief as text. Then IMMEDIATELY call AskUserQuestion:

**Developer mode:**
```
AskUserQuestion("This is what you'll be defending and who's coming at it. Framed right? Add/remove a persona or claim before we start.")
```

**Normal mode:**
```
AskUserQuestion("방어할 대상과 면접관 구성입니다. 이렇게 맞나요? 시작 전에 빼거나 더할 논점·면접관이 있으면 알려주세요.")
```

**AskUserQuestion is the LAST action. STOP. Do NOT start grilling until the user confirms.**

### Phase 1.5: LOAD QUESTIONS — generate the question pool (one fan-out)

**fan-out** (one agent per persona, parallel, sonnet). Each interviewer produces its sharpest
questions up front; the leader then spends them interactively in Phase 2.

```
Agent ({persona}):
"{grill_thinking}

You are the {persona} interviewer. Subject: {subject}
Load-bearing claims: {claims_from_phase_1}

Produce your 2-3 sharpest questions for this user, hardest first. Each question:
- targets ONE specific claim or gap (name which)
- is answerable in 2-3 sentences (not an essay prompt)
- has a 'strong answer looks like' note for the leader to grade against
Return only the questions + grading notes. Do not soften."
```

Collect all questions into one ordered queue (hardest-first, interleaved across personas).
Cap the queue at `--rounds N` (default 6).

### Phase 2: GRILL — spend the queue interactively

For each question in the queue (stop at `--rounds` or early-exit below), **ask ONE at a time**:

**Step A — Pose the question.** Call AskUserQuestion (REQUIRED), attributing the persona:

Developer mode:
```
AskUserQuestion("[🔪 {persona} · Q{n}/{total}]\n\n{question}\n\n(2-3 sentences. Be concrete — name the mechanism, the number, the owner.)")
```

Normal mode:
```
AskUserQuestion("[🔪 {persona} · {n}/{total}번째]\n\n{question}\n\n(2-3문장으로. 구체적으로 — 메커니즘, 수치, 담당자를 짚어주세요.)")
```

**AskUserQuestion is the LAST action. STOP. No text after it.**

**Step B — Diagnose + decide follow-up.** After the user answers, grade the answer against the
persona's grading note:

- **held** — concrete, evidenced, names the mechanism/owner. → move to the next queued question.
- **wobbled** — partially answers, hand-waves the hard part. → ask ONE follow-up that targets
  the hand-wave (leader generates it on the spot, same persona):
  `AskUserQuestion("[🔪 {persona} 꼬리질문] {the specific gap}. 거기는 어떻게 되나요?")`
  Then grade the follow-up; if still wobbled, record as wobbled and move on (do not chain forever).
- **collapsed** — cannot answer, contradicts an earlier answer, or concedes the point. → record
  the gap, do NOT pile on; move to the next question.

After grading, show a one-line status (text, not a question):
```
{persona} Q{n}: {held ✅ / wobbled ⚠ / collapsed ❌} — {one-line reason}
```

**Early exit:** if a `collapsed` answer invalidates the core decision itself (not just one claim),
stop the queue and go to Phase 3 — the rehearsal already found the breaking question.

**Round budget:** follow-ups count toward `--rounds`. When the budget is spent, go to Phase 3
even if questions remain in the queue (note how many were skipped).

### Phase 3: REPORT — readiness verdict

Compute a defense-readiness score from the graded answers:
- `held` → 1.0, `wobbled` → 0.5, `collapsed` → 0.0
- `readiness = round(mean(grades) * 10, 1)` → 0-10 scale

Map to a band:

| Band | Score | Meaning |
|------|-------|---------|
| **DEFENSIBLE** ✅ | 8.0-10 | You can walk into the room. Tighten the wording, ship it. |
| **SHAKY** 🔄 | 5.0-7.9 | Defensible core, soft edges. Close the gaps below before defending live. |
| **EXPOSED** ❌ | 0-4.9 | The decision itself is under-supported. Rehearse again after rework, or reconsider. |

**Output format:**

**Developer mode:**
```
🔪 [grill] Readiness: {DEFENSIBLE ✅ | SHAKY 🔄 | EXPOSED ❌} — {score}/10

Subject: {subject}
Panel: {personas} · {asked}/{total} questions ({skipped} skipped)

## Where you held
| Persona | Question | Why it held |
|---------|----------|-------------|
| ... | ... | ... |

## Where you broke (= homework before you defend this live)
| Persona | Question | Gap | Fix before the room |
|---------|----------|-----|---------------------|
| security | ... | no rollback story | write the rollback runbook + test it |

## The one question to prepare first
{the highest-impact collapsed/wobbled question, and what a strong answer needs}

## Recommendation
{2-3 sentences: defend now / rehearse again / rework first — and why}
```

**Normal mode:**
```
🔪 [grill] 방어 준비도: {방어 가능 ✅ | 흔들림 🔄 | 노출 ❌} — {score}/10

대상: {subject}
면접단: {personas} · {asked}/{total} 질문 ({skipped}개 건너뜀)

## 버틴 지점
| 면접관 | 질문 | 버틴 이유 |
|--------|------|-----------|
| ... | ... | ... |

## 무너진 지점 (= 실전 방어 전 숙제)
| 면접관 | 질문 | 빈틈 | 회의실 가기 전 보완 |
|--------|------|------|---------------------|
| security | ... | 롤백 시나리오 없음 | 롤백 런북 작성 + 테스트 |

## 가장 먼저 준비할 질문 하나
{영향이 가장 큰 무너진/흔들린 질문과, 강한 답이 갖춰야 할 것}

## 권장 사항
{2-3문장: 지금 방어 가능 / 다시 리허설 / 먼저 보완 — 그리고 이유}
```

---

### Final Step: Persist (REQUIRED — both files)

After emitting the report, MUST write to BOTH paths (see Termination Checkpoint in SKILL.md):

1. `mkdir -p .xm/probe/grill/` (Bash)
2. Build the JSON payload below (same object to both files)
3. Write `.xm/probe/grill/last-grill.json` — overwrites the previous run
4. Write `.xm/probe/grill/history/{YYYY-MM-DD}-{slug}.json` — archival; slug from subject, ≤ 40 chars, lowercase, hyphens
5. Surface paths: `💾 Saved: .xm/probe/grill/last-grill.json` and `💾 Archived: .xm/probe/grill/history/{filename}`

Do not end the session until both files are written and both paths are shown.

```json
{
  "timestamp": "ISO8601",
  "type": "grill",
  "subject": "...",
  "personas": ["security", "skeptical-senior", "pm"],
  "readiness_score": 6.5,
  "band": "DEFENSIBLE|SHAKY|EXPOSED",
  "asked": 6,
  "skipped": 0,
  "rounds": [
    { "persona": "security", "question": "...", "answer_strength": "held|wobbled|collapsed", "diagnosis": "..." }
  ],
  "held": ["claim that survived"],
  "gaps": [{ "persona": "security", "question": "...", "gap": "...", "fix": "..." }],
  "recommendation": "..."
}
```

### Post-Report Links

**On DEFENSIBLE / 방어 가능:**
```
방어 준비 완료. 결정을 기록으로 남길까요?
1) 네 → /xm:memory add (decision: {subject} — 방어 근거 포함)
2) 아니요 — 넘어가기
```

**On SHAKY / 흔들림:**
```
빈틈을 메운 뒤 다시 리허설하세요. 선택지:
1) 숙제를 끝내고 → /xm:probe grill "{subject}" 재실행
2) 가장 약한 답변 하나만 집중 보완
3) 넘어가기
```

**On EXPOSED / 노출:**
```
결정 자체가 약합니다 — 회의실 대신 여기서 알게 된 게 이득입니다.
1) 결정을 재고 → /xm:probe "{subject}" (타당성부터 다시)
2) 무너진 논점만 다시 설계
3) 왜 여기까지 왔는지 회고 → /xm:humble review "grill: {subject} — exposed"
```
