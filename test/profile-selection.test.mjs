import { describe, expect, test } from 'bun:test';
import { recommendBuildProfile } from '../x-build/lib/x-build/profile-selection.mjs';
import { recommendPlanMode } from '../x-plan/lib/x-plan/selection.mjs';

describe('adaptive planning depth selection', () => {
  test('build precedence is explicit then saved then automatic', () => {
    const signal = { recommendation: 'quick-eligible', signals: [] };
    expect(recommendBuildProfile({ explicitProfile: 'deep', savedProfile: 'light', researchSignal: signal }).profile).toBe('deep');
    expect(recommendBuildProfile({ savedProfile: 'standard', researchSignal: signal })).toMatchObject({ profile: 'standard', source: 'resumed' });
    expect(recommendBuildProfile({ researchSignal: signal })).toMatchObject({ profile: 'light', source: 'auto' });
  });

  test('build fails safe for greenfield, risky, unavailable, and unresolved input', () => {
    expect(recommendBuildProfile({ projectKind: 'greenfield' }).profile).toBe('deep');
    expect(recommendBuildProfile({ researchSignal: { recommendation: 'slim', signals: [{ id: 'contract-vocabulary', hit: true }] } }).profile).toBe('standard');
    expect(recommendBuildProfile({ researchSignal: { recommendation: 'slim', signals: [{ id: 'irreversible-surface', hit: true }] } }).profile).toBe('deep');
    expect(recommendBuildProfile({ goal: 'Migrate the public API schema', researchSignal: { recommendation: 'slim', signals: [{ id: 'contract-vocabulary', hit: true }] } }).profile).toBe('deep');
    expect(recommendBuildProfile({ goal: 'Migrate the public API schema', intentReady: false })).toMatchObject({ profile: 'deep', reasons: ['high_risk_surface'] });
    expect(recommendBuildProfile({ goal: 'Replace the internal architecture across every package', researchSignal: { recommendation: 'quick-eligible', signals: [] } })).toMatchObject({ profile: 'standard', reasons: ['broad_scope'] });
    expect(recommendBuildProfile({ goal: 'Refactor the whole codebase and update documentation', researchSignal: { recommendation: 'quick-eligible', signals: [] } })).toMatchObject({ profile: 'standard', reasons: ['broad_scope'] });
    expect(recommendBuildProfile({ goal: 'Update docs/security.md only; no security behavior changes', researchSignal: { recommendation: 'quick-eligible', signals: [] } })).toMatchObject({ profile: 'light', reasons: ['bounded_docs_only'] });
    expect(recommendBuildProfile({ goal: 'Document why delete is unsupported in docs/README.md', researchSignal: { recommendation: 'quick-eligible', signals: [] } })).toMatchObject({ profile: 'light', reasons: ['bounded_docs_only'] });
    expect(recommendBuildProfile({ goal: 'Update docs/security.md only across the whole codebase; no security behavior changes', researchSignal: { recommendation: 'quick-eligible', signals: [] } })).toMatchObject({ profile: 'standard', reasons: ['broad_scope'] });
    expect(recommendBuildProfile({ researchSignal: null })).toMatchObject({ profile: 'deep', confirmation_required: true });
    expect(recommendBuildProfile({ intentReady: false })).toMatchObject({ profile: 'standard', provisional: true, confirmation_required: false, reasons: ['intent_unresolved'] });
  });

  test('plan selector keeps Ultra explicit', () => {
    expect(recommendPlanMode('Migrate the public API schema and deploy safely').mode).toBe('standard');
    expect(recommendPlanMode('Update docs/README.md and its local tests without changing behavior').mode).toBe('standard');
    expect(recommendPlanMode('anything', { models: ['a', 'b'] }).mode).toBe('ultra');
  });

  test('broad changes never become Quick from docs, tests, or rename vocabulary alone', () => {
    expect(recommendPlanMode('Replace the internal architecture across every package and update docs everywhere')).toMatchObject({ mode: 'standard', risk: 'medium', reasons: ['broad_scope'] });
    expect(recommendPlanMode('Rename every private API endpoint across all services and update tests')).toMatchObject({ mode: 'standard' });
    expect(recommendPlanMode('Update docs/README.md and its local tests without changing behavior')).toMatchObject({ mode: 'standard', risk: 'low', reasons: ['quality_preserving_standard', 'bounded_local_change'] });
    expect(recommendPlanMode('Update docs/README.md and test/x-plan-cli.test.mjs together')).toMatchObject({ mode: 'standard' });
    expect(recommendPlanMode('Refactor the whole codebase and update documentation')).toMatchObject({ mode: 'standard', reasons: ['broad_scope'] });
    expect(recommendPlanMode('Update docs/security.md only; no security behavior changes')).toMatchObject({ mode: 'standard', reasons: ['quality_preserving_standard', 'bounded_docs_only'] });
  });

  test('selectors expose the shared risk assessment wire contract', () => {
    const plan = recommendPlanMode('Update src/local.mjs while migrating the public API schema');
    expect(plan).toMatchObject({ risk: 'high', conflicting_signals: true, confirmation_required: true });
    const build = recommendBuildProfile({ researchSignal: { recommendation: 'quick-eligible', signals: [] } });
    expect(build).toMatchObject({ risk: 'low', conflicting_signals: false });
  });
});
