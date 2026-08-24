const HIGH_RISK_IDS = new Set(['irreversible-surface', 'lessons-match']);
const HIGH_RISK_GOAL_RE = /\b(public api|schema|migration|deploy|release|publish|security|auth(?:entication|orization)?|delete|drop|breaking change)\b|공개\s*api|스키마|마이그레이션|배포|릴리스|보안|인증|인가|삭제|제거/i;

/** Map deterministic repository/research evidence to a concrete build profile. */
export function recommendBuildProfile({ explicitProfile = null, savedProfile = null, projectKind = 'brownfield', researchSignal = null, intentReady = true, goal = '' } = {}) {
  if (explicitProfile) return { profile: explicitProfile, risk: null, conflicting_signals: false, source: 'explicit', confidence: 'high', reasons: ['explicit_profile'], confirmation_required: false };
  if (savedProfile) return { profile: savedProfile, risk: null, conflicting_signals: false, source: 'resumed', confidence: 'high', reasons: ['saved_project_profile'], confirmation_required: false };
  if (!intentReady) return { profile: 'standard', risk: 'medium', conflicting_signals: false, provisional: true, source: 'fallback', confidence: 'low', reasons: ['intent_unresolved'], confirmation_required: false };
  if (projectKind === 'greenfield') return { profile: 'deep', risk: 'high', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: ['greenfield'], confirmation_required: false };
  if (!researchSignal || !Array.isArray(researchSignal.signals)) return { profile: 'deep', risk: 'high', conflicting_signals: false, source: 'fallback', confidence: 'low', reasons: ['research_signal_unavailable'], confirmation_required: true };
  const hitIds = researchSignal.signals.filter((signal) => signal.hit).map((signal) => signal.id);
  const goalHighRisk = HIGH_RISK_GOAL_RE.test(String(goal));
  if (goalHighRisk || hitIds.some((id) => HIGH_RISK_IDS.has(id)) || researchSignal.recommendation === 'full') {
    return { profile: 'deep', risk: 'high', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: goalHighRisk ? ['high_risk_surface', ...hitIds] : (hitIds.length ? hitIds : ['full_research']), confirmation_required: false };
  }
  if (researchSignal.recommendation === 'quick-eligible') {
    return { profile: 'light', risk: 'low', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: ['bounded_brownfield'], confirmation_required: false };
  }
  return { profile: 'standard', risk: 'medium', conflicting_signals: false, source: 'auto', confidence: 'high', reasons: hitIds.length ? hitIds : ['targeted_research'], confirmation_required: false };
}
