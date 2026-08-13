/** Pure aggregation for x-build effectiveness events. No filesystem/config imports. */

export const BUILD_PROFILES = ['light', 'standard', 'deep'];

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

export function aggregateEffectiveness(rows, { sinceDays = 30, profiles = null } = {}) {
  const cutoff = Date.now() - sinceDays * 86400000;
  // build_id is the only per-row attribution key. Profile is a property of the
  // build, not of the row: Research events are recorded before `plan` selects a
  // profile, so requiring row.profile here would drop the entire research phase
  // and leave research_change_rate permanently null.
  const semantic = rows.filter((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    const ts = Date.parse(row.timestamp || row.ts || '');
    return row.build_id && Number.isFinite(ts) && ts >= cutoff;
  });
  const builds = new Map();
  for (const row of semantic) {
    if (!builds.has(row.build_id)) builds.set(row.build_id, { id: row.build_id, profile: null, profile_at: -Infinity, events: [] });
    const build = builds.get(row.build_id);
    const rowTime = Date.parse(row.timestamp || row.ts || '');
    if (row.profile && rowTime >= build.profile_at) {
      build.profile = row.profile;
      build.profile_at = rowTime;
    }
    build.events.push(row);
  }
  // A build that never reached `plan` has no profile to attribute it to; it is
  // observed but not measurable, so it stays out of every per-profile rate.
  const observed = [...builds.values()].filter((build) => build.profile && (!profiles || profiles.includes(build.profile)));

  const summaries = [];
  for (const profile of (profiles || BUILD_PROFILES)) {
    const group = observed.filter((build) => build.profile === profile);
    const events = group.flatMap((build) => build.events);
    const phaseEvents = events.filter((event) => event.type === 'phase_effect');
    const planEvents = events.filter((event) => event.type === 'plan_revision');
    const researchEffects = phaseEvents.filter((event) => event.phase === 'research');
    const researchChanged = researchEffects.filter((event) => Object.values(event.delta || {}).some((value) => Number(value) !== 0)).length;
    const replannedBuilds = new Set(events.filter((event) => event.type === 'execution_replan').map((event) => event.build_id));
    const reopenedBuilds = new Set(events.filter((event) => event.type === 'task_reopened').map((event) => event.build_id));
    const verifies = events.filter((event) => event.type === 'verify_outcome');
    const verifiedBuilds = new Set(verifies.map((event) => event.build_id));
    const firstPassBuilds = new Set(verifies.filter((event) => event.first_pass === true).map((event) => event.build_id));
    const completed = new Set(events.filter((event) => event.type === 'build_complete' && event.success !== false).map((event) => event.build_id));
    const planning = phaseEvents.filter((event) => ['research', 'plan'].includes(event.phase));
    const planningByBuild = new Map(group.map((build) => [build.id, planning.filter((event) => event.build_id === build.id)]));
    const planningDurations = [...planningByBuild.values()]
      .filter((buildEvents) => buildEvents.length > 0)
      .map((buildEvents) => buildEvents.reduce((sum, event) => sum + (Number(event.duration_ms) || 0), 0));
    // Cost is intentionally fail-closed: a build contributes to the average only
    // when every observed planning phase has cost data. trace_id remains the join
    // key for a future trace importer; missing cost is surfaced by coverage.
    const completePlanningCosts = [...planningByBuild.values()]
      .filter((buildEvents) => buildEvents.length > 0 && buildEvents.every((event) => Number.isFinite(event.cost_usd)))
      .map((buildEvents) => buildEvents.reduce((sum, event) => sum + event.cost_usd, 0));
    const costedPlanningPhases = planning.filter((event) => Number.isFinite(event.cost_usd)).length;
    summaries.push({
      profile, builds: group.length, sufficient_sample: group.length >= 10,
      planning_duration_ms_avg: average(planningDurations),
      planning_cost_usd_avg: average(completePlanningCosts), planning_cost_coverage: rate(costedPlanningPhases, planning.length),
      research_change_rate: rate(researchChanged, researchEffects.length),
      plan_revision_rate: rate(new Set(planEvents.map((event) => event.build_id)).size, group.length),
      execution_replan_rate: rate(replannedBuilds.size, group.length),
      task_reopen_rate: rate(reopenedBuilds.size, group.length),
      verify_first_pass_rate: rate(firstPassBuilds.size, verifiedBuilds.size),
      completion_rate: rate(completed.size, group.length),
    });
  }
  // Reported so callers can size the exclusion without re-deriving the rule:
  // these builds have events in the window but never reached a profile, so no
  // per-profile rate can include them.
  const unattributed = [...builds.values()].filter((build) => !build.profile).map((build) => build.id);
  return { since_days: sinceDays, profiles: summaries, builds_observed: observed.length, unattributed_build_ids: unattributed };
}
