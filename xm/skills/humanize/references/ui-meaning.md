# UI Meaning Pass (`ui` mode, Korean and English)

`humanize ui` loads this file before the language file (`ui-strings-ko.md` or
`ui-strings-en.md`). Form rules make a string look like UI copy. This pass decides
whether the string says what the control actually does. Run it first: fixing the
ending of a label that names the wrong thing only polishes the wrong thing.

Two more passes live here because they also decide meaning, not form: the term
inventory (one concept, one name) and, when the input comes from a codebase, the
string inventory (every string, with its place and its control).

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

## Input from a codebase

A request can name a screen, a feature, or UI source files instead of handing
over an array ("improve the wording on the billing page"). The strings are then
spread over several files, and none of them carries a key. Build the array
yourself before judging anything.

1. **List the sources.** Check each kind and name the files you found:
   - templates and components: markup, inline scripts, template literals
   - strings the server builds: titles, details, status names, error text
   - notifications that leave the app: chat, email, push
   - settings metadata: labels, help text, option names
   - strings saved as data: seed rows, stored labels. A code change does not
     update rows that are already saved.
2. **Extract every user-visible string** from each source. One item per string;
   a sentence that markup splits is still one item. Leave out code comments, log
   lines, and template syntax.
3. **Record where and what.** Each item gets `loc` (`path:line`), a `type`, and a
   `context` written from the code around it: what the control does when used,
   which value fills the cell, or when the message appears. For a heading, tab,
   badge, or column title, read the code that selects or sets what sits under
   that name. The name is a claim about that code.
4. **Do not invent keys.** When the source has none, leave `key` out and set
   `group` to the screen region (`queue toolbar`, `settings table`).
5. **Judge in place.** Go region by region with the code open. Do not dump the
   strings into one flat list and pick the ones that look wrong: a flat list shows
   spacing and symbols, and hides naming conflicts and behavior mismatches.
6. **Count.** Keep, per source, the number of strings extracted and judged. The
   report states it.

## Term inventory

Run this over the whole input before grouping, for arrays and codebases alike.
Copy written directly for a screen rarely fails on grammar. It fails by calling
one thing by two names, and no per-string rule can see that.

1. **Collect.** List the things the strings name: objects (a record, a list, a
   scheduled check), states, and actions. For each, write down every name it
   appears under and where.
   - Two strings bound to the same code value name the same thing: the same
     status key, field, table, or endpoint.
   - Count names that differ only by language (`Log` and `기록`), and names that
     arrive from the server or in a notification.
2. **Find the conflicts.** One concept under two or more names is a finding
   (`G-P`). So is one name used for two things; when the two are a control and the
   state it produces, that is M-6.
3. **Choose one name per concept**, in this order:
   - the name that tells a first-time reader what the thing is;
   - an established product or vendor name, where the string means that product;
   - the name the screen's main heading or navigation already uses.

   An internal identifier, an enum value, or its literal translation is not a
   reason to choose a name. Neither is the majority count on its own.
4. **Ask when the evidence cannot decide.** List every undecided concept in one
   question. Until it is answered, those items keep `after` equal to `before`
   with `flag: true`.
5. **Apply the chosen name everywhere in the input**, including inflected and
   compound forms. Search for the retired name's stem, not the exact string:
   retiring `숨김` also means checking `숨긴 항목` and `숨겨집니다`.
6. **Report the leftovers.** A retired name that still shows outside the input,
   such as a menu item on another screen, is listed, not edited.

The project glossary (`.xm/ui-glossary.json`) seeds this inventory and wins a
conflict. It does not replace the inventory: most project terms are not in it.

## M rules — meaning

| Code | Problem | Example (before → after, with evidence) |
|------|---------|------------------------------------------|
| M-1 | Abstract name: the label does not say what the field takes or what the control does | `서비스에 필요한 다음 일` → `요청 내용` (textarea for the user's request) |
| M-2 | Behavior mismatch: the string promises an action, result, or property the code does not deliver, or hides one it does | `단일 에이전트로 비교` → `단일 에이전트` (run-mode option; nothing is compared); heading `인기 검색어` → `최근 검색어` (the list is filled with the latest searches, not the most frequent) |
| M-3 | Predicate does not fit its object or means | `근거로 진행을 봐요` → `진행 상황을 확인해요` (step title; neighbors are 해요 sentences); `View progress by evidence` → `Check progress` |
| M-4 | Concept name instead of what the reader meets: a heading names an abstract idea, not the content below it | `자율 수행의 경계` → `사용자가 결정하는 일` (box body: new goals, scope expansion, and deployment are decided by the user) |
| M-5 | Lost or inflated meaning: the rewrite drops an action, object, condition, or relation the source states, or spells a word out into a longer phrase without adding clarity | `승인이 필요한 작업` for the box above covers only its first sentence; `자율 수행 범위 및 승인 기준` adds `기준`, which the box never states |
| M-6 | One name, two things: a control and the state it produces share a label, so the reader cannot tell an action from a status | button `보관됨` beside the status `보관됨` → button `보관`, status unchanged (the click sets that status); `Archived` button → `Archive` |

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
5. Run step 4 again after every form rule. A length target, a sentence count, an
   ending rule, or a label/description overlap rule never licenses dropping the
   object a label names, joining unrelated facts with a connective, or adding a
   verb or advice so that sentences fit together.

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
- Do not swap a word's register or origin (native ↔ Sino-Korean, plain ↔ formal)
  only to satisfy a form rule. When a button changes its word, the dialog it
  opens must use the same word.
- Do not rename a column, tab, or state because a more general word exists. A
  rename needs evidence: the name is wrong (M-1, M-2) or it conflicts (term
  inventory).

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

## Report for file or screen input

A bare JSON array is for a caller that parses it. A person who asked for a
screen to be improved needs to see what was checked and that nothing has changed
yet. When the input was files or a screen, answer with this report instead of
the array, in the user's language.

1. **First line:** no file was changed, and how many strings were judged.
2. **Coverage:** a table of source, strings judged, edits proposed, flags.
3. **Terms:** each concept that had more than one name: the names with `loc`, the
   chosen name and the reason, or the question when the evidence could not decide.
4. **Proposed edits**, most important first: meaning (M codes), then terms
   (`G-P`), then form (S or E codes). Each row has `loc`, before, after, codes, and
   one line of evidence.
5. **Spelling and spacing** (`O-1`) last, as one grouped list. A repeated
   deviation is one row with a count, not one row per string.
6. **Questions:** every flagged item, phrased so that a short answer settles it.
7. **Offer to apply.** Do not apply.

Strings left unchanged are counted, not listed.

## Applying to files

Only when the user asks.

1. Apply the edits the report showed, as shown. An idea that comes up while
   applying is a new proposal: show it before applying it.
2. Before editing a string, find its other copies: the same text in another file,
   tests that assert it, and values already saved as data. Saved values need a
   migration. Say so instead of leaving the old text in place silently.
3. After editing, search the input scope again for the stem of every retired
   name. Report zero hits, or list what remains and why.
4. Run the project's tests that cover the edited files. Committing, pushing, and
   deploying are outside this skill.

## Self-check

- [ ] Every edited item has a meaning record grounded in `context`, its screen
  group, or its key — not in the string alone.
- [ ] No suspected behavior mismatch was rewritten without evidence; those items
  are `flag: true` with a question in `note`.
- [ ] No word was removed without evidence that its promise is false, and no
  false promise was restored.
- [ ] No label grew into a clause, and no label joins two concepts with `및` or `and/or`.
- [ ] The term inventory ran over the whole input. Every concept with two or more
  names was settled or flagged, and no retired name remains in the input,
  inflected forms included.
- [ ] After each form rule, M-5 still holds: no label lost its object, no
  unrelated facts were joined, and no advice was added.
- [ ] Every edited item cites a rule code.
- [ ] (Codebase input) Every kind of source was checked, every extracted string
  was judged in its region, and the counts in the report match.
- [ ] If most edits are `O-1`, the term inventory and the meaning pass were
  skipped. Go back.
