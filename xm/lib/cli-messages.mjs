/**
 * cli-messages.mjs — bilingual (ko/en) message catalog + language resolver for
 * the xm config CLI. Zero-dependency ESM leaf (imports nothing) so it can be
 * pulled in by cli-prompts.mjs and shared-config.mjs without any import cycle.
 *
 * Language resolution priority (highest wins):
 *   1. --lang <ko|en>   (CLI flag,  passed as flagLang)
 *   2. XM_LANG           (env var)
 *   3. config `lang` key (passed as configLang)
 *   4. OS locale         (LC_ALL / LC_MESSAGES / LANG starting with `ko` → ko)
 *   5. `en`              (default when nothing else matches)
 *
 * Only user-facing strings live here. Machine-parsed output (the `get` stdout
 * value, JSON), key names, file paths, command examples (`xm config show`), and
 * enum values (developer/normal/…) are NEVER translated — the caller keeps those
 * as literals. Interpolated messages are functions `(…args) => string`.
 */

const SUPPORTED = new Set(['ko', 'en']);

// Module-level resolved language. Defaults to 'en' until initLang() runs.
let _lang = 'en';

/**
 * Resolve the effective language from the override chain. Pure — reads env at
 * call time but never mutates module state.
 * @param {{flagLang?: string, configLang?: string}} [opts]
 * @returns {'ko'|'en'}
 */
export function resolveLang({ flagLang, configLang } = {}) {
  if (SUPPORTED.has(flagLang)) return flagLang;
  const env = process.env.XM_LANG;
  if (SUPPORTED.has(env)) return env;
  if (SUPPORTED.has(configLang)) return configLang;
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  if (/^ko/i.test(locale)) return 'ko';
  return 'en';
}

/**
 * Resolve the language via the override chain and store it as module state.
 * Call once at CLI entry (before rendering any user-facing string).
 * @param {{flagLang?: string, configLang?: string}} [opts]
 * @returns {'ko'|'en'} the resolved language
 */
export function initLang(opts = {}) {
  _lang = resolveLang(opts);
  return _lang;
}

/** Current resolved language ('ko' | 'en'). */
export function getLang() {
  return _lang;
}

/**
 * Look up a catalog message for the current language. Functions are called with
 * the trailing args (for interpolation); plain strings ignore them. Falls back
 * to en, then ko, then the raw key (so a missing key is visible, not silent).
 * @param {string} key
 * @param {...any} args
 * @returns {string}
 */
export function t(key, ...args) {
  const entry = MESSAGES[key];
  if (entry === undefined) return key;
  const val = entry[_lang] ?? entry.en ?? entry.ko;
  return typeof val === 'function' ? val(...args) : val;
}

// ── Catalog ─────────────────────────────────────────────────────────────
//
// Korean values are the EXACT strings the CLI shipped before i18n (the config
// test suite asserts them, run under XM_LANG=ko). English values follow
// PRODUCT.md tone — calm, precise, guiding; no marketing voice.

const MESSAGES = {
  // ── common (shared across categories) ──
  'common.xm_config': { ko: 'xm 설정', en: 'xm config' },
  'common.back': { ko: '뒤로', en: 'Back' },
  'common.exit': { ko: '나가기', en: 'Exit' },
  'common.keep_current': { ko: '현재값 유지', en: 'Keep current' },
  'common.no_change': { ko: '변경 없음', en: 'No change' },
  'common.current': { ko: '현재:', en: 'Current:' },
  'common.none': { ko: '(없음)', en: '(none)' },
  'common.unset': { ko: '(미설정)', en: '(unset)' },
  'common.cancelled_nosave': { ko: '취소됨 — 저장하지 않음', en: 'Cancelled — not saved' },
  'common.deleted_marker': { ko: '(삭제)', en: '(deleted)' },
  'common.save_target': {
    ko: (path, label) => `저장 대상: ${path} (${label})`,
    en: (path, label) => `Save target: ${path} (${label})`,
  },
  'common.max_attempts': {
    ko: '3회 입력 실패 — 항목을 취소하고 메뉴로 돌아갑니다',
    en: '3 failed attempts — cancelling the item and returning to the menu',
  },
  'common.retry_generic': {
    ko: (n) => `(${n}/3) 다시 입력하세요`,
    en: (n) => `(${n}/3) try again`,
  },
  'common.retry_check_allowed': {
    ko: (n) => `(${n}/3) 허용값을 확인하고 다시 입력하세요`,
    en: (n) => `(${n}/3) check the allowed values and try again`,
  },
  'common.enter_range': {
    ko: (r) => `${r}을 입력하세요`,
    en: (r) => `Enter ${r}`,
  },

  // ── counts (pluralizable value summaries) ──
  'count.roles': { ko: (n) => `${n}개 역할`, en: (n) => `${n} role(s)` },
  'count.projects': { ko: (n) => `${n}개 프로젝트`, en: (n) => `${n} project(s)` },
  'count.items': { ko: (n) => `${n}개`, en: (n) => `${n} item(s)` },

  // ── prompts ──
  'prompt.select': { ko: '선택: ', en: 'Select: ' },
  'prompt.select_enum': {
    ko: (opts) => `  선택 [${opts}, Enter=유지]: `,
    en: (opts) => `  Select [${opts}, Enter=keep]: `,
  },
  'prompt.enter_value_suffix': {
    ko: (suffix) => `  값 입력${suffix} [Enter=유지]: `,
    en: (suffix) => `  Enter value${suffix} [Enter=keep]: `,
  },
  'prompt.bool_toggle': {
    ko: '  값 [1) true  2) false, Enter=유지]: ',
    en: '  Value [1) true  2) false, Enter=keep]: ',
  },
  'prompt.bool_labeled': {
    ko: (label) => `  ${label} [1) true  2) false, Enter=유지]: `,
    en: (label) => `  ${label} [1) true  2) false, Enter=keep]: `,
  },

  // ── frontmatter sync (best-effort notices) ──
  'fm.skip_xmroot': {
    ko: 'frontmatter 동기화 건너뜀 (XM_ROOT 격리 환경)',
    en: 'frontmatter sync skipped (XM_ROOT isolated env)',
  },
  'fm.tool_not_found': {
    ko: 'frontmatter sync 도구를 찾지 못함 — 수동 실행: node xm/lib/skill-frontmatter-sync.mjs',
    en: 'frontmatter sync tool not found — run manually: node xm/lib/skill-frontmatter-sync.mjs',
  },
  'fm.sync_done': {
    ko: 'SKILL frontmatter 동기화 완료',
    en: 'SKILL frontmatter sync complete',
  },
  'fm.sync_failed': {
    ko: (status) => `frontmatter 동기화 실패 (exit ${status}) — 수동 실행 권장`,
    en: (status) => `frontmatter sync failed (exit ${status}) — manual run recommended`,
  },
  'fm.skip_err': {
    ko: (msg) => `frontmatter 동기화 건너뜀: ${msg}`,
    en: (msg) => `frontmatter sync skipped: ${msg}`,
  },

  // ── phase (expandPhaseAssignments + matrix) ──
  'phase.unknown': {
    ko: (slot) => `알 수 없는 phase: "${slot}" — plan, implement, review 중 선택`,
    en: (slot) => `unknown phase: "${slot}" — choose plan, implement, or review`,
  },
  'phase.model_choice': {
    ko: (a) => `모델: haiku, sonnet, opus, default 중 선택 ("${a}")`,
    en: (a) => `model: choose haiku, sonnet, opus, or default ("${a}")`,
  },
  'phase.label.plan': { ko: '설계 (plan)', en: 'plan' },
  'phase.label.implement': { ko: '구현 (implement)', en: 'implement' },
  'phase.label.review': { ko: '리뷰 (review)', en: 'review' },
  'phase.short.plan': { ko: '설계', en: 'plan' },
  'phase.short.implement': { ko: '구현', en: 'implement' },
  'phase.short.review': { ko: '리뷰', en: 'review' },
  'phase.matrix_title': { ko: '페이즈별 모델', en: 'Phase models' },
  'phase.hint_set': {
    ko: '설정: xm config phase plan=opus implement=sonnet review=opus',
    en: 'Set: xm config phase plan=opus implement=sonnet review=opus',
  },
  'phase.hint_restore': {
    ko: '복원: xm config phase <slot>=default  (프로필 기본값으로)',
    en: 'Restore: xm config phase <slot>=default  (back to profile default)',
  },
  'phase.profile_default': { ko: '프로필 기본값', en: 'profile default' },
  'phase.model_prompt': {
    ko: (label) => `  ${label} 모델 [1) 프로필 기본값 2) haiku 3) sonnet 4) opus, Enter=유지]: `,
    en: (label) => `  ${label} model [1) profile default 2) haiku 3) sonnet 4) opus, Enter=keep]: `,
  },
  'phase.enter_1_4': { ko: '1-4 또는 Enter를 입력하세요', en: 'Enter 1-4 or Enter' },

  // ── cmdConfig dispatch ──
  'cmd.unknown': {
    ko: (sub) => `알 수 없는 config 명령: ${sub}`,
    en: (sub) => `Unknown config command: ${sub}`,
  },

  // ── show ──
  'show.none_default': { ko: '(설정 없음 — 기본값 사용)', en: '(no settings — using defaults)' },
  'show.none': { ko: '(설정 없음)', en: '(no settings)' },

  // ── reset ──
  'reset.done': { ko: '설정 초기화 완료', en: 'Config reset complete' },

  // ── schema type errors (validateSet detail) ──
  'type.null_not_allowed': {
    ko: (type) => `null은 허용되지 않습니다 (기대: ${type})`,
    en: (type) => `null is not allowed (expected: ${type})`,
  },
  'type.expected_integer': {
    ko: (a) => `정수를 기대했지만 ${a} 입력됨`,
    en: (a) => `expected integer but got ${a}`,
  },
  'type.expected_number': {
    ko: (a) => `숫자를 기대했지만 ${a} 입력됨`,
    en: (a) => `expected number but got ${a}`,
  },
  'type.expected_boolean': {
    ko: (a) => `boolean을 기대했지만 ${a} 입력됨`,
    en: (a) => `expected boolean but got ${a}`,
  },
  'type.expected_string': {
    ko: (a) => `문자열을 기대했지만 ${a} 입력됨`,
    en: (a) => `expected string but got ${a}`,
  },
  'type.expected_array': {
    ko: (a) => `배열을 기대했지만 ${a} 입력됨`,
    en: (a) => `expected array but got ${a}`,
  },
  'type.expected_object': {
    ko: (a) => `객체를 기대했지만 ${a} 입력됨`,
    en: (a) => `expected object but got ${a}`,
  },

  // ── schema validation warnings ──
  'validate.unregistered': {
    ko: (key) => `미등록 키 '${key}' — config-schema 레지스트리에 없습니다. 저장은 되지만 런타임에서 소비되지 않을 수 있습니다.`,
    en: (key) => `unregistered key '${key}' — not in the config-schema registry. It will be saved but may not be consumed at runtime.`,
  },
  'validate.enum': {
    ko: (key, allowed, value) => `'${key}' 허용값: ${allowed} — 입력값 '${value}'은(는) 목록에 없습니다.`,
    en: (key, allowed, value) => `'${key}' allowed values: ${allowed} — input '${value}' is not in the list.`,
  },
  'validate.type': {
    ko: (key, err) => `'${key}' 타입 불일치: ${err}`,
    en: (key, err) => `'${key}' type mismatch: ${err}`,
  },
  'validate.min': {
    ko: (key, min, value) => `'${key}' 최솟값 ${min} 미만 (입력: ${value})`,
    en: (key, min, value) => `'${key}' below minimum ${min} (input: ${value})`,
  },
  'validate.max': {
    ko: (key, max, value) => `'${key}' 최댓값 ${max} 초과 (입력: ${value})`,
    en: (key, max, value) => `'${key}' above maximum ${max} (input: ${value})`,
  },

  // ── non-TTY guard ──
  'guard.tty_only': {
    ko: '— 대화형 위저드는 TTY에서만 실행됩니다',
    en: '— the interactive wizard runs only in a TTY',
  },
  'guard.use_subcommands': {
    ko: '비대화형(파이프·리다이렉트) 환경에서는 서브커맨드를 사용하세요:',
    en: 'In a non-interactive (pipe/redirect) environment, use a subcommand:',
  },
  'guard.desc_show': { ko: '현재 설정 표시', en: 'show current config' },
  'guard.desc_get': { ko: '값 조회', en: 'get a value' },
  'guard.desc_set': { ko: '값 설정', en: 'set a value' },
  'guard.desc_phase': { ko: '페이즈별 모델 지정', en: 'assign models per phase' },

  // ── scope selection ──
  'scope.choose_title': {
    ko: (key) => `저장 위치 — ${key}`,
    en: (key) => `Save location — ${key}`,
  },
  'scope.local_hint': { ko: '.xm/config.json (프로젝트)', en: '.xm/config.json (project)' },
  'scope.line_prompt': {
    ko: (label) => `  저장 위치 [1) global (~/.xm)  2) local (.xm), Enter=${label}]: `,
    en: (label) => `  Save location [1) global (~/.xm)  2) local (.xm), Enter=${label}]: `,
  },
  'scope.using_proposed': {
    ko: (label) => `제안 스코프 사용: ${label}`,
    en: (label) => `Using proposed scope: ${label}`,
  },

  // ── shadow warnings (2-tier) ──
  'shadow.local_override': {
    ko: (top) => `local이 '${top}' 키를 override 중 — 이 변경은 effective 값에 반영되지 않습니다.`,
    en: (top) => `local overrides the '${top}' key — this change will not affect the effective value.`,
  },
  'shadow.confirm_global': {
    ko: '  그래도 global에 저장할까요? [y/N]: ',
    en: '  Save to global anyway? [y/N]: ',
  },
  'shadow.local_wins': {
    ko: (top) => `local 값이 global '${top}'을(를) override합니다 (effective=local).`,
    en: (top) => `local overrides global '${top}' (effective=local).`,
  },

  // ── category: model ──
  'cat.model.title': { ko: '모델 설정', en: 'Model settings' },
  'cat.model.profile': { ko: '모델 프로필', en: 'Model profile' },
  'cat.model.overrides': { ko: '역할별 오버라이드', en: 'Per-role overrides' },
  'cat.model.phase': { ko: '페이즈별 모델', en: 'Phase models' },
  'overrides.header': {
    ko: '역할별 모델 오버라이드 (프로필 위에 적용):',
    en: 'Per-role model overrides (applied on top of the profile):',
  },
  'overrides.profile_default_paren': { ko: '(프로필 기본)', en: '(profile default)' },
  'overrides.format': {
    ko: '형식: role=model (예: architect=opus)  ·  clear=초기화  ·  Enter=끝',
    en: 'Format: role=model (e.g. architect=opus)  ·  clear=reset  ·  Enter=done',
  },
  'overrides.cleared': { ko: '오버라이드 초기화', en: 'Overrides reset' },
  'overrides.unknown_role': {
    ko: (role) => `알 수 없는 역할: ${role}`,
    en: (role) => `Unknown role: ${role}`,
  },
  'overrides.model_choice': {
    ko: '모델: haiku, sonnet, opus 중 선택',
    en: 'Model: choose haiku, sonnet, or opus',
  },

  // ── category: execution ──
  'cat.exec.title': { ko: '실행 설정', en: 'Execution settings' },

  // ── category: budget ──
  'budget.hint_zero_unlimited': { ko: ' (0 또는 null=무제한)', en: ' (0 or null=unlimited)' },
  'budget.hint_null_unset': { ko: ' (null=미설정)', en: ' (null=unset)' },
  'budget.enter_num_or_null': { ko: '숫자 또는 null을 입력하세요', en: 'Enter a number or null' },
  'budget.projects_header': {
    ko: '프로젝트별 예산 상한 { project: { max_usd } }:',
    en: 'Per-project budget cap { project: { max_usd } }:',
  },
  'budget.projects_format': {
    ko: '형식: name=max_usd (예: my-app=5)  ·  del <name> (삭제)  ·  Enter=끝',
    en: 'Format: name=max_usd (e.g. my-app=5)  ·  del <name> (delete)  ·  Enter=done',
  },
  'budget.no_such_project': {
    ko: (name) => `없는 프로젝트: ${name}`,
    en: (name) => `No such project: ${name}`,
  },
  'budget.deleted': {
    ko: (name) => `${name} 삭제`,
    en: (name) => `${name} deleted`,
  },
  'budget.projects_format_short': {
    ko: '형식: name=max_usd 또는 del <name>',
    en: 'Format: name=max_usd or del <name>',
  },
  'budget.max_usd_nonneg': {
    ko: 'max_usd는 0 이상 숫자여야 합니다',
    en: 'max_usd must be a number ≥ 0',
  },
  'cat.budget.title': {
    ko: '예산 설정 (기본 스코프: local)',
    en: 'Budget settings (default scope: local)',
  },
  'cat.budget.max_usd': { ko: '세션 최대 비용(USD)', en: 'Session max cost (USD)' },
  'cat.budget.window': { ko: '추적 윈도우(시간)', en: 'Tracking window (hours)' },
  'cat.budget.projects': { ko: '프로젝트별 예산', en: 'Per-project budget' },

  // ── category: gates ──
  'cat.gates.title': {
    ko: '게이트 설정 (auto / human-verify / quality)',
    en: 'Gate settings (auto / human-verify / quality)',
  },

  // ── category: worktree ──
  'worktree.title': { ko: 'worktree 설정', en: 'worktree settings' },
  'worktree.priority': {
    ko: '(우선순위: build-local > shared > global > defaults)',
    en: '(priority: build-local > shared > global > defaults)',
  },
  'worktree.xmroot_note': {
    ko: '(XM_ROOT: shared·global은 단일 파일로 합쳐집니다)',
    en: '(XM_ROOT: shared·global collapse into a single file)',
  },
  'worktree.gate_policy_merge': {
    ko: 'gate_policy (per-key 병합):',
    en: 'gate_policy (per-key merge):',
  },
  'worktree.gate_phase_enum': {
    ko: (phases, value) => `'worktree.gate_phase' 허용값: ${phases} — 입력값 '${value}'은(는) 목록에 없습니다.`,
    en: (phases, value) => `'worktree.gate_phase' allowed values: ${phases} — input '${value}' is not in the list.`,
  },
  'worktree.null_hint': { ko: ' (null=무제한)', en: ' (null=unlimited)' },
  'worktree.tier_title': { ko: '저장 위치 (tier)', en: 'Save location (tier)' },
  'worktree.tier_prompt': {
    ko: '  저장 위치 [1) build-local (.xm/build)  2) shared (.xm)  3) global (~/.xm), Enter=1]: ',
    en: '  Save location [1) build-local (.xm/build)  2) shared (.xm)  3) global (~/.xm), Enter=1]: ',
  },
  'worktree.tier_override': {
    ko: (label, keyPath) => `${label} tier가 'worktree.${keyPath}'를 override 중 — 이 변경은 effective 값에 반영되지 않습니다.`,
    en: (label, keyPath) => `the ${label} tier overrides 'worktree.${keyPath}' — this change will not affect the effective value.`,
  },
  'worktree.confirm_tier': {
    ko: (tier) => `  그래도 ${tier}에 저장할까요? [y/N]: `,
    en: (tier) => `  Save to ${tier} anyway? [y/N]: `,
  },
  'worktree.cancel_tier': {
    ko: '취소됨 — 1-3 중에서 선택하세요',
    en: 'Cancelled — choose 1-3',
  },
  'worktree.gate_policy_hint': { ko: 'per-key 병합 편집', en: 'per-key merge edit' },
  'cat.worktree.title': {
    ko: '편집할 worktree 키를 선택하세요',
    en: 'Choose a worktree key to edit',
  },

  // ── severity array editor ──
  'sev.title_suffix': { ko: '— 차단할 severity 선택', en: '— choose severity to block' },
  'sev.hint': {
    ko: '번호를 공백/쉼표로 나열 (예: 1 2 3), none=빈 목록, Enter=유지',
    en: 'List numbers separated by space/comma (e.g. 1 2 3), none=empty list, Enter=keep',
  },
  'sev.enter_valid': {
    ko: '1-4 번호 또는 severity 이름(critical/high/medium/low)을 입력하세요',
    en: 'Enter a number 1-4 or a severity name (critical/high/medium/low)',
  },

  // ── boolean toggle ──
  'bool.enter_valid': {
    ko: '1(true) 또는 2(false)를 입력하세요',
    en: 'Enter 1 (true) or 2 (false)',
  },

  // ── gate_policy submenu ──
  'gp.title': { ko: 'gate_policy (severity 정책)', en: 'gate_policy (severity policy)' },
  'gp.merge_note': {
    ko: 'per-key 병합: 한 항목만 저장해도 나머지 severity 목록은 tier 병합으로 유지됩니다 (전량 교체 아님).',
    en: 'per-key merge: saving one item keeps the other severity lists via tier merge (not a wholesale replace).',
  },

  // ── scan_roots editor ──
  'scan.header': {
    ko: '대시보드 프로젝트 스캔 루트 (경로 배열)',
    en: 'Dashboard project scan roots (path array)',
  },
  'scan.current_effective': { ko: '현재(effective):', en: 'Current (effective):' },
  'scan.format': {
    ko: '형식: 경로 입력(추가)  ·  del <번호> (삭제)  ·  Enter=끝',
    en: 'Format: enter a path (add)  ·  del <number> (delete)  ·  Enter=done',
  },
  'scan.empty': { ko: '(비어있음)', en: '(empty)' },
  'scan.enter_range': {
    ko: (len) => `1-${len} 범위의 번호를 입력하세요`,
    en: (len) => `Enter a number in range 1-${len}`,
  },
  'scan.deleted': {
    ko: (x) => `삭제: ${x}`,
    en: (x) => `Deleted: ${x}`,
  },
  'scan.already': {
    ko: (x) => `이미 있음: ${x}`,
    en: (x) => `Already present: ${x}`,
  },
  'scan.added': {
    ko: (x) => `추가: ${x}`,
    en: (x) => `Added: ${x}`,
  },

  // ── pipelines editor ──
  'pipe.header': { ko: '파이프라인 정의 (JSON 객체)', en: 'Pipeline definitions (JSON object)' },
  'pipe.hint': {
    ko: '예: {"review":["x-review","x-eval"]}  ·  {} = 초기화  ·  Enter=유지',
    en: 'e.g. {"review":["x-review","x-eval"]}  ·  {} = reset  ·  Enter=keep',
  },
  'pipe.prompt': { ko: '  JSON 입력 [Enter=유지]: ', en: '  Enter JSON [Enter=keep]: ' },
  'pipe.parse_failed': {
    ko: (msg) => `JSON 파싱 실패: ${msg}`,
    en: (msg) => `JSON parse failed: ${msg}`,
  },
  'pipe.retry_valid_object': {
    ko: (n) => `(${n}/3) 올바른 JSON 객체를 입력하세요`,
    en: (n) => `(${n}/3) enter a valid JSON object`,
  },
  'pipe.must_object': {
    ko: 'pipelines는 JSON 객체여야 합니다 (예: {"name":[...]})',
    en: 'pipelines must be a JSON object (e.g. {"name":[...]})',
  },

  // ── category: misc ──
  'cat.misc.title': { ko: '기타 설정', en: 'Other settings' },
  'cat.misc.mode': { ko: '출력 모드(mode)', en: 'Output mode (mode)' },
  'cat.misc.drift': { ko: 'drift 임계값(0-1)', en: 'drift threshold (0-1)' },
  'cat.misc.scan': { ko: '스캔 루트(scan_roots)', en: 'Scan roots (scan_roots)' },
  'cat.misc.pipe': { ko: '파이프라인(pipelines)', en: 'Pipelines (pipelines)' },
  'cat.misc.lang': { ko: '출력 언어(lang)', en: 'Output language (lang)' },

  // ── category: panel (cross-vendor providers — editable) ──
  //
  // Edited from BOTH this wizard and `xm panel setup`. models/judge are delegated
  // to setup (panel owns their validation); timeout_s and model_overrides are
  // direct config writes. panel's own merge is per-key project(.xm) > global(~/.xm),
  // which differs from shared-config's wholesale top-level replacement — surfaced
  // via panel.merge_note before any edit.
  'cat.panel.title': {
    ko: 'panel (cross-vendor 프로바이더)',
    en: 'panel (cross-vendor providers)',
  },
  'cat.panel.models': { ko: '모델 목록 (models)', en: 'Models (models)' },
  'cat.panel.judge': { ko: '판정기 (judge)', en: 'Judge (judge)' },
  'cat.panel.timeout': { ko: '타임아웃 (timeout_s)', en: 'Timeout (timeout_s)' },
  'cat.panel.overrides': { ko: '모델 오버라이드 (model_overrides)', en: 'Model overrides (model_overrides)' },
  'panel.rule_default': { ko: 'rule (기본)', en: 'rule (default)' },
  'panel.merge_note': {
    ko: 'panel 병합: project(.xm) > global(~/.xm) — 키 단위 병합 (shared-config의 최상위 통째 교체와 다름)',
    en: 'panel merge: project(.xm) > global(~/.xm) — per-key (differs from shared-config wholesale top-level replace)',
  },
  'panel.detected_providers': {
    ko: (list) => `PATH에서 감지된 프로바이더: ${list}`,
    en: (list) => `providers detected on PATH: ${list}`,
  },
  'panel.none_detected': { ko: 'PATH에서 감지된 프로바이더 없음', en: 'no providers detected on PATH' },
  'panel.detect_unavailable': { ko: '(프로바이더 감지 불가)', en: '(provider detection unavailable)' },
  // models / judge → delegated to `xm panel setup`
  'panel.delegate_note': {
    ko: 'models/judge는 xm panel setup에 위임됩니다 (검증 로직 중복 방지)',
    en: 'models/judge are delegated to xm panel setup (validation not duplicated here)',
  },
  'panel.models_format': {
    ko: '형식: claude,codex,agy 또는 cursor:kimi-k2.5 (쉼표 구분)  ·  Enter=취소',
    en: 'Format: claude,codex,agy or cursor:kimi-k2.5 (comma-separated)  ·  Enter=cancel',
  },
  'panel.judge_format': {
    ko: "형식: 판정기 값 (현재 유효값은 'rule' 하나)  ·  Enter=취소",
    en: "Format: judge value (only 'rule' is currently valid)  ·  Enter=cancel",
  },
  'panel.judge_confirm_nonrule': {
    ko: (v) => `'${v}'은(는) 알려진 판정기가 아닙니다 (유효: rule). 계속할까요? (y/N): `,
    en: (v) => `'${v}' is not a known judge (valid: rule). Continue? (y/N): `,
  },
  'panel.setup_failed': {
    ko: (code) => `xm panel setup 실패 (exit ${code}) — 저장되지 않았습니다`,
    en: (code) => `xm panel setup failed (exit ${code}) — not saved`,
  },
  'panel.setup_not_found': {
    ko: 'xm panel setup을 실행할 수 없습니다 (xm 미설치 및 x-panel-cli.mjs 미발견)',
    en: 'cannot run xm panel setup (xm not on PATH and x-panel-cli.mjs not found)',
  },
  'panel.via_setup': { ko: 'xm panel setup 경유', en: 'via xm panel setup' },
  // model_overrides → direct row-by-row write
  'panel.overrides_header': {
    ko: 'panel 모델 오버라이드 { vendor: model } — --models의 bare 이름이 이 모델로 해석됩니다:',
    en: 'panel model overrides { vendor: model } — bare names in --models resolve to this model:',
  },
  'panel.overrides_format': {
    ko: '형식: vendor=full-model-id (예: cursor=kimi-k2.5)  ·  del <vendor> (삭제)  ·  Enter=끝',
    en: 'Format: vendor=full-model-id (e.g. cursor=kimi-k2.5)  ·  del <vendor> (delete)  ·  Enter=done',
  },
  'panel.overrides_format_short': {
    ko: '형식: vendor=full-model-id 또는 del <vendor>',
    en: 'Format: vendor=full-model-id or del <vendor>',
  },

  // ── category: vendor (harness tier→model mapping) ──
  //
  // Consumed by the wizard's vendor mapping menu (t4). Two axes live here:
  // vendor_models (tier→model spec) and vendor_profiles (per-vendor profile).
  // The builtin tier→model defaults are owned by cost-engine's VENDOR_MODELS; the
  // wizard edits only user overrides. Tier keys (haiku/sonnet/opus) are shown with
  // their display labels (light/standard/max) so users don't read them as literal
  // Claude model names.
  'cat.vendor.title': {
    ko: 'vendor 모델 매핑 (harness별 tier→모델)',
    en: 'Vendor model mapping (per-harness tier→model)',
  },
  'vendor.header': {
    ko: 'harness(vendor)별 tier→모델 매핑 — 기본 매핑 위에 오버라이드를 얹습니다',
    en: 'Per-harness (vendor) tier→model mapping — overrides layered on the built-in table',
  },
  // detection state (per vendor row)
  'vendor.detected': {
    ko: (name) => `${name}: 감지됨`,
    en: (name) => `${name}: detected`,
  },
  'vendor.not_detected': {
    ko: (name) => `${name}: 미감지`,
    en: (name) => `${name}: not detected`,
  },
  'vendor.using_builtin': { ko: '기본 매핑', en: 'built-in mapping' },
  'vendor.user_mapping': { ko: '사용자 매핑', en: 'user mapping' },
  // tier labels — canonical tier + display label (light/standard/max) together
  'vendor.tier.haiku': { ko: 'haiku (light)', en: 'haiku (light)' },
  'vendor.tier.sonnet': { ko: 'sonnet (standard)', en: 'sonnet (standard)' },
  'vendor.tier.opus': { ko: 'opus (max)', en: 'opus (max)' },
  // model spec entry
  'vendor.format': {
    ko: '형식: vendor.tier=model[:effort] (예: codex.opus=gpt-5.5:high)  ·  clear=초기화  ·  Enter=끝',
    en: 'Format: vendor.tier=model[:effort] (e.g. codex.opus=gpt-5.5:high)  ·  clear=reset  ·  Enter=done',
  },
  'vendor.cleared': { ko: 'vendor 매핑 초기화', en: 'Vendor mapping reset' },
  // effort suffix — mirrors cost-engine parseModelSpec (MODEL_EFFORT_LEVELS)
  'vendor.effort_hint': {
    ko: (levels) => ` (effort 접미사 허용값: ${levels})`,
    en: (levels) => ` (effort suffix allowed: ${levels})`,
  },
  'vendor.effort_unknown': {
    ko: (effort, levels) => `알 수 없는 effort '${effort}' — 허용값: ${levels} (매핑은 저장되지만 effort는 무시됩니다)`,
    en: (effort, levels) => `unknown effort '${effort}' — allowed: ${levels} (mapping saved but effort ignored)`,
  },
  // vendor_profiles (per-vendor profile override)
  'vendor.profile_header': {
    ko: 'vendor별 프로필 오버라이드 { vendor: economy|default|max }:',
    en: 'Per-vendor profile override { vendor: economy|default|max }:',
  },
  'vendor.profile_inherit': {
    ko: '(미설정=model_profile 상속)',
    en: '(unset = inherits model_profile)',
  },
  'vendor.profile_format': {
    ko: '형식: vendor=economy|default|max (예: codex=economy)  ·  del <vendor> (삭제)  ·  Enter=끝',
    en: 'Format: vendor=economy|default|max (e.g. codex=economy)  ·  del <vendor> (delete)  ·  Enter=done',
  },

  // ── main menu ──
  'menu.model': { ko: '모델', en: 'Model' },
  'menu.model_hint': {
    ko: '프로필 · 역할 오버라이드 · 페이즈별 모델',
    en: 'profile · role overrides · phase models',
  },
  'menu.budget': { ko: '예산', en: 'Budget' },
  'menu.budget_hint': { ko: '세션/프로젝트 비용 상한', en: 'session/project cost cap' },
  'menu.exec': { ko: '실행', en: 'Execution' },
  'menu.exec_hint': { ko: '병렬 에이전트 수', en: 'parallel agent count' },
  'menu.gates': { ko: '게이트', en: 'Gates' },
  'menu.gates_hint': { ko: '페이즈 종료 게이트', en: 'phase-exit gates' },
  'menu.worktree_hint': {
    ko: '병렬 worktree 실행 (build-local 3-tier)',
    en: 'parallel worktree execution (build-local 3-tier)',
  },
  'menu.misc': { ko: '기타', en: 'Other' },
  'menu.vendor': { ko: 'vendor 모델 매핑', en: 'Vendor model mapping' },
  'menu.vendor_hint': {
    ko: 'harness별 tier→모델 매핑 · 프로필',
    en: 'per-harness tier→model mapping · profiles',
  },
  'menu.panel_hint': {
    ko: 'cross-vendor 프로바이더 (models/judge·timeout·overrides)',
    en: 'cross-vendor providers (models/judge · timeout · overrides)',
  },

  // ── session summary + wizard chrome ──
  'summary.title': { ko: '설정 요약', en: 'Config summary' },
  'summary.no_items': { ko: '변경된 항목 없음', en: 'No items changed' },
  'summary.saved_count': {
    ko: (n) => `— ${n}개 항목 저장됨`,
    en: (n) => `— ${n} item(s) saved`,
  },
  'summary.done': { ko: '완료', en: 'Done' },
  'wizard.subtitle': {
    ko: 'Esc/q 뒤로 · Ctrl-C 종료(저장된 항목 유지)',
    en: 'Esc/q back · Ctrl-C exit (saved items kept)',
  },
  'wizard.main_title': { ko: '설정할 항목을 선택하세요', en: 'Choose a setting to configure' },
  'wizard.hdr_profile': { ko: '모델 프로필:', en: 'Model profile:' },
  'wizard.hdr_agents': { ko: '에이전트 수:', en: 'Agent count:' },
  'wizard.eof': {
    ko: '입력 종료 (EOF/중단) — 저장된 항목은 유지됩니다',
    en: 'Input ended (EOF/abort) — saved items are kept',
  },
};
