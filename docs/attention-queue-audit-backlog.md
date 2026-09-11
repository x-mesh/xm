# Attention Queue — 구현 감사 백로그

출처: `docs/PRD-attention-queue.md` 초판 구현분에 대한 읽기 전용 코드 감사 (2026-09-11). 신규 테스트 31개 전부 통과(99 expect, 1.17s) 상태에서 수행 — **테스트 실패가 아니라 테스트가 덮지 못한 의미론적 결함**이 대상이다.

> 모든 경로는 **소스** `x-build/lib/x-build/` 기준. 수정 후 `bash scripts/sync-bundle.sh` → `node xm/scripts/skills-checksum.mjs` 로 `xm/lib/x-build/`, `x-dashboard/lib/x-build/` 사본 재생성 필요. 라인 번호는 감사 시점 기준이라 편집하며 시프트됨 — 헤더/문구로 위치 확인.

## 갱신 이력

**2026-09-11 2차 감사 — 14건 중 8건 해결, 6건 잔여.** A 치명 2건이 모두 닫혔고 B 정합성 4건, D 사소 2건도 해결됐다. 신규/관련 테스트 79개 통과(13개 파일, 239 expect), 기존 스위트 회귀 없음(`x-review-lifecycle` / `review-precision` / `worktrees/gate-panel` 91 pass, 486 expect).

잔여는 C 전량(5건)과 D-3. **모두 "없어도 수집한 데이터가 오염되지 않는" 항목**이므로 아래 선행 조건은 해제됐다.

## 선행 판단 — ~~A 두 건을 닫기 전에 데이터를 쌓지 말 것~~ (해제됨)

`escape-ledger.jsonl`은 append-only이고 `escapeRowKey` 기반으로 dedupe된다. **잘못 분류된 행은 영구히 남는다.** A-1/A-2를 고치기 전에 `attention --backfill`을 실운영에 돌리면 나중에 원장 전체를 폐기하고 재수집해야 했다.

→ **2026-09-11 해제.** A-1/A-2 해결 + `source:'probe'`→`'mutate'` 개명이 원장이 비어 있는 동안 완료됐으므로, 지금부터 `--backfill`을 실운영에 돌려도 된다.

---

## A. 치명 (2) — 신호 자체가 무효가 되는 결함

- [x] **변이 프로브에 baseline green 검증이 없음** — `probe.mjs:104-115` → **해결 2026-09-11** (`mutate.mjs:183-186`). 후보 루프 전 baseline 실행, 실패 시 `mutate baseline is not green; fix the test command first` + `exitCode 2`. `baseline_exit_code` / `baseline_outcome` / `test_command` / `test_command_source`를 리포트에 기록하고, **실패한 baseline 리포트도 `persistReport`로 영속화**해 원인을 사후 확인할 수 있게 했다(권고 범위 초과). 관련 후속: `27083a56 fix(build): avoid baseline mutation rewrites`.
  `runTaskProbe`가 변이 없는 원본으로 테스트를 한 번도 실행하지 않는다(`grep -c "baseline\|unmutated" probe.mjs` → 0). 테스트 명령이 의존성 누락·잘못된 러너·환경 문제 등 **어떤 이유로든 non-zero면 모든 변이가 `killed`로 기록**되고, 결과는 "테스트가 완벽하다"는 가장 안심되는 형태로 나온다. 오작동의 방향이 사각지대를 숨기는 쪽이라 최악이다.
  위험을 키우는 것은 `detectedTestCommand`(`probe.mjs:91-97`) — `package.json`에 `scripts.test`가 **존재하기만 하면 내용과 무관하게 `'bun test'`를 반환**한다. vitest/jest 레포에서 명령이 깨진 채로 전 변이 killed 판정이 난다.
  → 수정: `probe.mjs:113` 후보 루프 진입 전에 원본 상태로 `command`를 1회 실행하고, exit 0이 아니면 `error.exitCode=2`로 중단(`probe baseline is not green; fix the test command first`). 리포트에 `baseline_exit_code`를 남긴다.
  → 부수: `detectedTestCommand`가 `scripts.test` 문자열을 그대로 쓰거나(`bun run test`), 최소한 추측했음을 리포트에 `test_command_source: "detected"|"explicit"`로 표기.

- [x] **릴리스 escape가 앞단 게이트와 조인되지 않음 — 5종 분류 붕괴** — `attention-collect.mjs:36-46`, `escape-ledger.mjs:75-84` → **해결 2026-09-11** (`attention-collect.mjs:77,86`). before/after 패널에서 `reviewed_files_all`(구 `reviewed_files` 폴백) 기반 scope 인덱스를 만든 뒤 릴리스 finding을 조인한다. 권고안보다 나은 점 둘: (1) 단일 `escaped_from_task_id` 대신 **`escaped_from_task_ids` 배열**로 같은 파일을 건드린 복수 태스크를 모두 담아 소유자를 날조하지 않는다, (2) 동일 프로젝트로 scope를 한정한다. `contested-surfacing.test.mjs:4-5`가 **`collectAttention` 경로로 `reviewed_missed`와 `not_reviewed` 양쪽을 모두 발생**시키고 diff 접두사(`a/`)·역슬래시 경로 정규화까지 검증한다 — 감사가 지적한 "단위 테스트가 통합 경로 결함을 가림" 문제가 정확히 닫혔다.
  `collectAttention`이 패널 파일을 순회하며 `gateRecord:panel`을 넘기는데(`attention-collect.mjs:43`), 이 `panel`은 **지금 읽고 있는 그 파일 자신**이다. 릴리스 행의 `gateRecord`가 릴리스 패널이므로 `classifyEscape`의 판정(`escape-ledger.mjs:83-84`)이 "릴리스 패널이 이 파일을 봤나"를 묻게 된다. PRD R1의 핵심인 **"릴리스 finding을 동일 태스크의 before/after 게이트 결과와 조인"이 구현되어 있지 않다.**
  더해서 `gateRecord.reviewed_files`는 **레포 전체에 생산자가 없다.** 존재하는 것은 이름과 위치가 다른 `reviewed_files_all`(`x-build/lib/x-build/verify.mjs:996`, `xm/lib/review-lifecycle.mjs:587`, 산출물은 `last-result.json`)뿐이다. 따라서 `reviewed_missed`는 도달 불가능하고 모든 escape가 `not_reviewed`로 떨어진다. 스코프 구멍과 lens 맹점을 가르는 분류의 존재 이유가 사라진다.
  겹치는 문제: 릴리스 행은 `task_id:null`(`attention-collect.mjs:40`)이라 PRD Data Flow Trace가 규정한 조인 키 `task_id + file`을 만들 수도 없다.
  → 수정 3단계:
  1. 게이트 아티팩트에 심사 범위를 실어준다. 신규 필드를 만들지 말고 기존 `reviewed_files_all`을 `panel-<phase>.json`에 전달(append-only 하위호환). PRD Q1의 (b)안을 기존 자산으로 해소하는 경로다.
  2. `collectAttention`에서 프로젝트/태스크별로 `panel-before|after[.attempt-N].json`을 먼저 인덱싱한 뒤, 릴리스 finding을 그 인덱스와 조인해 `gateRecord`로 넘긴다.
  3. 릴리스 행에 `escaped_from_task_id`를 채운다(`task_id`는 "이 패널의 태스크" 의미로 유지하되 조인 대상 태스크를 별도 필드로).
  → 검증: 픽스처에서 `not_reviewed`/`reviewed_missed` 양쪽이 실제로 발생하는 테스트 추가. 현재 `escape-ledger.test.mjs`는 `classifyEscape`를 **직접 호출해** 두 분류를 확인하므로 통과하지만, `collectAttention` 경로로는 한쪽만 나온다. 단위 테스트가 통합 경로의 결함을 가린 사례다.

---

## B. 정합성 (4)

- [x] **워크트리 루트 해석 불일치** — `attention.mjs:29`, `probe.mjs:131` → **해결 2026-09-11** (`attention.mjs:14` `stateRoot`, `mutate.mjs:150` `canonicalStateRoot`). `resolveMainRepoRoot` 재사용 + `X_BUILD_ROOT` / `XM_ROOT` env 우선순위까지 gate-panel과 동일하게 맞췄다.
  둘 다 `process.cwd()`를 루트로 쓴다. 반면 `gate-panel.mjs`는 링크된 워크트리 cwd에서 호출된다는 전제로 `git rev-parse --git-common-dir` 기반 `resolveMainRepoRoot`(`worktree-shared.mjs`)를 써서 메인 레포 `.xm/`를 self-resolve한다. 워크트리에서 `xm build attention` / `xm build probe`를 실행하면 **다른 `.xm/`를 읽고 쓴다.**
  → 수정: `worktree-shared.mjs`의 `resolveMainRepoRoot`를 재사용. 기존 `X_BUILD_ROOT` / `X_PANEL_ROOT` env 우선순위 계약도 동일하게 따른다.

- [x] **변이 연산자에 경계·논리 연산자가 없음** — `probe.mjs:36-48` → **해결 2026-09-11**. 3종 → **6종**(`boolean`, `comparison`, `numeric`, `relational`, `logical`, `return`). 권고한 관계 연산자 경계와 논리 연산자에 더해 조기 반환까지 추가됐다. 후속 하드닝: `b40a70d2 fix(build): mask keyword regex mutations`.
  현재 3종뿐: boolean(`true`↔`false`, `:40`), comparison(`===`↔`!==`, `:44`), numeric(`n`→`n+1`, `:47`).
  빠진 것 중 가장 값진 것이 **관계 연산자 경계**(`<`↔`<=`, `>`↔`>=`)다. off-by-one은 변이 테스트가 가장 잘 잡는 버그 유형이고, 이 프로젝트의 출발점이 된 Dan Luu 실험에서도 대표적 실패 유형이었다. 논리 연산자(`&&`↔`||`)와 조기 반환 제거도 표준 연산자 집합에 든다.
  → 수정: `simpleMutations`에 `relational`, `logical` 연산자 추가. `maxMutants` 기본 12는 유지하되 연산자 다양성이 우선되도록 라운드로빈으로 뽑는다(현재는 라인 순서대로 채워 한 줄이 예산을 독식할 수 있음).

- [x] **`probe` 이름이 제품 안에서 반대 뜻으로 충돌** — `x-build/lib/x-build-cli.mjs:147`, `xm/commands/probe.md` → **해결 2026-09-11**. `probe.mjs` → `mutate.mjs`, 커맨드 `xm build mutate`, 원장 `source:'mutate'`, 테스트 `mutate-restore` / `mutate-runaway` / `mutate` / `xm-mutate-dispatch`까지 일괄 개명. 원장이 비어 있는 동안 처리해 마이그레이션 비용 0.
  `/xm:probe` = 전제 검증(소크라테스식 질문으로 아이디어를 죽이는 세션, `xm/skills/probe/SKILL.md`). `xm build probe` = 변이 주입. 네임스페이스는 분리돼 있으나 문서·대화·로그에서 같은 단어가 반대 의미로 쓰인다.
  → 수정: `xm build mutate`로 개명. `commands.md` 항목과 `probe.mjs` 파일명(`mutate.mjs`)까지 함께. 원장 `source:'probe'` 값도 `'mutate'`로 — **A-1/A-2 수정 전 원장이 비어 있는 지금이 개명 비용이 가장 싼 시점이다.**

- [x] **`--budget 0`의 의미가 문서화되지 않음** — `attention-rank.mjs:15-18`, `skills/build/references/commands.md` → **해결 2026-09-11**. `commands.md:58`에 `` `--budget 0` = all `` 명시.
  `applyBudget(items, 0)`은 전체 반환(무제한)이고 `cmdAttention`도 `budget<0`만 거부한다. 유용한 탈출구인데 커맨드 카탈로그에 설명이 없다.
  → 수정: `commands.md`의 `attention` 항목에 `--budget 0 = 전체 표시` 명시.

---

## C. PRD 이후 확정됐으나 미구현 (5)

PRD 초판 이후 근거 조사와 term-mesh PoC에서 확정된 항목. 자세한 근거는 별도 정리 참조.

- [x] **F5 — git 히스토리 기반 escape 수집기** → **해결 2026-09-11.** PURE 모듈 `escape-git.mjs`(파싱·분류·집계) + 불순 수집기 `attention-collect.mjs` `collectGitEscapes` + CLI `attention --backfill --git [--max-commits N]`. `--since`가 git 윈도우를 겸한다(기본 90d). 신규 필드 `commit` / `commit_type` / `confidence` / `fix_shipped_test` / `area` / `introduced_commit`(L2 예약), 신규 분류 `shipped_defect`. `.xm-review.json`의 `generated_copy_roots`를 자동 제외하고 `.xm/attention-git.json`으로 레포별 튜닝을 받는다. 테스트 `test/escape-git.test.mjs` 11개 통과(75 expect).
  현재 escape 소스는 릴리스 패널뿐이라 **릴리스 패널이 돌아야만 데이터가 생긴다.** git 히스토리 기반 수집기는 빌드 없이 아무 레포에서나 즉시 동작한다(term-mesh PoC: fix/perf 39건에서 60초 만에 반복 범인과 사각지대 도출). 원장 스키마에 `source` 필드가 이미 있으므로 `source:'git'`로 같은 원장에 들어간다.
  핵심 신호는 커밋 밀도가 아니라 **"fix 커밋이 테스트를 함께 넣었는가"**다. fix가 추가한 테스트가 곧 "없었던 테스트"이므로 공짜로 라벨링된 데이터셋이 된다.
  → 신규 필드: `commit_type`(fix/perf/revert), `fix_shipped_test`(bool), `introduced_commit`.
  → 범용화: 엔진은 코드, 레포별 차이는 설정으로. 커밋 컨벤션 패턴, 테스트 경로 glob, 경로→영역 매핑, 제외 경로(`.xm-review.json`의 `generated_copy_roots` 재사용).

- [x] **`perf` / `revert` 커밋 분류** (F5 종속) → **해결 2026-09-11.** `classifyCommitType`이 conventional commit을 우선 해석하고 없으면 키워드로 떨어지며 `confidence:'low'`를 붙인다 — 커밋 관례가 없는 레포가 조용히 깨끗해 보이지 않게 하려는 장치다. `perf`는 분류만 되고 결함 행을 생성하지 않으며, `revert`는 severity `high`로 올린다.
  PoC에서 드러난 결함. `perf(...)`는 결함이 아니므로 "테스트 없는 수정" 집계를 오염시킨다. 반대로 **`revert`는 가장 강한 탈출 신호인데 완전히 빠져 있다** — 되돌렸다는 것은 게이트가 통과시킨 것이 못 쓸 물건이었다는 뜻이다.

- [ ] **벤더 일치율 시계열 추적**
  현재 `collectAttention`은 `contested`(불일치)만 수집하고 일치는 조용히 통과시킨다. 그런데 "Correlated Errors in Large Language Models"(ICML 2025, [arXiv:2506.07962](https://arxiv.org/abs/2506.07962))에 따르면 **둘 다 틀릴 때 60% 확률로 같은 답으로 틀리며, 더 정확한 모델일수록 오류 상관이 증가**한다. LLM 코드에 대한 N-version 독립성 재현 실험([arXiv:2607.02808](https://arxiv.org/html/2607.02808v1))도 다수결이 이론적 이득의 0.43~0.44만 확보한다고 보고한다.
  즉 **일치율 상승은 "패널이 안정됐다"가 아니라 "패널 정보량이 떨어지고 있다"는 경고**로 읽어야 한다. 크로스벤더 전략의 수명이 모델 세대와 함께 짧아진다는 뜻이기도 하다.
  → 수정: 패널 실행별 일치율을 원장 또는 별도 메트릭에 기록하고, 대시보드에 추세로 노출.

- [ ] **L3 검증 — 테스트가 실제로 버그를 잡는지 확인**
  F5의 `fix_shipped_test` 지표는 **그 테스트가 실제로 해당 버그를 잡는지 확인하지 않는다.** 이 프로젝트가 문제 삼는 바로 그 실패 모드가 지표 자체에 재귀적으로 적용된다.
  → 수정: fix 커밋이 추가한 테스트를 부모 커밋에 적용해 실패하는지 확인. 빌드가 필요하므로 전수 불가 — **상위 N건 샘플링으로 지표 신뢰도를 보정**한다. 구현 전까지는 `fix_shipped_test`가 품질이 아니라 습관 지표임을 문서에 명시.

- [ ] **AGENTS.md / 스킬 파일을 신뢰 경계로 승격**
  "Finding Widespread Cheating on Popular Agent Benchmarks"(2026, [debugml](https://debugml.github.io/cheating-agents/))에서 Terminal-Bench 2 상위권 항목이 **AGENTS.md에 정답을 주입해 벤치마크를 통과**했다. 규칙 파일 자체가 공격 표면이다.
  → 수정: PRD Boundaries의 "Ask first"에 `AGENTS.md` / `CLAUDE.md` / `skills/**` 자동 수정 추가. 실효를 위해서는 stop-gate 수준의 검사가 필요.

---

## D. 사소 (3)

- [x] **purity 테스트가 미러 사본을 검사하지 않음** — `test/purity-contract.test.mjs:2` → **해결 2026-09-11**. `x-build/lib/x-build`, `xm/lib/x-build`, `x-dashboard/lib/x-build` 세 위치를 모두 순회하고 경로를 `import.meta.dir` 기준으로 해석한다.
  `x-build/lib/x-build/{escape-ledger,attention-rank}.mjs`만 검사한다. `xm/lib/x-build/`, `x-dashboard/lib/x-build/` 사본은 `sync-bundle.sh`가 복사하므로 실질 위험은 낮으나, PURE 계약이 의미를 갖는 지점은 **대시보드가 실제로 import 하는 사본**이다. 또한 경로가 상대라 cwd에 의존한다.
  → 수정: 세 위치를 모두 순회. 경로는 테스트 파일 기준 `import.meta.dir`로 해석.

- [x] **프로브 리포트 최상위에 임의 변이 하나의 필드가 섞임** — `probe.mjs:118` → **해결 2026-09-11** (`mutate.mjs:189`). `representative: result`로 명명된 키에 감쌌고, 카운트도 `counts:{survived,timeout}`로 정리됐다.
  `const result = outcomes.find(...=== 'survived') || outcomes[0]` 를 `...result`로 스프레드해서 `outcome`/`exit_code`/`file`/`operator`/`line`이 리포트 루트에 올라온다. 소비자가 이를 리포트 전체의 속성으로 오해할 수 있다.
  → 수정: `representative: result` 처럼 명명된 키로 감싼다.

- [ ] **큐 처리율이 나이 기반 경고에만 머무름** — `attention-rank.mjs:20-34`
  `attentionQueueHealth`가 `unacked_count`와 14일 경고를 준다(PRD 리스크 대응으로 충분히 잘 만들어졌다). 다만 PRD가 우려한 "큐가 또 하나의 안 보는 대시보드가 된다"를 실제로 측정하려면 **제시 대비 ack 비율(주간 처리율)**이 필요하다.
  → 수정: `presented_count`를 원장에 남기고 `ack_rate_7d`를 health에 추가.

---

## 권장 순서

| 순위 | 항목 | 비용 | 근거 |
|---|---|---|---|
| 1 | A-1 baseline green 검증 | 몇 줄 | 없으면 프로브 결과 전체가 신뢰 불가 |
| 2 | B-3 `probe` → `mutate` 개명 | 30분 | 원장이 비어 있는 지금이 가장 쌈 |
| 3 | A-2 `reviewed_files_all` 배선 + before/after 조인 | 반나절 | 분류 체계 복구. 데이터 수집의 전제 |
| 4 | B-1 `resolveMainRepoRoot` 재사용 | 30분 | 워크트리 실행 정합성 |
| 5 | B-2 관계·논리 연산자 추가 | 1시간 | off-by-one 검출력 |
| 6 | C F5 git 수집기 | 반나절~1일 | 데이터가 가장 빨리 쌓이는 소스 |
| 7 | 나머지 C, D | — | |

~~1~3번을 닫기 전에는 `--backfill`을 실운영에 돌리지 않는다.~~

> **2026-09-11 갱신 — 위 표의 1~5번은 모두 완료.** 재정렬된 잔여 순서는 아래와 같다.
>
> | 순위 | 항목 | 비용 | 근거 |
> |---|---|---|---|
> | 1 | C-1 F5 git 수집기 | 반나절~1일 | 현재 escape 소스가 릴리스 패널뿐이라 패널이 돌아야만 데이터가 생긴다 |
> | 2 | C-2 `perf`/`revert` 분류 | 1시간 | F5 종속. `revert`가 가장 강한 탈출 신호 |
> | 3 | C-3 벤더 일치율 시계열 | 반나절 | 패널 정보량 저하 조기 경보 |
> | 4 | D-3 `ack_rate` | 1시간 | 큐가 방치되는지 측정 |
> | 5 | C-5 AGENTS.md 신뢰 경계 | 몇 분~ | 규칙 파일 자체가 공격 표면 |
> | 6 | C-4 L3 검증 | 1일 | F5 지표의 신뢰도 보정 |
>
> 잔여 6건은 모두 없어도 이미 수집된 데이터를 오염하지 않는다. 따라서 `--backfill` 실운영 투입을 더 미룰 이유가 없다.

---

## 감사 방법과 한계

- 읽기 전용. 코드 수정 없음. `bun test` 신규 11개 파일만 실행(31 pass / 0 fail).
- 결함은 전부 **테스트가 통과하는 상태에서** 발견됐다. A-2는 단위 테스트(`classifyEscape` 직접 호출)가 통합 경로의 결함을 가린 사례이므로, 유사 구조가 다른 모듈에도 있는지 별도 점검 가치가 있다.
- 실제 `.xm/` 아티팩트로 end-to-end 실행은 하지 않았다. `reviewed_files` 부재는 정적 grep으로 확인했으므로, 런타임에 다른 경로로 주입될 가능성은 배제하지 못했다.

## 이 감사가 놓칠 수 있는 것

이 백로그는 **발견된 결함**만 담는다. 아무도 찾지 않은 결함은 여전히 보이지 않으며, 그것이 바로 이 프로젝트가 만들려는 도구의 존재 이유다. A-1이 닫히고 프로브가 신뢰 가능해지면, 이 감사 자체를 변이 프로브로 검증하는 것이 다음 단계다.

---

## 2차 감사에서 새로 관찰된 것 — `mutate.mjs` 자체가 첫 번째 테스트 케이스

결함은 아니다. 기록만 남긴다.

변이 모듈은 도입 하루 만에 **8KB → 34KB(4.25배)**로 커졌고, 총 **12개 커밋**이 이 파일을 건드렸다. 그중 8개가 신규 코드에 대한 하드닝 수정이다.

```
4dcb72d0 fix(build): isolate mutation execution
4f0c3464 fix(build): lock mutation workspaces
0ae2019f fix(build): preserve concurrent mutation edits
2d3c3a9c fix(build): preserve mutation file metadata
1557c2e9 fix(build): reject mutation target alias races
46597930 fix(build): validate mutation snapshots
27083a56 fix(build): avoid baseline mutation rewrites
b40a70d2 fix(build): mask keyword regex mutations
```

이것은 **이 도구가 포착하려는 신호 그 자체**다. 고침 밀도가 높은 파일, 새 코드에 반복되는 동시성·경로·스냅샷 결함. C-1(F5 git 수집기)이 완성되면 **첫 검증 대상을 `mutate.mjs` 자신으로 잡는 것**이 타당하다. 수집기가 이 8건을 실제로 집어내지 못한다면 수집기 쪽이 틀린 것이다.

별도로 판단할 것: 이 하드닝이 수렴하는 중인지, 아니면 "원본 트리의 파일을 직접 변이시키고 되돌린다"는 설계가 너무 많은 불변식(동시성, 권한, 심볼릭링크, 복구, alias)을 떠맡고 있는지. 후자라면 사본 워크트리에서 변이를 돌려 원본 트리를 아예 건드리지 않는 구조가 대안이다.

## 2차 감사 방법

- 읽기 전용. 코드 수정 없음. 이 문서의 체크박스와 상태 섹션만 갱신.
- 신규/관련 테스트 13개 파일 79개 통과(0 fail, 239 expect).
- 기존 스위트 회귀 확인: `x-review-lifecycle`, `review-precision`, `worktrees/gate-panel` 91개 통과(0 fail, 486 expect).
- 실제 `.xm/` 아티팩트로 end-to-end 실행은 여전히 하지 않았다. A-2 조인은 `contested-surfacing.test.mjs`의 픽스처 기반 통합 테스트로만 확인했다.

---

# 3차 — F5 git 수집기 구현 (2026-09-11)

**14건 중 10건 해결, 4건 잔여** (C-3 벤더 일치율, C-4 L3, C-5 AGENTS.md 신뢰 경계, D-3 `ack_rate`).

## 구현 요약

| 계층 | 파일 | 역할 |
|---|---|---|
| PURE | `x-build/lib/x-build/escape-git.mjs` (신규) | `gitWindowArg` / `classifyCommitType` / `isTestPath` / `isIgnoredPath` / `pathArea` / `parseGitLog` / `summarizeGitHistory` |
| 불순 | `attention-collect.mjs` `collectGitEscapes` | git 실행, 레포 설정 읽기, 행 생성 |
| 스키마 | `escape-ledger.mjs` | `shipped_defect` 분류, `commit`/`commit_type`/`confidence`/`fix_shipped_test`/`area`/`introduced_commit` 필드, 커밋을 포함한 id seed |
| 랭킹 | `attention-rank.mjs` | `shipped_defect: 25`, `fix_shipped_test === false`에 `+15` |
| CLI | `attention.mjs` | `--git`, `--max-commits`, `by_source`, `git` 요약 블록 |

`shipped_defect`를 새로 만든 이유: git 행을 `not_reviewed`에 넣으면 **"게이트가 그 diff를 본 적 없다"는 스코프 구멍 집계가 오염된다.** git 행은 게이트 관여 여부를 알 수 없으므로 별도 분류가 맞다.

id seed에 커밋을 **있을 때만** 덧붙였다. 무조건 붙이면 패널 수집기가 이미 기록한 행의 id가 바뀌어 append-only 원장에서 중복이 생긴다.

## 구현 중 발견한 결함 — `--since=30d`가 조용히 0건을 반환

`git log --since=30d`는 **에러가 아니다.** git이 인자를 받아들이고 커밋 0개를 반환한다. 첫 실행에서 정확히 이 일이 벌어졌다.

```
available: true | rows: 0 | errors: []
counts: {"fix":0,"perf":0,"revert":0}
```

레포에 fix 커밋이 65개 있는데 **"결함 없음"으로 보고**됐다. A-1에서 지적했던 mutate baseline 결함과 **완전히 같은 유형**이다. 도구가 안심되는 오답을 내는 방향으로 고장난다.

두 겹으로 막았다.

1. `gitWindowArg`가 `30d` → `30.days.ago`로 번역한다. git이 실제로 이해하는 형태가 아니면 수집 자체를 거부한다.
2. `git rev-parse --verify HEAD`로 히스토리 존재를 먼저 확인하고, **HEAD가 있는데 윈도가 0건이면 에러로 보고**한다(`window_commits`, `repo_has_history`). 빈 윈도와 무결점은 절대 같은 출력이 되지 않는다.

교훈은 백로그 A-1과 동일하다. **측정 도구는 "신호 없음"과 "측정 실패"를 반드시 구분해야 한다.** 이 원칙을 남은 수집기(C-3 벤더 일치율)에도 적용할 것.

## 검증

### x-kit 자신 (30일)

```
window 178 commits → fix 65, perf 1, revert 0, unclassified 112
defect commits 61 | with test 58 | test pairing 0.951

반복 범인
  14회  x-build/lib/x-build/verify.mjs
  11회  x-build/lib/x-build/mutate.mjs
   6회  x-eval/lib/x-eval/bench.mjs
```

**2차 감사의 예측이 검증됐다.** 문서에 "수집기가 `mutate.mjs`의 8건을 집어내지 못한다면 수집기 쪽이 틀린 것"이라고 적었는데, 11회로 2위에 올라왔다. 수집기가 자기 자신의 하드닝 이력을 정확히 포착한다.

`verify.mjs` 14회가 1위인 것은 새 정보다. 아직 아무도 들여다보지 않은 영역이다.

### term-mesh (90일, 1000 커밋)

```
fix 467, perf 26, revert 3, unclassified 504, low_confidence 2
defect commits 457 | with test 307 | test pairing 0.672

반복 범인
  96회  Sources/TeamOrchestrator+RemoteAgent.swift
  56회  Sources/TeamOrchestrator.swift
  41회  Sources/TerminalController.swift
  37회  daemon/term-mesh-cli/src/tm_agent.rs
  31회  Sources/RemoteHostStore.swift

영역
  740  Sources
  129  daemon/term-meshd
   70  scripts
```

**`TeamOrchestrator+RemoteAgent.swift` 단일 파일이 96회 수정됐다.** 2위의 1.7배다. term-mesh "회귀 지옥"의 진원지가 하나의 파일로 특정된다. 테스트 동반률 67.2%는 x-kit(95.1%)의 3분의 2 수준이다.

이 숫자가 다음 판단의 입력이다. 단위 계층을 어디부터 복원할지, 변이 프로브를 어디에 겨눌지가 추측이 아니라 순위로 나온다.

## 회귀 확인

- 신규 `test/escape-git.test.mjs` 11 pass / 0 fail (75 expect)
- 전체 스위트 3213개 중 3204 pass / **9 fail**
- 9건은 `git worktree`로 만든 **변경 없는 HEAD에서도 동일하게 9건 실패** — 기존 결함이며 이번 변경과 무관(`test/project-kind.test.mjs` 6, `test/plan.test.mjs` 2, `test/x-panel-cli.test.mjs` 1)
- `scripts/sync-bundle.sh` + `xm/scripts/skills-checksum.mjs` 재생성 완료. `escape-git.mjs`는 `xm/lib/x-build`에만 복사된다(대시보드는 import 하지 않음). purity 테스트를 모듈별 배포 위치 맵으로 바꿔 이를 반영했다

## 남은 4건과 다음 순서

| 순위 | 항목 | 비용 | 비고 |
|---|---|---|---|
| 1 | C-3 벤더 일치율 시계열 | 반나절 | "신호 없음 ≠ 측정 실패" 원칙을 여기에도 적용할 것 |
| 2 | D-3 `ack_rate` | 1시간 | 큐가 방치되는지 측정 |
| 3 | C-5 AGENTS.md 신뢰 경계 | 몇 분 | |
| 4 | C-4 L3 검증 | 1일 | `fix_shipped_test`가 습관 지표에 머무는 한계를 푼다 |

**C-4가 특히 중요해졌다.** 이제 `test_pairing_rate` 같은 숫자가 실제로 나오기 시작했는데, 그 테스트가 정말 버그를 잡는지는 여전히 아무도 확인하지 않는다. x-kit 0.951이라는 높은 숫자일수록 검증 없이 신뢰하면 위험하다. 문서와 CLI 출력에 **L1 지표는 품질이 아니라 습관을 잰다**는 단서를 유지할 것.
