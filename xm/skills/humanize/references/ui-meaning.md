# UI Meaning Pass (`ui` mode, Korean and English)

`humanize ui` loads this file before the language file (`ui-strings-ko.md` or
`ui-strings-en.md`). Form rules make a string look like UI copy. This pass decides
whether the string says what the control actually does. Run it first: fixing the
ending of a label that names the wrong thing only polishes the wrong thing.

## Target language

One array has one target language.

1. `--lang ko` or `--lang en` wins.
2. Otherwise, items that carry a `ko` field target Korean; `en` is then reference
   text only. Items with only `en` target English.
3. If items disagree, ask once which language to edit. Never translate between them.

Load `ui-strings-ko.md` for Korean and `ui-strings-en.md` for English. Both share
the JSON output contract defined in `ui-strings-ko.md`.

## Behavior evidence

Every item may carry an optional `context` field: what the control actually does,
taken from code, a spec, or the screen. Existing fields stay valid without it.

```json
{ "key": "run.mode.single", "ko": "단일 에이전트로 비교", "type": "select_option",
  "context": "Select labeled 작업 방식. Options team/single choose the run mode. No comparison runs." }
```

Read evidence in this order: `context`, then other strings in the same screen
group, then the `key`. Never infer behavior from the string under edit alone.
When the input is a source file, the surrounding code is evidence: read the
handler or the value the control sets before judging its label.

## M rules — meaning

| Code | Problem | Example (before → after, with evidence) |
|------|---------|------------------------------------------|
| M-1 | Abstract name: the label does not say what the field takes or what the control does | `서비스에 필요한 다음 일` → `요청 내용` (textarea for the user's request) |
| M-2 | Behavior mismatch: the string promises an action or result the control does not perform, or hides one it does | `단일 에이전트로 비교` → `단일 에이전트` (run-mode option; nothing is compared) |
| M-3 | Predicate does not fit its object or means | `근거로 진행을 봐요` → `진행 상황을 확인해요`; `View progress by evidence` → `Check progress` |
| M-4 | Concept name instead of what the reader meets: a heading names an abstract idea, not the content below it | `자율 수행의 경계` → `사용자가 결정하는 일` (box body: new goals, scope expansion, and deployment are decided by the user) |
| M-5 | Lost or inflated meaning: the rewrite drops an action, object, condition, or relation the source states, or spells a word out into a longer phrase without adding clarity | `승인이 필요한 작업` for the box above covers only its first sentence; `자율 수행 범위 및 승인 기준` adds `기준`, which the box never states |

## Procedure

1. For each item, write a meaning record from the evidence: who acts, on what,
   under which condition, with which result. Do not fill a slot from guesswork.
2. If the record cannot be filled and the wording is suspect, set `flag: true`,
   keep `after` equal to `before`, and ask the missing fact in `note`.
3. Choose words that express the record. Then apply the language file's form
   rules (Korean S codes, English E codes) to that choice.
4. Compare `after` with the record. Every element the evidence confirms must
   survive. Nothing new may appear. Remove a word only when the evidence shows its
   promise is false, and name that evidence in `note`.

Record M codes in `rules` alongside S or E codes.

## Constraints

- Do not replace a word because it appears on a watch list. A watched word is a
  reason to check the record, not an edit.
- Do not restore a word the evidence shows to be false. Re-adding `비교` to the
  run-mode option reintroduces M-2.
- Do not lengthen a short label into a clause or sentence to "explain" it.
  Explanations belong to `desc`.
- Do not join two concepts with `및`, `및/또는`, `and/or`, or `/` in a label to
  avoid choosing. Pick the concept the content shows.
- Keep established product terms and the project's register.

## Worked case: rejected alternatives

The run-mode select (`작업 방식`, options team/single, no comparison):

| Candidate | Verdict | Reason |
|-----------|---------|--------|
| `단일 에이전트` | accept | Names the mode; pairs with a team option such as `역할 분담 팀` |
| `한 에이전트가 작업` | reject | Clause fragment in an option slot; repeats the label word `작업` (S1-2) |
| `단일 에이전트 수행 결과 비교` | reject | Promises a comparison the control does not run (M-2) |
| `단일 에이전트 환경과의 비교` | reject | Same false promise, plus a noun chain |

The notice box (body: users decide new goals, scope expansion, and deployment;
unchecked content stays a proposal):

| Candidate | Verdict | Reason |
|-----------|---------|--------|
| `사용자가 결정하는 일` | accept | Matches both sentences of the body |
| `승인이 필요한 작업` | weak | Covers the first sentence only (M-5) |
| `자율 수행 범위 및 승인 기준` | reject | Joins two concepts with `및`; adds `기준` (M-5) |
| `자율 수행과 개입의 경계` | reject | Keeps the abstract `경계` the reader flagged (M-4) |

## What `ui` mode suspends

| Prose rule | Why it does not apply |
|-----------|----------------------|
| `## Change Rate Guardrails` | A correct UI fix is often a near-total rewrite: `복사한 텍스트를 붙여넣기 선반에 저장` → `클립보드 기록` is ~89%. Both the percentage ceiling and the short-input token ceiling would reject every valid edit. |
| Step 4 voice injection | Opinions, rhythm variation, and acknowledged complexity are wrong in a toggle label. Never give a UI string personality. |
| Genre allowance matrix (`genre-rules.md`) | UI strings match none of the six prose genres. The per-`type` table in the language file replaces it. |
| Auto-downshift triggers (KO-26 / KO-31) | Both count sentences across a document. A string array has no document. |
| KO-5 / KO-31 / KO-32 | Uniform length and uniform endings are *required* on a settings screen, not a defect to fix. |

## Self-check

- [ ] Every edited item has a meaning record grounded in `context`, its screen
  group, or its key — not in the string alone.
- [ ] No suspected behavior mismatch was rewritten without evidence; those items
  are `flag: true` with a question in `note`.
- [ ] No word was removed without evidence that its promise is false, and no
  false promise was restored.
- [ ] No label grew into a clause, and no label joins two concepts with `및` or `and/or`.
