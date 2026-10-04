import { createRL, menuSelect, ask, WizardEOF, P, clampAnsi } from './cli-prompts.mjs';
import { basename } from 'node:path';
import { loadRegistry, resolveCanonicalPath } from './x-projects-registry.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function displayText(value) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 120);
}

export function startSessionSpinner(output = process.stdout) {
  if (!output.isTTY) return () => {};
  const frames = ['|', '/', '-', '\\'];
  let index = 0;
  const paint = () => output.write(`\r\x1b[2K${clampAnsi(`${P.cyan(frames[index++ % frames.length])} 세션 조회 중…`, Math.max(1, (output.columns || 80) - 1))}`);
  paint();
  const timer = setInterval(paint, 80);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    output.write('\r\x1b[2K');
  };
}

export function createProjectNameResolver(projects = loadRegistry().projects, canonicalize = resolveCanonicalPath) {
  const names = new Map();
  return cwd => {
    if (!cwd) return null;
    if (!names.has(cwd)) {
      let name = null;
      try {
        const path = canonicalize(cwd);
        const matches = projects.filter(project => !project.archived && project.path === path);
        if (matches.length === 1) name = matches[0].name || null;
      } catch {}
      names.set(cwd, name);
    }
    return names.get(cwd);
  };
}

export async function chatCandidates(context, projectName, provider) {
  const providers = provider ? [provider] : ['codex', 'claude', 'agy'];
  const results = await Promise.allSettled(providers.map(name => Promise.resolve().then(() => context.listProvider(name, projectName))));
  const candidates = [];
  const notes = [];
  for (const [index, result] of results.entries()) {
    const name = providers[index];
    if (result.status === 'rejected') { notes.push(`${name} 조회 실패: ${displayText(result.reason.message)}`); continue; }
    for (const session of result.value.sessions) {
      const id = name === 'codex' ? session.thread_id : session.session_id;
      if (!UUID.test(id || '') || (name !== 'claude' && session.live_status !== 'running')) continue;
      candidates.push({ provider: name, id, name: session.name || id, cwd: session.cwd,
        directory: session.cwd ? basename(session.cwd) || session.cwd : '경로 확인 불가',
        projectName: context.projectNameFor?.(session.cwd) || null,
        sendable: session.capabilities?.send !== false,
        unavailable: session.unavailable_reason || null });
    }
    if (result.value.partial) notes.push(`${name} 목록 일부를 확인하지 못했습니다.`);
    for (const note of result.value.notes || []) notes.push(displayText(note));
  }
  return { candidates, notes };
}

export async function runChat(options, context, ui = { createRL, menuSelect, ask, startSpinner: startSessionSpinner }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('relay chat requires an interactive terminal; use relay send --to provider:UUID --message-file PATH');
  if (options['--project']) context.registryProject(options['--project']);
  const input = ui.createRL();
  let selectedIdentity = null;
  try {
    const stopSpinner = (ui.startSpinner || startSessionSpinner)();
    let snapshot;
    try { snapshot = await chatCandidates(context, options['--project'], options['--provider']); }
    finally { stopSpinner(); }
    while (true) {
      const selectedIndex = snapshot.candidates.findIndex(row => `${row.provider}:${row.id}` === selectedIdentity);
      const choice = await ui.menuSelect(input, {
        title: '메시지를 보낼 세션 선택',
        header: ['↑↓ 이동 · Enter 대상 선택 · r 갱신 · q 종료',
          ...(!snapshot.candidates.length ? ['실행 중인 세션이 없습니다.'] : []), ...snapshot.notes],
        options: [...snapshot.candidates.map((candidate, index) => ({
          key: String(index + 1),
          label: `${candidate.provider}  ${displayText(candidate.directory)}${candidate.projectName && candidate.projectName !== candidate.directory ? ` (${displayText(candidate.projectName)})` : ''}${candidate.sendable ? '' : '  전송 불가'}`,
          hint: `${candidate.name !== candidate.id ? displayText(candidate.name) + '  ' : ''}${displayText(candidate.id)}  ${displayText(candidate.cwd || '경로 확인 불가')}`,
        })), { key: 'r', label: '목록 갱신' }, { key: 'q', label: '종료' }],
        initialKey: selectedIndex >= 0 ? String(selectedIndex + 1) : undefined,
        backKey: 'q', prompt: '대상 번호 / r 갱신 / q 종료> ',
      });
      if (choice === 'q') return;
      if (choice === 'r') { snapshot = await chatCandidates(context, options['--project'], options['--provider']); continue; }
      const selected = snapshot.candidates[Number(choice) - 1];
      if (!selected) continue;
      selectedIdentity = `${selected.provider}:${selected.id}`;
      if (!selected.sendable) { context.report(selected.unavailable || '이 세션의 수신 경로를 확인할 수 없습니다.'); continue; }
      context.report(`대상: ${selected.provider} ${selected.id} (${displayText(selected.cwd || '경로 확인 불가')})`);
      const message = options['--message-file'] ? null : await ui.ask(input, '보낼 메시지·명령 (/back 대상 변경, /quit 종료)> ');
      if (message === '/quit') return;
      if (message === '/back' || (message !== null && !message.trim())) continue;
      const outgoing = { ...options, '--provider': selected.provider,
        [selected.provider === 'codex' ? '--thread' : '--session']: selected.id,
        '--kind': options['--kind'] || (message && /^\/?xm:/.test(message.trim()) ? 'command' : 'message'),
      };
      if (message !== null) outgoing['--message'] = message;
      snapshot = await chatCandidates(context, options['--project'], options['--provider']);
      const current = snapshot.candidates.find(row => `${row.provider}:${row.id}` === selectedIdentity);
      if (!current?.sendable) { context.report('선택한 세션이 종료되었거나 수신 경로가 사라졌습니다. 전송하지 않았습니다.'); continue; }
      try { context.report(await context.send(outgoing)); }
      catch (error) {
        if (options['--message-file']) throw error;
        context.report(`전송 실패: ${displayText(error.message)}`);
      }
      if (options['--message-file']) return;
    }
  } catch (error) {
    if (!(error instanceof WizardEOF)) throw error;
  } finally { input.close(); }
}
