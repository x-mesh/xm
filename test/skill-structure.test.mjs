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

describe('x-review headless execution boundary', () => {
  const skill = readSkill('x-review');

  test('degrades delegated headless runs instead of waiting forever', () => {
    expect(skill).toContain('Execution Boundary — Headless / Delegated Runtimes');
    expect(skill).toContain('single-pass-headless');
    expect(skill).toContain('exactly one spawn batch');
    expect(skill).toContain('returns no worker ids');
    expect(skill).toContain('Do not retry spawn');
    expect(skill).toContain('at least one successfully created worker is still live');
    expect(skill).toContain('no worker update three consecutive times');
    expect(skill).toContain('never wait indefinitely');
  });

  test('corrects invalid test-runner argument shapes at most once', () => {
    expect(skill).toContain('Use one shared filter or separate commands');
    expect(skill).toContain('An argument/usage error permits one corrected');
    expect(skill).toContain('command, not repetition of the invalid shape');
  });
});

describe('x-review bounded panel execution', () => {
  const skill = readSkill('x-review');

  test('chunks frozen panel targets to at most three files', () => {
    expect(skill).toContain('--chunk-file-budget 3');
    expect(skill).toContain('at most 3 frozen diff files');
    expect(skill).toContain('forbid repository search or opening files');
  });
});

// --- x-solver SKILL.md structure ---

describe('x-solver SKILL.md structure', () => {
  const content = readSkill('x-solver');
  const solverRoot = join(ROOT, 'x-solver', 'skills', 'solver');

  test('contains Step-Back in classify', () => {
    expect(content).toContain('Step-Back');
    expect(content).toContain('check higher-level pattern');
  });

  test('iterate phase flow leads with reproduce and ends in a regression proof', () => {
    expect(content).toContain('REPRODUCE → DIAGNOSE → HYPOTHESIZE → TEST → REFINE → RESOLVE');
    expect(content).toContain('[repro+marker]');
    expect(content).toContain('[state+baseline]');
    // "exec proof" only showed the command passing after the fix. The regression
    // proof also requires the recorded failure it is being compared against.
    expect(content).toContain('[fix+regression proof]');
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
    expect(content).toContain('must always start from reproduce');
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
  const workflow = readFileSync(join(ROOT, 'x-review', 'skills', 'review', 'references', 'review-workflow.md'), 'utf8');
  const dataDirectory = readFileSync(join(ROOT, 'x-review', 'skills', 'review', 'references', 'data-directory.md'), 'utf8');
  const integration = readFileSync(join(ROOT, 'x-review', 'skills', 'review', 'references', 'x-build-integration.md'), 'utf8');

  // Step 1's context-detection block lives in references/review-workflow.md so
  // SKILL.md stays inside the 500-line budget; SKILL.md keeps the link stub.
  test('Smart Router detects PR, branch, and main', () => {
    expect(content).toContain('Smart Router');
    expect(content).toContain('references/review-workflow.md');
    expect(workflow).toContain('PR_NUM');
    expect(workflow).toContain('LAST_REVIEW');
    expect(workflow).toContain('git merge-base');
  });

  test('Smart Router has priority order (PR first)', () => {
    // PR detection should come before LAST_REVIEW resolution
    const prPos = workflow.indexOf('gh pr view');
    const lastReviewPos = workflow.indexOf('LAST_REVIEW');
    // Both exist
    expect(prPos).toBeGreaterThan(0);
    expect(lastReviewPos).toBeGreaterThan(0);
  });

  test('Smart Router has unrecognized input fallback', () => {
    expect(content).toContain('Unrecognized input');
  });

  test('Smart Router has git ref validation', () => {
    expect(workflow).toContain('grep -qE');
    expect(workflow).toContain('HEAD~');
  });

  test('Smart Router reads the trace ledger under .review, not top level', () => {
    expect(workflow).toContain('.review.ref');
    expect(workflow).not.toContain("jq -r 'if (.chain_broken");
  });

  test('Smart Router resolves a base ref without assuming a local main', () => {
    expect(workflow).toContain('refs/remotes/origin/HEAD');
    expect(workflow).toContain('origin/main main origin/master master');
    expect(workflow).not.toContain('BASE=$(git merge-base main HEAD');
    // Routing priority 2 must require a resolved BASE
    expect(content).toContain('`BASE` non-empty');
  });

  test('Smart Router uses token-budgeted chunk coverage', () => {
    expect(content).toContain('24K tokens');
    expect(content).toContain('token planner can chunk');
    expect(content).toContain('Review incomplete');
    expect(content).toContain('N profiles × M chunks');
    expect(content).not.toContain('force-full');
  });

  test('contains full mode with lens-first split', () => {
    expect(content).toContain('### full');
    expect(content).toContain('Lens-first split');
    expect(content).toContain('one lens');
  });

  test('contains CoVe self-verify step', () => {
    expect(workflow).toContain('Self-Verify');
    expect(workflow).toContain('verification question');
    expect(workflow).toContain('CoVe-removed');
    expect(workflow).toContain('CoVe-downgraded');
  });

  test('consensus changes confidence, never severity', () => {
    expect(workflow).toContain('Never raise severity because sources agree');
    expect(workflow).toContain('A Low reported independently by');
    expect(workflow).not.toContain('Promote severity one level');
    expect(workflow).toContain('strongly-corroborated');
    expect(dataDirectory).toContain('\"confidence\": \"corroborated\"');
    expect(dataDirectory).toContain('\"source_count\": 2');
  });

  test('CoVe uses agent snippets, not file re-reads', () => {
    expect(workflow).toContain('frozen target and canonical report');
    expect(workflow).toContain('deterministic grounding');
  });

  test('contains presets (quick/standard/security)', () => {
    expect(content).toContain('--preset adaptive-fast');
    expect(content).toContain('--preset quick');
    expect(content).toContain('--preset standard');
    expect(content).toContain('--preset security');
  });

  test('adaptive-fast is one wave with conditional expensive gates', () => {
    expect(content).toContain('one parallel LLM wave');
    expect(content).toContain('scripts/plan-review.mjs');
    expect(content).toContain('Recall/panel/another reviewer');
    expect(workflow).toContain('correctness');
    expect(workflow).toContain('risk');
    expect(workflow).toContain('target_coverage');
    expect(workflow).toContain('Disabled; finish after the grounded first wave');
    expect(dataDirectory).toContain('duration_ms');
  });

  test('verdict includes reason', () => {
    expect(workflow).toContain('Include verdict rationale');
  });

  test('review results saved as MD', () => {
    expect(content).toContain('last-result.md');
    expect(content).toContain('history/');
    expect(content).toContain('reviewed_commit');
  });

  test('review artifacts bind review-fix to Phase-1 target bytes', () => {
    expect(content).toContain('reviewed_files_all');
    expect(content).toContain('reviewed_file_snapshots');
    expect(workflow).toContain('Capture these now, not');
    expect(workflow).toContain('refuses stale findings');
    expect(dataDirectory).toContain('raw bytes with SHA-256');
    expect(dataDirectory).toContain('not eligible for review-fix');
  });

  test('review-fix documents byte-bound finding lifecycle', () => {
    expect(workflow).toContain('open → fix_authorized → fixed → reverified');
    expect(workflow).toContain('--outcome resolved');
    expect(dataDirectory).toContain('finding-lifecycle.json');
    expect(dataDirectory).toContain('stable content-derived `finding_id`');
  });

  test('contains review-fix triage contract', () => {
    expect(content).toContain('REVIEW-FIX CONTRACT');
    expect(content).toContain('triage checklist');
    expect(content).toContain('fix_now');
  });

  test('fails closed on missing, stale, or empty lens reports before synthesis', () => {
    expect(content).toContain('lens-report-contract.md');
    expect(content).toContain('scripts/validate-reports.mjs');
    expect(workflow).toContain('N/N report coverage');
    expect(workflow).toContain('missing report, empty body');
    expect(content).toContain('Partial coverage forbids LGTM');
  });

  test('recovers delegate transport failures from validated artifacts first', () => {
    expect(content).toContain('Artifact-first recovery');
    expect(workflow).toContain('Delegate transport recovery (artifact first)');
    expect(workflow).toContain('Broken pipe');
    expect(workflow).toContain('validation.json.ok');
    expect(workflow).toContain('request_id');
    expect(workflow).toContain('Never invent a provider-specific retry flag');

    const validatePos = workflow.indexOf('Run `validate-reports.mjs` against the full expected manifest');
    const recoveryPos = workflow.indexOf('execute that command once');
    const redispatchPos = workflow.indexOf('Fresh-agent re-dispatch is the last step');
    expect(validatePos).toBeGreaterThan(0);
    expect(recoveryPos).toBeGreaterThan(validatePos);
    expect(redispatchPos).toBeGreaterThan(recoveryPos);
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

  test('inherits the effective reviewer model instead of pinning sonnet', () => {
    expect(workflow).not.toContain('model: "sonnet"');
    expect(workflow).toContain('omit the Agent `model` parameter');
    expect(workflow).toContain('may never silently substitute Sonnet');
  });

  test('uses panel only as the optional Phase 3 backend', () => {
    expect(content).toContain('x-panel is only the Phase');
    expect(content).toContain('must not run a native panel after x-review');
    expect(content).toContain('review.models');
    expect(content).toContain('two slots may share a provider');
    expect(content).toContain('--models "$REVIEW_MODELS"');
    expect(content).toContain('model sources agreed');
  });

  test('bounds review-fix convergence to one delta re-review', () => {
    expect(content).toContain('One automatic re-review is the default maximum');
    expect(integration).toContain('reviewed_commit');
    expect(integration).toContain('stop and report it');
    expect(integration).toContain('Do not run a');
    expect(integration).toContain('native x-panel review after x-review');
  });
});

// --- x-op SKILL.md structure ---

describe('x-op SKILL.md structure', () => {
  const content = readSkill('x-op');
  const opRoot = join(ROOT, 'x-op', 'skills', 'op');

  test('direct is a routable single-agent baseline strategy, confirmed like any other', () => {
    const directBody = readFileSync(join(opRoot, 'strategies', 'direct.md'), 'utf8');
    expect(directBody).toContain('Phase 1: EXECUTE');
    expect(directBody).toContain('STRATEGY_MULTIPLIERS.direct = 1.0');
    expect(content).toContain('- `direct` → [Strategy: direct]');
    expect(content).toContain('strategies/direct.md');
    // auto-route row + decision-tree leaf, and never a bypass of the confirmation protocol
    expect(content).toMatch(/\| direct \| medium \|/);
    expect(content).toContain('→ direct (one agent');
    expect(content).toContain('`direct` is a recommendation leaf, never a bypass');
    const autoRoute = readFileSync(join(opRoot, 'references', 'x-op-auto-route.md'), 'utf8');
    expect(autoRoute).toContain('**direct**');
  });

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
    // 17 orchestrated strategies + `direct`, the single-agent baseline they are measured against
    expect(routingStrategies).toHaveLength(18);
    expect(routingStrategies).toContain('direct');
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

  test('default path does not create a duplicate build PRD', () => {
    expect(content).toContain('같은 내용을 `.xm/build`에 복제하지 않습니다');
    expect(content).not.toContain('context/PRD.md');
  });

  test('native execution discloses actual models without pinning a tier', () => {
    const modelRouting = content.split('## Model Disclosure')[1]?.split('### Korean output style')[0] || '';
    expect(modelRouting).toContain('실제 model');
    expect(modelRouting).toContain('provider default');
    expect(modelRouting).not.toContain('model: "sonnet"');
  });

  test('plan-check is documented as 15 dimensions', () => {
    const otherCommands = readFileSync(
      join(buildRoot, 'commands', 'other-commands.md'),
      'utf8'
    );
    // The command catalog moved out of SKILL.md into references/commands.md
    // (2026-08-11, 500-line cap). The guarded fact is the dimension COUNT, not
    // which file states it — assert on the file that now owns the catalog.
    const commandsRef = readFileSync(
      join(buildRoot, 'references', 'commands.md'),
      'utf8'
    );

    expect(commandsRef).toContain('15 quality dimensions');
    expect(otherCommands).toContain('15-Dimension Validation');
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

  test('judges/assertion.md routes command-settleable statements to executable assertions', () => {
    expect(assertionJudge).toContain('When NOT to use this judge');
    expect(assertionJudge).toContain('xm eval assert');
    expect(assertionJudge).toContain('UNCERTAIN');
  });

  test('storage-layout.md includes assertion_results field', () => {
    expect(storage).toContain('assertion_results');
    expect(storage).toContain('HARD_FAIL');
    expect(storage).toContain('confidence');
  });
});

// x-solver iterate and x-op hypothesis both run falsifiable hypotheses through a
// fan-out, so the only thing keeping bug work from bouncing between them is a rule
// stated identically in both places. Nothing else in the repo notices if one drifts.
describe('x-solver / x-op boundary', () => {
  const BOUNDARY = 'Use `x-solver iterate` when the run must end in an applied, execution-proven fix';

  test('both skills carry the same boundary sentence', () => {
    expect(readSkill('x-solver')).toContain(BOUNDARY);
    expect(readSkill('x-op')).toContain(BOUNDARY);
    expect(
      readFileSync(join(ROOT, 'x-op', 'skills', 'op', 'strategies', 'hypothesis.md'), 'utf8'),
    ).toContain(BOUNDARY);
  });

  test('x-solver names debugging on its skill-selection surface', () => {
    // The frontmatter description is what decides whether this skill is invoked at
    // all; <Use_When> is only read once it already has been.
    const description = readSkill('x-solver').split('\n').find((line) => line.startsWith('description:'));
    expect(description).toMatch(/bug|debug|diagnos/i);
  });

  test('x-op routes a repair request to x-solver instead of hypothesis', () => {
    const op = readSkill('x-op');
    expect(op).toContain('→ x-solver iterate');
    // hypothesis keeps explanation-only requests.
    expect(op).toContain('why, root cause — explanation only, no fix expected');
  });
});

// iterate lives in its own file because solve.md outgrew the 500-line budget; these
// pin both halves so a future merge or split does not silently drop the gates.
describe('x-solver iterate command file', () => {
  const solverRoot = join(ROOT, 'x-solver', 'skills', 'solver');
  const iterate = readFileSync(join(solverRoot, 'commands', 'iterate.md'), 'utf8');
  const solve = readFileSync(join(solverRoot, 'commands', 'solve.md'), 'utf8');

  test('iterate.md carries the reproduce, refuter and regression gates', () => {
    expect(iterate).toContain('Phase: reproduce');
    expect(iterate).toContain('FAILURE MARKER');
    expect(iterate).toContain('INDEPENDENT REFUTER');
    expect(iterate).toContain('Regression proof');
  });

  test('iterate.md documents three terminating exits when iterations run out', () => {
    expect(iterate).toContain('--unconfirmed narrow');
    expect(iterate).toContain('--extend-iterations');
    expect(iterate).toContain('--abandon');
  });

  test('solve.md points at iterate.md and stays under the line budget', () => {
    expect(solve).toContain('commands/iterate.md');
    expect(solve.split('\n').length).toBeLessThan(500);
    expect(iterate.split('\n').length).toBeLessThan(500);
  });
});
