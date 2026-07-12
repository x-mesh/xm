---
target: x-dashboard 웹 대시보드
total_score: 28
p0_count: 0
p1_count: 3
timestamp: 2026-07-05T10-01-14Z
slug: x-dashboard-public-index-html
---
# Design Critique — xm-dashboard (web)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | 3s 폴링·저장 상태에 aria-live 없음; 로딩 스켈레톤 부재 |
| 2 | Match System / Real World | 3 | 개발자 대상엔 적정하나 전면 대문자+mono가 기계적 |
| 3 | User Control and Freedom | 3 | 해시 라우팅·테마 토글·config 취소 존재 |
| 4 | Consistency and Standards | 3 | 대체로 일관되나 --radius:0 시스템에 panel-tile만 8px |
| 5 | Error Prevention | 3 | config 인라인 검증+422+If-Match |
| 6 | Recognition Rather Than Recall | 3 | 19개 텍스트 라벨 nav(아이콘온리 아님), 커맨드 팔레트 없음 |
| 7 | Flexibility and Efficiency | 2 | 19라우트 파워툴인데 키보드 단축키/⌘K 없음 |
| 8 | Aesthetic and Minimalist Design | 2 | 장식(의도적 어긋남·글리치·인버트·wobble)이 데이터와 경쟁 |
| 9 | Error Recovery | 3 | card-error+cfg-status, 실패 가시화(L6) |
| 10 | Help and Documentation | 3 | empty state가 검색 경로+실행 커맨드 안내(우수) |
| **Total** | | **28/40** | **Good (약점 보완 시 견고)** |

## Anti-Patterns Verdict

일반적 "AI 슬롭"(SaaS-크림·둥근카드·그라디언트)은 **아니다**. 오히려 확신 있는 brutalist 다크 테마 — 관점이 있다는 점은 드물게 좋다. 문제는 반대 방향: dense 운영 툴에 장식이 과해 도구가 태스크 뒤로 사라지지 않는다.

Deterministic scan: side-tab(border-left accent) 16건, bounce-easing 1건. side-tab 다수는 brutalist 어휘로 의도적이나(active 표시 등), 집합적으로는 "AI 생성" 인상을 강화하는 탐지 신호. bounce-easing = wobble/glitch 키프레임.

## Overall Impression

가장 큰 기회: **장식을 걷어내고 데이터를 앞세우는 것.** 다크 테마·amber 액센트·하드 엣지의 확신은 유지하되, 도구의 본업(traces/costs/reviews/config를 빠르게 읽기)과 싸우는 gimmick을 제거하면 즉시 신뢰도가 오른다.

## What's Working

- **확신 있는 committed 아이덴티티** — radius 0, 하드 오프셋 섀도우, amber 단색 액센트. 밋밋하지 않고 방향이 분명.
- **우수한 empty state** — renderEmpty가 스캔한 경로 공개 + "Run `xm ...`" 안내. "왜 비었지?"를 없앤다.
- **포커스 인디케이터 존재** — `outline: 2px solid var(--accent)` + offset. AT 기본기 확보.
- **구조적 반응형** — 768px에서 사이드바→가로 nav, 테이블 overflow-x, config 그리드 붕괴.

## Priority Issues

### [P1] 장식이 데이터와 경쟁 — 도구가 태스크 뒤로 사라지지 않음
- **Why**: `.stat-bar .card:nth-child(even){transform:translateY(3px)}`(의도적 어긋남), `#app{animation:glitch-in}`(라우트마다 글리치 흔들림), `.badge:hover{filter:invert(1)}`(비인터랙티브 요소에 가짜 어포던스), wobble 회전. Product 레지스터의 정확한 실패 모드 "strangeness without purpose". 지표 카드 3px 어긋남은 스캔성을 해치고 렌더 버그처럼 보인다.
- **Fix**: 의도적 misalignment 제거(카드 정렬), glitch-in 페이지 애니메이션 제거(product는 page-load 연출 금지), badge invert·wobble 제거. 확신은 타이포·색·하드 엣지로 이미 충분.
- **Command**: `$impeccable quieter` (장식 톤다운, 데이터 우선)

### [P1] reduced-motion 이스케이프 없음 + 모션이 무조건 발동
- **Why**: CSS에 `prefers-reduced-motion` 0건. glitch-in·wobble·badge-invert·card hover transform이 전정 장애/모션 민감 사용자에게 그대로 발동. WCAG 2.3.3 및 스킬 규칙 위반.
- **Fix**: `@media (prefers-reduced-motion: reduce){ *{animation:none!important} #app{animation:none} .card:hover{transform:none} }` 추가. 장식 제거와 병행하면 표면적 자체가 축소.
- **Command**: `$impeccable harden` (모션·엣지케이스 a11y)

### [P1] 웹 표면이 제품 자체 브랜드와 상충 + 디자인 시스템 미정의
- **Why**: PRODUCT.md 브랜드는 "차분·정밀·안내형, 화려함 없이(without flashiness)", anti-ref는 "과장 배너·무의미한 스피너". DESIGN.md는 "웹 표면이 생기면 별도 섹션 추가"라며 **웹은 아직 미정의**. 그 공백에 "BRUTALIST EDITION"(글로우 섀도우·글리치·wobble)이 비준 없이 들어섬. 단일 소스 없는 표면은 이 프로젝트가 막으려는 드리프트 그 자체.
- **Fix**: 둘 중 하나로 정합화 — (a) DESIGN.md에 웹 섹션을 추가해 이 미학을 브랜드로 승격하거나, (b) calm/precise 원칙에 맞게 톤다운. 표면과 문서 중 하나가 틀렸다.
- **Command**: `$impeccable document` (현 코드에서 DESIGN.md 웹 섹션 생성 → 의도 확정)

### [P2] #555 마이크로 라벨 대비 미달 (WCAG)
- **Why**: nav-section 라벨(#555 on #263238 ≈ 1.75:1), 비활성 phase-dot(#555 on #181818 ≈ 2.37:1). 9~10px 대문자라 더 안 보임. 4.5:1(또는 큰 텍스트 3:1) 미달.
- **Fix**: 섹션/비활성 라벨을 `--text-muted`(#B0BEC5) 또는 최소 #8a94a0 계열로. 색만으로 위계 주지 말고 간격/구분선 병용.
- **Command**: `$impeccable colorize` 또는 `$impeccable audit` (대비 스윕)

### [P2] 파워유저 가속기·라이브 상태 접근성 공백
- **Why**: 19개 라우트 운영 대시보드인데 ⌘K 커맨드 팔레트·키보드 단축키 없음(Alex는 전부 마우스 이동). 3s 폴링·저장 결과에 aria-live/role=status 없음 → 스크린리더가 갱신·성공/실패를 못 읽음(Sam).
- **Fix**: 라우트 점프용 `⌘K` 팔레트(19개는 팔레트가 자연스러운 규모) + 상태 영역에 `role="status" aria-live="polite"`.
- **Command**: `$impeccable shape` (커맨드 팔레트 설계) + `$impeccable harden` (live region)

## Persona Red Flags

**Alex (파워유저)**: 19개 라우트를 오직 사이드바 클릭으로만 이동 — ⌘K도 라우트 단축키도 없음. 화면 전환마다 glitch-in 250ms 흔들림을 스킵 불가. badge hover invert가 "클릭되나?" 오인 유발.

**Sam (접근성 의존)**: reduced-motion 무시로 글리치·wobble 그대로 노출. nav 섹션 헤더 #555는 사실상 안 보임. 폴링·저장 상태 미고지(aria-live 부재)로 "저장됨/실패"를 인지 못함. 다만 포커스 아웃라인은 존재(플러스).

## Minor Observations

- panel-tile만 `border-radius:8px` — 시스템 전역 `--radius:0`와 불일치(하나가 틀림).
- 전면 대문자+mono+letter-spacing이 nav/헤더/카드타이틀/테이블헤더/뱃지/라벨에 균일 적용 → 위계가 평평해짐. 한글은 대문자 개념이 없어 한/영 혼용 시 리듬 불일치.
- 로딩 스켈레톤 부재(product 레지스터는 스피너 대신 스켈레톤 권장).
- nav-brand `text-shadow` 글로우 — 장식성 발광.

## Questions to Consider

- 이 대시보드가 "조용히 사라지는 도구"여야 하나, "존재감 있는 brutalist 표면"이어야 하나? 답이 브랜드 문서와 코드의 정합 방향을 결정한다.
- 지표 카드를 의도적으로 어긋나게 둘 만큼, 개성이 스캔성보다 중요한가?
- 19개 라우트를 사이드바로만 이동하는 게 파워유저에게 충분한가?
