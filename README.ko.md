<p align="center">
  🇰🇷 한국어 | 🇺🇸 <a href="./README.md">English</a>
</p>

<p align="center">
  <img src="assets/xm-logo.jpeg" alt="xm" width="600" />
</p>

<h1 align="center">xm</h1>

<p align="center">
  AI 코딩 에이전트는 조용히 실패합니다. 계획을 건너뛰고, 필요한 맥락을 놓치고, 검증도 없이 다 됐다고 말합니다.<br />
  <strong>xm은 바로 그 지점을 잡습니다.</strong>
</p>

<p align="center">
  <a href="https://github.com/x-mesh/xm/releases"><img src="https://img.shields.io/badge/version-1.26.17-blue" alt="Version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js" /></a>
  <a href="#플러그인"><img src="https://img.shields.io/badge/plugins-12-orange" alt="Plugins" /></a>
</p>

<p align="center">
  <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>용 플러그인 툴킷입니다. 시니어 엔지니어라면 거르지 않을 단계를 에이전트도 거르지 못하게 합니다 — 코딩 전에 계획하고, 머지 전에 리뷰하고, 완료라고 말하기 전에 검증하도록.
</p>

<p align="center">
  <code>/xm:build plan "JWT 인증이 포함된 REST API 만들기"</code><br />
  → PRD → 태스크 분해 → 병렬 에이전트 실행 → 검증 완료 ✅
</p>

---

## 목차

- [설치](#설치)
- [빠른 시작](#빠른-시작)
- [왜 xm인가?](#왜-xm인가)
- [플러그인](#플러그인) — [x-build](#x-build) · [x-op](#x-op) · [x-review](#x-review) · [x-solver](#x-solver) · [x-probe](#x-probe) · [x-eval](#x-eval) · [x-humble](#x-humble) · [x-agent](#x-agent) · [x-trace](#x-trace) · [x-memory](#x-memory) · [x-dashboard](#x-dashboard) · [x-ship](#x-ship) · [x-humanize](#x-humanize)
- [품질 & 학습 파이프라인](#품질--학습-파이프라인)
- [아키텍처](#아키텍처)
- [설정](#설정)
- [문제 해결](#문제-해결)
- [기여하기](#기여하기)
- [라이선스](#라이선스)

---

## 설치

### 사전 준비

xm은 테스트, 대시보드 서버, 스크립트 실행에 [Bun](https://bun.sh)을 JavaScript 런타임으로 사용합니다.

**왜 Bun인가?**
- 빠른 시작 — JIT 워밍업 없이 스크립트와 테스트가 즉시 실행됩니다
- 내장 테스트 러너 — `bun test`가 바로 동작하며 추가 devDependencies가 필요 없습니다
- 네이티브 TypeScript/ESM — `.ts`와 `.mjs` 파일을 트랜스파일 없이 직접 실행합니다
- 제로 설정 HTTP 서버 — npm 의존성 없이 `x-dashboard`를 구동합니다

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Homebrew
brew install oven-sh/bun/bun

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

설치 후 `bun --version`으로 확인하세요 (v1.0 이상 필요).

> Node.js >= 18은 Claude Code 자체에 여전히 필요합니다. Bun은 xm 자체 도구에 사용됩니다.

### 플러그인 설정

```bash
/plugin marketplace add x-mesh/xm
/plugin install xm@xm -s user
```

### 최초 초기화 (전역)

설치 후 머신당 한 번 실행하여 trace-session 훅을 `~/.claude/hooks/`에 복사하고 `~/.claude/settings.json`에 Skill matcher를 등록합니다:

```
/xm init              # trace-session 훅을 ~/.claude/에 설치
/xm init status       # 설치 상태 확인
/xm init uninstall    # 훅 파일 + settings.json 항목 제거
/xm init --no-hooks   # CLI만 설치 (현재는 no-op, 예약됨)
```

Idempotent: 재실행 안전. 기존 훅(mem-mesh 등)은 보존되고, 매 쓰기 시 `settings.json`의 타임스탬프 백업이 생성됩니다. 트레이스는 각 프로젝트의 `.xm/traces/`에 기록됩니다.

터미널에서 동일한 설치를 하려면 `xm init`을 쓰세요 ([터미널 CLI](#terminal-cli-optional) 참고).

### 터미널 CLI (선택)

`xm` 디스패처 CLI를 설치하면 Claude Code에 들어가지 않고 셸에서 바로 실행할 수 있습니다 — 대시보드, 동기화, 메모리, 트레이스 등에 유용:

```bash
# 로컬 저장소에서 설치
bash xm/scripts/install.sh

# 또는 원격
curl -fsSL https://raw.githubusercontent.com/x-mesh/xm/main/xm/scripts/install.sh | bash
```

인스톨러는 `~/.local/bin/xm`을 설치하고(`XM_BIN_DIR`로 경로 변경 가능, `PATH`에 있어야 함), `claude` CLI가 `PATH`에 있으면 `marketplace.json`의 모든 플러그인(x-build, x-agent, x-op, x-solver, x-review, x-trace, x-memory, x-eval, x-probe, x-humble, x-dashboard, xm)을 `claude plugin install <p>@xm -s user`로 일괄 설치합니다. 설치 후 Claude Code에서 `/reload-plugins`로 활성화하세요. `claude`가 `PATH`에 없으면 CLI 래퍼만 설치되고 수동 설치용 플러그인 목록이 출력됩니다.

#### 전역 훅 설치 (`xm init`)

bash `xm init` 서브커맨드는 `/xm init` 슬래시 커맨드와 동일한 동작을 합니다 — Skill 트레이싱 훅을 **사용자 스코프**(`~/.claude/`)에 설치합니다 (머신당 1회):

```bash
xm init                 # trace-session 훅을 ~/.claude/에 설치
xm init status          # 설치 상태 확인
xm init uninstall       # 훅 파일 + settings.json 항목 제거
xm init --no-hooks      # CLI만 설치 (현재는 no-op, 예약됨)
```

`~/.claude/hooks/xm-trace-session.mjs`를 복사하고 `~/.claude/settings.json`의 `PreToolUse`/`PostToolUse`에 Skill matcher를 병합합니다. 기존 훅(mem-mesh 등)은 보존되며, 수정 시 타임스탬프 백업이 생성됩니다. Claude Code 밖에서 실행해야 할 때는 bash 경로를 쓰고, 그 외에는 `/xm init`을 권장합니다.

```bash
xm dashboard                       # 시작 — `~/.xm/projects.json` 레지스트리에 등록된 모든 프로젝트 표시
xm dashboard --scan ~/work         # 레거시 멀티 프로젝트: ~/work 아래 .xm/ 디렉토리 스캔 (depth 4)
XM_DASHBOARD_SCAN=~/work xm dashboard   # 동일 동작을 환경변수로 영구 적용
xm dashboard stop                  # 중지
xm dashboard open                  # 브라우저에서 열기

# 프로젝트 레지스트리 (~/.xm/projects.json)
xm project import ~/work           # ~/work 아래 모든 .xm/ 프로젝트를 일괄 등록
xm project list                    # 등록된 프로젝트 목록
xm project add [<path>]            # CWD 또는 지정 경로 등록
xm project remove <id|path>        # 등록 해제
xm project archive <id>            # 삭제하지 않고 대시보드에서만 숨김
xm project gc                      # 경로가 사라진 항목 정리
xm sync push           # .xm/ 상태를 sync 서버로 push
xm sync pull           # sync 서버에서 pull
xm memory <subcmd>     # save | recall | inject | list
xm build <subcmd>      # build status / list / ...
xm trace <subcmd>      # 실행 트레이스
xm solver <subcmd>     # 구조화된 문제 해결
xm handoff [reason]    # 세션 상태 저장
xm handon              # 세션 상태 복원
xm which               # 해석된 lib 경로 확인
xm version
xm help
```

CLI는 `~/.claude/plugins/cache/xm/` (또는 `$XM_LIB`)의 플러그인 lib을 호출하므로 Claude Code 플러그인이 먼저 설치되어 있어야 합니다. `sync` 서브커맨드는 `x-sync` 플러그인 lib을 그대로 재사용하므로 `x-sync/install.sh client`를 별도로 실행할 **필요 없습니다**.

#### 프로젝트 레지스트리 (`xm project`)

대시보드는 `~/.xm/projects.json` 머신 로컬 레지스트리를 읽습니다. 한 번 채워두면 `xm dashboard`에서 `--scan` 없이도 등록된 모든 프로젝트가 보입니다.

- **최초 설정**: `xm project import ~/work` (또는 임의 루트)로 기존 `.xm/` 프로젝트를 일괄 등록. Idempotent — 재실행 시 `last_seen`만 갱신됩니다.
- **자동 등록**: 프로젝트 디렉토리에서 어떤 xm 명령이든 실행하면 dispatcher가 자동으로 자기 자신을 등록합니다. 새 프로젝트는 명시적 작업 없이 대시보드에 등장.
- **워크트리**: 이미 등록된 레포의 워크트리는 본 레포 엔트리로 합쳐집니다. 어떤 워크트리에서 `xm`을 실행해도 동일 엔트리 하나만 갱신 — 중복 없음.
- **해석 우선순위**: `--scan` 플래그 → `~/.xm/projects.json` → 레거시 `~/.xm/config.json`의 `scan_roots` → CWD only.

### 다중 도구 설치 (Cursor / Codex / Kiro / Antigravity / OpenCode)

xm은 Claude Code 마켓플레이스 플러그인으로 배포되지만, 16개 SKILL을 다른 AI 코딩 도구가 인식하는 룰/스티어링 형식으로도 변환할 수 있습니다. 단일 소스 컴파일러(`xm/lib/install/install-cli.mjs`)가 도구별 산출물을 생성합니다.

```bash
# 대화형 선택기 (범위 + 도구)
xm install
# 컴파일러를 직접 호출할 때
node xm/lib/install/install-cli.mjs --interactive

# 설치 미리보기 (파일 변경 없음)
node xm/lib/install/install-cli.mjs --list

# 한 개 또는 여러 도구에 프로젝트 단위 설치 (기본값)
node xm/lib/install/install-cli.mjs --target cursor,codex,kiro,antigravity,opencode

# 사용자 글로벌 설치 (~/.cursor/, ~/.codex/, ~/.kiro/, ~/.gemini/, ~/.config/opencode/)
node xm/lib/install/install-cli.mjs --target cursor --global

# 설치된 파일을 manifest와 재해시 비교 (R-SEC-13/15)
node xm/lib/install/install-cli.mjs --verify --target cursor

# xm이 설치한 파일만 제거. AGENTS.md 안의 사용자 콘텐츠는 보존됩니다
node xm/lib/install/install-cli.mjs --uninstall --target cursor,codex
```

**도구별 레이아웃:**

| 도구 | 스킬 | 슬래시 호출 | 훅 |
|------|------|------------|------|
| Cursor | `.cursor/rules/xm-*.mdc` (frontmatter: `description`, `alwaysApply`) | agent-requested | `.cursor/hooks.json` (camelCase 이벤트) |
| Codex CLI | `.codex/prompts/xm-*.md` (프로젝트) 또는 `~/.codex/prompts/xm-*.md` (`--global`) + `AGENTS.md` 인덱스 (≤ 16 KiB 블록) | `/prompts:xm-<plug>` | `.codex/hooks.json` / `~/.codex/hooks.json` (`[features] codex_hooks=true` 필요) |
| Kiro | `.kiro/steering/xm-*.md` (frontmatter: `inclusion: auto\|manual`) | n/a | `.kiro/hooks/xm-*.kiro.hook` (informational only — Kiro는 차단 불가) |
| Antigravity | `.agent/skills/xm-*.md` (프로젝트) 또는 `~/.gemini/antigravity/skills/xm-*.md` (`--global`) + 공유 `AGENTS.md` 인덱스 | agent-requested | 미지원 (programmable hook API 없음) |
| OpenCode | `.opencode/skills/xm-*/SKILL.md` (프로젝트) 또는 `~/.config/opencode/skills/xm-*/SKILL.md` (`--global`) | native skill discovery | 생성 안 함 |

**안전성:**
- `<!-- xm:BEGIN v2 --> ... <!-- xm:END -->` 마커가 사용자와 공유되는 파일(AGENTS.md) 내부에서 xm 영역을 분리합니다. 기존 사용자 콘텐츠는 보존됩니다.
- 기존 파일은 첫 덮어쓰기 시 `.bak`, `.bak.1`, `.bak.2`로 회전(최대 3개). 심볼릭 링크는 abort.
- Lock 파일은 `O_EXCL` atomic 생성 + 60초 stale TTL.
- 설치 시 도구별 `xm/manifest.json` 경로(예: `.cursor/xm/manifest.json`, `~/.config/opencode/xm/manifest.json`)에 SHA-256 + HMAC self-checksum 기록. `--verify`는 해시 재계산, `--uninstall`은 기록된 파일만 정확히 제거.
- `R-SEC-02` 공급망 가드: 소스 SKILL.md 해시를 `xm/skills.checksums.json`과 비교 후 렌더. `--allow-unverified`로 우회 가능 (audit entry 표시).
- 설치는 멱등 — 동일 인자 재실행 시 diff 0.

전체 가이드는 [`docs/multi-tool-install.ko.md`](docs/multi-tool-install.ko.md)에서 — 지원 표면 비교, 도구별 설치 절차, IDE 안에서의 수동 검증, 보안 모델, 트러블슈팅을 다룹니다. 설계 문서(PRD v2.1)는 [`.xm/build/projects/multi-tool-install/phases/02-plan/PRD.md`](.xm/build/projects/multi-tool-install/phases/02-plan/PRD.md)에 있습니다.

## 빠른 시작

```bash
/xm:build plan "JWT 인증이 포함된 REST API 만들기"
```

이 한 줄로:
1. 프로젝트를 생성하고 요구사항이 담긴 PRD를 자동 생성합니다
2. 완료 기준이 포함된 태스크로 자동 분해합니다
3. 계획을 검토할 수 있도록 보여줍니다 (사용자 승인)
4. 에이전트가 태스크를 병렬 실행하고 → 품질을 검증합니다

리서치/PRD 단계를 건너뛰고 바로 실행하려면 `--quick`을 사용하세요:
```bash
/xm:build plan "JWT 인증이 포함된 REST API 만들기" --quick
```

실패했다면? `/xm:build run`을 다시 실행하세요. 완료된 태스크는 건너뛰고, 남은 것만 실행합니다.

<details>
<summary>단계별 튜토리얼 (5분)</summary>

```bash
# 1. 프로젝트 초기화
/xm:build init my-project

# 2. 요구사항 수집 (선택, 권장)
/xm:build discuss --mode interview
# → 에이전트가 질문하고, CONTEXT.md를 생성합니다

# 3. PRD 생성 + 태스크 분해
/xm:build plan "JWT 인증 시스템 만들기"
# → PRD + 태스크 목록을 자동 생성합니다

# 4. 계획 검증
/xm:build plan-check
# → 11개 차원을 검사합니다 (원자성, 커버리지, 스코프 명확성, ...)

# 5. 실행
/xm:build run
# → 에이전트가 DAG 순서로 병렬 실행합니다

# 6. 검증
/xm:build quality                  # 테스트/린트/빌드 체크
/xm:build verify-traceability      # R# ↔ Task ↔ AC 매트릭스

# 7. 완료!
/xm:build status
```

</details>

---

## 왜 xm인가?

대부분의 AI 코딩 도구는 체크리스트를 돌립니다. SQL 인젝션, null 체크, N+1 — 패턴 잡는 데는 능합니다. 그런데 시니어 엔지니어는 패턴이 아니라 문제를 봅니다.

차이는 손을 대기 전에 던지는 질문입니다. 보안 발견을 올리기 전에 묻습니다, 공격자가 실제로 이 경로까지 도달할 수 있는가. 디버깅에 들어가기 전에 묻습니다, 마지막으로 정상이었던 게 언제였나. 심각도를 한 칸 올리려는 순간에는, 지금 확신이 없어서 부풀리고 있는 건 아닌지 자문합니다.

xm은 그 질문들을 에이전트 프롬프트에 그대로 심어 둡니다. 덕분에 에이전트가 리스트를 패턴 매칭하는 대신, 맥락을 읽고 판단합니다.

<details>
<summary>Before & After 예시</summary>

**코드 리뷰 (x-review):**

| | 체크리스트 에이전트 | xm 에이전트 |
|---|----------------|-------------|
| 발견 | `[Medium] src/api.ts:42 — SQL 인젝션 가능성` | `[Critical] src/api.ts:42 — req.query.id가 SQL 템플릿 리터럴에 직접 삽입됨. 인증 미들웨어 없는 Public API 엔드포인트.` |
| 수정 | `입력을 검증하세요.` | `db.query('SELECT * FROM users WHERE id = $1', [req.query.id])` |
| 이유 | *(없음)* | `인증 없는 public 엔드포인트, 입력이 쿼리 싱크에 직접 흐름` |

**프로젝트 계획 (x-build):**

| | 원칙 없이 | 원칙 적용 |
|---|-------------------|-----------------|
| 접근법 | "요즘 트렌드니까 마이크로서비스" | "모듈 경계가 있는 모놀리스 — 별도 배포가 필요한 제약 없음" |
| 리스크 | "보안 위험" | "JWT 시크릿 로테이션 시 활성 세션이 무효화될 수 있음 — 유예 기간으로 완화" |
| 완료 기준 | "인증이 잘 동작함" | "만료된 토큰에 401 응답, 리프레시 로테이션 테스트 완료" |

**디버깅 (x-solver):**

| | 일반 AI | xm |
|---|-----------|-------|
| 첫 행동 | 가설 5개 생성 | 현재 상태 기술 + 마지막 정상 상태(baseline) 찾기 |
| 근거 | "이슈가 ~인 것 같습니다..." | "git bisect로 커밋 abc1234에서 회귀 확인, 테스트 출력으로 검증" |
| 막혔을 때 | 같은 방법 재시도 | 레이어 전환 (앱 코드 확인 중 → 인프라/설정 확인) |

</details>

<details>
<summary>사고 원칙 요약</summary>

| 할 때 | xm 원칙 | 도구 |
|-------------|----------------|------|
| 코드 리뷰 | 맥락이 심각도를 결정 — 같은 패턴이라도 노출 범위에 따라 위험도 다름 | x-review |
| 코드 리뷰 | 근거 없으면 발견 아님 — diff에서 추적하거나 보고하지 않음 | x-review |
| 코드 리뷰 | 확신 없으면 낮추기 — 과잉 보고는 신뢰를 깎음 | x-review |
| 프로젝트 계획 | 안 만들 것부터 정하기 — 제외로 스코프 정의 | x-build |
| 프로젝트 계획 | 리스크를 먼저 일정에 넣기 — 빨리 실패, 늦게 말고 | x-build |
| 프로젝트 계획 | 검증 못 하면 출시 못 함 — 모든 태스크에 완료 기준 필요 | x-build |
| 문제 해결 | 가설 전에 상태 진단 — 뭐가 잘못됐는지가 아니라, 뭐가 일어나고 있는지 | x-solver |
| 문제 해결 | 정상 상태에 앵커 — baseline 없으면 찾기부터 | x-solver |
| 문제 해결 | 복합 신호 — 로그 한 줄로 결론 내지 않음 | x-solver |
| 회고 | 왜 발생했나 · 왜 늦게 발견했나 · 프로세스에서 뭘 바꿀까 | x-humble |

**시니어 엔지니어의 디버깅 방법** — x-solver에 내장된 사고 프로토콜:

```
진단 ──→ 가설 ──→ 테스트 ──→ 개선 ──→ 해결 ──→ 회고
```

1. **"지금 무슨 일이 일어나고 있는가?"** — 문제가 아니라, 관찰 가능한 상태를 기술
2. **"마지막으로 정상이었던 때는?"** — baseline을 찾음. 없으면 먼저 찾기
3. **"왜?" — 근거와 함께** — 다른 소스에서 교차 확인. 근거 없으면 멈춤
4. **"막혔으면 렌즈를 바꾸기"** — 같은 레이어에서만 가설? 다른 레이어 보기
5. **"동작하는 걸 보여줘"** — 실행이 유일한 증거
6. **"왜 이걸 놓쳤나?"** — x-humble로 회고

</details>

---

### 공유 참조

공통 참조 자료는 `references/`에 있습니다 (marketplace 동기화 시 `xm/references/`로 복사). Skill이 필요할 때만 pull-in — progressive disclosure로 각 SKILL.md를 가볍게 유지합니다.

| 참조 | 사용처 |
|------|--------|
| `ask-user-question-rule.md` | 7 plugin (AskUserQuestion Dark-Theme 규칙) |
| `trace-recording.md` | 9 plugin (trace hook 프로토콜) |
| `dimension-anchors.md` | x-op 전략, x-review lens, x-eval rubric |
| `self-score-protocol.md` | 모든 x-op 전략, x-agent solve/consensus |
| `finding-severity.md` | x-review, CLAUDE.md 코드 리뷰 원칙 |

---

## 플러그인

12개 플러그인, 각각 개별 설치 또는 `xm` 번들로 한 번에 설치 가능.

| 플러그인 | 용도 | 주요 커맨드 |
|--------|---------|-------------|
| [x-build](#x-build) | 프로젝트 라이프사이클 & PRD 파이프라인 | `/xm:build plan "목표"` |
| [x-op](#x-op) | 17가지 멀티 에이전트 전략 | `/xm:op debate "A vs B"` |
| [x-review](#x-review) | 판단 기반 코드 리뷰 | `/xm:review diff` |
| [x-solver](#x-solver) | 구조화된 문제 해결 | `/xm:solver init "버그"` |
| [x-probe](#x-probe) | 근거 기반 전제 검증 | `/xm:probe "아이디어"` |
| [x-eval](#x-eval) | 품질 평가 & 벤치마크 | `/xm:eval score file` |
| [x-humble](#x-humble) | 구조화된 회고 | `/xm:humble reflect` |
| [x-agent](#x-agent) | 에이전트 기본 도구 & 팀 | `/xm:agent fan-out "작업"` |
| [x-trace](#x-trace) | 실행 추적 & 비용 | `/xm:trace timeline` |
| [x-memory](#x-memory) | 세션 간 메모리 | `/xm:memory inject` |
| [x-sync](#x-sync) | 멀티 머신 .xm/ 동기화 | `xm sync push` |
| [x-ship](#x-ship) | 릴리스 자동화 & 커밋 정리 | `/xm:ship auto` |
| [x-humanize](#x-humanize) | AI 글쓰기 패턴 제거 | `/xm:humanize audit text` |
| xm | 번들 + 설정 + 파이프라인 | `/xm pipeline release` |

---

### x-build

프로젝트를 아이디어에서 검증된 결과물까지 이어 줍니다. PRD를 만들고, 토론 모드를 돌리고, 모든 태스크에 완료 기준을 붙이고, 실행은 품질 게이트로 막습니다.

```bash
/xm:build init my-api
/xm:build discuss --mode interview       # 다중 라운드 요구사항 인터뷰
/xm:build plan "JWT 인증이 포함된 REST API 만들기"
/xm:build run                             # DAG 순서로 에이전트 실행
```

```
리서치 ──→ PRD ──→ 계획 ──→ 실행 ──→ 검증 ──→ 종료
 [discuss]  [quality]  [critique]  [contract]  [quality]  [auto]
  interview   consensus   validate    adapt     verify-contracts
  validate
```

<details>
<summary>기능 & 커맨드</summary>

| 기능 | 설명 |
|---------|-------------|
| **다중 모드 토론** | `discuss`에 5가지 모드: interview, assumptions, validate, critique, adapt |
| **PRD 생성** | 리서치 산출물에서 8개 섹션 PRD 자동 생성 |
| **PRD 품질 게이트** | 요청 시 심사 — 평가 기준 기반 점수 + 가이드 |
| **계획 원칙** | 제외로 스코프 정의, 리스크 우선 일정, 계획은 가설, 의도 > 구현, 검증 못 하면 출시 못 함 |
| **합의 리뷰** | 4명 에이전트 리뷰 (architect, critic, planner, security) 합의까지 |
| **완료 조건** | 태스크별 `done_criteria` — PRD에서 자동 도출, 종료 시 검증 |
| **전략 태그 태스크** | `--strategy` 플래그 태스크는 x-op으로 품질 검증과 함께 실행 |
| **팀 실행** | `--team`으로 계층적 팀 (x-agent 팀 시스템)에 라우팅 |
| **DAG 실행** | 의존성 순서로 태스크 실행, 가능한 경우 병렬 |
| **비용 예측** | 태스크별 $ 예측, 복잡도 보정된 신뢰도 |
| **품질 대시보드** | 태스크별 점수 + 프로젝트 평균 status 출력 |
| **추적성 매트릭스** | R# ↔ Task ↔ AC ↔ Done Criteria, 갭 탐지 |
| **범위 초과 감지** | 새 태스크가 PRD "범위 밖" 항목과 겹치면 경고 |
| **에러 복구** | 지수 백오프 자동 재시도, 서킷 브레이커, git 롤백 |
| **plan-check (11차원)** | 원자성, 의존성, 커버리지 (done_criteria 포함), 세분도 (상한 >15), 완전성, 컨텍스트, 네이밍 (44-동사 사전), 기술 누출, 스코프 명확성 (범위 밖 매칭), 리스크 순서 (DAG 기반), 종합 |
| **도메인별 done_criteria** | 태스크 도메인, 크기, PRD 비기능 요구사항 기반 자동 생성 |

| 카테고리 | 커맨드 |
|----------|----------|
| **프로젝트** | `init`, `list`, `status`, `next [--json]`, `close`, `dashboard` |
| **페이즈** | `phase next/set`, `gate pass/fail`, `checkpoint`, `handoff --full`, `handon` |
| **계획** | `plan "목표"`, `plan-check [--strict]`, `prd-gate [--threshold N]`, `consensus [--round N]` |
| **태스크** | `tasks add [--deps] [--size] [--strategy] [--team] [--done-criteria]`, `tasks done-criteria`, `tasks list`, `tasks remove [--cascade]`, `tasks update`, `later add/list/promote/dismiss` |
| **스텝** | `steps compute/status/next` |
| **실행** | `run`, `run --json`, `run-status` |
| **검증** | `quality`, `verify-coverage`, `verify-traceability`, `verify-contracts`, `verify-review-fix [--init]` |
| **분석** | `forecast`, `metrics`, `decisions`, `summarize` |
| **내보내기** | `export --format md/csv/jira/confluence`, `import` |
| **릴리스** | `release detect`, `release squash`, `release bump`, `release commit`, `release test`, `release trace`, `release diff-report` |
| **설정** | `mode developer/normal`, `config set/get/show` |

</details>

---

### x-op

17가지 멀티 에이전트 전략. 결과물은 스스로 점수를 매기고, 필요하면 x-eval에 품질 검증을 위임합니다.

```bash
/xm:op refine "결제 API 설계" --rounds 4 --verify
/xm:op tournament "최적 접근법" --agents 6 --bracket double
/xm:op debate "REST vs GraphQL"
/xm:op investigate "Redis vs Memcached" --depth deep
/xm:op compose "brainstorm | tournament | refine" --topic "v2 계획"
```

| 카테고리 | 전략 |
|----------|-----------|
| **협력** | refine, brainstorm, socratic |
| **경쟁** | tournament, debate, council |
| **파이프라인** | chain, distribute, scaffold, compose, decompose |
| **분석** | review, red-team, persona, hypothesis, investigate |
| **메타** | monitor |

**품질 기능:**
- **Confidence Gate**: 사전 4-question 체크리스트 — 불명확한 작업을 에이전트 실행 전에 차단
- **Self-Score + 4Q 체크**: 모든 전략이 자동 채점(1-10) 후 증거/요구사항/가정/일관성 검증
- **--verify**: 전략별 기본 rubric으로 x-eval에 품질 검증 위임
- **결과 저장**: 전략 결과를 `.xm/op/`에 자동 저장 — x-dashboard에서 조회 가능
- **Compose 프리셋**: `--preset analysis-deep`, `--preset security-audit`, `--preset consensus`
- **출력 품질 계약**: 근거 기반, 검증 가능한 주장 + 항목별 태그와 기준 앵커

<details>
<summary>전체 17가지 전략</summary>

| 전략 | 패턴 | 적합한 상황 |
|----------|---------|----------|
| **refine** | 발산 → 수렴 → 검증 | 설계 반복 개선 |
| **tournament** | 경쟁 → 시드 → 토너먼트 → 우승 | 최적 해법 선택 |
| **chain** | A → B → C 조건부 분기 | 다단계 분석 |
| **review** | 병렬 다관점 (동적 스케일링) | 코드 리뷰 |
| **debate** | 찬성 vs 반대 + 심판 → 판정 | 트레이드오프 결정 |
| **red-team** | 공격 → 방어 → 재공격 | 보안 강화 |
| **brainstorm** | 자유 발상 → 클러스터링 → 투표 | 기능 탐색 |
| **distribute** | 분할 → 병렬 → 병합 | 대규모 병렬 작업 |
| **council** | 가중치 토론 → 합의 | 다수 이해관계자 결정 |
| **socratic** | 질문 기반 심층 탐구 | 가정에 도전 |
| **persona** | 다역할 관점 분석 | 모든 각도의 요구사항 |
| **scaffold** | 설계 → 배분 → 통합 | 하향식 구현 |
| **compose** | 전략 파이핑 (A \| B \| C) | 복합 워크플로 |
| **decompose** | 재귀 분할 → 리프 병렬 → 조립 | 대규모 구현 |
| **hypothesis** | 생성 → 반증 → 채택 | 버그 진단, 근본 원인 |
| **investigate** | 다각도 → 교차 검증 → 갭 분석 | 미지 영역 탐색 |
| **monitor** | 관찰 → 분석 → 자동 디스패치 | 변경 감시 |

</details>

<details>
<summary>어떤 전략을 써야 할까?</summary>

| 상황 | 전략 | 이유 |
|-----------|----------|-----|
| 설계 반복 개선 | `refine` | 발산 → 수렴 → 검증 |
| 최적 해법 선택 | `tournament` | 경쟁 → 익명 투표 |
| 코드 리뷰 | `review` | 다관점 병렬 리뷰 |
| REST vs GraphQL 트레이드오프 | `debate` | 찬반 + 심판 판정 |
| 버그 근본 원인 찾기 | `hypothesis` | 생성 → 반증 → 채택 |
| 대규모 기능 구현 | `decompose` | 재귀 분할 → 병렬 → 병합 |
| 보안 강화 | `red-team` | 공격 → 방어 → 보고 |
| 기능 브레인스토밍 | `brainstorm` | 자유 발상 → 클러스터링 → 투표 |
| 미지 영역 탐색 | `investigate` | 다각도 → 갭 분석 |

잘 모르겠다면? `/xm:op list`로 모든 전략과 설명을 확인하세요.

</details>

<details>
<summary>옵션</summary>

```
--rounds N              라운드 수 (기본 4)
--preset quick|thorough|deep|analysis-deep|security-audit|consensus
--agents N              에이전트 수 (기본: agent_max_count)
--model sonnet|opus     에이전트 모델
--target <file>         리뷰/레드팀/모니터 대상
--depth shallow|deep|exhaustive   조사 깊이
--verify                x-eval에 품질 검증 위임
--threshold N           품질 기준점 (기본 7)
--vote                  투표 활성화 (brainstorm)
--dry-run               실행 계획만 표시
--resume                체크포인트에서 재개
--explain               의사결정 추적 포함
--pipe <strategy>       전략 체이닝 (compose)
```

</details>

---

### x-review

체크리스트로 패턴을 맞히는 대신, 발견 하나하나의 맥락을 따져 보는 다관점 코드 리뷰.

```bash
/xm:review diff                     # 마지막 커밋 리뷰
/xm:review diff HEAD~3              # 최근 3개 커밋 리뷰
/xm:review pr 142                   # GitHub PR 리뷰
/xm:review file src/auth.ts         # 특정 파일 리뷰
/xm:review diff --specialists       # 도메인 전문가 에이전트로 렌즈 강화
```

| 기능 | 설명 |
|---------|-------------|
| **기본 4개 렌즈** | security, logic, perf, tests (7개로 확장 가능: +architecture, docs, errors) |
| **--specialists** | 매칭되는 전문가 에이전트 규칙을 렌즈 서문으로 주입 |
| **판단 프레임워크** | 렌즈별 원칙, 판단 기준, 심각도 보정, 무시 조건 |
| **Why-line 필수** | 모든 발견은 어떤 심각도 기준이 적용되는지 명시해야 함 |
| **Challenge 단계** | 리더가 각 발견의 심각도를 최종 보고 전 검증 |
| **합의 상향** | 2+ 에이전트가 같은 이슈 보고 → 심각도 승격 + `[consensus]` 태그 |
| **Recall Boost** | 심각도 필터링 후 2차 패스로 6개 카테고리(스텁, 모순, 교차 참조, 무음 동작 변경, 누락된 에러 경로, off-by-one)를 `[Observation]` 태그로 포착 |
| **--thorough** | 별도 recall 에이전트가 fresh context로 스캔, 최대 10개 observation, 적극적 자동 승격 |
| **심각도 판별** | Architecture 렌즈: "이 diff가 도입" → Medium vs "기존 컨벤션 따름" → Low |
| **판정** | LGTM (Critical 0, High 0, Medium ≤ 3) / Request Changes (High 1-2 또는 Medium > 3) / Block (Critical 1+ 또는 High > 2) |

**리뷰 원칙:** 맥락이 심각도를 결정 · 근거 없으면 발견 아님 · 수정 방향 없으면 발견 아님 · 확신 없으면 낮추기

---

### x-solver

문제를 풀어 가는 4가지 전략. 문제의 모양을 보고 어떤 전략으로 갈지 자동으로 골라 줍니다.

```bash
/xm:solver init "React 컴포넌트 메모리 누수"
/xm:solver classify          # 전략 자동 추천
/xm:solver solve             # 에이전트로 실행
```

| 전략 | 패턴 | 적합한 상황 |
|----------|---------|----------|
| **decompose** | 분해 → 리프 해결 → 병합 | 복합적 다면 문제 |
| **iterate** | 진단 → 가설 → 테스트 → 개선 | 버그, 디버깅, 근본 원인 |
| **constrain** | 도출 → 후보 → 채점 → 선택 | 설계 결정, 트레이드오프 |
| **pipeline** | 자동 감지 → 최적 전략 라우팅 | 잘 모를 때 |

```
진단 → 가설 → 테스트 → 개선 → 해결 → x-humble
[상태+baseline] [검증 가능] [변수 하나] [전환/복원] [실행 검증] [왜 늦었나?]
```

---

### x-probe

이걸 만들어야 할까? 코드에 손대기 전에 한 번 흔들어 봅니다. 모든 전제에 근거 등급을 매기고, 사전부검을 돌리고, 치명적 가정이 남지 않을 때만 진행 판정을 내립니다.

```bash
/xm:probe "결제 시스템 만들기"          # 전체 검증 세션
/xm:probe verdict                      # 마지막 판정 보기
/xm:probe list                         # 과거 검증 목록
```

```
FRAME ──→ PROBE ──→ STRESS ──→ VERDICT
[전제 추출]  [소크라틱]  [사전부검]  [진행/재검토/중단]
                        [반론]
                        [대안]
```

<details>
<summary>기능</summary>

| 기능 | 설명 |
|---------|-------------|
| **6가지 사고 원칙** | 기본은 NO, 가장 쉬운 질문으로 검증, 출처와 날짜가 있는 근거, 사전부검, 코드는 비싸다, 답하지 말고 물어라 |
| **전제 추출** | 3-7개 가정을 자동 식별, 근거 등급(가정/경험/데이터/검증됨)과 취약도 순 정렬 |
| **소크라틱 검증** | 등급 보정된 질문 — 가정에 집중, 검증된 전제에는 가볍게 |
| **3-에이전트 스트레스 테스트** | 사전부검 (실패 시나리오) + 반론 (하지 말아야 할 이유) + 대안 (코드 없이) |
| **도메인 감지** | 아이디어 도메인 자동 분류 (기술/비즈니스/시장) → 전문 질문 |
| **재분류 트리거** | 사용자 근거에 따라 등급 자동 상향/하향 |
| **판정** | 진행 / 재검토 / 중단 + 근거 요약 — 핵심+가정이면 진행 차단 |
| **x-build 연동** | 진행 판정 시 검증된 전제를 CONTEXT.md에 자동 주입 |
| **Verdict 스키마 v2** | 도메인, 근거 등급, 갭이 포함된 구조화 JSON — x-solver/x-humble/x-memory가 소비 |
| **x-humble 연동** | 중단 판정 시 아이디어가 왜 검증 단계까지 왔는지 회고 트리거 |

</details>

---

### x-eval

결과물에 루브릭으로 점수를 매깁니다. 전략끼리 맞붙여 비교하고, 커밋 사이에 품질이 어떻게 움직였는지도 측정합니다.

```bash
/xm:eval score output.md --rubric code-quality     # 심사 패널 채점
/xm:eval score output.md --rubric code-quality \
  --assert "빈 입력 처리" \
  --assert "전역 상태 없음"              # + 이진 결과 단언 (HARD FAIL 게이트)
/xm:eval compare old.md new.md --judges 5          # A/B 비교
/xm:eval bench "버그 찾기" --strategies "refine,debate,tournament" --trials 5
                                                  # pass@k/pass^k 신뢰성 지표
/xm:eval diff --from abc1234 --quality              # 변경 측정
/xm:eval diff --baseline v1.5.0                     # 고정 태그 대비 회귀 감지
/xm:eval consistency x-review                       # 특정 플러그인 일관성 테스트
/xm:eval report --sample-transcript 2              # 점수 감사용 심사위원 판단 근거 출력
/xm:eval calibrate --rubric code-quality            # 인간 vs 심사위원 편향 점검
```

<details>
<summary>커맨드 & 루브릭</summary>

| 커맨드 | 기능 |
|---------|-------------|
| **score** | N명 심사위원이 평가 기준으로 채점 (1-10, 가중 평균); `--assert`로 이진 HARD FAIL 게이트 추가; 근거 불충분 기준은 `N/A` 반환 (가중치 재정규화) |
| **compare** | 위치 편향 완화된 A/B 비교 |
| **bench** | 전략 × 모델 × 시행 매트릭스, `pass@k`/`pass^k` 신뢰성 지표, σ 기반 추천, broken-task 경고, Score/$ 최적화 |
| **diff** | Git 기반 변경 분석 + 선택적 전후 품질 비교; `--baseline <tag>`으로 회귀 감지 (delta ≤ -0.5 → ⛔, CI 게이트 용) |
| **consistency** | 반복 실행 간 플러그인 출력 일관성 측정 |
| **rubric** | 커스텀 평가 기준 생성/목록 |
| **report** | 집계된 평가 이력 |
| **calibrate** | 인간 vs 심사위원 편향 루프: 기준별 편향(과대/과소평가) 측정; 체계적 편향 ≥ 1.0 시 심사위원 지침 제공; \|Δ\| ≥ 1.5인 고비중 기준은 자동화 게이팅 차단 |

**내장 평가 기준:** `code-quality`, `review-quality`, `plan-quality`, `general` — 각 루브릭은 `pass_threshold`(7.0–8.0)를 선언하고, `bench`가 이를 기준으로 pass@k / pass^k를 계산합니다. 커스텀 루브릭은 `pass_threshold` 필드로 재정의 가능.

**감사 추적:** `score`/`bench`는 심사위원별 판단 근거를 `.xm/eval/results/`에 보존합니다. `report --sample-transcript N`로 읽어서 점수가 단순 집계 분위기가 아닌지 검증하세요.

**도메인 프리셋:** `api-design`, `frontend-design`, `data-pipeline`, `security-audit`, `architecture-review`

**편향 점검 심사:** 높은 신뢰도의 x-humble 레슨 (확인 3회+)이 심사 컨텍스트로 제공

</details>

---

### x-humble

실패에서 같이 배우는 자리입니다. 끝에 남는 규칙이 아니라, 회고하는 그 과정이 핵심입니다.

```bash
/xm:humble reflect              # 전체 세션 회고
/xm:humble review "왜 scaffold?"  # 특정 결정 심층 분석
/xm:humble lessons              # 축적된 레슨 보기
/xm:humble apply L3             # 레슨을 CLAUDE.md에 적용
```

```
CHECK-IN ──→ RECALL ──→ IDENTIFY ──→ ANALYZE ──→ ALTERNATIVE ──→ COMMIT
[책임 확인]    [요약]    [실패 식별]   [근본 원인]   [대안 강화]    [유지/중단/시작]
```

<details>
<summary>기능</summary>

| 기능 | 설명 |
|---------|-------------|
| **Phase 0 Check-In** | 새 회고 전 이전 COMMIT 항목 이행 확인 |
| **근본 원인 분석** | 왜 발생했나 · 왜 늦게 발견했나 · 프로세스에서 뭘 바꿀까 |
| **편향 분석** | 7가지 인지 편향 탐지 (앵커링, 확증, 매몰 비용, ...) |
| **세션 간 패턴** | 반복되는 편향 태그 자동 감지 |
| **강화 반론** | 사용자가 먼저 대안 제시, 에이전트가 논리를 강화 |
| **건설적 도전** | 에이전트가 자기 합리화에 직접 도전 |
| **유지/중단/시작** | 레슨 저장, 선택적으로 CLAUDE.md에 적용 |
| **x-solver 연동** | 문제 해결 후 비자명한 문제에 회고 자동 제안 |
| **액션 품질 계약** | 모든 액션은 검증 가능, 범위 한정, 근본 원인 추적. 액션 유형: PROCESS, PROMPT, CONTEXT, TOOL, CALIBRATION |

</details>

---

### x-dashboard

`.xm/` 프로젝트 상태를 보는 웹 대시보드. 빌드, 프로브, 솔버, **리뷰, 평가, humble 레슨**, 트레이스, 메모리, 비용을 한 화면에서 읽기 전용으로 둘러봅니다. 빌드 단계 없이 그냥 띄우면 동작합니다.

<p align="center">
  <img src="docs/images/dashboard.png" alt="x-dashboard" width="800" />
</p>

```bash
bun x-dashboard/lib/x-dashboard-server.mjs              # 시작 (독립 실행)
bun x-dashboard/lib/x-dashboard-server.mjs --stop       # 중지
/xm:dashboard                                       # Claude Code에서 시작
```

```
브라우저 ──→ Bun HTTP :19841 ──→ .xm/ (읽기 전용)
  │
  ├── 홈 (요약 + 비용 위젯)
  ├── 빌드 (프로젝트 목록 + 상세 + 태스크 + 문서 + PRD)
  ├── 프로브 (히스토리 + 상세 + 두 결과 비교)
  ├── 솔버 (목록 + 상세 + 페이즈 데이터)
  ├── 트레이스 (타임라인 + 스팬별 토큰/비용)
  ├── 메모리 (결정 검색/필터)
  └── 설정
```

<details>
<summary>기능</summary>

| 기능 | 설명 |
|------|------|
| **멀티루트 워크스페이스** | `--scan ~/work` 또는 `~/.xm/config.json`의 `scan_roots` — 여러 디렉토리의 프로젝트를 한곳에서 조회 |
| **프로브 verdict 비교** | 두 프로브 실행 결과를 사이드바이사이드로 비교, 가정 변화 하이라이트 |
| **비용/토큰 대시보드** | 모델별(haiku/sonnet/opus), 날짜별 비용 집계 |
| **Brutalism UI** | 하드 그림자, 모노스페이스 악센트, 다크/라이트 토글 |
| **검색** | 프로젝트, 태스크, 프로브, 솔버, 문서 통합 검색 |
| **내보내기** | 프로젝트/프로브/솔버 상세를 마크다운으로 다운로드 |
| **자동 갱신** | 3초 폴링 + ETag/304 — 스크롤/포커스 유지 |
| **접근성** | 스킵 링크, ARIA 라벨, 키보드 탐색, 포커스 표시 |
| **세션 핸드오프 카드** | 전체 핸드오프 표시 — 커밋, 결정, 품질 점수, 테스트 상태, 차단 요인, stash (접이식) |
| **멀티루트 세션 상태** | 모든 워크스페이스에서 핸드오프를 병렬로 가져와 최신 항목 표시 |
| **의존성 제로** | Vanilla HTML/JS/CSS, Bun HTTP 서버, npm 패키지 없음 |

</details>

---

### x-agent

Claude Code Agent 도구 위에 얹은 프리미티브와 자율 행동입니다. 단계를 직접 통제하고 싶을 땐 프리미티브를, 경로 자체를 에이전트에게 맡기고 싶을 땐 자율 행동을 씁니다 (공유 보드를 통한 stigmergy).

```bash
# 프리미티브
/xm:agent fan-out "이 코드에서 버그 찾기" --agents 5
/xm:agent delegate security "src/auth.ts 리뷰"
/xm:agent broadcast "이 PR 리뷰" --roles "security,perf,logic"

# 자율 행동
/xm:agent research "Redis pub/sub 한계" --budget 5
/xm:agent solve "CI에서만 실패하는 auth 테스트" --agents 3
/xm:agent consensus "JWT vs Session 인증 방식" --agents 4
/xm:agent swarm "테스트 커버리지 80% 달성" --agents 5

# 팀
/xm:agent team create eng --template engineering
/xm:agent team assign eng "결제 시스템 만들기"
```

| 레이어 | 커맨드 | 기능 |
|--------|--------|------|
| **Primitives** | fan-out, delegate, broadcast | 직접 에이전트 제어 — 병렬, 전문가, 역할 기반 |
| **Autonomous** | research, solve, consensus, swarm | 목표 기반 — 에이전트가 탐색, 적응, 수렴 |
| **Team** | team create/assign/status | 계층 구조: Team Leader (opus) → Members |
| **Presets** | 15개 역할 프리셋 | 모든 레이어에 적용되는 역할 |

**핵심 차이**: x-op = 지휘자와 악보 (리더가 모든 단계 제어). x-agent = 재즈 밴드 (에이전트가 서로 듣고 적응).

**자율 행동 옵션**: `--budget N` (최대 라운드), `--depth shallow|deep|exhaustive`, `--focus <hint>`, `--web` (웹 검색 허용).

모델 자동 라우팅: `architect` → opus, `executor` → sonnet, `scanner` → haiku. `--model`로 오버라이드.

---

### x-trace

에이전트가 실제로 뭘 했는지 봅니다. 타임라인을 따라가고, 비용을 점검하고, 어떤 실행이든 그대로 다시 돌릴 수 있습니다.

```bash
/xm:trace timeline              # 에이전트 실행 타임라인
/xm:trace cost                  # 에이전트별 토큰/비용 분석
/xm:trace replay <id>           # 과거 실행 리플레이
/xm:trace diff <id1> <id2>      # 두 실행 비교
```

---

### x-memory

세션 간 결정과 패턴을 유지. 시작 시 관련 컨텍스트를 자동 주입.

```bash
/xm:memory save --type decision "캐싱에 Redis — ACID 불필요, 읽기 중심"
/xm:memory save --type failure "Auth 미들웨어 순서 중요 — rate limiter 전에 적용"
/xm:memory list                 # 전체 메모리 목록 (--type, --tag 필터)
/xm:memory show mem-001         # 메모리 상세 보기
/xm:memory recall "auth"        # 과거 결정과 패턴 검색
/xm:memory forget mem-003       # 메모리 삭제
/xm:memory inject               # 관련 메모리를 현재 컨텍스트에 자동 주입
/xm:memory export --format json # JSON 또는 Markdown으로 내보내기
/xm:memory import backup.json   # 메모리 가져오기 (중복 건너뜀)
/xm:memory stats                # 유형별 메모리 통계
```

| 유형 | 용도 | 자동 주입 |
|------|---------|--------------|
| **decision** | 아키텍처/기술 선택과 근거 | 관련 파일 변경 시 |
| **failure** | 과거 실수와 교훈 | 유사 패턴 시 |
| **pattern** | 재사용 가능한 해법 | 매칭 컨텍스트 시 |

---

### x-sync

여러 머신의 `.xm/` 프로젝트 데이터를 중앙 API 서버로 동기화합니다.

#### 서버 배포

**방법 A: Docker (원격 서버 권장)**
```bash
# 원클릭 배포
XM_SYNC_API_KEY=secret docker compose -f x-sync/docker-compose.yml up -d

# 또는 GHCR에서 직접 실행
docker run -d -p 19842:19842 -e XM_SYNC_API_KEY=secret \
  -v x-sync-data:/root/.xm/sync jinwoo/xm:sync:latest
```

**방법 B: 직접 설치**
```bash
# ~/.local/bin/x-sync-server로 설치
curl -fsSL https://raw.githubusercontent.com/x-mesh/xm/main/x-sync/install.sh | bash -s server

# 실행
XM_SYNC_API_KEY=secret x-sync-server --port 19842
```

#### 클라이언트 설정

```bash
# CLI 설치
curl -fsSL https://raw.githubusercontent.com/x-mesh/xm/main/x-sync/install.sh | bash -s client

# 설정
x-sync setup

# 사용
x-sync push     # .xm/ 데이터를 서버로 push
x-sync pull     # 다른 머신의 데이터를 pull
x-sync status   # 설정 및 동기화 상태 확인
```

Claude Code 안에서도 사용 가능: `/xm:sync push`, `/xm:sync pull`, `/xm:sync setup`

| 기능 | 상세 |
|------|------|
| **Push** | SHA-256 해시 중복 제거, batch POST |
| **Pull** | 타임스탬프 기반 증분, 자기 머신 데이터 skip |
| **인증** | API key (`X-Api-Key` 헤더) |
| **저장** | 서버 SQLite WAL |
| **오프라인** | SessionEnd hook이 `.sync-queue/`에 저장, 다음 push 시 drain |
| **머신 ID** | hostname 기반 자동 생성, `~/.xm/sync.json`에 저장 |

---

### x-ship

릴리스 자동화: WIP 커밋을 정리하고, 버전을 올리고, 푸시까지 합니다. xm 마켓플레이스 플러그인은 물론 독립 프로젝트(Node.js, Rust, Python, Go)에서도 동작합니다.

```bash
/xm:ship                # 인터랙티브: 테스트 → 리뷰 → 릴리스
/xm:ship auto           # 스쿼시 + 범프 + 푸시 (게이트 없이)
/xm:ship status         # 마지막 릴리스 이후 커밋 확인
/xm:ship patch          # 명시적 패치 범프
```

| 기능 | 설명 |
|------|------|
| **릴리스 CLI** | 7개 서브커맨드: `detect`, `diff-report`, `squash`, `bump`, `test`, `commit`, `trace` |
| **WIP 스쿼시** | WIP 커밋(tm(), fixup!, wip:)을 자동 분류하고 스쿼시 |
| **품질 게이트** | 릴리스 전 선택적 테스트 + 리뷰 게이트 |
| **독립 프로젝트 지원** | package.json, Cargo.toml, pyproject.toml, go.mod 자동 감지 |
| **릴리스 메트릭** | 버전, 범프 타입, 테스트/리뷰 결과를 `.xm/traces/`에 기록 |
| **Diff 기반 분석** | 커밋별 diff 리포트로 지능적 스쿼시 그루핑 |

---

### x-humanize

AI 글쓰기 패턴을 감지해 자연스러운 한국어/영어 문체로 재작성. 영어 카탈로그는 Wikipedia "Signs of AI writing" 가이드, 한국어는 실전 LLM 출력에서 관찰된 슬롭 패턴을 SSOT로 정리.

```bash
/xm:humanize audit <텍스트>         # AI 패턴 리포트만 (재작성 없음)
/xm:humanize light <텍스트>         # 최소 편집, 원본 구조 유지
/xm:humanize <텍스트>               # 기본: medium 강도 재작성
/xm:humanize strong <텍스트>        # 문장 전면 재구성, 사실은 보존
/xm:humanize voice <파일> <텍스트>  # 샘플 파일 문체에 맞춰 재작성
/xm:humanize --lang ko <텍스트>     # 한국어 출력 강제
```

| 기능 | 설명 |
|------|------|
| **패턴 카탈로그** | 한국어 KO-1 ~ KO-40 + 영어 EN-1 ~ EN-22, 심각도(High/Medium/Low) 표기. 한국어는 번역투, 기계적 병렬, hedging 버릇, 격식체 과잉, 이모지 불릿 등을 커버. |
| **장르 인식 필터** | 6개 장르(column / report / blog / formal / marketing / README) — 해당 장르가 정당하게 사용하는 패턴은 자동 드롭 (예: 공적 문서의 격식체, README의 `1) 2) 3)` 인덱싱, 에세이의 em-dash). 임계값 조정(KO-26 권고형 결말 5→8 in formal, KO-39 따옴표 5→8 in marketing). |
| **변경률 가드레일** | < 30% 진행 · 30–50% 경고 + fact inventory 재검증 · > 50% 강제 중단(출력 거부). 짧은 입력은 절대 카운트(5 / 10) 임계값 적용. |
| **Auto-downshift** | KO-26 (권고형 결말) 5회+ + KO-31 (단문 일변도) 5+ 연속 동시 검출 시 사용자가 `medium`/`strong`을 요청해도 강제 `light`로 다운시프트 — 한 단락이 변경률 예산을 폭증시키는 것을 방지. |
| **Fact inventory** | 고유명사·수치·날짜·인용을 재작성 전에 기록. 누락된 사실은 복원하고, 새 사실은 절대 추가하지 않음. 모호한 주장은 모호하게 유지(임의로 구체화 금지). |
| **Voice calibration** | Voice 샘플이 있으면 장르 룰을 덮어씀 — 사용자의 문장 길이 분포·어휘 수준·전환 습관에 맞춤. "깔끔하지만 영혼 없는" 출력 회피. |
| **Anti-AI audit pass** | Step 5 필수 — "여전히 AI처럼 들리는 부분이 무엇인가?" 자문 후 1회 재수정. 잔존 em-dash, 사대주의적 도입부, 챗봇 잔재 종결문을 잡음. |

**원칙:** 의미 100% 보존 · span 단위 수술적 수정(처방 없는 finding은 보고 안 함) · 장르 보존(칼럼 ↛ 에세이) · 과윤문 금지(변경률 50% 이상 차단)

---

## 품질 & 학습 파이프라인

한 플러그인의 사고 원칙은 다음 플러그인의 입력이 됩니다. 리뷰에서 잡힌 것은 다음 계획의 제약이 되고, solve에서 막힌 것은 humble 레슨이 됩니다.

**예시: 결제 API 만들기**
1. `x-build plan` → PRD 목표에 "and"가 있으면? 두 프로젝트로 분리. *(계획 원칙)*
2. `x-build consensus` → critic이 "결제 게이트웨이 타임아웃 시 재시도 로직 미명시" 발견 *(사고)*
3. `x-build run` → 에이전트가 done_criteria를 완료 조건으로 실행
4. `x-review diff` → 미처리 에러 경로 발견, Challenge 단계에서 실제 High인지 검증 *(판단)*
5. `x-solver iterate` → 상태 진단, 마지막 통과 테스트에 앵커, 근거로 추적 *(사고 프로토콜)*
6. `x-humble reflect` → "재시도 갭이 왜 계획이 아닌 리뷰에서 발견됐나?" → 레슨 저장 *(회고)*

<details>
<summary>전체 파이프라인 다이어그램</summary>

```
x-probe → 전제 검증 (진행/재검토/중단)
     ↓
x-build plan → PRD 품질 게이트 (7.0+) → 합의 리뷰 (4명 에이전트)
     ↓
x-build tasks done-criteria → PRD에서 완료 조건
     ↓
x-op strategy --verify → 심사 패널 (편향 인식) → 자동 재시도
     ↓
x-eval score → 태스크별 품질 추적 → 프로젝트 품질 대시보드
     ↓
x-build verify-contracts → 완료 기준 충족 체크
     ↓
x-humble reflect → 근본 원인 + 편향 분석 → KEEP/STOP/START 레슨
     ↓
레슨 → CLAUDE.md + x-eval 심사 컨텍스트 → 다음 세션에 패턴 적용
```

| 컴포넌트 | 메커니즘 |
|-----------|-----------|
| **자체 채점** | 모든 x-op 전략이 평가 기준 대비 자동 채점 |
| **--verify 루프** | 심사 패널 (편향 인식) → 실패 → 피드백 → 재실행 (최대 2회) |
| **PRD 합의** | architect + critic + planner + security, 원칙 기반 프롬프트 |
| **완료 조건** | `done_criteria`를 PRD에서 자동 도출 → 에이전트에 주입 → 종료 시 검증 |
| **자동 핸드오프** | 페이즈 전환 시 결정은 보존, 탐색 노이즈는 버림 |
| **plan-check (11차원)** | 원자성, 의존성, 커버리지 (done_criteria 포함), 세분도 (상한 >15), 완전성, 컨텍스트, 네이밍 (44-동사 사전), 기술 누출, 스코프 명확성 (범위 밖 매칭), 리스크 순서 (DAG 기반), 종합 |
| **품질 대시보드** | `x-build status`로 태스크별 점수 + 프로젝트 평균 |
| **도메인 평가 기준** | 5가지 프리셋 (api-design, frontend, data-pipeline, security, architecture) |
| **편향 점검 심사** | x-humble 레슨 (확인 3회+)이 심사 컨텍스트에 반영 |
| **x-eval diff** | 스킬 변경 사항 + 품질 델타 측정 |

</details>

---

## 벤치마크

전체 플러그인에 대한 실증적 일관성 측정. `/xm:eval consistency`로 실행.

| 플러그인 | 전략 | 일관성 | 상태 |
|--------|----------|:-----------:|--------|
| x-eval | rubric-scoring | **0.957** | PASS |
| x-humble | retrospective | **0.950** | PASS |
| x-op | debate | **0.930** | PASS |
| x-solver | decompose | **0.917** | PASS |
| x-review | multi-lens review | **0.890** | PASS |
| x-probe | premise-extraction | **0.826** | PASS |
| x-build | planning | **0.824** | PASS |

**평균: 0.899** | 7개 플러그인 전부 PASS | 판정 일관성: 100%

A/B vs 기본 Claude Code: xm이 기본 F1 (0.857)에 매칭하면서 precision은 더 높음 (1.0 vs 0.75).

전체 데이터: [`benchmarks/`](./benchmarks/SUMMARY.md)

---

## 아키텍처

```
xm/                              마켓플레이스 레포
├── x-build/                        프로젝트 관리 + PRD 파이프라인
├── x-op/                           전략 오케스트레이션 (17가지 전략)
├── x-eval/                         품질 평가 + diff
├── x-humble/                       구조화된 회고
├── x-solver/                       문제 해결 (4가지 전략)
├── x-agent/                        에이전트 기본 도구 & 팀
├── x-probe/                        전제 검증 (만들기 전에 검증)
├── x-review/                       코드 리뷰 오케스트레이터
├── x-trace/                        실행 추적
├── x-memory/                       세션 간 메모리
├── x-sync/                         멀티 머신 .xm/ 동기화 서버
├── xm/                          번들 (전체 스킬) + 공유 설정 + 서버
└── .claude-plugin/marketplace.json  11개 플러그인 등록
```

<details>
<summary>동작 원리</summary>

```
SKILL.md (스펙)  →  Claude (오케스트레이터)  →  Agent Tool (실행)
       ↕                      ↕
x-build CLI (상태)  ←  tasks update (콜백)
```

- **SKILL.md**: Claude가 읽는 오케스트레이션 스펙. plan→run 흐름, 에이전트 스폰 패턴, 에러 복구를 정의.
- **x-build CLI**: 상태 관리 레이어. 태스크/페이즈/체크포인트를 `.xm/build/`에 JSON으로 저장. 에이전트를 직접 실행하지 않음.
- **Claude**: SKILL.md를 해석하고, Agent Tool로 에이전트를 실행하며, 완료 시 CLI 콜백 호출.
- **영속 서버**: Bun HTTP 서버가 CLI 호출을 캐시하여 반복 응답 가속. 요청별 격리에 AsyncLocalStorage 사용.
- **번들 동기화**: `scripts/sync-bundle.sh`가 standalone ↔ bundle 파일 동기화를 강제.

</details>

---

## 에이전트 카탈로그

xm은 37개 전문가 에이전트를 함께 가지고 다닙니다. 코어 역할군과 도메인 전문가로 나뉘어 있고, 플러그인이 필요한 맥락에 맞춰 자동으로 끌어 씁니다. x-op refine은 주제에 따라 전문가를 주입하고, x-review는 `--specialists`로 직접 호출합니다.

```bash
/xm agents list                        # 37개 전문가 목록
/xm agents match "결제 API 설계"       # 주제에 맞는 에이전트 찾기
/xm agents get security --slim         # 전문가 규칙 보기
```

| 티어 | 에이전트 |
|------|--------|
| **코어** | api-designer, compliance, database, dependency-manager, deslop, developer-experience, devops, docs, frontend, performance, qa, refactor, reviewer, security, sre, tech-lead, ux-reviewer |
| **도메인** | ai-coding-dx, analytics, blockchain, data-pipeline, data-visualization, eks, embedded-iot, event-driven, finops, gamedev, i18n, kubernetes, macos, mlops, mobile, monorepo, oke, prompt-engineer, search, serverless |

카탈로그 위치: `xm/agents/catalog.json`. 각 에이전트에 전체 규칙 파일과 슬림 버전 (~30줄)이 있습니다.

---

## 설정

```bash
/xm config set agent_max_count 10              # 병렬 에이전트 10개
/xm config set team_default_leader_model opus  # Team Leader 모델
/xm config set team_max_members 5              # 팀당 최대 멤버
/xm config show
```

설정은 `.xm/config.json` (프로젝트 수준)에 저장됩니다.

### 비용 효율화

지출은 두 손잡이로 잡습니다. **모델 프로필**은 어떤 역할에 어떤 모델을 쓸지 정하고, **예산 가드**는 한도를 넘어가려는 실행을 멈춥니다.

```bash
/xm config set model_profile economy           # Sonnet 중심, 최대 절약
/xm config set model_profile default           # 기본값 — Opus 중심 (Opus 4.7 기준)
/xm config set model_profile max               # 전부 Opus, 품질 최우선
/xm config set budget '{"max_usd": 5.0}'       # 세션 예산 한도 설정
```

`model_profile`은 **비용 의도**(얼마나 쓸지)를 단일 축으로 표현합니다. 기존 이름 `balanced`, `performance`는 각각 `default`, `max`로 자동 매핑됩니다.

| 프로필 | architect | executor | designer | explorer | writer | 비고 |
|--------|-----------|----------|----------|----------|--------|------|
| economy | sonnet | sonnet | sonnet | haiku | haiku | default 대비 ~70-85% 절감 |
| default | opus | opus | sonnet | sonnet | haiku | Opus 중심 기준선 |
| max | opus | opus | opus | sonnet | haiku | default 대비 ~1.5-2배 |

스크립트 전용 명령(`config show`, `version`, `agents list` 등)은 프로필과 무관하게 항상 haiku로 라우팅됩니다 (`xm/skills/kit/SKILL.md`의 Model Guardrail 참고).

프로필 변경 시 SKILL.md frontmatter의 `model:` 필드와 본문 마커(`<!-- managed-model: <role> -->`)가 `xm/lib/skill-frontmatter-sync.mjs`를 통해 자동으로 재작성됩니다 — Claude Code 런타임이 선택된 모델을 skill turn 단위로 결정론적으로 강제합니다. 매핑 테이블: `xm/lib/skill-model-map.json`.

주요 역할만 표시. 전체 매핑(reviewer, security, designer, debugger, writer 포함)은 소스의 `MODEL_PROFILES` 참조.

역할별 오버라이드: `/xm config set model_overrides '{"architect": "opus"}'`로 프로필 위에 개별 설정 가능.

예산 가드는 80% 사용 시 경고하고, 100%에서 실행을 차단하며 세션 메트릭으로 추적됩니다. 롤링 지출은 `.xm/spend-cache.json`에 설정 가능한 윈도우(`budget.window_hours`, 기본값 24h) 단위로 추적됩니다. 프로젝트별 상한은 `budget.projects`로 설정합니다:

```bash
/xm config set budget '{"max_usd": 5.0, "window_hours": 48, "projects": {"my-proj": {"max_usd": 2.0}}}'
```

#### 비용 대비 품질 벤치마크

동일한 코딩 태스크(`rateLimiter` — 슬라이딩 윈도우)를 세 모델로 실행한 결과:

| 기준 | haiku | sonnet | opus |
|------|:-:|:-:|:-:|
| 정확성 | ✅ 동작 | ✅ 동작 | ✅ 동작 |
| 엣지케이스 (0, 음수) | 부분 | ✅ 완전 | ✅ 완전 |
| 엣지케이스 (NaN, Infinity, 소수) | ✗ | ✗ | ✅ isFinite + floor |
| 코드 품질 | 6/10 | 8/10 | 9/10 |
| **예상 비용 (medium 태스크)** | **$0.07** | **$0.81** | **$4.05** |

> **핵심:** haiku는 돌아가는 코드를 줍니다. 다만 엣지케이스는 직접 챙겨야 합니다. sonnet 정도면 대부분의 프로덕션 작업이 끝납니다. opus는 비용을 감수하더라도 견고함이 우선일 때 꺼내 드는 카드입니다. 프로필로 트레이드오프를 고르세요: `economy`(Sonnet 중심), `default`(Opus 중심), `max`(전부 Opus). 워크로드별 추정치는 `/xm:build forecast`로 봅니다.

#### 자동 모델 라우팅

xm은 요청을 처리할 수 있는 가장 저렴한 모델을 자동으로 고릅니다. 단순 조회/표시는 **haiku** (~78% 저렴)로 떨어지고, 사고가 필요한 작업은 sonnet이나 opus로 올라갑니다.

| 작업 유형 | 모델 | 예시 |
|----------|-------|------|
| 조회/표시 | **haiku** | `config show`, `version`, `agents list`, `status`, `task list` |
| 인터랙티브 위자드 | **sonnet** | `config` (인터랙티브), `init`, `setup`, auto-route 확인 |
| 추론 | **sonnet** (예산 여유 시 **opus**로 에스컬레이트) | `plan`, `run`, 전략 실행, 코드 리뷰 |

> 원칙: 출력이 스크립트에 의해 결정되면 (LLM 추론이 아니면) haiku를 사용합니다. 모델은 전달자이지 사고자가 아닙니다.

#### 비용 인지 라우팅

선택 체인은 세 단계입니다: `model_overrides → profile → fallback`. 결정마다 상관 ID(`ce-XXXXXXXX`)가 찍히기 때문에, 나중에 결과 메트릭과 거꾸로 맞춰 볼 수 있습니다. 특정 역할을 프로필과 무관하게 고정하고 싶을 때는 `model_overrides`를 쓰세요.

---

## 문제 해결

<details>
<summary>Circuit breaker가 OPEN</summary>

```bash
/xm:build circuit-breaker reset    # 수동 리셋
```

</details>

<details>
<summary>"No steps computed"</summary>

```bash
/xm:build steps compute            # 태스크 실행 순서 계산
```

</details>

<details>
<summary>plan-check에서 에러 표시</summary>

1. 각 에러 메시지 읽기
2. 수정: `/xm:build tasks update <id> --done-criteria "..."` 또는 누락 태스크 추가
3. 재실행: `/xm:build plan-check`

</details>

<details>
<summary>"Cannot run — current phase is Plan"</summary>

```bash
/xm:build phase next               # Execute 페이즈로 진행
/xm:build run                      # 그다음 실행
```

</details>

<details>
<summary>태스크가 RUNNING 상태에서 멈춤</summary>

```bash
/xm:build tasks update <id> --status failed --error-msg "timeout"
/xm:build run                      # 재시도 또는 스킵
```

</details>

---

## 기여하기

기여를 환영합니다. [이슈 페이지](https://github.com/x-mesh/xm/issues)에서 열린 작업을 확인하세요.

- [변경 이력 / 릴리스](https://github.com/x-mesh/xm/releases)
- [버그 신고](https://github.com/x-mesh/xm/issues/new)

---

## 요구사항

- Claude Code (Node.js >= 18 번들)
- macOS, Linux, 또는 Windows
- 외부 의존성 없음

## 라이선스

MIT © [x-mesh](https://github.com/x-mesh)
