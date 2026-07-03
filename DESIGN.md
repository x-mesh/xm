# Design System — xm CLI (terminal)

터미널 CLI용으로 번안한 디자인 시스템. 웹 표면이 생기면 별도 섹션 추가.

## Theme

터미널 네이티브. 사용자의 터미널 팔레트를 신뢰한다 — ANSI 16색만 사용(truecolor 가정 금지), 배경색 칠하기 금지. `NO_COLOR` 또는 non-TTY stdout이면 색 전부 제거.

## Color Roles (ANSI)

| Role | ANSI | 용도 |
|------|------|------|
| value / selection | cyan | 설정값, 현재 선택, 링크성 텍스트 |
| success | green | 저장 완료, 통과 |
| warning | yellow | 검증 경고, shadow 경고 |
| error | red | 실패, 차단 |
| muted | dim | 출처 tier, 보조 설명, 비활성 옵션 |
| heading | bold | 섹션 제목, 키 이름 |

색만으로 의미를 전달하지 않는다 — 상태 글리프가 항상 동반된다.

## Glyphs (clack 계열 어휘)

| 의미 | UTF-8 | ASCII 폴백 |
|------|-------|-----------|
| 섹션 시작 | `◇` | `*` |
| 활성 질문 | `◆` | `*` |
| 그룹 레일 | `│` | `\|` |
| 섹션 끝 | `└` | `+` |
| 선택된 라디오 | `●` | `(o)` |
| 비선택 라디오 | `○` | `( )` |
| 체크(멀티) 선택 | `◼` | `[x]` |
| 체크(멀티) 비선택 | `◻` | `[ ]` |
| 커서 | `❯` | `>` |
| 성공 | `✓` | `+` |
| 실패 | `✗` | `x` |
| 경고 | `⚠` | `!` |

이모지 사용 금지 (anti-reference). UTF-8 감지: `LANG`/`LC_*`에 `UTF-8` 없으면 ASCII 세트.

## Components

모든 인터랙티브 컴포넌트는 세 모드를 지원한다: **raw TTY**(화살표 내비게이션) / **line 모드**(`XM_CONFIG_WIZARD_STDIN=1` 테스트·파이프: 숫자/텍스트 입력) / **non-TTY 가드**(진입 차단 + 사용법).

- **intro / outro** — `◇ xm 설정` 한 줄 + dim 부제. outro는 저장 요약(변경 항목 수, 기록 경로).
- **section** — `◇ 제목` + 이하 `│` 레일 들여쓰기 2칸.
- **select** — `◆ 질문` 아래 옵션 목록. 활성 행: `❯ ● 라벨` (cyan), 비활성: `  ○ 라벨` (dim 설명 우측). ↑↓ 이동, Enter 확정, Esc/q 뒤로. line 모드에선 번호 입력 허용(기존 테스트 계약 보존).
- **multiselect** — `◼`/`◻` + Space 토글, Enter 확정.
- **text input** — 프롬프트 우측 dim placeholder(현재값). 검증 실패 시 아래 줄 `⚠ 허용값: …` + 재입력(3회 실패 시 취소, FM4).
- **status line** — `현재: <값> (출처tier)` — 모든 편집 전에 표시 (Design Principle 1).
- **summary table** — 라벨 좌측 정렬 bold, 값 cyan, 출처 dim. 컬럼 정렬은 공백 패딩(탭 금지).
- **shadow warning** — `⚠` + 노란 본문 + `계속할까요?` confirm. 색+글리프 동반.

## Spacing & Layout

- 들여쓰기 2칸 고정. 섹션 사이 빈 줄 1개. 그룹 내부는 `│` 레일로 소속 표시.
- 한 줄 = 한 의미 단위. 줄 너비 80자 기준으로 줄바꿈 설계.
- 정렬 컬럼: 라벨 최대폭 + 2칸 패딩. CJK 폭(2칸) 고려해 패딩 계산.

## Interaction & States

- select/multiselect: default(비활성 dim) / focused(❯ + cyan) / selected(●) / disabled(dim + 선택 불가 사유).
- 취소 경로 일관성: Esc = 한 단계 뒤로, Ctrl-C = 위저드 종료(이미 저장된 항목 유지 + outro 요약, FM3).
- 모션 없음. 스피너·타자기 효과 금지 (product register: 상태 전달 외 모션 금지). 즉시 재렌더만.

## Voice

- 프롬프트는 평서형 질문 1줄. 설명은 dim 1줄 이하.
- 버튼/선택지 라벨: 동사+목적어 or 명확한 명사. "확인"/"OK" 대신 "이 tier에 저장".
- 과장·이모티콘·감탄 금지.
