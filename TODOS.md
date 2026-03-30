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

## ✅ Completed (5e50253)

- ~~P1: PRD Quality Gate~~ — prd-gate 커맨드 + 5-criteria rubric 채점 (5e50253)
- ~~P1: Strategy-Tagged Execution~~ — cmdRun() JSON에 strategy/strategy_hint 출력 (5e50253)

## ✅ Completed (600b49a)

- ~~P2: Consensus Loop~~ — consensus 커맨드 + 4 에이전트 합의 리뷰 (600b49a)
- ~~P2: Task Scoring~~ — taskList()에 품질 요약 (avg/threshold 경고) (600b49a)
- ~~P2: 체크포인트 저장/복원~~ — x-op SKILL.md 저장 워크플로우 상세화 (600b49a)
- ~~P2: compose pipe_payload~~ — 구성 가이드 5규칙 추가 (600b49a)

## ✅ Completed (4df12be)

- ~~P3: Team Assignment 연동~~ — --team 플래그 + run 출력에 team/team_hint (4df12be)
- ~~P3: Strategy Auto-Suggestion~~ — suggestStrategy() 키워드 매핑 + run 출력에 strategy_suggestion (4df12be)
- ~~P3: 조건 분기 chain 가이드~~ — 조건 평가 기준, 흐름도, 자동 분기 규칙, 예시 추가 (4df12be)
