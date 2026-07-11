/**
 * config-schema.mjs — Central registry of every real-consumed xm config key.
 *
 * Single source of truth for `key → { type, enum?, scope, description, default,
 * owner? }`. Consumed by shared-config.mjs (`resolveScope` → `scopeForKey`) and,
 * going forward, by the CLI wizard and the dashboard config editor, so a new key
 * is declared once here instead of in four scattered readers (shared-config
 * DEFAULT_CONFIG, default-config.json, worktree-shared WORKTREE_CONFIG_DEFAULTS,
 * and the dashboard's implicit key knowledge).
 *
 * Scope semantics (write-target default when the user gives no --local/--global):
 *   'local'       → project `.xm/config.json`
 *   'global'      → `~/.xm/config.json`
 *   'either'      → valid in both layers; defaults to global for writes
 *   'build-local' → resolved from `.xm/build/config.json` (worktree 3-tier); NOT
 *                   written through the shared local/global resolver. The shared
 *                   `resolveScope` treats build-local like global (its historical
 *                   behavior); the worktree category owns real 3-tier writes.
 *
 * `owner` marks a key managed by another plugin's dedicated tooling (panel.* →
 * x-panel). Registered here for discovery only; `xm config` must not edit it.
 *
 * `group` is display/grouping metadata (wizard sections, dashboard categories),
 * one of: 'model' | 'vendor' | 'cross_vendor' | 'budget' | 'gates' | 'worktree'
 * | 'misc' | 'panel'. Every entry must set it; it has no effect on resolution.
 *
 * Dead keys (workflow, granularity, execution.*, discussion.*, research.*) are
 * intentionally NOT registered — they have no runtime consumer and are being
 * removed from default-config.json.
 *
 * Zero runtime dependencies. Pure ESM leaf module (imports nothing) so it can be
 * imported by shared-config.mjs without reintroducing an import cycle.
 */

// ── scope vocabulary ──────────────────────────────────────────────────
export const SCOPE_VALUES = ['local', 'global', 'either', 'build-local'];

// ── registry ──────────────────────────────────────────────────────────
//
// worktree.* defaults mirror WORKTREE_CONFIG_DEFAULTS (worktree-shared.mjs).
// That module stays the RUNTIME source of truth for worktree resolution; the
// values here are display/validation metadata. Kept as literals (not imported)
// to keep this module a zero-import leaf — see header. If WORKTREE_CONFIG_DEFAULTS
// changes, update the mirrored entries below.

export const SCHEMA = [
  // ── model / execution ──
  {
    key: 'mode',
    group: 'model',
    type: 'string',
    enum: ['developer', 'normal'],
    scope: 'global',
    default: 'developer',
    description: '출력 상세도 모드 — developer(기술 용어·간결) / normal(쉬운 한국어)',
  },
  {
    key: 'agent_max_count',
    group: 'model',
    type: 'integer',
    scope: 'global',
    default: 4,
    min: 1,
    max: 10,
    description: '병렬 에이전트 최대 개수 (1-10)',
  },
  {
    key: 'lang',
    group: 'model',
    type: 'string',
    enum: ['ko', 'en'],
    scope: 'global',
    nullable: true,
    default: null,
    description: 'CLI 출력 언어 (미설정=locale 자동 감지, 기본 en)',
  },
  {
    key: 'model_profile',
    group: 'model',
    type: 'string',
    enum: ['economy', 'default', 'max'],
    scope: 'global',
    default: 'default',
    description: '비용 프로필 — economy(절약) / default(균형) / max(품질 최우선)',
  },
  {
    key: 'model_overrides',
    group: 'model',
    type: 'object',
    scope: 'global',
    default: {},
    description: '역할별 모델 오버라이드 { role: model }',
  },

  // ── vendor (harness) model mapping ──
  //
  // vendor_models is NOT a literal mirror of cost-engine's VENDOR_MODELS. The
  // builtin tier→model table (claude/codex defaults) is OWNED by cost-engine.mjs
  // (VENDOR_MODELS); this key's default is an EMPTY object. It carries only USER
  // overrides, which resolveVendorModel layers on top of the builtin table via
  // cfg.vendor_models[vendor][tier]. If the builtin defaults change, edit
  // cost-engine.mjs — never hardcode them here.
  {
    key: 'vendor_models',
    group: 'vendor',
    type: 'object',
    scope: 'global',
    default: {},
    description: 'harness(vendor)별 tier(haiku/sonnet/opus)→모델 매핑 { vendor: { tier: model[:effort] } } — model_overrides(role→tier)·panel.*(패널 프리셋)와 다른 축',
  },
  {
    key: 'vendor_profiles',
    group: 'vendor',
    type: 'object',
    scope: 'global',
    default: {},
    description: 'vendor별 프로필 오버라이드 { vendor: economy|default|max } (미설정=model_profile 상속)',
  },

  // ── cross-vendor defaults (consumer opt-in fallback chain) ──
  //
  // Resolution per consumer: CLI flag (--cross-vendor / --no-cross-vendor)
  // → cross_vendor.<consumer> → cross_vendor.default → false. Keys are
  // nullable booleans: null = "fall through to the next link", so a user can
  // set cross_vendor.default=true once and exempt a single consumer with
  // cross_vendor.eval=false. Consumers: x-build consensus / x-op strategies /
  // x-eval judges / x-review lenses / x-solver cross-check / x-agent fan-out.
  {
    key: 'cross_vendor.default',
    group: 'cross_vendor',
    type: 'boolean',
    nullable: true,
    scope: 'either',
    default: null,
    description: '크로스벤더 기본값 — 플러그인별 키 미설정 시 폴백 (미설정=false)',
  },
  {
    key: 'cross_vendor.build',
    group: 'cross_vendor',
    type: 'boolean',
    nullable: true,
    scope: 'either',
    default: null,
    description: 'x-build consensus 크로스벤더 여부 (미설정=cross_vendor.default)',
  },
  {
    key: 'cross_vendor.op',
    group: 'cross_vendor',
    type: 'boolean',
    nullable: true,
    scope: 'either',
    default: null,
    description: 'x-op 전략(debate/council/persona/brainstorm 등) 크로스벤더 여부 (미설정=cross_vendor.default)',
  },
  {
    key: 'cross_vendor.eval',
    group: 'cross_vendor',
    type: 'boolean',
    nullable: true,
    scope: 'either',
    default: null,
    description: 'x-eval 심판 패널 크로스벤더 여부 (미설정=cross_vendor.default)',
  },
  {
    key: 'cross_vendor.review',
    group: 'cross_vendor',
    type: 'boolean',
    nullable: true,
    scope: 'either',
    default: null,
    description: 'x-review 렌즈 크로스벤더 여부 (미설정=cross_vendor.default)',
  },
  {
    key: 'cross_vendor.solver',
    group: 'cross_vendor',
    type: 'boolean',
    nullable: true,
    scope: 'either',
    default: null,
    description: 'x-solver 교차검산 크로스벤더 여부 (미설정=cross_vendor.default)',
  },
  {
    key: 'cross_vendor.agent',
    group: 'cross_vendor',
    type: 'boolean',
    nullable: true,
    scope: 'either',
    default: null,
    description: 'x-agent fan-out/broadcast 크로스벤더 여부 (미설정=cross_vendor.default)',
  },

  // ── budget (local-default) ──
  {
    key: 'budget.max_usd',
    group: 'budget',
    type: 'number',
    nullable: true,
    scope: 'local',
    default: null,
    description: '세션당 최대 비용(USD). null=무제한',
  },
  {
    key: 'budget.window_hours',
    group: 'budget',
    type: 'number',
    nullable: true,
    scope: 'local',
    default: null,
    description: '비용 추적 롤링 윈도우(시간). 미설정 시 24h로 동작',
  },
  {
    key: 'budget.projects',
    group: 'budget',
    type: 'object',
    scope: 'local',
    default: {},
    description: '프로젝트별 예산 상한 { project: { max_usd } }',
  },

  // ── phase gates ──
  {
    key: 'gates.research-exit',
    group: 'gates',
    type: 'string',
    enum: ['auto', 'human-verify', 'quality'],
    scope: 'global',
    default: 'human-verify',
    description: 'Research 페이즈 종료 게이트',
  },
  {
    key: 'gates.plan-exit',
    group: 'gates',
    type: 'string',
    enum: ['auto', 'human-verify', 'quality'],
    scope: 'global',
    default: 'human-verify',
    description: 'Plan 페이즈 종료 게이트',
  },
  {
    key: 'gates.execute-exit',
    group: 'gates',
    type: 'string',
    enum: ['auto', 'human-verify', 'quality'],
    scope: 'global',
    default: 'auto',
    description: 'Execute 페이즈 종료 게이트',
  },
  {
    key: 'gates.verify-exit',
    group: 'gates',
    type: 'string',
    enum: ['auto', 'human-verify', 'quality'],
    scope: 'global',
    default: 'quality',
    description: 'Verify 페이즈 종료 게이트',
  },
  {
    key: 'gates.close-exit',
    group: 'gates',
    type: 'string',
    enum: ['auto', 'human-verify', 'quality'],
    scope: 'global',
    default: 'auto',
    description: 'Close 페이즈 종료 게이트',
  },

  // ── worktree (build-local 3-tier; runtime source = WORKTREE_CONFIG_DEFAULTS) ──
  {
    key: 'worktree.enabled',
    group: 'worktree',
    type: 'boolean',
    scope: 'build-local',
    default: true,
    description: 'worktree 병렬 실행 활성화',
  },
  {
    key: 'worktree.base',
    group: 'worktree',
    type: 'string',
    scope: 'build-local',
    default: 'develop',
    description: 'worktree 브랜치의 베이스 브랜치',
  },
  {
    key: 'worktree.branch_prefix',
    group: 'worktree',
    type: 'string',
    scope: 'build-local',
    default: 'feat/',
    description: 'worktree 브랜치 접두사',
  },
  {
    key: 'worktree.max_parallel',
    group: 'worktree',
    type: 'integer',
    scope: 'build-local',
    default: 4,
    min: 1,
    description: '동시 실행 worktree 최대 개수',
  },
  {
    key: 'worktree.gate',
    group: 'worktree',
    type: 'string',
    scope: 'build-local',
    default: 'panel',
    description: 'worktree 병합 게이트 종류 (기본 panel)',
  },
  {
    key: 'worktree.gate_phase',
    group: 'worktree',
    type: 'string',
    enum: ['before', 'after', 'release'],
    scope: 'build-local',
    default: 'before',
    description: 'worktree 게이트 실행 시점 — before(병합 전) / after(병합 후) / release(릴리스 통합)',
  },
  {
    key: 'worktree.gate_policy',
    group: 'worktree',
    type: 'object',
    scope: 'build-local',
    default: {
      block_confirmed: ['critical', 'high', 'medium'],
      block_unreviewed: ['critical', 'high'],
      block_contested: ['critical'],
      allow_low: true,
    },
    description: 'worktree 게이트 severity 정책 (계층별 per-key 병합)',
  },
  {
    key: 'worktree.preflight',
    group: 'worktree',
    type: 'boolean',
    scope: 'build-local',
    default: true,
    description: 'worktree 생성 전 gk 프리플라이트 검사',
  },
  {
    key: 'worktree.cleanup',
    group: 'worktree',
    type: 'boolean',
    scope: 'build-local',
    default: true,
    description: 'worktree 병합 후 정리',
  },
  {
    key: 'worktree.review_integration_max_bytes',
    group: 'worktree',
    type: 'number',
    nullable: true,
    scope: 'build-local',
    default: null,
    description: 'review-integration 패치 크기 상한(bytes). null=무제한',
  },
  {
    key: 'worktree.gate_lock_backoff_ms',
    group: 'worktree',
    type: 'integer',
    scope: 'build-local',
    default: 250,
    min: 0,
    description: 'worktree 게이트 락 경합 시 재시도 백오프(ms)',
  },

  // ── misc (global) ──
  {
    key: 'scan_roots',
    group: 'misc',
    type: 'array',
    scope: 'global',
    default: [],
    description: '대시보드 프로젝트 스캔 루트 목록 (legacy fallback)',
  },
  {
    key: 'drift.drift_threshold',
    group: 'misc',
    type: 'number',
    scope: 'global',
    default: 0.7,
    min: 0,
    max: 1,
    description: 'goal drift 게이트 임계값 (0-1)',
  },
  {
    key: 'pipelines',
    group: 'misc',
    type: 'object',
    scope: 'global',
    default: {},
    description: '파이프라인 정의 { name: [plugin, ...] } (LLM 프롬프트 전용)',
  },
  // x-op SKILL.md "Post-Strategy Eval Gate" reads eval.auto from the project's
  // .xm/config.json — scope 'local' keeps `xm config set eval.auto` writing
  // where that consumer reads.
  {
    key: 'eval.auto',
    group: 'misc',
    type: 'boolean',
    scope: 'local',
    default: false,
    description: 'x-op 전략 완료 후 x-eval 자동 평가 훅 (Post-Strategy Eval Gate)',
  },

  // ── owned by another plugin (discovery only) ──
  //
  // panel.* is owned by x-panel, but two leaves are editable through the `xm config`
  // panel category: panel.timeout_s (direct write, registered below) and
  // panel.model_overrides (object, validated as a panel.* special case in
  // shared-config's validateSet). models/judge stay delegated to `xm panel setup`.
  {
    key: 'panel',
    group: 'panel',
    type: 'object',
    scope: 'global',
    owner: 'x-panel',
    default: {},
    description: 'cross-vendor 프로바이더 설정 — xm panel setup/doctor/models 또는 xm config 위저드로 관리',
  },
  {
    key: 'panel.timeout_s',
    group: 'panel',
    type: 'integer',
    scope: 'global',
    owner: 'x-panel',
    min: 30,
    default: 600,
    description: '패널/cross-vendor 모델별 idle 타임아웃(초) — xm panel setup 또는 xm config 위저드에서 편집',
  },
];

// ── indexes ───────────────────────────────────────────────────────────
export const SCHEMA_BY_KEY = new Map(SCHEMA.map(e => [e.key, e]));

/**
 * Look up the schema entry for a key. Tries an exact match, then the key's
 * top-level segment (so `budget` resolves via `budget.max_usd`). Returns null
 * for unregistered keys.
 * @param {string} key
 * @returns {object|null}
 */
export function getSchemaEntry(key) {
  if (!key || typeof key !== 'string') return null;
  const exact = SCHEMA_BY_KEY.get(key);
  if (exact) return exact;
  const top = key.split('.')[0];
  const topExact = SCHEMA_BY_KEY.get(top);
  if (topExact) return topExact;
  // A bare top-level segment (e.g. `budget`) matches its first registered child.
  for (const e of SCHEMA) {
    if (e.key === top || e.key.startsWith(top + '.')) return e;
  }
  return null;
}

/**
 * Resolve the registry scope for a key. Unregistered keys default to 'global',
 * preserving the historical rule "budget → local, everything else → global".
 * @param {string} key
 * @returns {'local'|'global'|'either'|'build-local'}
 */
export function scopeForKey(key) {
  const entry = getSchemaEntry(key);
  return entry ? entry.scope : 'global';
}
