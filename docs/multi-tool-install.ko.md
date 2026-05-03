# xm 다중 도구 설치 가이드

xm은 Claude Code 마켓플레이스 플러그인으로 배포되지만, 16개 SKILL을 **Cursor**, **OpenAI Codex CLI**, **AWS Kiro**, **Google Antigravity**가 인식하는 형식으로도 변환할 수 있습니다. 단일 소스 컴파일러(`xm/lib/install/install-cli.mjs`)가 도구별 산출물을 생성하므로 소스를 한 곳에서만 유지하면 됩니다.

> **요약**
> ```bash
> # 미리보기
> node xm/lib/install/install-cli.mjs --list
> # 한 레포에 4 도구 모두 설치
> node xm/lib/install/install-cli.mjs --target cursor,codex,kiro,antigravity
> # 검증
> node xm/lib/install/install-cli.mjs --verify
> # 제거 (AGENTS.md의 사용자 콘텐츠 보존)
> node xm/lib/install/install-cli.mjs --uninstall
> ```

## 목차
- [지원 표면 비교](#지원-표면-비교)
- [전제 조건](#전제-조건)
- [도구별 설치](#도구별-설치)
  - [Cursor](#cursor)
  - [Codex CLI](#codex-cli)
  - [Kiro](#kiro)
  - [Antigravity](#antigravity)
- [검증](#검증)
- [제거](#제거)
- [테스트](#테스트)
- [보안 모델](#보안-모델)
- [트러블슈팅](#트러블슈팅)

---

## 지원 표면 비교

Claude Code가 기준 — 다른 도구는 호스트의 플러그인 모델 한계에 따라 컴파일된 부분 집합입니다.

| 기능 | Claude Code | Cursor | Codex CLI | Kiro | Antigravity |
|------|:-:|:-:|:-:|:-:|:-:|
| 16 SKILL 본문 | ✅ | ✅ `.cursor/rules/*.mdc` | ✅ `.codex/prompts/*.md` (또는 `--global` 시 `~/.codex/prompts/`) | ✅ `.kiro/steering/*.md` | ✅ `.agent/skills/*.md` (또는 `~/.gemini/antigravity/skills/`) |
| 자동 룰 로딩 | ✅ | △ description 기반 agent-requested | ❌ 사용자 호출 `/prompts:xm-<plug>` | △ inclusion: auto/manual | △ agent-requested |
| 슬래시 명령 디스커버리 | ✅ `/xm:build` | △ `.cursor/commands/` (현재 미정의) | △ `/prompts:xm-build` | ❌ | △ workflows 파일 |
| 차단형 훅 (exit 2) | ✅ | ✅ `.cursor/hooks.json` (camelCase) | △ Bash/shell만 안정 (issue #16732) | ❌ run-only, 차단 불가 | ❌ programmable API 없음 |
| References 분리 파일 | ✅ | ✅ `xm-*-ref-*.mdc` | △ 본문 인라인 | ✅ `#[[file:…]]` include | △ 본문 인라인 |
| CLI 번들링 (build/solver/memory) | ✅ `${CLAUDE_PLUGIN_ROOT}` | ✅ `~/.cursor/xm/lib/` | ✅ `~/.codex/xm/lib/` | ✅ `~/.kiro/xm/lib/` | ✅ `~/.gemini/xm/lib/` |
| MCP 서버 | ✅ | ✅ | ✅ | ✅ | ✅ (config 전용) |
| Programmable hook API | ✅ | ✅ | △ partial | △ run-only | ❌ |

범례: ✅ 풀 / △ 제한적 / ❌ 미지원.

---

## 전제 조건

- **Node.js ≥ 20** 또는 **Bun** — install CLI는 `.mjs`이고 Node 표준 라이브러리 + crypto만 사용. 외부 의존 없음.
- **Git** — manifest는 소스 옆에 위치, `.bak` 회전은 일반 파일에서만 동작.
- 이 레포 클론 또는 디스크에 풀린 `x-mesh/xm` 패키지.

> 동일한 SKILL 소스가 4 도구로 모두 렌더링됩니다. `xm install` 실행 전에 각 도구 IDE를 깔아둘 필요는 없습니다 — 다음에 해당 도구로 프로젝트를 열면 룰이 인식됩니다.

---

## 도구별 설치

`xm install`은 두 가지 루트 중 하나에 파일을 씁니다:

| 범위 | 루트 | 사용 시점 |
|-----:|:-----|:----------|
| `--local` (기본) | 현재 작업 디렉토리 | 레포별 설치, 룰을 버전 관리 |
| `--global` | `$HOME` | 머신 전역 룰, 모든 프로젝트에서 보임 |

도구는 하나 또는 여러 개 동시 선택 가능:

```bash
# 한 도구, 프로젝트 단위 (가장 일반적)
node xm/lib/install/install-cli.mjs --target cursor

# 4 도구 동시, 프로젝트 단위
node xm/lib/install/install-cli.mjs --target cursor,codex,kiro,antigravity

# 글로벌, 확인 생략 (CI)
node xm/lib/install/install-cli.mjs --target cursor --global --yes
```

첫 실행은 새 파일 + manifest를 작성하고, 재실행은 멱등 — 동일 인자면 `git diff` 0. 사용자 작성 콘텐츠 (예: AGENTS.md에 직접 적은 메모)는 `<!-- xm:BEGIN v2 --> ... <!-- xm:END -->` 마커와 `.bak` 회전(최대 3개)으로 보존됩니다.

### Cursor

```bash
node xm/lib/install/install-cli.mjs --target cursor
```

생성:
- `.cursor/rules/xm-<plug>.mdc` × 16 — 메인 스킬 룰 (frontmatter: `description`, `alwaysApply: false`)
- `.cursor/rules/xm-<plug>-ref-<name>.mdc` — 참조 동반 파일 (alwaysApply: false)
- `.cursor/hooks.json` — `.claude/settings.json`의 훅을 Cursor 1.7+ 형식으로 변환
- `.cursor/xm/manifest.json` — 설치 manifest (자동)

Cursor에서 검증:
1. 프로젝트 열기. Cursor가 세션 시작 시 `.cursor/rules/*.mdc` 읽음.
2. 새 채팅에서 SKILL description과 매칭될 만한 질문 ("phased rollout 계획해줘"). `xm-build.mdc`가 자동 첨부되어야 함.
3. 파일 편집 시 `block-marketplace-copy.mjs` 훅이 발동 (Cursor agent 로그에 표시).

> **`xm-op.mdc`는 Cursor 권장 500줄을 초과 (522줄).** Cursor가 잘릴 수 있어 경고 출력. x-op SKILL.md가 분해되기 전까지는 best-effort로 사용.

### Codex CLI

```bash
# 글로벌 권장 — Codex prompts/는 사용자 단위
node xm/lib/install/install-cli.mjs --target codex --global

# 훅 활성화 (1회)
codex config set features.codex_hooks true
# 또는 ~/.codex/config.toml에 추가:
# [features]
# codex_hooks = true
```

생성:
- `~/.codex/AGENTS.md` (또는 `--local` 시 `./AGENTS.md`) — `xm:BEGIN v2 / xm:END` 마커 안의 16 KiB 이하 인덱스 블록, 사용 가능한 모든 `/prompts:xm-*` 나열
- `~/.codex/prompts/xm-<plug>.md` × 16 — 스킬별 프롬프트 본문, 사용자가 호출
- `~/.codex/hooks.json` — Claude 스타일 PascalCase 훅, command sanitization 적용
- `~/.codex/xm/manifest.json`

Codex에서 검증:
1. `codex` (세션 시작). 시스템 프롬프트에 AGENTS.md 인덱스가 보여야 함 ("xm — multi-agent orchestration toolkit").
2. `/prompts:xm-build "phased rollout 계획"` 입력. Codex가 SKILL 본문을 펼쳐 실행.
3. 훅: Bash 도구 호출 시 `PreToolUse` 훅 동작 (다른 matcher는 silently 무시될 수 있음 — 업스트림 [openai/codex#16732](https://github.com/openai/codex/issues/16732)).

### Kiro

```bash
node xm/lib/install/install-cli.mjs --target kiro
```

생성:
- `.kiro/steering/xm-<plug>.md` × 16 — `inclusion: auto` (Kiro가 LLM에게 로딩 여부 질의)
- `.kiro/steering/xm-<plug>-ref-<name>.md` × 23 — `inclusion: manual` (명시 호출 시만 로드)
- `.kiro/hooks/xm-<event>-<index>.kiro.hook` — JSON 훅 (변환 가능한 Claude 훅당 1파일); 도구 이벤트는 `when.toolTypes[]`, 파일 이벤트는 `when.patterns[]` 사용; `version: "1.0.0"` (semver). **연산과 병렬 실행, 차단 불가** (R-SEC-09 한계)
- `.kiro/hooks/xm-pretooluse-1.kiro.hook` (등) — trace-session 훅은 **best-effort**로 변환 (`toolTypes: ["*"]`); Kiro에 Skill 매처 대응 없음
- `.kiro/xm/manifest.json`

Kiro에서 검증:
1. Kiro로 프로젝트 열기. "Steering" 패널에 xm-* 엔트리 표시.
2. "xm build가 뭐 하는 거야?" — `inclusion: auto`가 description으로 매칭해 `xm-build.md` 자동 첨부.
3. inclusion 참조: `#xm-op-ref-strategies`로 manual-inclusion 파일 호출.
4. `.kiro/hooks/` 확인 — 훅 파일에 `version: "1.0.0"`, `when.toolTypes` (배열, 도구 이벤트), `enabled`/`when.tool` 필드 부재 확인. trace-session 훅은 `toolTypes: ["*"]`와 description에 "best-effort" 포함.

> **훅 의미가 Claude/Cursor와 다름.** Kiro의 `runCommand`는 도구 호출과 병렬 실행 — exit code로 차단 불가. 훅의 `description` 필드와 install stdout에 명시. 차단이 필요하면 Cursor 또는 Codex 사용.

> **Trace-session 훅**은 `toolTypes: ["*"]` (모든 도구 호출에 트리거)로 best-effort 변환됩니다. 원본 Claude의 `Skill` 매처는 Kiro에 대응이 없으며, 훅의 description에 이 근사치를 안내합니다.

### Antigravity

Antigravity는 2026-04 시점 **Public Preview**. 렌더러를 의도적으로 보수적으로 유지.

```bash
node xm/lib/install/install-cli.mjs --target antigravity
```

생성:
- `AGENTS.md` 인덱스 블록 (Codex와 동일 본문 — 의도적)
- `.agent/skills/xm-<plug>.md` × 16 (프로젝트) 또는 `~/.gemini/antigravity/skills/xm-<plug>.md` (`--global`) — 스킬별 본문, plain Markdown (frontmatter 없음)
- `.gemini/xm/manifest.json`

주의:
- `~/.gemini/GEMINI.md`는 글로벌 설치에서 회피 (`gemini-cli` 충돌, [google-gemini/gemini-cli#16058](https://github.com/google-gemini/gemini-cli/issues/16058)) — `~/.gemini/AGENTS.md` 사용.
- Antigravity는 programmable hook API **미지원**. 렌더러가 훅을 완전히 스킵하므로 그 표면이 필요하면 Cursor/Codex 사용.
- spike 결정 근거는 [`E0-gate.md`](../.xm/build/projects/multi-tool-install/phases/02-plan/E0-gate.md) 참조.

---

## 검증

설치된 파일을 manifest의 SHA-256과 재해시 비교 (R-SEC-13/15). 변조, `0o644`/`0o600`에서 벗어난 모드 변경, 누락 파일을 탐지.

```bash
node xm/lib/install/install-cli.mjs --verify
node xm/lib/install/install-cli.mjs --verify --target cursor       # 한 도구만
```

깨끗한 설치는:
```
# cursor (local, 40 files)
  selfChecksum: ok
  status counts: ok=40
```

변조된 파일은:
```
# cursor (local, 40 files)
  selfChecksum: ok
  status counts: ok=39, changed=1
  changed  /path/to/.cursor/rules/xm-build.mdc
```

모드 불일치 (예: 글로벌 파일을 chmod 666):
```
  ⚠ mode mismatch: 1 entry(ies) (R-SEC-08).
    expected=0o600 actual=0o666 /path/to/file
```

`selfChecksum: ok` + 모든 status가 `ok`/`unverified` + 모드 불일치 0일 때만 exit code 0.

---

## 제거

```bash
node xm/lib/install/install-cli.mjs --uninstall --target cursor,codex
```

각 manifest를 읽어 xm이 쓴 파일만 제거하고, AGENTS.md를 xm 설치 이전 상태로 복원합니다 (마커 외부에 추가한 콘텐츠는 보존). 외부 파일 (`.cursor/rules/` 아래에 직접 작성한 `xm-*` 아닌 파일 + manifest에 없는 파일)은 그대로 둡니다.

두 번째 실행은 안전하게 "nothing to uninstall" 보고.

---

## 테스트

### 자동화된 단위 + 통합 (CI)

```bash
bun test test/install.test.mjs
# 24 pass / 53 expect() calls / ~1.4초  (현재 카운트는 `bun test test/install.test.mjs`로 확인)
```

검증 범위: 입력 검증, `--list`/`--dry-run` (부작용 0), 4 도구 모두 install + 멱등성, 공급망 checksum 가드 (정상 + bypass 둘 다), `--verify` (clean / 변조 / 누락), 제거 (사용자 콘텐츠 + 외부 파일 보존), 파일 권한 (`0o644` local, `0o600` global).

전체 프로젝트 테스트는 그린 유지:

```bash
bun test
# 565 pass / 1 fail (pre-existing x-dashboard/api unrelated)
```

### 스모크 스크립트 (수동, 한 명령)

```bash
bash xm/scripts/test-install.sh
# 4 도구 모두
bash xm/scripts/test-install.sh cursor codex
# 일부만
```

스크립트 동작:
1. tmp 프로젝트 생성, `.claude/settings.json` 시드 + 사용자 작성 `AGENTS.md`.
2. `xm/skills.checksums.json` 자기 일관성 검사 (`--check`).
3. 도구별: install → 재install (멱등성) → `--verify` clean → AGENTS.md 보존 (codex/antigravity).
4. 마지막 uninstall 패스 + AGENTS.md 사용자 콘텐츠 보존 확인.
5. 검사별 pass/fail 출력. 실패 시 non-zero exit.

최근 실행: **20 passed, 0 failed**, 약 6초.

### 실제 IDE에서 수동 end-to-end

CI 테스트는 파일 형태와 내용을 검증합니다. 룰이 *실제로 소비*되는지 확인하려면 대상 IDE를 직접 열어야 합니다:

| 도구 | 룰 로딩 검증 방법 |
|------|-----------------|
| Cursor | 프로젝트 열기. "phased rollout 계획" 채팅 → `xm-build.mdc` 첨부 확인 (`@Files` 패널 또는 inspector) |
| Codex CLI | `codex` 후 `/prompts:xm-build` → "unknown command"가 아닌 SKILL 본문 출력 확인 |
| Kiro | 프로젝트 열기. "Steering" 패널에 xm-* 엔트리와 inclusion 모드 표시 확인 |
| Antigravity | 프로젝트 열기. "xm 도구 뭐 있어?" → AGENTS.md 인덱스 참조 확인 |

결과는 자체 QA 로그에 기록하세요. 각 IDE를 CI에 번들하지는 않습니다.

---

## 보안 모델

설치자는 [`PRD.md`](../.xm/build/projects/multi-tool-install/phases/02-plan/PRD.md) §14에 정의된 15개 보안 요구사항(R-SEC-01..15)에 따라 동작합니다.

핵심:
- **R-SEC-02** — `xm/skills.checksums.json`이 모든 SKILL.md의 SHA-256을 기록. CLI는 해시가 다른 SKILL 렌더링을 거부. `--allow-unverified`는 audit 플래그를 남기고 우회 (R-SEC-15).
- **R-SEC-04** — `--target`은 enum (`cursor|codex|kiro|antigravity`); 플러그인/스킬명은 `/^[a-z][a-z0-9-]{0,30}$/` 매칭 필수; 최종 쓰기 경로는 `resolve()` + `startsWith(installRoot)` 검증.
- **R-SEC-05** — `.bak` 회전은 symlink (`lstat` 검사) 시 abort, TOCTOU symlink-escape 방어.
- **R-SEC-13/14** — manifest 엔트리는 SHA-256 보유, manifest 자체는 install 시 nonce를 키로 한 HMAC `selfChecksum` 보유. Lock 파일은 `O_EXCL` atomic create + 60초 stale TTL.
- **R-SEC-08** — 글로벌 쓰기 모드는 `0o600`/`0o700`; `--verify`가 모드 drift 감지.

SKILL.md 변경 시 checksum 레지스트리 갱신:

```bash
node xm/scripts/skills-checksum.mjs           # 작성
node xm/scripts/skills-checksum.mjs --check   # CI gate (stale 시 exit 1)
```

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `R-SEC-02: SKILL.md checksum mismatch` | `xm/skills.checksums.json`이 stale 또는 SKILL.md 편집됨 | `node xm/scripts/skills-checksum.mjs` (릴리스 흐름) — 또는 일회성 디버깅 시 `--allow-unverified` |
| `lock held: <file>.lock` | 다른 `xm install`이 진행 중이거나 60초 안에 직전 실행이 crash | 대기 또는 다른 프로세스 없음 확인 후 `.lock` 직접 삭제 |
| `marker mismatch in AGENTS.md` | xm 마커 블록이 수동 편집 또는 일부 삭제됨 | 파일 검사 후 마커 짝 직접 복구 또는 손상 블록 삭제 — 자동 복구는 의도적으로 거부 |
| `refusing to back up symlink: …` | 대상 경로가 symlink (R-SEC-05) | 일반 파일로 교체 또는 symlink 위치 변경 |
| Cursor가 룰을 인식하지 못함 | `.cursor/rules/*.mdc` hot-reload 비신뢰; 룰은 세션 시작 시 부착 | 새 Cursor 채팅 열기 또는 IDE 재시작 |
| Codex `/prompts:xm-build`가 "unknown" | `~/.codex/prompts/`가 Codex prompt path에 없거나 stale install | `xm install --target codex --global` 재실행; `codex config get prompts.path` 확인 |
| `xm-op.mdc body has 522 lines (> 500)` 경고 | Cursor 권장 한도 초과 | 인지된 사항, PRD §16에 추적; 줄 한도가 중요하면 `--target codex` 사용 |
| Kiro 훅이 쓰기를 차단하지 못함 | Kiro는 exit-code denial 미지원 (R-SEC-09) | 차단 의미가 필요하면 Cursor 또는 Codex 사용 |
| `~/.gemini/GEMINI.md`가 알 수 없이 변경됨 | gemini-cli도 같은 경로 사용 ([#16058](https://github.com/google-gemini/gemini-cli/issues/16058)) | 기본값은 `~/.gemini/AGENTS.md`; 굳이 `GEMINI.md`를 써야 하면 `--local` 한정 |

`--verify`가 `selfChecksum: FAIL`이면 manifest 자체가 변조됨. install 재실행으로 재생성하고, `<install-root>/.<tool>/xm/manifest.json`을 installer 외부에서 수정한 프로세스가 무엇인지 점검 권장.

---

## 참조

- 아키텍처 결정: [`PRD.md`](../.xm/build/projects/multi-tool-install/phases/02-plan/PRD.md) §5.1 (SkillIR), §5.2 (overflow 전략), §5.3 (multi-writer 프로토콜)
- Frozen IR: [`xm/lib/install/INTERFACE-FREEZE.md`](../xm/lib/install/INTERFACE-FREEZE.md)
- E0 (Antigravity) gate 결정: [`E0-gate.md`](../.xm/build/projects/multi-tool-install/phases/02-plan/E0-gate.md)
- B PoC gate 증거: [`B-gate.md`](../.xm/build/projects/multi-tool-install/phases/02-plan/B-gate.md)
- 도구별 리서치 노트: [`phases/01-research/notes.md`](../.xm/build/projects/multi-tool-install/phases/01-research/notes.md)
