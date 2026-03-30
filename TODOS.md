# TODOS

## ✅ Completed (64101d7)

- ~~P0: x-build plan/run 실제 구현 상태 조사~~ — CLI=상태관리, SKILL.md=오케스트레이션 확인
- ~~P0: SKILL.md plan→run 가이드 강화~~ — Quick Mode + Error Recovery Guide 추가
- ~~P0: README 정직하게 재작성~~ — 킬러 기능 중심 + 아키텍처 정확하게 설명
- ~~P0: 체크포인트/resume 재설계~~ — 기존 메커니즘 활용 (재실행 = resume), SKILL.md에 가이드 추가
- ~~P0: 클라이언트 타임아웃 조정~~ — command-aware timeout (30s / 10min)
- ~~P1: /exec plugin name validation~~ — `/^[a-z][a-z0-9-]*$/` 검증 추가
- ~~P2: 텔레메트리 스키마 확장~~ — 기존 appendMetric에 run_complete 메트릭 추가

## ✅ Completed (83b28a1)

- ~~P2: x-build-cli.mjs 모듈 분리~~ — 4100줄 단일 파일을 9개 모듈로 분리 (83b28a1)
- ~~P2: 상태 경로 통합~~ — .xm/build로 통합 완료 (433aa4a)
- ~~P2: x-build run 진행 상황 표시~~ — 진행률 표시 추가 (433aa4a)
- ~~P3: 핵심 테스트 추가~~ — bun test 기반 서버 import 가드 + 핵심 테스트 (63c17fa)

## P1 — x-build 고급 기능

### PRD Quality Gate
- **What:** Judge Panel 3명이 PRD를 rubric 기반으로 채점 → 합격/불합격 판정
- **Why:** SKILL.md에 정의되어 있으나 실제 채점/피드백 로직 미구현
- **Effort:** M

### Strategy-Tagged Execution
- **What:** `--strategy review/refine/debate` 플래그를 run 시 x-op 전략과 연동하여 실행
- **Why:** 플래그 저장은 되지만 cmdRun()에서 strategy를 읽지 않음
- **Effort:** S

## P2 — x-build 연동

### Consensus Loop
- **What:** 4 에이전트(architect/critic/planner/security) 합의 루프로 계획 검증
- **Why:** SKILL.md에 정의된 다중 에이전트 합의 프로세스 미구현
- **Effort:** M

### Task Scoring
- **What:** rubric 기반 태스크 완료 채점 로직. task.score/task.rubric 필드는 존재하나 채점 미구현
- **Why:** Quality Dashboard와 연결되는 핵심 피드백 루프
- **Effort:** S

## P2 — x-op 안정화

### 체크포인트 저장/복원 검증
- **What:** `--resume` 실제 동작 검증 + `.xm/op-checkpoints/` 저장 가이드 보강
- **Why:** 장시간 전략 실행 중 중단 시 재개 필수
- **Effort:** S

### compose pipe_payload 명확화
- **What:** 전략 간 데이터 전달(pipe_payload) 규칙을 리더 프롬프트에 더 명확히 주입
- **Why:** compose 파이프라인에서 전략 간 데이터 손실 가능
- **Effort:** S

## P3 — 확장

### Team Assignment 연동
- **What:** x-build `--team` 플래그 → x-agent `team assign` 연동
- **Why:** 팀 기반 병렬 실행 지원
- **Effort:** S

### Strategy Auto-Suggestion
- **What:** 태스크명/설명에서 적합한 x-op 전략을 자동 추론하여 제안
- **Why:** 사용자가 전략을 몰라도 최적 전략 활용 가능
- **Effort:** S

### 조건 분기 chain 가이드 보강
- **What:** `if:condition→step` 조건 분기 사용법을 SKILL.md에 예시와 함께 보강
- **Why:** 현재 문법만 정의, 실사용 가이드 부족
- **Effort:** S
