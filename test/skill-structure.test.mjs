import { describe, test, expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function readSkill(plugin) {
  // Skills dirs use short name (no x- prefix) since xm namespace rename
  const shortName = plugin.replace(/^x-/, '');
  return readFileSync(join(ROOT, plugin, 'skills', shortName, 'SKILL.md'), 'utf8');
}

function readEvalFile(path) {
  return readFileSync(join(ROOT, 'x-eval', 'skills', 'eval', path), 'utf8');
}

// --- x-solver SKILL.md structure ---

describe('x-solver SKILL.md structure', () => {
  const content = readSkill('x-solver');
  const solverRoot = join(ROOT, 'x-solver', 'skills', 'solver');

  test('contains Step-Back in classify', () => {
    expect(content).toContain('Step-Back');
    expect(content).toContain('check higher-level pattern');
  });

  test('iterate phase flow includes diagnose', () => {
    expect(content).toContain('DIAGNOSE → HYPOTHESIZE → TEST → REFINE → RESOLVE');
    expect(content).toContain('[state+baseline]');
    expect(content).toContain('[fix+exec proof]');
  });

  test('contains Fishbone analysis in diagnose', () => {
    expect(content).toContain('Fishbone');
    expect(content).toContain('Ishikawa');
    expect(content).toContain('Delta = "unknown"');
  });

  test('contains Contrastive Matrix in constrain evaluate', () => {
    expect(content).toContain('Contrastive Matrix');
    expect(content).toContain('Winner');
  });

  test('iterate diagnose cannot be skipped', () => {
    expect(content).toContain('cannot be skipped');
    expect(content).toContain('must always start from diagnose');
  });

  test('iterate has leader execution rules', () => {
    expect(content).toContain('must never directly read code');
    expect(content).toContain('verify hypotheses');
    expect(content).toContain('delegate to an agent');
  });

  test('each iterate phase has checklist', () => {
    // Count checklist blocks
    const checklistCount = (content.match(/Checklist:/g) || []).length;
    expect(checklistCount).toBeGreaterThanOrEqual(5); // diagnose, hypothesize, test, refine, resolve
  });

  test('allowed-tools includes AskUserQuestion', () => {
    expect(content).toContain('allowed-tools');
    expect(content).toContain('AskUserQuestion');
  });

  test('referenced x-solver reference files are bundled with x-solver', () => {
    const references = new Set(
      [...content.matchAll(/references\/([a-z0-9-]+\.md)/g)].map((match) => match[1])
    );

    for (const reference of references) {
      expect(existsSync(join(solverRoot, 'references', reference))).toBe(true);
    }
  });

  test('agent count resolution avoids hardcoded plugin cache versions', () => {
    expect(content).toContain('agent_count');
    expect(content).toContain('solving.parallel_agents');
    expect(content).not.toContain('xm/xm/1.26.4');
  });

  test('classify direct path is documented as non-strategy', () => {
    const classifyBody = readFileSync(join(solverRoot, 'commands', 'classify.md'), 'utf8');

    expect(classifyBody).toContain('direct');
    expect(classifyBody).toContain('do not run `$XMS strategy set direct`');
  });

  test('solve command documents solve-advance validation', () => {
    const solveBody = readFileSync(join(solverRoot, 'commands', 'solve.md'), 'utf8');

    expect(solveBody).toContain('solve-advance');
    expect(solveBody).toContain('validates');
    expect(solveBody).toContain('refine → hypothesize');
  });
});

// --- x-review SKILL.md structure ---

describe('x-review SKILL.md structure', () => {
  const content = readSkill('x-review');

  test('Smart Router detects PR, branch, and main', () => {
    expect(content).toContain('Smart Router');
    expect(content).toContain('PR_NUM');
    expect(content).toContain('LAST_REVIEW');
    expect(content).toContain('git merge-base');
  });

  test('Smart Router has priority order (PR first)', () => {
    // PR detection should come before LAST_REVIEW resolution
    const prPos = content.indexOf('gh pr view');
    const lastReviewPos = content.indexOf('LAST_REVIEW');
    // Both exist
    expect(prPos).toBeGreaterThan(0);
    expect(lastReviewPos).toBeGreaterThan(0);
  });

  test('Smart Router has unrecognized input fallback', () => {
    expect(content).toContain('Unrecognized input');
  });

  test('Smart Router has git ref validation', () => {
    expect(content).toContain('grep -qE');
    expect(content).toContain('HEAD~');
  });

  test('Smart Router has large diff guard', () => {
    expect(content).toContain('500');
    expect(content).toContain('2000');
    expect(content).toContain('force-full');
  });

  test('contains full mode with lens-first split', () => {
    expect(content).toContain('### full');
    expect(content).toContain('Lens-first split');
    expect(content).toContain('one lens');
  });

  test('contains CoVe self-verify step', () => {
    expect(content).toContain('Self-Verify');
    expect(content).toContain('Chain-of-Verification');
    expect(content).toContain('CoVe-removed');
    expect(content).toContain('CoVe-downgraded');
  });

  test('CoVe uses agent snippets, not file re-reads', () => {
    expect(content).toContain('do not re-read the file');
    expect(content).toContain('snippet');
  });

  test('contains presets (quick/standard/security)', () => {
    expect(content).toContain('--preset quick');
    expect(content).toContain('--preset standard');
    expect(content).toContain('--preset security');
  });

  test('verdict includes reason', () => {
    expect(content).toContain('verdict rationale');
  });

  test('review results saved as MD', () => {
    expect(content).toContain('last-result.md');
    expect(content).toContain('history/');
    expect(content).toContain('reviewed_commit');
  });

  test('contains review-fix triage contract', () => {
    expect(content).toContain('REVIEW-FIX CONTRACT');
    expect(content).toContain('triage checklist');
    expect(content).toContain('fix_now');
  });

  test('all 7 lenses documented', () => {
    expect(content).toContain('security');
    expect(content).toContain('logic');
    expect(content).toContain('perf');
    expect(content).toContain('tests');
    expect(content).toContain('architecture');
    expect(content).toContain('docs');
    expect(content).toContain('errors');
  });

  test('allowed-tools includes AskUserQuestion', () => {
    expect(content).toContain('allowed-tools');
    expect(content).toContain('AskUserQuestion');
  });
});

// --- x-op SKILL.md structure ---

describe('x-op SKILL.md structure', () => {
  const content = readSkill('x-op');
  const opRoot = join(ROOT, 'x-op', 'skills', 'op');

  test('brainstorm has --analogical and --lateral modes', () => {
    // brainstorm strategy body lives in strategies/brainstorm.md (extracted from SKILL.md)
    const brainstormBody = readFileSync(
      join(ROOT, 'x-op', 'skills', 'op', 'strategies', 'brainstorm.md'),
      'utf8'
    );
    expect(brainstormBody).toContain('--analogical');
    expect(brainstormBody).toContain('--lateral');
    expect(brainstormBody).toContain('Brainstorm Modes');
    // SKILL.md still references the strategy via link stub
    expect(content).toContain('strategies/brainstorm.md');
  });

  test('--analogical and --lateral in Options table', () => {
    // Should be in the Options section, not just in the brainstorm body
    const optionsSection = content.split('## Options')[1]?.split('## Shared Config')[0] || '';
    expect(optionsSection).toContain('analogical');
    expect(optionsSection).toContain('lateral');
  });

  test('monitor uses OODA (4 phases)', () => {
    // monitor strategy body lives in strategies/monitor.md (extracted from SKILL.md)
    const monitorBody = readFileSync(
      join(ROOT, 'x-op', 'skills', 'op', 'strategies', 'monitor.md'),
      'utf8'
    );
    expect(monitorBody).toContain('Phase 1: OBSERVE');
    expect(monitorBody).toContain('Phase 2: ORIENT');
    expect(monitorBody).toContain('Phase 3: DECIDE');
    expect(monitorBody).toContain('Phase 4: ACT');
    // SKILL.md still references the strategy via link stub
    expect(content).toContain('strategies/monitor.md');
  });

  test('--vote Self-Consistency documented', () => {
    // --vote details live in references/x-op-options.md (extracted from SKILL.md)
    const optionsBody = readFileSync(
      join(ROOT, 'x-op', 'skills', 'op', 'references', 'x-op-options.md'),
      'utf8'
    );
    expect(optionsBody).toContain('Self-Consistency');
    expect(optionsBody).toContain('Confidence Map');
    expect(optionsBody).toContain('50%');
    // SKILL.md still references the options via link stub
    expect(content).toContain('references/x-op-options.md');
  });

  test('routing strategy list matches strategy files', () => {
    const strategyDir = join(opRoot, 'strategies');
    const strategyFiles = readdirSync(strategyDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.replace(/\.md$/, ''))
      .sort();

    const routingStrategies = [...content.matchAll(/^- `([^`]+)` → \[Strategy:/gm)]
      .map((match) => match[1])
      .sort();

    expect(routingStrategies).toEqual(strategyFiles);
    expect(routingStrategies).toHaveLength(17);
    expect(content).not.toContain('18 strategies');
    expect(content).not.toContain('classify narrows');
  });

  test('referenced x-op reference files are bundled with x-op', () => {
    const contractBody = readFileSync(
      join(opRoot, 'references', 'agent-output-contract.md'),
      'utf8'
    );
    const references = new Set(
      [...`${content}\n${contractBody}`.matchAll(/references\/([a-z0-9-]+\.md)/g)].map(
        (match) => match[1]
      )
    );

    for (const reference of references) {
      expect(existsSync(join(opRoot, 'references', reference))).toBe(true);
    }
  });

  test('--verify uses x-eval as the single evaluation path', () => {
    const optionsBody = readFileSync(
      join(opRoot, 'references', 'x-op-options.md'),
      'utf8'
    );
    const optionsSection = content.split('## Options')[1]?.split('## Shared Config')[0] || '';

    expect(content).toContain('invoke x-eval score');
    expect(optionsBody).toContain('delegates final scoring to x-eval');
    expect(optionsSection).toContain('Delegate final quality verification to x-eval');
    expect(optionsBody).not.toContain('Summon Judge Panel');
    expect(optionsSection).not.toContain('judge panel scoring');
  });

  test('x-op persistence schema links strategy results to x-eval by run_id', () => {
    const persistenceBody = readFileSync(
      join(opRoot, 'references', 'x-op-result-persistence.md'),
      'utf8'
    );

    expect(persistenceBody).toContain('"run_id"');
    expect(persistenceBody).toContain('"evaluation"');
    expect(persistenceBody).toContain('source_result_path');
    expect(persistenceBody).toContain('evaluation.result_path');
    expect(persistenceBody).toContain('Do not omit the `evaluation` object');
    expect(content).toContain('--source-plugin x-op');
    expect(content).toContain('--source-result');
  });
});

// --- x-build SKILL.md structure ---

describe('x-build SKILL.md structure', () => {
  const content = readSkill('x-build');
  const buildRoot = join(ROOT, 'x-build', 'skills', 'build');

  test('referenced x-build reference files are bundled with x-build', () => {
    const references = new Set(
      [...content.matchAll(/references\/([a-z0-9-]+\.md)/g)].map((match) => match[1])
    );

    for (const reference of references) {
      expect(existsSync(join(buildRoot, 'references', reference))).toBe(true);
    }
  });

  test('uses canonical PRD path in plan phase directory', () => {
    expect(content).toContain('phases/02-plan/PRD.md');
    expect(content).not.toContain('context/PRD.md');
  });

  test('model routing example matches haiku display commands', () => {
    const modelRouting = content.split('## Model Routing')[1]?.split('## Mode Detection')[0] || '';
    expect(modelRouting).toContain('**haiku**');
    expect(modelRouting).toContain('model: "haiku"');
    expect(modelRouting).not.toContain('model: "sonnet"');
  });

  test('plan-check is documented as 11 dimensions', () => {
    const otherCommands = readFileSync(
      join(buildRoot, 'commands', 'other-commands.md'),
      'utf8'
    );

    expect(content).toContain('11 quality dimensions');
    expect(otherCommands).toContain('11-Dimension Validation');
    expect(otherCommands).not.toContain('8-Dimension Validation');
  });

  test('next routing documents missing PRD before plan execution', () => {
    const otherCommands = readFileSync(
      join(buildRoot, 'commands', 'other-commands.md'),
      'utf8'
    );

    expect(otherCommands).toContain('No `phases/02-plan/PRD.md`');
    expect(otherCommands.indexOf('No `phases/02-plan/PRD.md`')).toBeLessThan(
      otherCommands.indexOf('No tasks')
    );
  });
});

// --- x-eval Tier 1 structure (pass@k/pass^k, broken-task warning, transcripts) ---

describe('x-eval Tier 1 structure', () => {
  const bench = readEvalFile('subcommands/bench.md');
  const rubrics = readEvalFile('references/rubrics.md');
  const report = readEvalFile('subcommands/report.md');
  const score = readEvalFile('subcommands/score.md');
  const storage = readEvalFile('references/storage-layout.md');

  test('bench.md defines pass@k and pass^k metrics', () => {
    expect(bench).toContain('pass@k');
    expect(bench).toContain('pass^k');
    expect(bench).toContain('Capability upper bound');
    expect(bench).toContain('Reliability lower bound');
  });

  test('bench.md documents broken-task warning with empirical threshold', () => {
    expect(bench).toContain('Broken-task warning');
    expect(bench).toContain('avg_score < 4.5');
    expect(bench).toContain('pass_at_k_rate == 0');
    expect(bench).toContain('trials >= 2');
  });

  test('bench.md recommendation logic is pass-aware AND σ-aware', () => {
    expect(bench).toContain('Recommendation logic (pass-aware + σ-aware)');
    expect(bench).toContain('pass^k = 1');
    expect(bench).toContain('lowest σ');
    expect(bench).toContain('No reliable recommendation');
  });

  test('bench.md includes low-confidence advisory for small samples', () => {
    expect(bench).toContain('Low-confidence advisory');
    expect(bench).toContain('σ >= 1.0');
    expect(bench).toMatch(/trials\s*<=?\s*3/i);
  });

  test('rubrics.md declares pass_threshold for every built-in + preset', () => {
    // 9 rubrics total: 4 built-in + 5 domain presets
    const matches = rubrics.match(/\*\*Pass threshold\*\*/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(9);
  });

  test('rubrics.md declares default threshold in introduction', () => {
    expect(rubrics).toContain('pass_threshold');
    expect(rubrics).toMatch(/Default.{0,20}7\.0/);
  });

  test('report.md supports --sample-transcript flag', () => {
    expect(report).toContain('--sample-transcript N');
    expect(report).toContain('Transcript sampling');
    expect(report).toContain('eval.persist_transcripts');
  });

  test('score.md preserves judge_rationales for audit', () => {
    expect(score).toContain('judge_rationales');
    expect(score).toContain('pass_threshold');
    expect(score).toContain('passed');
  });

  test('storage-layout.md documents new Tier 1 fields', () => {
    expect(storage).toContain('pass_threshold');
    expect(storage).toContain('pass_at_k');
    expect(storage).toContain('pass_hat_k');
    expect(storage).toContain('per_trial_overall');
    expect(storage).toContain('judge_rationales');
    expect(storage).toContain('broken_task_warning');
  });

  test('score storage documents x-op run_id linkage', () => {
    expect(score).toContain('--run-id <id>');
    expect(score).toContain('--source-plugin <name>');
    expect(score).toContain('--source-result <path>');
    expect(storage).toContain('"run_id"');
    expect(storage).toContain('"source_plugin": "x-op"');
    expect(storage).toContain('"source_result_path"');
    expect(storage).toContain('Required when `source_plugin: "x-op"`');
  });

  test('SKILL.md help text mentions Tier 1 features', () => {
    const skillContent = readSkill('x-eval');
    expect(skillContent).toContain('pass@k');
    expect(skillContent).toContain('--sample-transcript');
  });
});

// --- x-eval Tier 2/3 structure (diff --baseline, insufficient_info N/A) ---

describe('x-eval Tier 2/3 structure', () => {
  const diff = readEvalFile('subcommands/diff.md');
  const score = readEvalFile('subcommands/score.md');
  const storage = readEvalFile('references/storage-layout.md');
  const reusable = readEvalFile('judges/reusable.md');

  test('diff.md supports --baseline flag', () => {
    expect(diff).toContain('--baseline <tag>');
    expect(diff).toContain('implies `--quality`');
    expect(diff).toContain('regression-focused');
  });

  test('diff.md defines regression thresholds', () => {
    expect(diff).toContain('REGRESSION');
    expect(diff).toContain('delta ≤ -0.5');
    expect(diff).toContain('unchanged');
    expect(diff).toContain('improved');
  });

  test('diff.md --baseline execution flow is documented', () => {
    expect(diff).toContain('--baseline execution flow');
    expect(diff).toContain('non-zero signal');
  });

  test('judges/reusable.md documents N/A escape hatch', () => {
    expect(reusable).toContain('Score: N/A');
    expect(reusable).toContain('insufficient information');
    expect(reusable).toContain('renormalize');
  });

  test('judges/reusable.md documents weight renormalization math', () => {
    expect(reusable).toContain('N/A Weight Renormalization');
    expect(reusable).toContain('total_scored_weight');
    expect(reusable).toContain('effective_weight');
  });

  test('score.md handles N/A criteria in aggregation', () => {
    expect(score).toContain('N/A criterion handling');
    expect(score).toContain('na_criteria');
    expect(score).toContain('Do NOT default N/A to 5');
  });

  test('storage-layout.md includes na_criteria field', () => {
    expect(storage).toContain('na_criteria');
    expect(storage).toContain('must not treat absence as implicit 0');
  });
});

// --- x-eval calibrate structure ---

describe('x-eval calibrate structure', () => {
  const calibrate = readEvalFile('subcommands/calibrate.md');
  const storage = readEvalFile('references/storage-layout.md');
  const skill = readSkill('x-eval');

  test('calibrate.md defines human scoring loop', () => {
    expect(calibrate).toContain('Human scoring');
    expect(calibrate).toContain('AskUserQuestion');
    expect(calibrate).toContain('bias_delta');
  });

  test('calibrate.md defines bias thresholds', () => {
    expect(calibrate).toContain('calibrated');
    expect(calibrate).toContain('systematic');
    expect(calibrate).toContain('1.0');
    expect(calibrate).toContain('1.5');
  });

  test('calibrate.md documents band-to-midpoint mapping', () => {
    expect(calibrate).toContain('midpoints');
    expect(calibrate).toContain('7–8 → 7.5');
  });

  test('calibrate.md documents gating rule', () => {
    expect(calibrate).toContain('gate');
    expect(calibrate).toContain('automated gating');
    expect(calibrate).toContain('30 days');
  });

  test('storage-layout.md includes calibrate schema', () => {
    expect(storage).toContain('calibrate');
    expect(storage).toContain('bias_delta');
    expect(storage).toContain('systematic_criteria');
    expect(storage).toContain('calibrations/');
  });

  test('SKILL.md routes calibrate', () => {
    expect(skill).toContain('calibrate');
    expect(skill).toContain('[Subcommand: calibrate]');
  });
});

// --- x-eval outcome assertions (--assert flag) ---

describe('x-eval outcome assertion structure', () => {
  const score = readEvalFile('subcommands/score.md');
  const storage = readEvalFile('references/storage-layout.md');
  const assertionJudge = readEvalFile('judges/assertion.md');

  test('score.md documents --assert flag', () => {
    expect(score).toContain('--assert');
    expect(score).toContain('binary outcome assertion');
  });

  test('score.md defines HARD FAIL gate on passed', () => {
    expect(score).toContain('HARD FAIL');
    expect(score).toContain('passed = false');
    expect(score).toContain('regardless of rubric score');
  });

  test('score.md defines UNCERTAIN as non-blocking', () => {
    expect(score).toContain('UNCERTAIN');
    expect(score).toContain("passed` unaffected");
  });

  test('judges/assertion.md defines PASS/FAIL format', () => {
    expect(assertionJudge).toContain('Result: PASS');
    expect(assertionJudge).toContain('Result: FAIL');
    expect(assertionJudge).toContain('HARD FAIL');
  });

  test('judges/assertion.md documents x-probe future integration', () => {
    expect(assertionJudge).toContain('x-probe');
    expect(assertionJudge).toContain('future');
  });

  test('storage-layout.md includes assertion_results field', () => {
    expect(storage).toContain('assertion_results');
    expect(storage).toContain('HARD_FAIL');
    expect(storage).toContain('confidence');
  });
});
