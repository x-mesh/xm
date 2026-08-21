export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_STATUSES = ['complete', 'incomplete', 'invalid'];
export const REQUIREMENT_PRIORITIES = ['must', 'should', 'could'];
export const ASSUMPTION_CONFIDENCE = ['high', 'medium', 'low', 'unknown'];
export const REQUIRED_PLAN_FIELDS = [
  'schema_version', 'status', 'executable', 'goal', 'requirements', 'assumptions',
  'decision', 'tasks', 'steps', 'validation', 'disagreements',
  'unresolved_questions', 'provenance',
];
export const SAFE_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
