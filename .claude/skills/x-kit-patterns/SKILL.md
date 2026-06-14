---
name: x-kit-patterns
description: x-kit(xm 툴킷) 모노레포의 코딩·릴리스·번들 패턴. git 이력 200커밋 분석으로 추출. 플러그인 추가/수정, 릴리스, 번들 동기화, 테스트 작성 시 사용.
version: 1.0.0
source: local-git-analysis
analyzed_commits: 200
---

# x-kit Patterns

x-kit은 Claude Code 플러그인 모노레포다. 독립 플러그인(`x-build`, `x-op`, `x-solver`, `x-eval`, `x-review`, `x-memory`, `x-humble`, `x-probe`, `x-trace`, `x-agent`, `x-humanize`, `x-dashboard`)을 빌드하고, `xm`이 이를 하나로 묶는 통합 디스패처다. 루트 패키지는 `xm`(현재 2.3.14).

## Commit Conventions

Conventional Commits 준수율 **98%** (195/199). 표준 type 외에 이 repo 고유 type이 있다:

| Type | 빈도 | 의미 |
|---|---|---|
| `release:` | 101 | 버전 범프 릴리스. 형식: `release: x-build@2.6.3, xm@2.3.14` (멀티 플러그인 동시 범프) |
| `fix:` | 25 | 버그 수정 |
| `feat:` | 18 | 신규 기능 |
| `tm(...)` | 17 | x-build 하네스 자동 생성 커밋 (예: `tm(execute/t1): ... [COMPLETED]`). **사람이 직접 쓰지 말 것** — 하네스가 만든다 |
| `docs:` | 12 | 문서 (README/SKILL.md) |
| `chore:` | 6 | 잡무 |
| `proto:` | 5 | `prototypes/` 실험 코드 |
| `test:` `refactor:` | 각 4 | 테스트 / 리팩터 |

새 커밋은 위 type 중 하나로 시작한다. 릴리스는 항상 `release:` + 영향받은 플러그인을 `name@version`으로 나열.

## Code Architecture

```
x-{name}/                      # ★ 소스의 진실 (standalone plugin)
├── .claude-plugin/plugin.json # 플러그인 메타 + version
├── commands/{name}.md         # 슬래시 커맨드 정의
├── skills/{name}/SKILL.md     # 스킬 본문
└── lib/                       # (x-build 등) .mjs 구현

xm/                            # 통합 번들 — sync-bundle.sh가 생성/갱신 (수기 편집 금지)
├── skills/{name}/SKILL.md     # x-{name}/skills/{name}/ 에서 복사 (x- 접두사 제거)
├── lib/x-build/*.mjs          # x-build/lib/ 에서 복사
└── skills.checksums.json      # 번들 무결성 체크섬

.claude-plugin/marketplace.json # 전 플러그인 버전 카탈로그
package.json                    # 루트(name: xm)
scripts/sync-bundle.sh          # 동기화 엔진
test/*.test.mjs                 # bun:test (32개)
docs/korean-output-style.md     # 한국어 출력 스타일(AI-slop 회피) 규범
```

**핵심 규칙**: `x-{name}/`가 소스의 진실이다. `xm/` 하위 번들 파일은 **직접 수정하지 않는다** — `x-{name}/`를 고치고 `sync-bundle.sh`로 전파한다. 네이밍: 소스 디렉토리는 `x-{name}/`, 번들 스킬 디렉토리는 `{name}/`(접두사 없음).

## Workflows

### 새 플러그인/스킬 추가
1. `x-{name}/.claude-plugin/plugin.json` 생성 (version 시작값)
2. `x-{name}/commands/{name}.md` + `x-{name}/skills/{name}/SKILL.md` 작성
3. `scripts/sync-bundle.sh`의 plugin 루프(`for plugin in build op solver ... sync`)에 이름 추가
4. `./scripts/sync-bundle.sh` 실행 → `xm/` 번들 갱신
5. `.claude-plugin/marketplace.json`에 플러그인 등록

### 기존 플러그인 수정 (가장 흔한 흐름)
1. `x-{name}/` 안의 SKILL.md/lib 수정 (번들 아님)
2. `./scripts/sync-bundle.sh` → `xm/{name}/`·`xm/lib/`·`skills.checksums.json` 자동 동기화
3. 영향 파일이 함께 바뀌었는지 확인 (아래 co-change)

### 릴리스 (`release:` 커밋)
한 릴리스에서 보통 이 파일들이 **함께** 바뀐다 (co-change 확인됨):
- `.claude-plugin/marketplace.json` (105회 — 가장 빈번)
- `package.json` (루트, 101회)
- 변경된 각 `x-{name}/.claude-plugin/plugin.json`
- `xm/.claude-plugin/plugin.json` (xm도 같이 범프되는 경우 다수)
- `xm/skills.checksums.json`

→ 커밋: `release: x-build@2.6.3, xm@2.3.14`. (자동화: repo의 `/x-release` 커맨드 사용)

### 문서
README는 **이중 언어**다 — `README.md`(영문)와 `README.ko.md`(국문)가 **항상 함께** 갱신된다(32/33회 co-change). 한쪽만 고치지 말 것. 한국어 출력은 `docs/korean-output-style.md` 규범(빈 강조어·강제 3박자·애매한 결말 금지)을 따른다.

## Testing Patterns

- 러너: **bun:test** (`import { describe, test, expect } from 'bun:test'`). 실행: `bun test`
- 위치: `test/*.test.mjs` (32개). 단위/통합 분리 없이 기능별 파일 (`core.test.mjs`, `cli.test.mjs`, `cost-engine.test.mjs`, `drift.test.mjs`, `install.test.mjs`, `convergence.test.mjs` 등)
- CLI 테스트는 `spawnSync` + `mkdtempSync`로 임시 디렉토리에서 실제 실행을 검증 (격리 테스트)
- 루트 `package.json`에는 `test` 스크립트가 없다 — `bun test`를 직접 호출

## Co-change Map (함께 바뀌는 파일)

| 무엇을 고치면 | 같이 갱신 |
|---|---|
| `x-{name}/skills/{name}/SKILL.md` | `xm/skills/{name}/SKILL.md` + `xm/skills.checksums.json` (via sync-bundle) |
| `x-build/lib/**/*.mjs` | `xm/lib/x-build/*.mjs` (via sync-bundle) |
| 버전 범프 | marketplace.json + package.json + plugin.json + checksums |
| README.md | README.ko.md |

> 생성: local-git-analysis, 200 commits. 패턴이 바뀌면 `/skill-create`로 재생성할 것.
