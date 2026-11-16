export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_STATUSES = ['complete', 'incomplete', 'invalid'];
export const REQUIREMENT_PRIORITIES = ['must', 'should', 'could'];
export const ASSUMPTION_CONFIDENCE = ['high', 'medium', 'low', 'unknown'];
export const UNVERIFIED_CONFIDENCE = ['low', 'unknown'];
export const REQUIRED_PLAN_FIELDS = [
  'schema_version', 'status', 'executable', 'goal', 'requirements', 'assumptions',
  'decision', 'tasks', 'steps', 'validation', 'disagreements',
  'unresolved_questions', 'provenance',
];
export const SAFE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
// Requirement domains where an unenumerated failure mode is an undefended one.
// Mirrors the coverage rule in x-build's PRD template section 7.5; the
// phase-routing experiment (docs/phase-model-routing-experiment.md) measured
// enumeration as the difference between 0/3 and 3/3 on robustness.
export const RISK_DOMAIN_RE = /(pars(?:e|er|ing)|regex|regexp|match(?:er|ing)|cach(?:e|ing)|concurren|lock|mutex|queue|auth|crypto|encrypt|decrypt|token|input|stream|protocol|socket|upload|deserial|파싱|파서|정규식|캐시|동시성|잠금|큐|인증|권한|암호|입력|스트림|프로토콜|업로드|역직렬화)/i;
// Words that contain a risk stem and name something else. The stems stay substring matches,
// because requiring a word start also dropped "unauthorized", "requeue", "uncached" and
// "spinlock": a missed requirement goes undefended without notice, while a false hit costs one
// "none — <justification>" line. So only words seen to be unrelated are removed, and
// "authorize" and "authorization" are kept by ending the author forms at a non-letter.
const UNRELATED_WORD_RE = /[a-z]*block[a-z]*|[a-z]*clock[a-z]*|sparse[a-z]*|mismatch[a-z]*|(?:up|down|main)stream[a-z]*|lockfiles?|[a-z]*author(?:s|ed|ing|ship)?(?![a-z])/gi;

/** Whether a requirement text names a risk domain. */
export function mentionsRiskDomain(text) {
  // camelCase is split first so removing "block" from `blockLock` leaves "Lock" to match.
  return RISK_DOMAIN_RE.test(String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(UNRELATED_WORD_RE, ' '));
}
