# x-op Quality Audit — Backlog (low severity)

출처: 39-agent quality audit workflow (2026-06-09), adversarial-verified (31 raised → 30 confirmed).
**medium 8건은 `x-op@2.1.1`에서 해결됨** (passive-ref 인라인 6 + council CONVERGE 게이트 + auto-route 도달성).
아래는 미반영 **low 21건** + 2.1.1에서 함께 해결된 1건.

> 모든 경로는 **소스** `x-op/skills/op/` 기준. 수정 후 `bash scripts/sync-bundle.sh` → `node xm/scripts/skills-checksum.mjs` (SKILL.md 변경 시 install supply-chain) 재생성 필요. 라인 번호는 2.1.1 기준이라 편집하며 시프트됨 — 헤더/문구로 위치 확인.

## A. SKILL.md 구조 컴플라이언스 (5)
CLAUDE.md 필수 6섹션(`Overview → When to Use → Core Process → Common Rationalizations → Red Flags → Verification`) 중 5개 헤더 부재. tripwire 자체는 이미 inline이라 **cosmetic/컴플라이언스 폴리시** — 동작 영향 없음.

- [ ] `## Overview` 부재 — `SKILL.md:11-13` preamble을 헤더로 래핑 (내용 재작성 불필요)
- [ ] `## When to Use` 부재 — Arguments 앞에 x-op 호출 트리거 + x-solver/x-review/x-build 경계 명시 (`Strategy Selection Guide`는 전략 선택 후 단계라 별개)
- [ ] `## Core Process` 부재 — `Interaction Protocol`을 래핑/개명해 route→confidence gate→dispatch→phase checkpoint→self-score→persist 흐름을 명명
- [ ] `## Red Flags` 부재 — 산재된 anti-pattern(`SKILL.md:90,145,257`)을 단일 tripwire 목록으로 통합 (`Common Rationalizations` 뒤)
- [ ] `## Verification` 부재 — Termination Checkpoint(`:422`)/Phase Checkpoint(`:95`)를 canonical 헤더로 수집 (마지막 섹션)

## B. 전략 일관성 (3)
- [ ] phase 진행 마커가 17중 9전략만 — `> {emoji} [{strategy}] Phase N: {Name}` 컨벤션을 전 전략에 통일 (`investigate.md:6`/`monitor.md:9` 기준)
- [ ] per-item persistence body schema가 4전략(brainstorm/council/investigate/tournament)만 강제 — 동일 tabular 출력인 review/red-team/hypothesis/persona/monitor는 summary-only → 대시보드 카드 빈 렌더. body schema 확장 또는 summary-only 사유 명시
- [ ] `investigate.md:29-85` depth 프롬프트 3중복(~85% 동일, drift 시작) — 1 템플릿 + depth-params 표로 ~40줄 축약

## C. 품질 게이트 실효성 (5) — "gate가 실제로 gate 안 함"
- [ ] Post-Strategy Eval Gate 기본경로가 suggestion 문자열 출력뿐인 no-op (`SKILL.md:58,69-70`) — 개명하거나 `Overall<threshold OR 4Q 2+⚠`면 cheap 체크 무조건 발동
- [ ] `--threshold`(기본7)가 어떤 점수와도 비교 안 됨 = 장식 (`SKILL.md:175`) — eval/self-score Overall과 비교 분기 추가
- [ ] self-score per-criterion 행동 앵커 부재 → 점수 재현 불가 (`self-score-protocol.md:33`, 4개 전역 앵커뿐) — 각 rubric의 5/7/9 레벨 디스크립터 추가
- [ ] self-score/4Q를 생산자가 self-grade, 실패 결과는 suggestion뿐 → trivially gameable — 2+⚠ or Overall<threshold면 Termination 차단(accept_risk 사유 강제)
- [ ] Overall 가중평균 산식 미표기 → 검증 불가 (`self-score-protocol.md:30`) — `score×weight` 인라인 표기 또는 단순평균으로

## D. 출력 명료성 (4)
- [ ] Final Output 템플릿이 영어 하드코딩, normal-mode Korean 변형 없음 → 쉬운한국어 사용자가 "Verdict"/"Adopted Solution" 영어로 받음 (`SKILL.md:39` 약속과 모순) — Mode Detection에 localize 규칙 + 예시 인라인
- [ ] debate Final Output이 recommendation/dimension score 누락 → 전략 핵심 산출물 폐기 (`debate.md:26` vs `:30-33`) — `## Recommendation` + dimension score 슬롯 추가
- [ ] catalog가 process로만 기술, deliverable("뭘 받나") 부재 (`x-op-list.md:9-10`) — 각 행에 `Output:` 절 추가 (refine→"one adopted solution", debate→"PRO/CON verdict + recommendation" 등)
- [ ] debate/council Final Output 표에 `|---|` separator 행 없음 → plain text 렌더 (`debate.md:31-33`, `council.md:37`) — separator + placeholder 행 추가

## E. passive-ref 잔여 (2)
2.1.1에서 핵심 메커니즘은 인라인했으나 아래 둘은 남음:
- [ ] Dimension Anchor 풀이 DOUBLE-hop 뒤(`agent-output-contract.md:14` → `dimension-anchors.md:9-14`, 0/5의 제곱) — 4행 풀 테이블을 SKILL.md Agent Primitives 근처에 인라인
- [ ] 5전략(brainstorm/chain/compose/investigate/red-team — 적대적 red-team·investigate 포함)이 per-agent evidence 요구 자체 누락 — 각 전략 프롬프트에 evidence 절 추가 (`agent-output-contract.md:34` 계약과 연결)

## F. auto-route 오라우팅 (1)
- [ ] 공유 키워드가 한 sibling으로 무분별 라우팅: "파이프라인"→compose인데 chain이 실제 시퀀셜, "나눠"→decompose vs distribute (`x-op-auto-route.md:16,18,19`) — 서브신호 컬럼 추가로 구분

## G. dual-definition 잔여 (1)
- [ ] brainstorm vote count: `SKILL.md:299` "top 3" vs `brainstorm.md:60` "Top 5" 모순 (vote 프롬프트는 3 수집 `brainstorm.md:53`) — 셋을 N=3으로 통일

## 해결됨 (x-op@2.1.1)
- [x] auto-route priority rule 5 "fallback → refine 강제" → "highest-confidence row, tie → ask" 로 보정, SKILL.md + ref 동기화 (감사 당시 low였으나 medium 인라인 작업 중 함께 수정)

## 권장 처리 순서
1. **C (품질 게이트)** — gate가 실제로 gate하게: x-op 신뢰성의 핵심. self-score/4Q를 Termination 차단으로 연결하면 D·B의 가시성 문제도 일부 완화.
2. **A (구조 컴플라이언스)** — CLAUDE.md 필수 섹션 일괄 추가, 저위험·기계적.
3. **E + G + F (passive-ref/dual/오라우팅 잔여)** — 짧고 명확, 2.1.1 작업의 자연스러운 연장.
4. **B·D (일관성·명료성)** — 폴리시, 마지막 배치.
