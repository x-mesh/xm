# 요구사항 문서

## 소개

`xm install --target kiro` 기능을 종합적으로 개선하여, Kiro에서도 Claude Code와 유사한 수준의 사용성을 보장합니다. 현재 Kiro 훅 렌더러(`kiro-shared.mjs`)가 생성하는 JSON이 Kiro의 실제 훅 스키마와 불일치하는 치명적 문제를 수정하고, steering 파일의 auto-inclusion 품질을 높이며, trace-session 훅을 best-effort로 지원하고, 테스트와 문서를 갱신합니다.

## 용어집

- **Hook_Renderer**: `xm/lib/install/transform/kiro-shared.mjs` — Claude Code의 `.claude/settings.json` 훅을 Kiro `.kiro.hook` JSON 파일로 변환하는 모듈
- **Steering_Renderer**: `xm/lib/install/transform/kiro.mjs` — SkillIR을 `.kiro/steering/*.md` 파일로 변환하는 모듈
- **Path_Planner**: `xm/lib/install/plan-paths.mjs` — 대상 도구별 출력 파일 경로를 계획하는 모듈
- **Kiro_Hook_Schema**: Kiro가 실제로 인식하는 `.kiro.hook` JSON 구조 (name, version(semver), when.type, when.toolTypes[], then.type, then.command)
- **Steering_Frontmatter**: Kiro steering 파일의 YAML 프론트매터 (inclusion, description, fileMatchPattern 필드)
- **Auto_Inclusion**: Kiro가 steering 파일의 description을 LLM 매칭으로 평가하여 자동 로딩 여부를 결정하는 메커니즘
- **Install_Test_Suite**: `test/install.test.mjs` — 설치 CLI의 자동화된 단위/통합 테스트 모음
- **Trace_Hook**: `.claude/hooks/trace-session.mjs` — Claude Code에서 Skill 매처로 세션 추적을 수행하는 훅

## 요구사항

### 요구사항 1: Kiro 훅 스키마 정합성 수정

**사용자 스토리:** 개발자로서, `xm install --target kiro`가 Kiro의 실제 훅 스키마에 맞는 JSON을 생성하길 원합니다. 그래야 Kiro가 훅을 정상적으로 인식하고 실행할 수 있습니다.

#### 인수 기준

1. WHEN Hook_Renderer가 Kiro 훅 JSON을 생성할 때, THE Hook_Renderer SHALL `when.toolTypes` 필드를 문자열 배열로 출력한다 (기존의 `when.tool` 문자열 필드 대신)
2. WHEN Hook_Renderer가 Kiro 훅 JSON을 생성할 때, THE Hook_Renderer SHALL `version` 필드를 semver 형식 `"1.0.0"`으로 출력한다 (기존의 `"1"` 대신)
3. THE Hook_Renderer SHALL 생성된 JSON에 `enabled` 필드를 포함하지 않는다 (Kiro 스키마에 존재하지 않는 필드)
4. WHEN Claude 이벤트 `PreToolUse`를 변환할 때, THE Hook_Renderer SHALL Kiro 이벤트 타입 `preToolUse`로 매핑하고 `when.toolTypes`에 도구 카테고리 배열을 설정한다
5. WHEN Claude 이벤트 `PostToolUse`를 변환할 때, THE Hook_Renderer SHALL Kiro 이벤트 타입 `postToolUse`로 매핑하고 `when.toolTypes`에 도구 카테고리 배열을 설정한다

### 요구사항 2: Kiro 이벤트 타입 매핑 정확성

**사용자 스토리:** 개발자로서, Claude Code의 훅 이벤트가 Kiro의 정확한 이벤트 타입으로 변환되길 원합니다. 그래야 훅이 올바른 시점에 트리거됩니다.

#### 인수 기준

1. THE Hook_Renderer SHALL Claude의 `PreToolUse`를 Kiro의 `preToolUse`로 매핑한다
2. THE Hook_Renderer SHALL Claude의 `PostToolUse`를 Kiro의 `postToolUse`로 매핑한다
3. THE Hook_Renderer SHALL Claude의 `Stop`을 Kiro의 `agentStop`으로 매핑한다
4. THE Hook_Renderer SHALL Claude의 `UserPromptSubmit`을 Kiro의 `promptSubmit`으로 매핑한다
5. WHEN 파일 이벤트를 변환할 때, THE Hook_Renderer SHALL `fileCreate`가 아닌 `fileCreated`, `fileSave`가 아닌 `fileEdited`, `fileDelete`가 아닌 `fileDeleted`를 사용한다
6. IF Claude 이벤트에 대응하는 Kiro 이벤트가 없으면, THEN THE Hook_Renderer SHALL 해당 훅을 스킵하고 사유를 notes에 기록한다

### 요구사항 3: 파일 이벤트 훅의 패턴 필드 지원

**사용자 스토리:** 개발자로서, 파일 기반 이벤트 훅이 Kiro의 `when.patterns` 배열 필드를 올바르게 사용하길 원합니다. 그래야 특정 파일 패턴에만 훅이 트리거됩니다.

#### 인수 기준

1. WHEN 파일 이벤트(`fileEdited`, `fileCreated`, `fileDeleted`) 훅을 생성할 때, THE Hook_Renderer SHALL `when.patterns` 필드를 문자열 배열로 출력한다
2. WHEN 도구 이벤트(`preToolUse`, `postToolUse`) 훅을 생성할 때, THE Hook_Renderer SHALL `when.toolTypes` 필드를 문자열 배열로 출력한다 (`when.patterns`가 아닌)
3. THE Hook_Renderer SHALL 파일 이벤트에 `when.toolTypes`를 포함하지 않고, 도구 이벤트에 `when.patterns`를 포함하지 않는다

### 요구사항 4: Steering 파일 프론트매터 표준화

**사용자 스토리:** 개발자로서, Kiro steering 파일의 프론트매터가 Kiro의 표준 필드만 사용하길 원합니다. 그래야 Kiro가 프론트매터를 정확히 파싱합니다.

#### 인수 기준

1. THE Steering_Renderer SHALL 프론트매터에 `name` 필드를 포함하지 않는다 (Kiro 표준 프론트매터 필드가 아님)
2. THE Steering_Renderer SHALL `inclusion` 필드를 포함한다 (`auto`, `manual`, `fileMatch`, `always` 중 하나)
3. WHEN `inclusion`이 `auto`일 때, THE Steering_Renderer SHALL `description` 필드를 포함한다
4. WHEN `inclusion`이 `fileMatch`일 때, THE Steering_Renderer SHALL `fileMatchPattern` 필드를 포함한다

### 요구사항 5: Auto-Inclusion Description 품질 향상

**사용자 스토리:** 개발자로서, steering 파일의 description이 Kiro의 LLM 기반 auto-inclusion 매칭에 최적화되길 원합니다. 그래야 사용자 질문에 적절한 스킬이 자동으로 로딩됩니다.

#### 인수 기준

1. THE Steering_Renderer SHALL auto-inclusion steering 파일의 description을 30자 이상으로 생성한다
2. WHEN description이 30자 미만일 때, THE Steering_Renderer SHALL 경고를 출력한다
3. THE Steering_Renderer SHALL description에 스킬의 핵심 기능과 트리거 키워드를 포함한다 (LLM 매칭 최적화)

### 요구사항 6: Trace-Session 훅 Best-Effort 지원

**사용자 스토리:** 개발자로서, Claude Code의 `trace-session.mjs` 훅이 Kiro에서도 가능한 범위 내에서 동작하길 원합니다. 그래야 세션 추적 기능을 부분적으로라도 활용할 수 있습니다.

#### 인수 기준

1. WHEN Claude의 `Skill` 매처 훅을 변환할 때, THE Hook_Renderer SHALL Kiro의 `preToolUse`/`postToolUse` 이벤트와 적절한 `toolTypes`로 best-effort 변환을 시도한다
2. THE Hook_Renderer SHALL trace-session 훅의 description에 "best-effort adaptation — Kiro has no Skill matcher equivalent" 안내를 포함한다
3. IF trace-session 훅 변환이 의미 있는 매핑을 생성할 수 없으면, THEN THE Hook_Renderer SHALL 해당 훅을 스킵하고 사유를 notes에 기록한다

### 요구사항 7: 다중 훅 파일 지원

**사용자 스토리:** 개발자로서, 여러 Claude 훅이 각각 별도의 Kiro `.kiro.hook` 파일로 생성되길 원합니다. 그래야 Kiro가 각 훅을 독립적으로 관리할 수 있습니다.

#### 인수 기준

1. THE Hook_Renderer SHALL 변환 가능한 각 Claude 훅에 대해 별도의 `.kiro/hooks/xm-<event>-<index>.kiro.hook` 파일을 생성한다
2. THE Path_Planner SHALL 다중 훅 파일 경로를 계획에 포함한다 (기존의 단일 `xm.kiro.hook` 대신 또는 추가로)
3. WHEN 동일 이벤트에 여러 훅이 있을 때, THE Hook_Renderer SHALL 인덱스 번호로 파일명을 구분한다

### 요구사항 8: 테스트 커버리지 갱신

**사용자 스토리:** 개발자로서, Kiro 훅 스키마 수정 사항이 테스트로 검증되길 원합니다. 그래야 향후 회귀를 방지할 수 있습니다.

#### 인수 기준

1. THE Install_Test_Suite SHALL Kiro 훅 JSON의 `when.toolTypes` 필드가 배열인지 검증한다
2. THE Install_Test_Suite SHALL Kiro 훅 JSON의 `version` 필드가 semver 형식인지 검증한다
3. THE Install_Test_Suite SHALL Kiro 훅 JSON에 `enabled` 필드가 없는지 검증한다
4. THE Install_Test_Suite SHALL Kiro 훅 JSON에 `when.tool` 필드가 없는지 검증한다 (구 스키마 잔재 방지)
5. THE Install_Test_Suite SHALL Kiro steering 파일의 프론트매터에 `name` 필드가 없는지 검증한다

### 요구사항 9: 문서 갱신

**사용자 스토리:** 개발자로서, 영문 및 한국어 설치 가이드가 Kiro 훅 스키마 변경 사항을 반영하길 원합니다. 그래야 사용자가 정확한 정보를 참조할 수 있습니다.

#### 인수 기준

1. WHEN Kiro 훅 스키마가 수정되면, THE docs/multi-tool-install.md SHALL Kiro 섹션의 생성 파일 목록과 검증 절차를 갱신한다
2. WHEN 영문 문서가 갱신되면, THE docs/multi-tool-install.ko.md SHALL 동일한 변경 사항을 한국어로 반영한다
3. THE docs/multi-tool-install.md SHALL Kiro 지원 표면 비교 테이블에서 trace 훅 상태를 갱신한다 (❌ → △ best-effort)
4. THE docs/multi-tool-install.ko.md SHALL 동일한 테이블 변경을 반영한다
