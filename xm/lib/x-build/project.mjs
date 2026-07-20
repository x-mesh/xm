/**
 * x-build/project — Project management commands
 */

import {
  PHASES, TASK_STATES, C,
  readJSON, writeJSON, readMD, writeMD,
  manifestPath, phaseStatusPath, tasksPath, stepsPath, prdPath, contextDir, projectDir,
  projectsDir, checkpointsDir, phaseDir, toSlug,
  resolveProject, findCurrentProject, findActiveProjects, logDecision,
  loadConfig, loadSharedConfig, resolveGates, requiresSignoff, autopilotActive, isNormalMode, L, renderBar, fmtDuration,
  setCmdInit,
  existsSync, readdirSync, mkdirSync, join, readFileSync, writeFileSync,
  createRL, ask, pickMenu,
  parseOptions,
  decisionsPath, metricsPath,
  execSync,
  exitFail,
  repoRoot, gaugeProjectKind,
} from './core.mjs';

// ── cmdInit ─────────────────────────────────────────────────────────

export function cmdInit(args) {
  const name = args[0];
  if (!name) {
    console.error('Usage: x-build init <project-name>');
    exitFail(1);
  }

  const slug = toSlug(name);

  if (existsSync(manifestPath(slug))) {
    console.error(`❌ Project "${slug}" already exists.`);
    exitFail(1);
  }

  const now = new Date().toISOString();
  // Computed once, at init time — kind() may change later (e.g. the user
  // adds source files), but the manifest records what the project looked
  // like the moment x-build started managing it.
  const projectKind = gaugeProjectKind(repoRoot()).kind;
  const manifest = {
    name: slug,
    display_name: name,
    current_phase: '01-research',
    created_at: now,
    updated_at: now,
    project_kind: projectKind,
  };

  writeJSON(manifestPath(slug), manifest);

  for (const phase of PHASES) {
    const status = {
      phase: phase.name,
      status: phase.id === '01-research' ? 'active' : 'pending',
      started_at: phase.id === '01-research' ? now : null,
      completed_at: null,
    };
    writeJSON(phaseStatusPath(slug, phase.id), status);
  }

  writeMD(join(contextDir(slug), 'brief.md'), `# ${name} — Context Brief\n\nProject initialized at ${now}.\n`);
  writeMD(join(contextDir(slug), 'decisions.md'), `# ${name} — Decisions Log\n\n`);

  writeMD(join(phaseDir(slug, '01-research'), 'notes.md'), `# Research Notes\n\n`);
  writeMD(join(phaseDir(slug, '02-plan'), 'roadmap.md'), `# Roadmap\n\n`);
  writeJSON(tasksPath(slug), { tasks: [] });
  writeMD(join(phaseDir(slug, '04-verify'), 'checklist.md'), `# Verification Checklist\n\n`);
  writeMD(join(phaseDir(slug, '05-close'), 'summary.md'), `# Project Summary\n\n`);

  mkdirSync(checkpointsDir(slug), { recursive: true });

  console.log(`✅ Project "${slug}" initialized.`);
  console.log(`📁 ${projectDir(slug)}`);
  console.log(`📍 Current phase: Research`);
  console.log(`→ Next: x-build discuss --mode interview   (resolve open questions, then: plan "goal")`);
  return slug;
}

// Register cmdInit for resolveProject's autoInit
setCmdInit(cmdInit);

// ── cmdList ─────────────────────────────────────────────────────────

export function cmdList() {
  const dir = projectsDir();
  if (!existsSync(dir)) {
    console.log('No projects found.');
    return;
  }
  const projects = readdirSync(dir).filter(d => existsSync(manifestPath(d)));
  if (projects.length === 0) {
    console.log('No projects found.');
    return;
  }

  console.log('Projects:\n');
  for (const p of projects) {
    const m = readJSON(manifestPath(p));
    const phase = PHASES.find(ph => ph.id === m.current_phase);
    console.log(`  ${p}  →  ${phase?.label || m.current_phase}  (${m.created_at.slice(0, 10)})`);
  }
}

// ── cmdStatus ───────────────────────────────────────────────────────

// ── buildProjectState ─────────────────────────────────────────────
// Single source of truth: assembles project state from distributed files.
// Consumed by: cmdStatus --json, dashboard /api/state/, cmdStatus --save.

export function buildProjectState(project) {
  const manifest = readJSON(manifestPath(project));
  if (!manifest) return null;

  const phase = PHASES.find(p => p.id === manifest.current_phase);
  const taskData = readJSON(tasksPath(project));
  const tasks = taskData?.tasks || [];
  const decisionsData = readJSON(decisionsPath(project));
  const decisions = decisionsData?.decisions || [];

  // Phase progress — carries the resolved exit-gate type and the last gate-decision
  // ledger (gate_type/passed/passed_by/ts) so CI and dashboards see gate state, not
  // just phase status.
  const gates = resolveGates();
  const phases = PHASES.map(p => {
    const s = readJSON(phaseStatusPath(project, p.id));
    return {
      id: p.id, name: p.name, label: p.label,
      status: s?.status || 'pending',
      started_at: s?.started_at || null, completed_at: s?.completed_at || null,
      gate_type: gates[`${p.name}-exit`] || 'auto',
      gate: s?.gate || null,
    };
  });
  const completedPhases = phases.filter(p => p.status === 'completed').length;

  // Task progress
  const completed = tasks.filter(t => t.status === TASK_STATES.COMPLETED).length;
  const failed = tasks.filter(t => t.status === TASK_STATES.FAILED).length;
  const pending = tasks.filter(t => ![TASK_STATES.COMPLETED, TASK_STATES.CANCELLED].includes(t.status));

  // Cost from metrics
  let spent = 0;
  try {
    const mp = metricsPath();
    if (existsSync(mp)) {
      const lines = readFileSync(mp, 'utf8').trim().split('\n');
      for (const line of lines) {
        try { const m = JSON.parse(line); if (typeof m.cost_usd === 'number' && m.project === project) spent += m.cost_usd; } catch {}
      }
    }
  } catch {}

  // Context files
  const contextFiles = {
    context: existsSync(join(contextDir(project), 'CONTEXT.md')),
    requirements: existsSync(join(contextDir(project), 'REQUIREMENTS.md')),
    roadmap: existsSync(join(contextDir(project), 'ROADMAP.md')),
    prd: existsSync(prdPath(project)),
  };

  // Steps
  const stData = readJSON(stepsPath(project));
  const stepsTotal = stData?.steps?.length || 0;
  const stepsDone = stData?.steps?.filter(w => w.tasks.every(id => tasks.find(t => t.id === id)?.status === TASK_STATES.COMPLETED)).length || 0;

  // Quality
  const scoredTasks = tasks.filter(t => t.score != null);
  const avgScore = scoredTasks.length > 0 ? scoredTasks.reduce((s, t) => s + t.score, 0) / scoredTasks.length : null;

  return {
    project,
    display_name: manifest.display_name || project,
    phase: { id: phase?.id, name: phase?.name, label: phase?.label },
    phase_progress: { completed: completedPhases, total: PHASES.length },
    // Per-phase detail carrying the resolved exit-gate type + last gate-decision
    // ledger (gate_type/passed/passed_by/ts) so CI and dashboards can read gate state.
    phases,
    tasks: {
      total: tasks.length,
      completed,
      failed,
      pending: pending.map(t => ({ id: t.id, name: t.name, status: t.status, deps: t.depends_on || [] })),
    },
    steps: { total: stepsTotal, completed: stepsDone },
    cost: { spent: Math.round(spent * 10000) / 10000 },
    quality: avgScore != null ? { avg_score: Math.round(avgScore * 10) / 10 } : null,
    recent_decisions: decisions.slice(-5).map(d => d.title || d.message || ''),
    context_files: contextFiles,
    created_at: manifest.created_at,
    updated_at: manifest.updated_at,
    built_at: new Date().toISOString(),
  };
}

// ── stateToMarkdown ───────────────────────────────────────────────

function stateToMarkdown(state) {
  if (!state) return '# STATE\n\nNo project found.\n';
  const lines = [];
  lines.push(`# STATE: ${state.display_name}`);
  lines.push('');
  lines.push(`- **Phase:** ${state.phase.label} (${state.phase_progress.completed}/${state.phase_progress.total})`);
  lines.push(`- **Created:** ${state.created_at?.slice(0, 10) || '?'}`);
  lines.push(`- **Built:** ${state.built_at?.slice(0, 19) || '?'}`);
  lines.push('');

  // Tasks
  if (state.tasks.total > 0) {
    lines.push(`## Tasks (${state.tasks.completed}/${state.tasks.total})`);
    if (state.tasks.failed > 0) lines.push(`- Failed: ${state.tasks.failed}`);
    if (state.tasks.pending.length > 0) {
      lines.push('');
      lines.push('### Pending');
      for (const t of state.tasks.pending) {
        const deps = t.deps.length > 0 ? ` (deps: ${t.deps.join(', ')})` : '';
        lines.push(`- [${t.id}] ${t.name} — ${t.status}${deps}`);
      }
    }
    lines.push('');
  }

  // Steps
  if (state.steps.total > 0) {
    lines.push(`## Steps: ${state.steps.completed}/${state.steps.total}`);
    lines.push('');
  }

  // Cost
  if (state.cost.spent > 0) {
    lines.push(`## Cost: $${state.cost.spent.toFixed(4)}`);
    lines.push('');
  }

  // Quality
  if (state.quality) {
    lines.push(`## Quality: ${state.quality.avg_score}/10`);
    lines.push('');
  }

  // Decisions
  if (state.recent_decisions.length > 0) {
    lines.push('## Recent Decisions');
    for (const d of state.recent_decisions) lines.push(`- ${d}`);
    lines.push('');
  }

  // Context files
  lines.push('## Artifacts');
  for (const [k, v] of Object.entries(state.context_files)) {
    lines.push(`- ${k}: ${v ? '✅' : '⬜'}`);
  }
  lines.push('');

  return lines.join('\n');
}

export function cmdStatus(args) {
  const opts = parseOptions(args);
  const isJson = args.includes('--json');
  const isSave = args.includes('--save');
  const explicitName = opts.positional[0] || args.find(a => !a.startsWith('--'));
  const name = resolveProject(explicitName, { autoInit: true });
  const manifest = readJSON(manifestPath(name));
  if (!manifest) {
    if (isJson) { console.log(JSON.stringify({ error: 'no_project' })); return; }
    console.log('No project found. Run: x-build init <name>');
    return;
  }

  // Multi-active ambiguity warning — only when caller didn't disambiguate.
  // findActiveProjects returns all manifest-bearing projects sorted by manifest mtime descending.
  // If more than one exists and the user didn't pass a name, surface the list so
  // they don't read "wrong project" output as truth. JSON mode emits the list as
  // a metadata field instead of corrupting the structured output.
  if (!explicitName) {
    const all = findActiveProjects();
    if (all.length > 1) {
      const others = all.filter(p => p.name !== name).map(p => p.name);
      if (isJson) {
        // Re-emit JSON with disambiguation note appended in buildProjectState path below.
        // We can't mutate from here, so stash on a module-scoped marker via stderr.
        process.stderr.write(JSON.stringify({ warning: 'multi_active', active: all.map(p => p.name), showing: name }) + '\n');
      } else {
        console.log(`${C.yellow}⚠ Multiple active projects detected: ${all.map(p => p.name).join(', ')}${C.reset}`);
        console.log(`${C.dim}  Showing "${name}" (most recently updated). To disambiguate: x-build status <name>${C.reset}`);
        console.log('');
      }
    }
  }

  // --json: output structured state for API/Claude consumption
  if (isJson) {
    const state = buildProjectState(name);
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  // --save: generate STATE.md file
  if (isSave) {
    const state = buildProjectState(name);
    const md = stateToMarkdown(state);
    const statePath = join(projectDir(name), 'STATE.md');
    writeFileSync(statePath, md, 'utf8');
    console.log(`✅ STATE.md saved: ${statePath}`);
    return;
  }

  const config = loadConfig();

  const completedPhases = PHASES.filter(p => {
    const s = readJSON(phaseStatusPath(name, p.id));
    return s?.status === 'completed';
  }).length;

  const normal = isNormalMode();

  if (normal) {
    console.log(`\n${C.bold}${C.cyan}📋 프로젝트: ${manifest.display_name || name}${C.reset}`);
    console.log(`   시작일: ${manifest.created_at.slice(0, 10)}  전체 진행률: ${renderBar(completedPhases, PHASES.length, 15)}`);
  } else {
    console.log(`\n${C.bold}${C.cyan}📋 ${manifest.display_name || name}${C.reset}`);
    console.log(`   Created: ${manifest.created_at.slice(0, 10)}  ${renderBar(completedPhases, PHASES.length, 15)}`);
  }
  if (autopilotActive()) {
    // Name the decision gates that still block. Without this line an autopilot user
    // who hits plan-exit thinks the flag is broken, instead of seeing it working as
    // designed (confirmations passed, direction approval kept).
    const blocking = PHASES
      .map(p => [p, resolveGates()[`${p.name}-exit`]])
      .filter(([, t]) => t === 'decision')
      .map(([p]) => p.label);
    console.log(normal
      ? `   ${C.yellow}🚀 오토파일럿 ON — 단계 확인 없이 자동 진행 (품질 검사·계획 검증은 유지)${C.reset}`
      : `   ${C.yellow}🚀 autopilot ON — phase confirmations auto-passed (quality + plan-check still enforced)${C.reset}`);
    if (blocking.length) {
      console.log(normal
        ? `   ${C.dim}   단, ${blocking.join(', ')} 종료 시 방향 승인은 그대로 멈춥니다 (gate pass 필요)${C.reset}`
        : `   ${C.dim}   still blocking: ${blocking.join(', ')} exit (decision gate — needs gate pass)${C.reset}`);
    }
  }
  console.log('');

  const gates = resolveGates();
  for (const phase of PHASES) {
    const status = readJSON(phaseStatusPath(name, phase.id));
    const isCurrent = phase.id === manifest.current_phase;
    const gateKey = `${phase.name}-exit`;
    const gateType = gates[gateKey] || 'auto';

    let icon = '⬜';
    let color = C.dim;
    let stateLabel = normal ? '아직 안 함' : '';
    if (status?.status === 'completed') { icon = '✅'; color = C.green; stateLabel = normal ? '완료!' : ''; }
    else if (status?.status === 'active') { icon = '🔵'; color = C.blue; stateLabel = normal ? '지금 하는 중' : ''; }
    else if (status?.status === 'failed') { icon = '❌'; color = C.red; stateLabel = normal ? '문제 발생' : ''; }

    let dur = '';
    if (status?.started_at) {
      const end = status.completed_at ? new Date(status.completed_at) : new Date();
      const elapsed = end - new Date(status.started_at);
      dur = normal ? ` ${C.dim}(${fmtDuration(elapsed)} 걸림)${C.reset}` : ` ${C.dim}(${fmtDuration(elapsed)})${C.reset}`;
    }

    const marker = isCurrent ? ` ${C.yellow}← 여기${C.reset}` : '';
    const gate = status?.status !== 'completed' ? ` ${C.dim}[${L(gateType)}]${C.reset}` : '';
    const label = normal ? L(phase.label) : phase.label;
    const extra = stateLabel && normal ? ` ${C.dim}${stateLabel}${C.reset}` : '';
    console.log(`  ${icon} ${color}${label}${C.reset}${gate}${dur}${extra}${marker}`);
  }

  // Show task summary if in plan/execute phase
  if (['02-plan', '03-execute'].includes(manifest.current_phase)) {
    const tasks = readJSON(tasksPath(name));
    if (tasks?.tasks?.length > 0) {
      const total = tasks.tasks.length;
      const done = tasks.tasks.filter(t => t.status === TASK_STATES.COMPLETED).length;
      const failed = tasks.tasks.filter(t => t.status === TASK_STATES.FAILED).length;
      const taskLabel = normal ? '할 일' : 'Tasks';
      const failLabel = normal ? `${failed}개 문제` : `${failed} failed`;
      console.log(`\n📊 ${taskLabel}: ${renderBar(done, total)}${failed ? ` ${C.red}(${failLabel})${C.reset}` : ''}`);

      const scoredTasks = tasks.tasks.filter(t => t.score != null);
      if (scoredTasks.length > 0) {
        const avg = scoredTasks.reduce((s, t) => s + t.score, 0) / scoredTasks.length;
        const belowThreshold = scoredTasks.filter(t => t.score < 7).length;
        console.log(`\n  Project Quality: ${avg.toFixed(1)}/10 avg${belowThreshold > 0 ? ` (${belowThreshold} below threshold)` : ''}`);
      }
    }

    const stData = readJSON(stepsPath(name));
    if (stData?.steps?.length > 0) {
      const doneSteps = stData.steps.filter(w => {
        const taskData = readJSON(tasksPath(name));
        return w.tasks.every(id => taskData?.tasks?.find(t => t.id === id)?.status === TASK_STATES.COMPLETED);
      }).length;
      console.log(`🔹 Steps: ${renderBar(doneSteps, stData.steps.length, 10)}`);
    }
  }

  // Next action suggestion based on current phase
  const phase = PHASES.find(p => p.id === manifest.current_phase);
  const suggestions = {
    research: ['x-build discuss --mode interview', 'x-build research'],
    plan: ['x-build plan "goal"', 'x-build plan-check', 'x-build phase next'],
    execute: ['x-build run', 'x-build run-status'],
    verify: ['x-build quality', 'x-build verify-coverage', 'x-build verify-traceability'],
    close: ['x-build close --summary "..."'],
  };
  const normalHints = {
    research: '요구사항을 정리하는 인터뷰를 시작합니다',
    plan: '목표를 할 일 목록으로 나눕니다',
    execute: '다음 할 일을 실행합니다',
    verify: '결과물을 검사합니다',
    close: '프로젝트를 마무리합니다',
  };
  const actions = suggestions[phase?.name] || [];
  if (actions.length > 0) {
    const label = normal ? '💡 다음 단계' : '💡 Next';
    const hint = normal && normalHints[phase?.name] ? ` ${C.dim}— ${normalHints[phase.name]}${C.reset}` : '';
    console.log(`  ${label}: ${C.cyan}${actions[0]}${C.reset}${hint}`);
  }

  console.log('');
}

// ── cmdClose ────────────────────────────────────────────────────────

export function cmdClose(args) {
  const { opts } = parseOptions(args);
  const project = resolveProject(null);
  const manifest = readJSON(manifestPath(project));
  const now = new Date().toISOString();

  for (const phase of PHASES) {
    const status = readJSON(phaseStatusPath(project, phase.id));
    if (phase.id === '05-close') {
      status.status = 'active';
      status.started_at = now;
    } else if (status.status !== 'completed') {
      status.status = 'completed';
      status.completed_at = now;
    }
    writeJSON(phaseStatusPath(project, phase.id), status);
  }

  manifest.current_phase = '05-close';
  manifest.updated_at = now;

  const taskData = readJSON(tasksPath(project));
  const total = taskData?.tasks?.length || 0;
  const done = taskData?.tasks?.filter(t => t.status === TASK_STATES.COMPLETED).length || 0;
  const decisions = readMD(join(contextDir(project), 'decisions.md'));

  const summaryContent = opts.summary || '';
  const summary = [
    `# Project Summary: ${manifest.display_name || project}`,
    '',
    `**Created:** ${manifest.created_at.slice(0, 10)}`,
    `**Closed:** ${now.slice(0, 10)}`,
    `**Tasks:** ${done}/${total} completed`,
    '',
    summaryContent ? `## Summary\n${summaryContent}\n` : '',
    '## Decisions',
    decisions.split('\n').filter(l => l.startsWith('- ')).join('\n') || '(none)',
    '',
  ].join('\n');

  writeMD(join(phaseDir(project, '05-close'), 'summary.md'), summary);

  const closeStatus = readJSON(phaseStatusPath(project, '05-close'));
  closeStatus.status = 'completed';
  closeStatus.completed_at = now;
  writeJSON(phaseStatusPath(project, '05-close'), closeStatus);
  manifest.current_phase = '05-close';
  writeJSON(manifestPath(project), manifest);

  logDecision(project, `Project closed.${summaryContent ? ` Summary: ${summaryContent}` : ''}`);
  console.log(`✅ Project "${project}" closed.`);
  console.log(`📄 Summary: ${join(phaseDir(project, '05-close'), 'summary.md')}`);
}

// ── cmdDashboard ────────────────────────────────────────────────────

export function cmdDashboard() {
  const dir = projectsDir();
  if (!existsSync(dir)) { console.log('No projects.'); return; }
  const projects = readdirSync(dir).filter(d => existsSync(manifestPath(d)));
  if (projects.length === 0) { console.log('No projects.'); return; }

  console.log(`\n${C.bold}${C.cyan}📊 x-build Dashboard${C.reset}\n`);

  const header = `  ${C.bold}${'Project'.padEnd(20)} ${'Phase'.padEnd(12)} ${'Tasks'.padEnd(12)} Health${C.reset}`;
  console.log(header);
  console.log(`  ${'─'.repeat(55)}`);

  for (const p of projects) {
    const m = readJSON(manifestPath(p));
    const phase = PHASES.find(ph => ph.id === m.current_phase);
    const taskData = readJSON(tasksPath(p));
    const total = taskData?.tasks?.length || 0;
    const done = taskData?.tasks?.filter(t => t.status === TASK_STATES.COMPLETED).length || 0;
    const failed = taskData?.tasks?.filter(t => t.status === TASK_STATES.FAILED).length || 0;

    let health = '🟢';
    if (failed > 0) health = '🔴';
    else if (total > 0 && done < total / 2) health = '🟡';

    const taskStr = total > 0 ? `${done}/${total}` : '-';
    console.log(`  ${p.padEnd(20)} ${(phase?.label || '?').padEnd(12)} ${taskStr.padEnd(12)} ${health}`);
  }
  console.log('');
}

// ── Interactive ─────────────────────────────────────────────────────

export async function interactiveInit() {
  const rl = createRL();
  try {
    const name = await ask(rl, '  프로젝트 이름: ');
    if (name.trim()) {
      cmdInit([name.trim()]);
    } else {
      console.log('  ⚠ 이름이 비어있습니다.');
    }
  } finally {
    rl.close();
  }
}

export async function interactiveDashboard() {
  const rl = createRL();
  const config = loadConfig();

  try {
    const current = findCurrentProject();

    if (!current) {
      console.log('\n⚙️  x-build — Phase-Based Project Harness\n');
      console.log('  프로젝트가 없습니다.\n');
      const name = await ask(rl, '  새 프로젝트 이름 (취소: Enter): ');
      if (name.trim()) {
        cmdInit([name.trim()]);
      }
      rl.close();
      return;
    }

    // Import needed functions lazily to avoid circular deps
    const { taskList, taskUpdate } = await import('./tasks.mjs');
    const { stepsCompute, stepsStatus, stepsNext } = await import('./tasks.mjs');
    const { cmdCheckpoint } = await import('./phase.mjs');
    const { cmdGate } = await import('./phase.mjs');

    let running = true;
    while (running) {
      cmdStatus([current]);

      const manifest = readJSON(manifestPath(current));
      const actions = getPhaseActions(manifest, config);

      const allActions = [
        ...actions,
        { label: '─────────────────', action: 'separator' },
        { label: '📊 전체 상태 보기', action: 'status' },
        { label: '📄 Context Brief 생성', action: 'context' },
        { label: '📋 프로젝트 목록', action: 'list' },
        { label: '🆕 새 프로젝트 생성', action: 'new-project' },
      ].filter(a => a.action !== 'separator');

      const choice = await pickMenu(rl, '🔧 액션 선택:', allActions);

      if (!choice) { running = false; break; }

      switch (choice.action) {
        case 'phase-next': {
          const { phaseNext } = await import('./phase.mjs');
          phaseNext([current]);
          break;
        }

        case 'gate-pass': {
          const msg = await ask(rl, '  승인 메시지 (선택): ');
          cmdGate(['pass', ...(msg.trim() ? [msg.trim()] : [])]);
          break;
        }

        case 'task-add': {
          const { interactiveTaskAdd } = await import('./tasks.mjs');
          await interactiveTaskAdd(rl, current);
          break;
        }

        case 'task-list':
          taskList(current);
          break;

        case 'task-update': {
          const { interactiveTaskUpdate } = await import('./tasks.mjs');
          await interactiveTaskUpdate(rl, current);
          break;
        }

        case 'step-compute':
          stepsCompute(current);
          break;

        case 'step-status':
          stepsStatus(current);
          break;

        case 'step-next':
          stepsNext(current);
          break;

        case 'checkpoint': {
          const { interactiveCheckpoint } = await import('./phase.mjs');
          await interactiveCheckpoint(rl, current);
          break;
        }

        case 'context': {
          const { cmdContext } = await import('./misc.mjs');
          cmdContext([current]);
          break;
        }

        case 'show-notes': {
          const notesFile = join(phaseDir(current, '01-research'), 'notes.md');
          console.log(`\n📝 리서치 노트: ${notesFile}`);
          console.log(readMD(notesFile) || '  (비어있음)');
          break;
        }

        case 'close': {
          const summary = await ask(rl, '  종료 요약 (선택): ');
          cmdClose(summary.trim() ? ['--summary', summary.trim()] : []);
          running = false;
          break;
        }

        case 'status':
          cmdStatus([current]);
          break;

        case 'list':
          cmdList();
          break;

        case 'new-project': {
          const name = await ask(rl, '  프로젝트 이름: ');
          if (name.trim()) cmdInit([name.trim()]);
          break;
        }
      }

      if (running) {
        const cont = await ask(rl, '\n  계속하려면 Enter (종료: q): ');
        if (cont.trim().toLowerCase() === 'q') running = false;
      }
    }
  } finally {
    rl.close();
  }

  console.log('\n👋 x-build 종료.\n');
}

// ── cmdHandoffFull ───────────────────────────────────────────────────

export function cmdHandoffFull(args) {
  const opts = parseOptions(args);

  // Git info
  let branch = '', lastCommits = [], uncommittedFiles = [], ahead = 0, behind = 0, commitsToday = [];
  try {
    branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    lastCommits = execSync('git log --oneline -5', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    uncommittedFiles = execSync('git status --short', { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(l => l.trim());
    const ab = execSync('git rev-list --left-right --count origin/' + branch + '...HEAD 2>/dev/null || echo "0 0"', { encoding: 'utf8' }).trim().split(/\s+/);
    behind = parseInt(ab[0]) || 0;
    ahead = parseInt(ab[1]) || 0;
    commitsToday = execSync('git log --oneline --since="24 hours ago"', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {}

  // Active projects
  const activeProjects = [];
  const allDecisions = [];
  const projDir = projectsDir();
  if (existsSync(projDir)) {
    for (const entry of readdirSync(projDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mPath = join(projDir, entry.name, 'manifest.json');
      if (!existsSync(mPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(mPath, 'utf8'));
        const phase = PHASES.find(p => p.id === manifest.current_phase);

        // Tasks
        let taskTotal = 0, taskCompleted = 0, pendingTasks = [];
        const phasesDir = join(projDir, entry.name, 'phases');
        if (existsSync(phasesDir)) {
          for (const ph of readdirSync(phasesDir, { withFileTypes: true })) {
            if (!ph.isDirectory()) continue;
            const tp = join(phasesDir, ph.name, 'tasks.json');
            if (existsSync(tp)) {
              try {
                const td = JSON.parse(readFileSync(tp, 'utf8'));
                const tasks = td.tasks || [];
                taskTotal = tasks.length;
                taskCompleted = tasks.filter(t => t.status === 'completed').length;
                pendingTasks = tasks.filter(t => !['completed', 'cancelled'].includes(t.status)).map(t => t.name).slice(0, 3);
              } catch {}
              break;
            }
          }
        }

        // Decisions
        const dmPath = join(projDir, entry.name, 'context', 'decisions.md');
        const djPath = join(projDir, entry.name, 'context', 'decisions.json');
        let decs = [];
        if (existsSync(djPath)) {
          try { decs = (JSON.parse(readFileSync(djPath, 'utf8')).decisions || []).slice(-3).map(d => ({ what: d.title || d.message, why: d.rationale || '' })); } catch {}
        } else if (existsSync(dmPath)) {
          try { decs = readFileSync(dmPath, 'utf8').split('\n').filter(l => l.startsWith('- ')).slice(-3).map(l => ({ what: l.slice(2).trim(), why: '' })); } catch {}
        }
        for (const d of decs) allDecisions.push({ ...d, project: entry.name });

        const isClosed = manifest.current_phase === '05-close';
        if (!isClosed) {
          activeProjects.push({
            name: entry.name,
            phase: phase?.label || manifest.current_phase,
            tasks: `${taskCompleted}/${taskTotal}`,
            pending: pendingTasks,
          });
        }
      } catch {}
    }
  }

  // Recent traces
  const traces = [];
  const tracesDir = join(repoRoot(), '.xm', 'traces');
  if (existsSync(tracesDir)) {
    const files = readdirSync(tracesDir).filter(f => f.endsWith('.jsonl')).sort().reverse().slice(0, 5);
    for (const f of files) {
      try {
        const lines = readFileSync(join(tracesDir, f), 'utf8').trim().split('\n');
        const first = JSON.parse(lines[0]);
        const agentCount = lines.filter(l => l.includes('"agent_step"')).length;
        traces.push({ name: f.replace('.jsonl', ''), skill: first.skill || first.source || '?', agents: agentCount });
      } catch {}
    }
  }

  // Quality scores from .xm/eval — keep latest per target
  const qualityScores = {};
  const evalDir = join(repoRoot(), '.xm', 'eval', 'results');
  if (existsSync(evalDir)) {
    const files = readdirSync(evalDir).filter(f => f.endsWith('-score.json')).sort();
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(evalDir, f), 'utf8'));
        if (data.target && data.overall) qualityScores[data.target] = data.overall;
      } catch {}
    }
  }

  // Test status
  let testStatus = null;
  try {
    const result = execSync('bun test 2>&1 | tail -3', { encoding: 'utf8', timeout: 60000 });
    const match = result.match(/(\d+)\s+pass/);
    const failMatch = result.match(/(\d+)\s+fail/);
    if (match) testStatus = `${match[1]} pass, ${failMatch ? failMatch[1] : 0} fail`;
  } catch {}

  // Key files (most changed recently)
  let keyFiles = [];
  try {
    keyFiles = execSync('git diff --stat HEAD~10 -- "*.mjs" "*.js" "*.ts" 2>/dev/null | head -5', { encoding: 'utf8' })
      .trim().split('\n').filter(l => l.includes('|')).map(l => l.split('|')[0].trim()).slice(0, 5);
  } catch {}

  // Diff summary for uncommitted changes (staged + unstaged)
  let diffSummary = '';
  try {
    const unstaged = execSync('git diff --shortstat 2>/dev/null', { encoding: 'utf8' }).trim();
    const staged = execSync('git diff --cached --shortstat 2>/dev/null', { encoding: 'utf8' }).trim();
    const parts = [staged, unstaged].filter(Boolean);
    if (parts.length) diffSummary = parts.join(' | ');
  } catch {}

  // Stash info
  let stashes = [];
  try {
    stashes = execSync('git stash list 2>/dev/null', { encoding: 'utf8' }).trim().split('\n').filter(Boolean).slice(0, 3);
  } catch {}

  // Narrative: conversation-level context the leader composes before dispatch.
  // Passed as `--narrative-json '{"intent":"...","open_questions":[...], ...}'`.
  // Fields: intent, open_questions, rejected_alternatives, next_session_should_know.
  let narrative = null;
  // Tier-2 detailed archive (retrieval-only). Composed by the leader alongside
  // the compact narrative but kept OUT of what handon auto-injects — see cmdHandon.
  let sessionLog = null;
  let narrativeValueIdx = -1; // exclude from positional reason scan
  const njIdx = args.findIndex(a => a === '--narrative-json' || a.startsWith('--narrative-json='));
  if (njIdx !== -1) {
    let raw;
    if (args[njIdx].startsWith('--narrative-json=')) {
      raw = args[njIdx].slice('--narrative-json='.length);
    } else {
      raw = args[njIdx + 1];
      narrativeValueIdx = njIdx + 1;
    }
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        narrative = {
          intent: typeof parsed.intent === 'string' ? parsed.intent : '',
          open_questions: Array.isArray(parsed.open_questions) ? parsed.open_questions : [],
          rejected_alternatives: Array.isArray(parsed.rejected_alternatives) ? parsed.rejected_alternatives : [],
          next_session_should_know: Array.isArray(parsed.next_session_should_know) ? parsed.next_session_should_know : [],
        };
        if (parsed.session_log && typeof parsed.session_log === 'object') {
          const strArr = (x) => (Array.isArray(x) ? x.filter(v => typeof v === 'string' && v.trim()) : []);
          const sl = {
            rejected: strArr(parsed.session_log.rejected),
            open_forks: strArr(parsed.session_log.open_forks),
            constraints_prefs: strArr(parsed.session_log.constraints_prefs),
            attempts: strArr(parsed.session_log.attempts),
          };
          if (sl.rejected.length || sl.open_forks.length || sl.constraints_prefs.length || sl.attempts.length) {
            sessionLog = sl;
          }
        }
      } catch (e) {
        console.error(`⚠️  Invalid --narrative-json (${e.message}); narrative will be omitted.`);
      }
    }
  }

  const reason = args.find((a, i) => i !== narrativeValueIdx && !a.startsWith('--')) || opts.reason || opts.summary || null;

  const state = {
    v: 1,
    saved_at: new Date().toISOString(),

    where: {
      branch,
      last_commits: lastCommits.slice(0, 5),
      uncommitted_files: uncommittedFiles.slice(0, 10),
      ahead, behind,
    },

    what_done: commitsToday.slice(0, 10),

    what_remains: {
      active_projects: activeProjects,
      uncommitted: uncommittedFiles.filter(l => l.startsWith('M') || l.startsWith('??') || l.startsWith(' M')).map(l => l.replace(/^[A-Z? ]+/, '').trim()).slice(0, 10),
      ideas: [],
    },

    decisions: allDecisions.slice(-10),

    context: {
      current_focus: commitsToday.length > 0
        ? [...new Set(commitsToday.map(c => c.replace(/^[a-f0-9]+ /, '')))].filter(m => !m.includes('[COMPLETED]') && !m.startsWith('Merge ')).slice(0, 3).join(' | ') || commitsToday[0].replace(/^[a-f0-9]+ /, '')
        : '',
      blockers: [],
      key_files: keyFiles,
      test_status: testStatus,
      quality_scores: qualityScores,
      diff_summary: diffSummary || null,
      stashes: stashes.length ? stashes : undefined,
    },

    narrative,

    // Tier-2: detailed archive. Persisted here and rendered into HANDOFF.md, but
    // stripped to a summary by `handon --json` so it never enters leader context
    // by default. Load on demand with `handon --log`.
    session_log: sessionLog,

    why_stopped: reason || 'Session handoff',
  };

  // Save
  const buildDir = join(repoRoot(), '.xm', 'build');
  mkdirSync(buildDir, { recursive: true });
  const statePath = join(buildDir, 'SESSION-STATE.json');
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');

  // Also emit a tool-neutral HANDOFF.md so sessions that cannot run the
  // handoff/handon skills (Codex, Cursor) read the same context in plain
  // markdown. Best-effort: never fail the handoff over the markdown mirror.
  // Keep the format in sync with x-recall/lib/x-recall/handoff-md.mjs.
  try {
    writeFileSync(join(buildDir, 'HANDOFF.md'), _sessionStateToHandoffMd(state), 'utf8');
  } catch { /* best-effort mirror */ }

  // Render the mem-mesh payload deterministically so the skill only has to hand
  // it to `mcp__mem-mesh__add` — no hand-built JSON, no schema guessing.
  // Overwriting an unrepaired mirror destroys the only copy of a session that
  // never reached mem-mesh. We still overwrite (this handoff is the current
  // state) but never silently — the user gets one chance to notice.
  const prevMirror = readMirrorState();
  if (prevMirror?.status === 'pending') {
    console.error(`⚠️  Overwriting a PENDING mem-mesh mirror from ${prevMirror.created_at || 'an earlier handoff'} — that session never reached mem-mesh and its payload is now lost.`);
  } else if (prevMirror?.status === 'unreadable') {
    console.error(`⚠️  Replacing an unreadable mem-mesh mirror file (${prevMirror.error}).`);
  }

  // `memmesh.mirror: false` opts a file-only setup out entirely — without it the
  // pending warning recurs on every restore for users who have no mem-mesh at all,
  // and --mirror-skip only silences one handoff at a time.
  // scope 'either' → the shared local/global resolver, NOT loadConfig() (which
  // reads .xm/build/config.json, a different layer).
  const mirrorEnabled = loadSharedConfig()?.memmesh?.mirror !== false;
  const mirror = mirrorEnabled ? buildMemMeshMirror(state) : null;
  let mirrorWritten = false;
  if (mirror) {
    try {
      writeFileSync(mirrorPath(), JSON.stringify(mirror, null, 2) + '\n', 'utf8');
      mirrorWritten = true;
    } catch (e) {
      console.error(`⚠️  Could not write mem-mesh mirror payload: ${e.message}`);
    }
  }

  console.log(`✅ Session state saved: ${statePath}`);
  console.log(`   Branch: ${branch} (+${ahead} ahead)`);
  console.log(`   Commits today: ${commitsToday.length}`);
  console.log(`   Active projects: ${activeProjects.length}`);
  console.log(`   Decisions: ${allDecisions.length}`);
  if (uncommittedFiles.length) console.log(`   Uncommitted: ${uncommittedFiles.length} files`);
  if (narrative) {
    const oq = narrative.open_questions.length;
    const ra = narrative.rejected_alternatives.length;
    const nk = narrative.next_session_should_know.length;
    console.log(`   Narrative: intent${narrative.intent ? ' ✓' : ' —'}, ${oq} open Q, ${ra} rejected alt, ${nk} next-session note(s)`);
  } else {
    console.log(`   Narrative: (not provided — pass --narrative-json to capture intent / open questions)`);
  }
  if (sessionLog) {
    const n = sessionLog.rejected.length + sessionLog.open_forks.length + sessionLog.constraints_prefs.length + sessionLog.attempts.length;
    console.log(`   Session log: ${n} detailed item(s) archived (retrieval-only; load with handon --log)`);
  }

  // The mirror is only half-done until the leader actually calls mem-mesh.
  // Say so loudly — a silent pending state is what let dual-write rot.
  //
  // EVERY branch prints exactly one line. An earlier version only spoke when the
  // mirror was written or when there was no narrative at all, so a narrative that
  // rendered no payload (too thin, or a failed write) produced silence — the very
  // failure mode this feature exists to remove.
  if (mirrorWritten) {
    console.log('');
    console.log(`🧠 mem-mesh mirror PENDING → ${mirrorPath()}`);
    console.log(`   Pass that file's .payload verbatim to mcp__mem-mesh__add, then run:`);
    console.log(`   xm build handoff --mirror-done <memory_id>`);
    console.log(`   (no mem-mesh tools available → xm build handoff --mirror-skip; the file handoff above is complete on its own)`);
  } else if (mirror) {
    // Payload rendered but the file write failed — the warning went to stderr above.
    console.log(`   mem-mesh mirror: NOT WRITTEN (payload rendered, file write failed — see warning above)`);
  } else if (!mirrorEnabled) {
    console.log(`   mem-mesh mirror: disabled (memmesh.mirror=false)`);
  } else if (!narrative && !sessionLog) {
    console.log(`   mem-mesh mirror: skipped (no narrative to mirror)`);
  } else if (!_narrativeHasContent(narrative, sessionLog)) {
    // A narrative object was passed but every field is empty — that is "nothing
    // to say", not a length failure. Blaming the 100-char floor sends the skill
    // (and the user) chasing a limit that was never reached.
    console.log(`   mem-mesh mirror: skipped (narrative present but empty)`);
  } else {
    console.log(`   mem-mesh mirror: skipped (narrative too thin — under the ${MIRROR_MIN_CONTENT}-char minimum mem-mesh requires)`);
  }
}

// ── mem-mesh mirror (dual-write) ─────────────────────────────────────
//
// The file half of a handoff is written by this CLI, so it always lands. The
// mem-mesh half used to depend on the skill remembering to call
// `mcp__mem-mesh__add` with a hand-built payload — a probabilistic step that
// silently no-opped (zero mirrors ever landed). The CLI now renders the exact
// payload to disk and tracks whether it was mirrored, so a skipped mirror is
// visible state instead of an invisible gap.
//
// Payload shape follows the mem-mesh `add` tool schema exactly: `category`
// (NOT `type`) and `content` of at least MIRROR_MIN_CONTENT chars.

const MIRROR_MIN_CONTENT = 100;

export function mirrorPath() {
  return join(repoRoot(), '.xm', 'build', 'memmesh-mirror.json');
}

// mem-mesh project_id pattern: ^[a-zA-Z0-9_-]{1,100}$
function _mirrorProjectId() {
  const base = repoRoot().split('/').filter(Boolean).pop() || 'project';
  return (base.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100)) || 'project';
}

function _mirrorContent(state) {
  const nar = state.narrative || {};
  const sl = state.session_log || {};
  const w = state.where || {};
  const ctx = state.context || {};
  const L = [];

  L.push(nar.intent || ctx.current_focus || 'Session handoff');
  L.push(`Stopped: ${state.why_stopped || '—'}`);
  L.push('');

  const sec = (title, items) => {
    if (!items || !items.length) return;
    L.push(`## ${title}`);
    for (const it of items) L.push(`- ${it}`);
    L.push('');
  };

  // Tier-2 detail when present, tier-1 narrative as fallback.
  sec('Open questions & forks', sl.open_forks?.length ? sl.open_forks : nar.open_questions);
  sec('Rejected (with reasoning)', sl.rejected?.length ? sl.rejected : nar.rejected_alternatives);
  sec('Constraints & preferences', sl.constraints_prefs);
  sec('What was tried & why', sl.attempts);
  sec('Next session should know', nar.next_session_should_know);

  let content = L.join('\n').trim();

  // `add` rejects content under 100 chars. A thin session would fail schema
  // validation, so top it up with the git facts rather than dropping the mirror.
  if (content.length < MIRROR_MIN_CONTENT) {
    const tail = [];
    if (w.branch) tail.push(`Branch: ${w.branch}`);
    if (state.what_done?.length) tail.push(`Commits this session: ${state.what_done.length}`);
    if (w.last_commits?.length) tail.push(`Last commit: ${w.last_commits[0]}`);
    if (ctx.test_status) tail.push(`Tests: ${ctx.test_status}`);
    if (state.saved_at) tail.push(`Saved: ${state.saved_at}`);
    if (tail.length) content = `${content}\n\n## Session facts\n${tail.map(t => `- ${t}`).join('\n')}`;
  }

  return content;
}

function _mirrorAnchors(state) {
  const anchors = {};
  try {
    const commit = execSync('git rev-parse HEAD 2>/dev/null', { encoding: 'utf8' }).trim();
    if (/^[0-9a-fA-F]{7,64}$/.test(commit)) anchors.commit_hash = commit;
  } catch { /* not a git repo — anchors stay empty */ }
  const branch = state.where?.branch;
  if (branch) anchors.branch = branch;
  const files = (state.context?.key_files || []).filter(f => f && !f.startsWith('/') && !f.includes('..')).slice(0, 20);
  if (files.length) anchors.file_paths = files;
  return Object.keys(anchors).length ? anchors : null;
}

// Does this narrative/session_log carry anything at all? Shared by the payload
// builder and the CLI's reporting so "empty" and "too short" never get conflated.
function _narrativeHasContent(nar, sl) {
  const hasNarrative = nar && (nar.intent || nar.open_questions?.length || nar.rejected_alternatives?.length || nar.next_session_should_know?.length);
  const hasLog = sl && (sl.rejected?.length || sl.open_forks?.length || sl.constraints_prefs?.length || sl.attempts?.length);
  return Boolean(hasNarrative || hasLog);
}

// Build the mem-mesh `add` payload for a session state. Returns null when the
// session carries no narrative worth mirroring — a bare `handoff --full` with
// no `--narrative-json` has nothing mem-mesh can serve that the file cannot.
export function buildMemMeshMirror(state) {
  if (!_narrativeHasContent(state.narrative, state.session_log)) return null;

  const content = _mirrorContent(state);
  if (content.length < MIRROR_MIN_CONTENT) return null;

  const anchors = _mirrorAnchors(state);
  return {
    v: 1,
    status: 'pending',
    created_at: state.saved_at,
    memory_id: null,
    mirrored_at: null,
    // Pass this object straight to mcp__mem-mesh__add — no reshaping.
    payload: {
      content,
      project_id: _mirrorProjectId(),
      category: 'idea',
      tags: ['handoff', 'session-state'],
      client: 'claude_code',
      ...(anchors ? { anchors } : {}),
    },
  };
}

// Returns null only when there genuinely is no mirror. A file that exists but
// cannot be read or parsed is NOT "no mirror" — reporting it as absent hides a
// pending dual-write behind the same silence this feature removes (Lesson L6).
export function readMirrorState() {
  const p = mirrorPath();
  if (!existsSync(p)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`⚠️  mem-mesh mirror file unreadable (${p}): ${e.message}`);
    return { status: 'unreadable', error: e.message };
  }
  // Parsing is not enough: `null`, an array, or a bare string all parse fine and
  // would become a phantom mirror with `payload: undefined`. Shape-check too.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.payload) {
    const why = 'not a mirror object (missing .payload)';
    console.error(`⚠️  mem-mesh mirror file unreadable (${p}): ${why}`);
    return { status: 'unreadable', error: why };
  }
  return parsed;
}

// `handoff --mirror-status` / `--mirror-done <memory_id>` / `--mirror-skip`
export function cmdHandoffMirror(args) {
  const p = mirrorPath();
  const doneIdx = args.findIndex(a => a === '--mirror-done' || a.startsWith('--mirror-done='));

  // File-only users never call --mirror-done, so a pending mirror would warn on
  // every restore forever. Let them dismiss it without pretending it was saved.
  if (args.includes('--mirror-skip')) {
    const state = readMirrorState();
    if (!state) { console.log('No mirror payload to skip.'); return; }
    if (state.status === 'unreadable') {
      console.error(`Refusing to overwrite an unreadable mirror file: ${p}`);
      console.error(`Inspect or delete it manually, then re-run the handoff.`);
      exitFail(1);
    }
    // Dismissing an already-mirrored record would drop a real memory_id and
    // relabel a completed dual-write as "never sent".
    if (state.status === 'mirrored') {
      console.error(`Already mirrored (${state.memory_id}) — nothing to dismiss.`);
      exitFail(1);
    }
    state.status = 'skipped';
    state.skipped_at = new Date().toISOString();
    writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
    console.log('🧠 mem-mesh mirror dismissed (file-only). The file handoff is unaffected.');
    return;
  }

  if (doneIdx !== -1) {
    const memoryId = args[doneIdx].startsWith('--mirror-done=')
      ? args[doneIdx].slice('--mirror-done='.length)
      : args[doneIdx + 1];
    if (!memoryId || memoryId.startsWith('--')) {
      console.error('Usage: xm build handoff --mirror-done <memory_id>');
      exitFail(1);
    }
    const state = readMirrorState();
    if (!state) {
      console.error(`No mirror payload found at ${p}. Run: xm build handoff --full --narrative-json '...'`);
      exitFail(1);
    }
    // Never rewrite a file we could not parse — that would destroy the only copy
    // of a payload whose add may well have succeeded.
    if (state.status === 'unreadable') {
      console.error(`Refusing to overwrite an unreadable mirror file: ${p}`);
      console.error(`The memory id ${memoryId} was NOT recorded. Inspect or delete the file, then re-run the handoff.`);
      exitFail(1);
    }
    state.status = 'mirrored';
    state.memory_id = memoryId;
    state.mirrored_at = new Date().toISOString();
    try {
      writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch (e) {
      // The add already succeeded — the memory exists in mem-mesh. Losing this
      // write only loses the bookkeeping, so surface the id the caller must not
      // drop rather than dying with a bare stack trace.
      console.error(`⚠️  mem-mesh add succeeded (${memoryId}) but the mirror status could not be written: ${e.message}`);
      console.error(`   The memory EXISTS. Record it manually or re-run: xm build handoff --mirror-done ${memoryId}`);
      exitFail(1);
    }
    console.log(`🧠 mem-mesh mirror recorded: ${memoryId}`);
    return;
  }

  // --mirror-status
  const state = readMirrorState();
  if (!state) { console.log(JSON.stringify({ status: 'none' })); return; }
  if (state.status === 'unreadable') {
    // Carry the parse reason — a machine caller cannot act on a bare status.
    console.log(JSON.stringify({ status: 'unreadable', error: state.error }, null, 2));
    return;
  }

  // Age the record against the CURRENT session state, exactly as handon does.
  // Reporting the raw status here called a previous session's record `mirrored`
  // while handon correctly called the same record `stale`.
  let sessionState = null;
  try { sessionState = JSON.parse(readFileSync(join(repoRoot(), '.xm', 'build', 'SESSION-STATE.json'), 'utf8')); } catch { /* no state yet */ }
  const aged = sessionState ? _mirrorStatusFor(sessionState) : { status: state.status };

  console.log(JSON.stringify({
    status: aged.status,
    from_earlier_handoff: aged.from_earlier_handoff,
    memory_id: state.memory_id,
    created_at: state.created_at,
    mirrored_at: state.mirrored_at,
    skipped_at: state.skipped_at,
    payload: state.payload,
  }, null, 2));
}

// Render SESSION-STATE into a tool-neutral HANDOFF.md. Mirrors
// x-recall/lib/x-recall/handoff-md.mjs:sessionStateToMarkdown — keep in sync.
function _sessionStateToHandoffMd(state) {
  const list = (items, fmt = (x) => `- ${x}`) =>
    (!items || !items.length) ? '_(none)_' : items.map(fmt).join('\n');
  const w = state.where || {};
  const ctx = state.context || {};
  const nar = state.narrative || {};
  const rem = state.what_remains || {};
  const L = [];
  L.push('# Session Handoff', '');
  L.push('> Tool-neutral handoff generated from `.xm/build/SESSION-STATE.json`. Readable by any session (Claude, Codex, Cursor).', '');
  L.push(`- **Saved:** ${state.saved_at || '—'}`);
  L.push(`- **Branch:** ${w.branch || '—'}${w.ahead != null ? ` (+${w.ahead}/-${w.behind || 0})` : ''}`);
  if (state.why_stopped) L.push(`- **Stopped because:** ${state.why_stopped}`);
  if (ctx.current_focus) L.push(`- **Focus:** ${ctx.current_focus}`);
  if (ctx.test_status) L.push(`- **Tests:** ${ctx.test_status}`);
  L.push('');
  if (nar.intent) L.push('## Intent', nar.intent, '');
  L.push('## Done last session', list(state.what_done), '');
  const active = (rem.active_projects || []).map(p =>
    typeof p === 'string' ? p : `${p.name || '?'}${p.phase ? ` (${p.phase})` : ''}${p.pending ? ` — ${p.pending} pending` : ''}`);
  L.push('## Remaining', '**Active projects:** ' + (active.length ? '\n' + list(active) : '_(none)_'));
  if (w.uncommitted_files && w.uncommitted_files.length) L.push('', '**Uncommitted:**', list(w.uncommitted_files));
  L.push('');
  if (state.decisions && state.decisions.length) {
    L.push('## Decisions carried forward', list(state.decisions, d => `- **${d.what || d}**${d.why ? ` — ${d.why}` : ''}`), '');
  }
  if (nar.open_questions && nar.open_questions.length) L.push('## Open questions', list(nar.open_questions), '');
  if (nar.rejected_alternatives && nar.rejected_alternatives.length) L.push('## Ruled out (do not re-litigate)', list(nar.rejected_alternatives), '');
  if (nar.next_session_should_know && nar.next_session_should_know.length) L.push('## Next session should know', list(nar.next_session_should_know), '');
  const sl = state.session_log;
  if (sl && (sl.rejected?.length || sl.open_forks?.length || sl.constraints_prefs?.length || sl.attempts?.length)) {
    L.push('## Detailed session log', '_Retrieval-only detail; not auto-injected on restore._', '');
    if (sl.rejected?.length) L.push('### Rejected alternatives (full reasoning)', list(sl.rejected), '');
    if (sl.open_forks?.length) L.push('### Open questions & forks', list(sl.open_forks), '');
    if (sl.constraints_prefs?.length) L.push('### Constraints & user preferences', list(sl.constraints_prefs), '');
    if (sl.attempts?.length) L.push('### What was tried & why', list(sl.attempts), '');
  }
  if (w.last_commits && w.last_commits.length) L.push('## Recent commits', list(w.last_commits.slice(0, 5)), '');
  return L.join('\n');
}

// ── cmdHandon ────────────────────────────────────────────────────────

function _timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Did the handoff that produced THIS state actually reach mem-mesh? A mirror
// file from an older handoff says nothing about the current one, so match on
// created_at before reporting.
function _mirrorStatusFor(state) {
  const m = readMirrorState();
  if (!m) return { status: 'none' };

  // Unreadable is its own outcome — not "none", and not silently pending.
  if (m.status === 'unreadable') return { status: 'unreadable', error: m.error };

  const matchesCurrent = !m.created_at || !state.saved_at || m.created_at === state.saved_at;
  const status = m.status || 'pending';

  // A PENDING mirror stays visible even when it predates the current state.
  // Ageing it out to `stale` is how an unrepaired dual-write disappeared: a
  // narrative-less handoff bumps saved_at without rewriting the mirror, and the
  // warning silently stopped. Flag the age instead of hiding the failure — the
  // payload is still on disk and still the only copy of that session.
  if (status === 'pending') {
    return { status: 'pending', created_at: m.created_at, from_earlier_handoff: !matchesCurrent };
  }

  // `skipped` means the user deliberately dismissed it. Ageing that into `stale`
  // would read as "already mirrored", which is the opposite of what happened.
  if (status === 'skipped') {
    return { status: 'skipped', created_at: m.created_at, from_earlier_handoff: !matchesCurrent };
  }

  // Only `mirrored` genuinely goes stale — that record describes a session state
  // this one has moved past, and there is nothing left to repair.
  if (!matchesCurrent) return { status: 'stale', memory_id: m.memory_id, created_at: m.created_at };
  return { status, memory_id: m.memory_id, mirrored_at: m.mirrored_at };
}

export function cmdHandon(args) {
  const isJson = args.includes('--json');
  const statePath = join(repoRoot(), '.xm', 'build', 'SESSION-STATE.json');

  if (!existsSync(statePath)) {
    if (isJson) { console.log(JSON.stringify({ error: 'no_session_state' })); return; }
    console.log('No session state found. Run: xmb handoff --full');
    return;
  }

  let state;
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {
    console.log('Error reading SESSION-STATE.json');
    return;
  }

  // On-demand: print the tier-2 detailed archive. handon --json deliberately
  // withholds this (it only reports a count) so it never enters leader context
  // by default; the user loads it explicitly with `handon --log`.
  if (args.includes('--log')) {
    const sl = state.session_log;
    const has = sl && (sl.rejected?.length || sl.open_forks?.length || sl.constraints_prefs?.length || sl.attempts?.length);
    if (!has) {
      console.log(isJson ? JSON.stringify({ error: 'no_session_log' }) : 'No detailed session log in this handoff.');
      return;
    }
    if (isJson) { console.log(JSON.stringify(sl, null, 2)); return; }
    const sec = (title, items) => { if (items?.length) { console.log(`\n${C.bold}${title}${C.reset}`); for (const it of items) console.log(`  • ${it}`); } };
    console.log(`${C.bold}📚 Detailed session log${C.reset} ${C.dim}(saved ${state.saved_at ? _timeAgo(state.saved_at) : '?'})${C.reset}`);
    sec('Rejected alternatives (full reasoning)', sl.rejected);
    sec('Open questions & forks', sl.open_forks);
    sec('Constraints & user preferences', sl.constraints_prefs);
    sec('What was tried & why', sl.attempts);
    return;
  }

  if (isJson) {
    let newCommits = [];
    try {
      const lastHash = (state.where?.last_commits?.[0] || '').split(' ')[0];
      if (lastHash) {
        newCommits = execSync(`git log --oneline ${lastHash}..HEAD 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      }
    } catch {}
    state.since_handoff = { new_commits: newCommits.length, commits: newCommits.slice(0, 5) };
    state.memmesh_mirror = _mirrorStatusFor(state);
    // Strip tier-2 detail from the injected payload — replace with a summary so
    // the restore stays high-signal and the log loads only on `handon --log`.
    if (state.session_log) {
      const sl = state.session_log;
      state.session_log_summary = {
        available: true,
        rejected: sl.rejected?.length || 0,
        open_forks: sl.open_forks?.length || 0,
        constraints_prefs: sl.constraints_prefs?.length || 0,
        attempts: sl.attempts?.length || 0,
      };
      delete state.session_log;
    }
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  // Pretty print
  const ago = state.saved_at ? _timeAgo(state.saved_at) : '?';

  console.log(`\n${C.bold}📋 Session Restore${C.reset} — saved ${ago}\n`);

  // Where
  console.log(`  ${C.cyan}📍 Branch:${C.reset} ${state.where?.branch || '?'} (+${state.where?.ahead || 0} ahead, -${state.where?.behind || 0} behind)`);
  if (state.where?.last_commits?.length) {
    console.log(`     Last: ${C.dim}${state.where.last_commits[0]}${C.reset}`);
  }

  // What done
  if (state.what_done?.length) {
    console.log(`\n  ${C.green}✅ Done${C.reset} (${state.what_done.length} commits):`);
    for (const c of state.what_done.slice(0, 5)) {
      console.log(`     ${C.dim}${c}${C.reset}`);
    }
    if (state.what_done.length > 5) console.log(`     ${C.dim}... +${state.what_done.length - 5} more${C.reset}`);
  }

  // What remains
  if (state.what_remains?.active_projects?.length) {
    console.log(`\n  ${C.yellow}📌 Active Projects:${C.reset}`);
    for (const p of state.what_remains.active_projects) {
      console.log(`     ${p.name}  ${C.dim}${p.phase}  ${p.tasks} tasks${C.reset}`);
      if (p.pending?.length) {
        for (const t of p.pending) console.log(`       ${C.dim}→ ${t}${C.reset}`);
      }
    }
  }
  if (state.what_remains?.uncommitted?.length) {
    console.log(`\n  ${C.red}📝 Uncommitted:${C.reset} ${state.what_remains.uncommitted.length} files`);
    for (const f of state.what_remains.uncommitted.slice(0, 5)) {
      console.log(`     ${C.dim}${f}${C.reset}`);
    }
  }
  if (state.what_remains?.ideas?.length) {
    console.log(`\n  ${C.blue}💡 Ideas:${C.reset}`);
    for (const idea of state.what_remains.ideas) console.log(`     ${C.dim}${idea}${C.reset}`);
  }

  // Decisions
  if (state.decisions?.length) {
    console.log(`\n  ${C.cyan}🔒 Decisions:${C.reset}`);
    for (const d of state.decisions.slice(0, 5)) {
      console.log(`     • ${d.what}${d.why ? ` ${C.dim}(${d.why})${C.reset}` : ''}`);
    }
  }

  // Context
  if (state.context) {
    console.log(`\n  ${C.bold}🎯 Focus:${C.reset} ${state.context.current_focus || '—'}`);
    if (state.context.test_status) console.log(`     Tests: ${state.context.test_status}`);
    if (state.context.diff_summary) console.log(`     Changes: ${state.context.diff_summary}`);
    if (state.context.stashes?.length) {
      console.log(`     ${C.yellow}Stashes:${C.reset}`);
      for (const s of state.context.stashes) console.log(`       ${C.dim}${s}${C.reset}`);
    }
    if (state.context.quality_scores && Object.keys(state.context.quality_scores).length) {
      for (const [k, v] of Object.entries(state.context.quality_scores)) {
        console.log(`     Quality: ${k} → ${v}/10`);
      }
    }
  }

  // Narrative — conversation-level context that disk artifacts can't capture
  if (state.narrative) {
    const n = state.narrative;
    if (n.intent || n.open_questions?.length || n.rejected_alternatives?.length || n.next_session_should_know?.length) {
      console.log(`\n  ${C.bold}🧭 Narrative${C.reset}`);
      if (n.intent) console.log(`     ${C.cyan}Intent:${C.reset} ${n.intent}`);
      if (n.open_questions?.length) {
        console.log(`     ${C.yellow}Open questions:${C.reset}`);
        for (const q of n.open_questions) console.log(`       ${C.dim}? ${q}${C.reset}`);
      }
      if (n.rejected_alternatives?.length) {
        console.log(`     ${C.dim}Rejected alternatives:${C.reset}`);
        for (const r of n.rejected_alternatives) console.log(`       ${C.dim}✗ ${r}${C.reset}`);
      }
      if (n.next_session_should_know?.length) {
        console.log(`     ${C.green}Next session should know:${C.reset}`);
        for (const k of n.next_session_should_know) console.log(`       ${C.dim}→ ${k}${C.reset}`);
      }
    }
  }

  // Tier-2 archive — announce availability only; load with `handon --log`
  {
    const sl = state.session_log;
    const n = sl ? (sl.rejected?.length || 0) + (sl.open_forks?.length || 0) + (sl.constraints_prefs?.length || 0) + (sl.attempts?.length || 0) : 0;
    if (n) console.log(`\n  ${C.bold}📚 Detailed log:${C.reset} ${n} item(s) archived ${C.dim}— run 'xm build handon --log' to load${C.reset}`);
  }

  // Why stopped
  if (state.why_stopped) {
    console.log(`\n  ${C.dim}💤 Stopped: ${state.why_stopped}${C.reset}`);
  }

  // mem-mesh mirror — surface a pending mirror so a silently skipped dual-write
  // is visible on the next restore instead of vanishing.
  {
    const m = _mirrorStatusFor(state);
    if (m.status === 'mirrored') {
      console.log(`  ${C.dim}🧠 mem-mesh: mirrored (${m.memory_id})${C.reset}`);
    } else if (m.status === 'pending') {
      const from = m.from_earlier_handoff ? ' from an earlier handoff' : '';
      console.log(`  ${C.yellow}🧠 mem-mesh: mirror PENDING${C.reset}${C.dim}${from} — never reached mem-mesh${C.reset}`);
      console.log(`     ${C.dim}repair it, or run 'xm build handoff --mirror-skip' if you don't use mem-mesh${C.reset}`);
    } else if (m.status === 'unreadable') {
      console.log(`  ${C.red}🧠 mem-mesh: mirror file UNREADABLE${C.reset} ${C.dim}(${m.error})${C.reset}`);
    }
  }

  // Since handoff
  let newCommits = 0;
  try {
    const lastHash = (state.where?.last_commits?.[0] || '').split(' ')[0];
    if (lastHash) {
      newCommits = parseInt(execSync(`git rev-list --count ${lastHash}..HEAD 2>/dev/null`, { encoding: 'utf8' }).trim()) || 0;
    }
  } catch {}

  let currentUncommitted = 0;
  try {
    currentUncommitted = execSync('git status --short', { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
  } catch {}

  console.log(`\n  ${C.dim}Since handoff: ${newCommits} new commits, ${currentUncommitted} uncommitted files${C.reset}`);
  console.log('');
}

function getPhaseActions(manifest, config) {
  const currentPhase = PHASES.find(p => p.id === manifest.current_phase);
  if (!currentPhase) return [];

  const gateKey = `${currentPhase.name}-exit`;
  const gateType = resolveGates()[gateKey] || 'auto';

  const actions = [];

  switch (currentPhase.name) {
    case 'research':
      actions.push(
        { label: '📝 리서치 노트 보기/편집 안내', action: 'show-notes' },
        { label: '➡️  다음 단계 (Plan)로 이동', action: 'phase-next' },
      );
      break;
    case 'plan':
      actions.push(
        { label: '➕ 태스크 추가', action: 'task-add' },
        { label: '📋 태스크 목록', action: 'task-list' },
        { label: '🔹 Step 계산', action: 'step-compute' },
      );
      if (requiresSignoff(gateType)) {
        actions.push({ label: '✅ 계획 승인 (gate pass)', action: 'gate-pass' });
      }
      actions.push({ label: '➡️  다음 단계 (Execute)로 이동', action: 'phase-next' });
      break;
    case 'execute':
      actions.push(
        { label: '🔹 Step 상태 확인', action: 'step-status' },
        { label: '▶️  다음 Step 활성화', action: 'step-next' },
        { label: '✏️  태스크 상태 변경', action: 'task-update' },
        { label: '➡️  다음 단계 (Verify)로 이동', action: 'phase-next' },
      );
      break;
    case 'verify':
      actions.push(
        { label: '📌 체크포인트 기록', action: 'checkpoint' },
        { label: '📄 Context Brief 생성', action: 'context' },
        { label: '➡️  다음 단계 (Close)로 이동', action: 'phase-next' },
      );
      break;
    case 'close':
      actions.push(
        { label: '🏁 프로젝트 종료', action: 'close' },
      );
      break;
  }

  return actions;
}
