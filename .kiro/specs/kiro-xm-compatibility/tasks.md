# 구현 계획: kiro-xm-compatibility

## 개요

Kiro 훅 렌더러(`kiro-shared.mjs`)의 JSON 스키마를 Kiro 실제 스키마에 맞게 수정하고, steering 렌더러(`kiro.mjs`)의 프론트매터를 표준화하며, trace-session 훅의 best-effort 지원을 추가합니다. 변경 사항을 테스트와 문서에 반영합니다.

## Tasks

- [x] 1. Hook 렌더러 핵심 스키마 수정 (`kiro-shared.mjs`)
  - [x] 1.1 `buildKiroHook()`의 반환 JSON에서 `enabled` 필드를 제거하고, `version`을 `"1.0.0"` (semver)으로 변경한다
    - `enabled: true` 라인 삭제
    - `version: '1'` → `version: '1.0.0'`
    - _Requirements: 1.2, 1.3_

  - [x] 1.2 `when.tool` (문자열) 필드를 `when.toolTypes` (문자열 배열)로 변경한다
    - `translateMatcher()`가 문자열 배열을 반환하도록 수정
    - `buildKiroHook()`에서 `when: { type, tool }` → `when: { type, toolTypes }` 구조로 변경
    - 도구 이벤트(`preToolUse`, `postToolUse`)에만 `toolTypes` 포함
    - _Requirements: 1.1, 1.4, 1.5, 3.2_

  - [x] 1.3 `translateEvent()`에 파일 이벤트 매핑을 추가하고, 파일 이벤트용 `when.patterns` 필드를 지원한다
    - `FileCreate` → `fileCreated`, `FileSave` → `fileEdited`, `FileDelete` → `fileDeleted` 매핑 추가
    - 파일 이벤트일 때 `when.patterns` 배열 사용, `when.toolTypes` 미포함
    - 기타 이벤트(`agentStop`, `promptSubmit`)일 때 `toolTypes`와 `patterns` 모두 미포함
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.3_

  - [x] 1.4 `translateMatcher()`에서 `Skill` 매처를 best-effort로 처리한다 — `null` 대신 `['*']` 반환 + `bestEffort` 플래그
    - `Skill` 토큰 감지 시 `{ toolTypes: ['*'], bestEffort: true }` 반환
    - `buildKiroHook()`에서 `bestEffort`일 때 description에 "best-effort adaptation — Kiro has no Skill matcher equivalent" 포함
    - 의미 있는 매핑 불가 시 기존처럼 스킵 + notes 기록
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 1.5 Hook 스키마 property-based 테스트 작성 (`test/kiro-hook-schema.prop.test.mjs`)
    - **Property 1: 훅 JSON 스키마 정합성** — 유효한 입력에 대해 `buildKiroHook()`이 non-null 반환 시 version이 semver, enabled 부재, when.tool 부재, 이벤트 타입별 toolTypes/patterns 정확성 검증
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 3.1, 3.2, 3.3**

  - [x] 1.6 미지원 이벤트 스킵 property-based 테스트 작성 (`test/kiro-hook-schema.prop.test.mjs`)
    - **Property 2: 미지원 이벤트 스킵** — 지원 매핑 테이블 외 이벤트 문자열에 대해 `buildKiroHook()`이 `json: null` 반환 + note 비어있지 않음 검증
    - **Validates: Requirements 2.6**

  - [x] 1.7 Skill 매처 best-effort property-based 테스트 작성 (`test/kiro-hook-schema.prop.test.mjs`)
    - **Property 5: Skill 매처 Best-Effort 변환** — `Skill` 매처 + 유효한 command 입력 시 non-null JSON 반환, `toolTypes: ["*"]`, description에 "best-effort" 포함 검증
    - **Validates: Requirements 6.1, 6.2**

  - [x] 1.8 훅 파일 고유성 property-based 테스트 작성 (`test/kiro-hook-schema.prop.test.mjs`)
    - **Property 6: 훅 파일 고유성** — 랜덤 개수의 훅 목록에 대해 `renderKiroShared()` outputs의 `relativePath`가 모두 고유한지 검증
    - **Validates: Requirements 7.1, 7.3**

- [x] 2. Checkpoint — 훅 렌더러 변경 검증
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Steering 렌더러 프론트매터 수정 (`kiro.mjs`)
  - [x] 3.1 `renderKiroFrontmatter()`에서 `name` 필드 출력을 제거한다
    - `if (fm.name !== undefined) lines.push(...)` 라인 삭제
    - _Requirements: 4.1_

  - [x] 3.2 `renderKiroWithDiagnostics()` 호출부에서 `name` 파라미터 전달을 제거한다
    - primary skill과 reference companion 모두에서 `name` 파라미터 제거
    - `inclusion`, `description`, `fileMatchPattern` 필드는 유지
    - _Requirements: 4.2, 4.3, 4.4_

  - [x] 3.3 Steering 프론트매터 property-based 테스트 작성 (`test/kiro-steering.prop.test.mjs`)
    - **Property 3: Steering 프론트매터 정합성** — 랜덤 SkillIR 입력에 대해 프론트매터에 `name:` 라인 부재, `inclusion:` 라인 존재, `auto` inclusion 시 `description:` 존재 검증
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [x] 3.4 짧은 description 경고 property-based 테스트 작성 (`test/kiro-steering.prop.test.mjs`)
    - **Property 4: 짧은 Description 경고** — description 30자 미만 SkillIR에 대해 `renderKiroWithDiagnostics()` warnings에 해당 스킬명과 글자 수 포함 경고 존재 검증
    - **Validates: Requirements 5.1, 5.2**

- [x] 4. Checkpoint — Steering 렌더러 변경 검증
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. 기존 테스트 스위트 갱신 (`test/install.test.mjs`)
  - [x] 5.1 Kiro 훅 스키마 검증 단위 테스트를 추가한다
    - `when.toolTypes`가 배열인지 검증
    - `version`이 semver 형식인지 검증
    - `enabled` 필드 부재 검증
    - `when.tool` 필드 부재 검증 (구 스키마 잔재 방지)
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 5.2 Kiro steering 프론트매터 검증 단위 테스트를 추가한다
    - 생성된 `.kiro/steering/*.md`의 프론트매터에 `name:` 필드 부재 확인
    - _Requirements: 8.5_

  - [x] 5.3 Trace-session best-effort 훅 생성 검증 단위 테스트를 추가한다
    - Skill 매처 훅이 스킵되지 않고 best-effort 출력 생성 확인
    - description에 "best-effort" 문자열 포함 확인
    - _Requirements: 6.1, 6.2_

- [x] 6. Checkpoint — 전체 테스트 스위트 검증
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. 문서 갱신
  - [x] 7.1 영문 문서 갱신 (`docs/multi-tool-install.md`)
    - Kiro 섹션의 생성 파일 목록에서 훅 파일 설명 갱신 (스키마 변경 반영)
    - Capability Matrix에서 trace 훅 상태를 `❌` → `△ best-effort`로 변경 (해당 행이 있다면)
    - Kiro 검증 절차에 새 스키마 필드 언급 추가
    - _Requirements: 9.1, 9.3_

  - [x] 7.2 한국어 문서 갱신 (`docs/multi-tool-install.ko.md`)
    - 영문 문서와 동일한 변경 사항을 한국어로 반영
    - Kiro 섹션 생성 파일 목록, 지원 표면 비교 테이블, 검증 절차 갱신
    - _Requirements: 9.2, 9.4_

- [x] 8. 최종 Checkpoint — 전체 빌드 및 테스트 통과 확인
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- `*` 표시된 태스크는 선택 사항이며 빠른 MVP를 위해 건너뛸 수 있습니다
- 각 태스크는 추적 가능성을 위해 구체적인 요구사항을 참조합니다
- Checkpoint는 점진적 검증을 보장합니다
- Property 테스트는 `fast-check` 라이브러리를 사용하며 `bun test`로 실행합니다
- 단위 테스트는 특정 예시와 엣지 케이스를 검증합니다
- 설계 문서의 "변경하지 않는 것" 목록 (types.mjs, cursor-shared.mjs, security.mjs, merge.mjs, manifest 로직)은 수정하지 않습니다
