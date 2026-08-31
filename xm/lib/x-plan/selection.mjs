const HIGH_RISK_RE = /\b(public api|schema|migration|deploy|release|publish|security|auth(?:entication|orization)?|delete|drop|breaking change)\b|공개\s*api|스키마|마이그레이션|배포|릴리스|보안|인증|인가|삭제|제거/i;
const LOCAL_PATH_RE = /(?:^|[\s`])((?:src|lib|app|test|tests|docs|scripts)\/[\w./-]+)/ig;
const BROAD_SCOPE_RE = /\b(entire|every|everywhere|whole\s+(?:codebase|repository|repo|project)|across\s+(?:all|the)|cross-cutting|architecture|monorepo|all\s+(?:packages|services|modules|endpoints)|repo(?:sitory)?-wide|codebase-wide|system-wide)\b|전체|전역|모든\s*(?:패키지|서비스|모듈|엔드포인트)|아키텍처/i;
const DOC_ONLY_RE = /\b(?:docs?|document(?:ation)?|readme)\b|문서/i;
const SAFE_DOC_QUALIFIER_RE = /\b(?:only|unsupported|no\s+(?:runtime|security|public|api|schema|behavior)\s+(?:behavior\s+)?changes?)\b|문서만|동작\s*변경\s*없/i;

/** Side-effect-free planning depth recommendation. Quick and Ultra are explicit-only quality/cost trade-offs. */
export function recommendPlanMode(requirements, { explicitMode = null, models = null, resumedMode = null } = {}) {
  if (explicitMode) return { mode: explicitMode, risk: null, conflicting_signals: false, source: 'explicit', confidence: 'high', reasons: ['explicit_mode'], confirmation_required: false };
  if (models?.length) return { mode: 'ultra', risk: null, conflicting_signals: false, source: 'explicit_models', confidence: 'high', reasons: ['exact_models'], confirmation_required: false };
  if (resumedMode) return { mode: resumedMode, risk: null, conflicting_signals: false, source: 'session', confidence: 'high', reasons: ['resumed_session'], confirmation_required: false };

  const text = String(requirements || '').trim();
  if (text.length < 24) return { mode: 'standard', risk: 'medium', conflicting_signals: false, source: 'auto', confidence: 'low', reasons: ['requirements_too_short'], confirmation_required: true };
  const highRisk = HIGH_RISK_RE.test(text);
  const broadScope = BROAD_SCOPE_RE.test(text);
  const localPaths = new Set([...text.matchAll(LOCAL_PATH_RE)].map((match) => match[1].toLowerCase()));
  const local = localPaths.size === 1 && !broadScope && text.length >= 40;
  const boundedDocsOnly = local && [...localPaths][0].startsWith('docs/') && DOC_ONLY_RE.test(text) && SAFE_DOC_QUALIFIER_RE.test(text);
  if (broadScope) return { mode: 'standard', risk: highRisk ? 'high' : 'medium', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: [highRisk ? 'high_risk_surface' : 'broad_scope'], confirmation_required: false };
  if (boundedDocsOnly) return { mode: 'standard', risk: 'low', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: ['quality_preserving_standard', 'bounded_docs_only'], confirmation_required: false };
  if (highRisk) return { mode: 'standard', risk: 'high', conflicting_signals: local, source: 'auto', confidence: local ? 'medium' : 'high', reasons: ['high_risk_surface', ...(local ? ['bounded_local_change'] : [])], confirmation_required: local };
  if (local) return { mode: 'standard', risk: 'low', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: ['quality_preserving_standard', 'bounded_local_change'], confirmation_required: false };
  return { mode: 'standard', risk: 'medium', conflicting_signals: false, source: 'auto', confidence: 'medium', reasons: ['repository_inspection_needed'], confirmation_required: false };
}
