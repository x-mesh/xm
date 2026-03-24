---
name: xm-release
description: Release automation — detect changes, bump versions, update marketplace.json, commit and push
---

<Purpose>
Automate the xm-kit release process. Detects which sub-plugins changed, bumps versions, updates marketplace.json, commits, and pushes.
</Purpose>

<Use_When>
- After modifying any xm-* plugin (skill, CLI, template, hook)
- User says "release", "publish", "bump version", "push changes"
- Before sharing updates with users
</Use_When>

<Do_Not_Use_When>
- No changes have been made
- Working in a user's project (not the xm-kit repo itself)
</Do_Not_Use_When>

# xm-release — Release Automation

xm-kit 플러그인 변경 사항을 감지하고, 버전을 올리고, marketplace.json을 갱신하고, 커밋 + push한다.

## Arguments

User provided: $ARGUMENTS

## Routing

- `$ARGUMENTS`가 비어있거나 `auto` → [Mode: auto] (변경 감지 → 자동 처리)
- `patch` / `minor` / `major` → [Mode: manual] (지정된 버전 범프)
- `status` → [Mode: status] (현재 상태만 확인)
- `dry-run` → [Mode: dry-run] (변경 사항 미리보기, 실제 커밋 안 함)

---

## Mode: status

변경 상태만 확인한다.

```bash
git status --short
git diff --name-only HEAD
```

변경된 파일을 서브 플러그인별로 그룹핑하여 표시:

```
📊 xm-kit Release Status

  xm-agent/   ✅ no changes
  xm-build/   🔄 2 files changed (lib/xm-build-cli.mjs, skills/xm-build/SKILL.md)
  xm-op/      🔄 1 file changed (skills/xm-op/SKILL.md)
  xm-kit/     ✅ no changes

  Current versions:
    xm-agent  1.0.0
    xm-build  1.0.0
    xm-op     1.0.0
    xm-kit    1.0.0
```

---

## Mode: dry-run

auto와 동일하게 분석하되, 실제 파일 수정/커밋/push를 하지 않는다.

```
🔍 [dry-run] Release Preview

  Would bump:
    xm-build  1.0.0 → 1.0.1 (patch)
    xm-op     1.0.0 → 1.0.1 (patch)
    xm-kit    1.0.0 → 1.0.1 (meta bump)

  Would update:
    .claude-plugin/marketplace.json
    xm-build/.claude-plugin/plugin.json
    xm-op/.claude-plugin/plugin.json
    xm-kit/.claude-plugin/plugin.json
    package.json

  Would commit: "release: xm-build@1.0.1, xm-op@1.0.1"
  Would push to: origin/main
```

---

## Mode: auto

### Step 1: 변경 감지

```bash
git diff --name-only HEAD
```

변경된 파일을 서브 플러그인별로 매핑:

| 경로 패턴 | 서브 플러그인 |
|----------|-------------|
| `xm-agent/**` | xm-agent |
| `xm-build/**` | xm-build |
| `xm-op/**` | xm-op |
| `xm-kit/**` | xm-kit |
| `.claude-plugin/**` | marketplace (root) |
| `README.md`, `package.json` | root |

변경 없으면:
> ✅ No changes detected. Nothing to release.

### Step 2: 버전 범프 결정

변경 유형에 따라 자동 판단:

| 변경 내용 | 범프 |
|----------|------|
| SKILL.md 텍스트 수정, 템플릿 수정 | patch (0.0.x) |
| 새 커맨드 추가, 기능 추가 | minor (0.x.0) |
| 호환성 깨는 변경 (커맨드 제거, 구조 변경) | major (x.0.0) |
| `$ARGUMENTS`에 `patch`/`minor`/`major` 명시 | 해당 범프 사용 |

사용자에게 범프 레벨을 확인받는다 (AskUserQuestion):
```
xm-build에 변경이 감지되었습니다. 버전을 어떻게 올릴까요?
  1) patch (1.0.0 → 1.0.1) — 버그 수정, 문서 변경
  2) minor (1.0.0 → 1.1.0) — 새 기능 추가
  3) major (1.0.0 → 2.0.0) — 호환성 깨는 변경
```

### Step 3: 버전 업데이트

변경된 각 서브 플러그인에 대해:

1. **plugin.json** 버전 업데이트:
```bash
# Read, update version, write back
```
Read tool로 `xm-{name}/.claude-plugin/plugin.json` 읽고, Edit tool로 version 필드 수정.

2. **marketplace.json** 버전 업데이트:
Read tool로 `.claude-plugin/marketplace.json` 읽고, 해당 플러그인의 version 필드를 Edit tool로 수정.

3. **package.json** 루트 버전도 갱신 (가장 높은 서브 플러그인 버전과 동기화).

4. **xm-kit 메타 패키지** — 어떤 서브 플러그인이든 변경되면 xm-kit도 같이 범프 (patch).

### Step 4: 커밋

```bash
git add .claude-plugin/ xm-agent/.claude-plugin/ xm-build/.claude-plugin/ xm-op/.claude-plugin/ xm-kit/.claude-plugin/ package.json
```

변경된 소스 파일도 함께 stage:
```bash
git add <변경된 파일들>
```

커밋 메시지 형식:
```
release: xm-build@1.0.1, xm-op@1.0.1

- xm-build: fixed quality gate detection
- xm-op: added --agents option to debate

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

### Step 5: Push

```bash
git push origin main
```

### Step 6: 결과 출력

```
🚀 Released!

  xm-build  1.0.0 → 1.0.1
  xm-op     1.0.0 → 1.0.1
  xm-kit    1.0.0 → 1.0.1 (meta)

  Commit: abc1234
  Push: origin/main ✅

  Users can update:
    /plugin marketplace update xm-kit
    /plugin install xm-kit@xm-build
```

---

## Mode: manual

`$ARGUMENTS`에 `patch`, `minor`, `major`가 명시된 경우.

auto와 동일하되:
- Step 2의 자동 판단과 사용자 확인을 건너뛴다
- 모든 변경된 서브 플러그인에 동일한 범프를 적용한다

```
/xm-release patch    → 모든 변경된 플러그인을 patch 범프
/xm-release minor    → 모든 변경된 플러그인을 minor 범프
```

---

## Safety Rules

- **변경 없으면 릴리즈하지 않는다** (빈 커밋 방지)
- **uncommitted 변경이 있으면 먼저 확인** — "커밋되지 않은 변경이 있습니다. 포함할까요?"
- **main 브랜치가 아니면 경고** — "현재 브랜치가 main이 아닙니다. 계속할까요?"
- **push 실패 시 롤백하지 않음** — 커밋은 유지, 사용자에게 수동 push 안내
