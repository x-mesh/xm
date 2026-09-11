# Attention Queue — 구현 감사 백로그

출처: `docs/PRD-attention-queue.md` 초판 구현분에 대한 읽기 전용 코드 감사 (2026-09-11). 신규 테스트 31개 전부 통과(99 expect, 1.17s) 상태에서 수행 — **테스트 실패가 아니라 테스트가 덮지 못한 의미론적 결함**이 대상이다.

> 모든 경로는 **소스** `x-build/lib/x-build/` 기준. 수정 후 `bash scripts/sync-bundle.sh` → `node xm/scripts/skills-checksum.mjs` 로 `xm/lib/x-build/`, `x-dashboard/lib/x-build/` 사본 재생성 필요. 라인 번호는 감사 시점 기준이라 편집하며 시프트됨 — 헤더/문구로 위치 확인.

## 선행 판단 — A 두 건을 닫기 전에 데이터를 쌓지 말 것

`escape-ledger.jsonl`은 append-only이고 `escapeRowKey` 기반으로 dedupe된다. **잘못 분류된 행은 영구히 남는다.** A-1/A-2를 고치기 전에 `attention --backfill`을 실운영에 돌리면 나중에 원장 전체를 폐기하고 재수집해야 한다.

---

## A. 치명 (2) — 신호 자체가 무효가 되는 결함

- [ ] **변이 프로브에 baseline green 검증이 없음** — `probe.mjs:104-115`
  `runTaskProbe`가 변이 없는 원본으로 테스트를 한 번도 실행하지 않는다(`grep -c "baseline\|unmutated" probe.mjs` → 0). 테스트 명령이 의존성 누락·잘못된 러너·환경 문제 등 **어떤 이유로든 non-zero면 모든 변이가 `killed`로 기록**되고, 결과는 "테스트가 완벽하다"는 가장 안심되는 형태로 나온다. 오작동의 방향이 사각지대를 숨기는 쪽이라 최악이다.
  위험을 키우는 것은 `detectedTestCommand`(`probe.mjs:91-97`) — `package.json`에 `scripts.test`가 **존재하기만 하면 내용과 무관하게 `'bun test'`를 반환**한다. vitest/jest 레포에서 명령이 깨진 채로 전 변이 killed 판정이 난다.
  → 수정: `probe.mjs:113` 후보 루프 진입 전에 원본 상태로 `command`를 1회 실행하고, exit 0이 아니면 `error.exitCode=2`로 중단(`probe baseline is not green; fix the test command first`). 리포트에 `baseline_exit_code`를 남긴다.
  → 부수: `detectedTestCommand`가 `scripts.test` 문자열을 그대로 쓰거나(`bun run test`), 최소한 추측했음을 리포트에 `test_command_source: "detected"|"explicit"`로 표기.

- [ ] **릴리스 escape가 앞단 게이트와 조인되지 않음 — 5종 분류 붕괴** — `attention-collect.mjs:36-46`, `escape-ledger.mjs:75-84`
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

- [ ] **워크트리 루트 해석 불일치** — `attention.mjs:29`, `probe.mjs:131`
  둘 다 `process.cwd()`를 루트로 쓴다. 반면 `gate-panel.mjs`는 링크된 워크트리 cwd에서 호출된다는 전제로 `git rev-parse --git-common-dir` 기반 `resolveMainRepoRoot`(`worktree-shared.mjs`)를 써서 메인 레포 `.xm/`를 self-resolve한다. 워크트리에서 `xm build attention` / `xm build probe`를 실행하면 **다른 `.xm/`를 읽고 쓴다.**
  → 수정: `worktree-shared.mjs`의 `resolveMainRepoRoot`를 재사용. 기존 `X_BUILD_ROOT` / `X_PANEL_ROOT` env 우선순위 계약도 동일하게 따른다.

- [ ] **변이 연산자에 경계·논리 연산자가 없음** — `probe.mjs:36-48`
  현재 3종뿐: boolean(`true`↔`false`, `:40`), comparison(`===`↔`!==`, `:44`), numeric(`n`→`n+1`, `:47`).
  빠진 것 중 가장 값진 것이 **관계 연산자 경계**(`<`↔`<=`, `>`↔`>=`)다. off-by-one은 변이 테스트가 가장 잘 잡는 버그 유형이고, 이 프로젝트의 출발점이 된 Dan Luu 실험에서도 대표적 실패 유형이었다. 논리 연산자(`&&`↔`||`)와 조기 반환 제거도 표준 연산자 집합에 든다.
  → 수정: `simpleMutations`에 `relational`, `logical` 연산자 추가. `maxMutants` 기본 12는 유지하되 연산자 다양성이 우선되도록 라운드로빈으로 뽑는다(현재는 라인 순서대로 채워 한 줄이 예산을 독식할 수 있음).

- [ ] **`probe` 이름이 제품 안에서 반대 뜻으로 충돌** — `x-build/lib/x-build-cli.mjs:147`, `xm/commands/probe.md`
  `/xm:probe` = 전제 검증(소크라테스식 질문으로 아이디어를 죽이는 세션, `xm/skills/probe/SKILL.md`). `xm build probe` = 변이 주입. 네임스페이스는 분리돼 있으나 문서·대화·로그에서 같은 단어가 반대 의미로 쓰인다.
  → 수정: `xm build mutate`로 개명. `commands.md` 항목과 `probe.mjs` 파일명(`mutate.mjs`)까지 함께. 원장 `source:'probe'` 값도 `'mutate'`로 — **A-1/A-2 수정 전 원장이 비어 있는 지금이 개명 비용이 가장 싼 시점이다.**

- [ ] **`--budget 0`의 의미가 문서화되지 않음** — `attention-rank.mjs:15-18`, `skills/build/references/commands.md`
  `applyBudget(items, 0)`은 전체 반환(무제한)이고 `cmdAttention`도 `budget<0`만 거부한다. 유용한 탈출구인데 커맨드 카탈로그에 설명이 없다.
  → 수정: `commands.md`의 `attention` 항목에 `--budget 0 = 전체 표시` 명시.

---

## C. PRD 이후 확정됐으나 미구현 (5)

PRD 초판 이후 근거 조사와 term-mesh PoC에서 확정된 항목. 자세한 근거는 별도 정리 참조.

- [ ] **F5 — git 히스토리 기반 escape 수집기**
  현재 escape 소스는 릴리스 패널뿐이라 **릴리스 패널이 돌아야만 데이터가 생긴다.** git 히스토리 기반 수집기는 빌드 없이 아무 레포에서나 즉시 동작한다(term-mesh PoC: fix/perf 39건에서 60초 만에 반복 범인과 사각지대 도출). 원장 스키마에 `source` 필드가 이미 있으므로 `source:'git'`로 같은 원장에 들어간다.
  핵심 신호는 커밋 밀도가 아니라 **"fix 커밋이 테스트를 함께 넣었는가"**다. fix가 추가한 테스트가 곧 "없었던 테스트"이므로 공짜로 라벨링된 데이터셋이 된다.
  → 신규 필드: `commit_type`(fix/perf/revert), `fix_shipped_test`(bool), `introduced_commit`.
  → 범용화: 엔진은 코드, 레포별 차이는 설정으로. 커밋 컨벤션 패턴, 테스트 경로 glob, 경로→영역 매핑, 제외 경로(`.xm-review.json`의 `generated_copy_roots` 재사용).

- [ ] **`perf` / `revert` 커밋 분류** (F5 종속)
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

- [ ] **purity 테스트가 미러 사본을 검사하지 않음** — `test/purity-contract.test.mjs:2`
  `x-build/lib/x-build/{escape-ledger,attention-rank}.mjs`만 검사한다. `xm/lib/x-build/`, `x-dashboard/lib/x-build/` 사본은 `sync-bundle.sh`가 복사하므로 실질 위험은 낮으나, PURE 계약이 의미를 갖는 지점은 **대시보드가 실제로 import 하는 사본**이다. 또한 경로가 상대라 cwd에 의존한다.
  → 수정: 세 위치를 모두 순회. 경로는 테스트 파일 기준 `import.meta.dir`로 해석.

- [ ] **프로브 리포트 최상위에 임의 변이 하나의 필드가 섞임** — `probe.mjs:118`
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

1~3번을 닫기 전에는 `--backfill`을 실운영에 돌리지 않는다.

---

## 감사 방법과 한계

- 읽기 전용. 코드 수정 없음. `bun test` 신규 11개 파일만 실행(31 pass / 0 fail).
- 결함은 전부 **테스트가 통과하는 상태에서** 발견됐다. A-2는 단위 테스트(`classifyEscape` 직접 호출)가 통합 경로의 결함을 가린 사례이므로, 유사 구조가 다른 모듈에도 있는지 별도 점검 가치가 있다.
- 실제 `.xm/` 아티팩트로 end-to-end 실행은 하지 않았다. `reviewed_files` 부재는 정적 grep으로 확인했으므로, 런타임에 다른 경로로 주입될 가능성은 배제하지 못했다.

## 이 감사가 놓칠 수 있는 것

이 백로그는 **발견된 결함**만 담는다. 아무도 찾지 않은 결함은 여전히 보이지 않으며, 그것이 바로 이 프로젝트가 만들려는 도구의 존재 이유다. A-1이 닫히고 프로브가 신뢰 가능해지면, 이 감사 자체를 변이 프로브로 검증하는 것이 다음 단계다.
