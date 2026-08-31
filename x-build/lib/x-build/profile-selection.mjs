const HIGH_RISK_IDS = new Set(['irreversible-surface', 'lessons-match']);
const HIGH_RISK_GOAL_RE = /\b(public api|schema|migration|deploy|release|publish|security|auth(?:entication|orization)?|delete|drop|breaking change)\b|공개\s*api|스키마|마이그레이션|배포|릴리스|보안|인증|인가|삭제|제거/i;
const BROAD_SCOPE_GOAL_RE = /\b(entire|every|everywhere|whole\s+(?:codebase|repository|repo|project)|across\s+(?:all|the)|cross-cutting|architecture|monorepo|all\s+(?:packages|services|modules|endpoints)|repo(?:sitory)?-wide|codebase-wide|system-wide)\b|전체|전역|모든\s*(?:패키지|서비스|모듈|엔드포인트)|아키텍처/i;
const DOC_PATH_RE = /(?:^|[\s`])docs\/[\w./-]+/ig;
const DOC_ONLY_RE = /\b(?:docs?|document(?:ation)?|readme)\b|문서/i;
const SAFE_DOC_QUALIFIER_RE = /\b(?:only|unsupported|no\s+(?:runtime|security|public|api|schema|behavior)\s+(?:behavior\s+)?changes?)\b|문서만|동작\s*변경\s*없/i;

/** Map deterministic repository/research evidence to a concrete build profile. */
export function recommendBuildProfile({ explicitProfile = null, savedProfile = null, projectKind = 'brownfield', researchSignal = null, intentReady = true, goal = '' } = {}) {
  if (explicitProfile) return { profile: explicitProfile, risk: null, conflicting_signals: false, source: 'explicit', confidence: 'high', reasons: ['explicit_profile'], confirmation_required: false };
  if (savedProfile) return { profile: savedProfile, risk: null, conflicting_signals: false, source: 'resumed', confidence: 'high', reasons: ['saved_project_profile'], confirmation_required: false };
  const goalText = String(goal);
  const docPaths = new Set([...goalText.matchAll(DOC_PATH_RE)].map((match) => match[0].trim().toLowerCase()));
  const boundedDocsOnly = docPaths.size === 1 && DOC_ONLY_RE.test(goalText) && SAFE_DOC_QUALIFIER_RE.test(goalText);
  const goalHighRisk = HIGH_RISK_GOAL_RE.test(goalText);
  const goalBroadScope = BROAD_SCOPE_GOAL_RE.test(goalText);
  // Explicit irreversible/public surfaces remain deep even when the rest of
  // the request needs clarification. Otherwise do not lock in a project-kind
  // profile while intent is ambiguous; reclassify the provisional standard
  // profile after the blocking gap is resolved.
  if (goalBroadScope) return { profile: 'standard', risk: 'medium', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: ['broad_scope'], confirmation_required: false };
  if (boundedDocsOnly) return { profile: 'light', risk: 'low', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: ['bounded_docs_only'], confirmation_required: false };
  if (goalHighRisk) return { profile: 'deep', risk: 'high', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: ['high_risk_surface'], confirmation_required: false };
  if (!intentReady) return { profile: 'standard', risk: 'medium', conflicting_signals: false, provisional: true, source: 'fallback', confidence: 'low', reasons: ['intent_unresolved'], confirmation_required: false };
  if (projectKind === 'greenfield') return { profile: 'deep', risk: 'high', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: ['greenfield'], confirmation_required: false };
  if (!researchSignal || !Array.isArray(researchSignal.signals)) return { profile: 'deep', risk: 'high', conflicting_signals: false, source: 'fallback', confidence: 'low', reasons: ['research_signal_unavailable'], confirmation_required: true };
  const hitIds = researchSignal.signals.filter((signal) => signal.hit).map((signal) => signal.id);
  if (hitIds.some((id) => HIGH_RISK_IDS.has(id)) || researchSignal.recommendation === 'full') {
    return { profile: 'deep', risk: 'high', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: hitIds.length ? hitIds : ['full_research'], confirmation_required: false };
  }
  if (researchSignal.recommendation === 'quick-eligible') {
    return { profile: 'light', risk: 'low', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: ['bounded_brownfield'], confirmation_required: false };
  }
  return { profile: 'standard', risk: 'medium', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: hitIds.length ? hitIds : ['targeted_research'], confirmation_required: false };
}
