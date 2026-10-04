import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { basename } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MENU_WINDOW = '0';

function displayText(value) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 120);
}

function displayState(value) {
  return ({ working: '작업 중', busy: '작업 중', active: '작업 중', blocked: '확인 대기',
    waiting: '확인 대기', idle: '대기 중', done: '응답 완료', stopped: '중지됨',
    failed: '실패', notLoaded: '저장된 대화' })[value] || '상태 확인 불가';
}

export async function chatCandidates(context, projectName) {
  const project = projectName ? context.registryProject(projectName) : null;
  const matches = project ? context.createProjectMatcher(project.path) : null;
  const results = await Promise.allSettled([
    context.listSessions(projectName),
    Promise.resolve().then(() => context.claudeSessions()),
  ]);
  const candidates = [];
  const notes = [];
  if (results[0].status === 'fulfilled') {
    const inventory = results[0].value;
    for (const session of inventory.sessions) {
      if (typeof session.thread_id !== 'string' || !UUID.test(session.thread_id)) continue;
      candidates.push({ provider: 'codex', id: session.thread_id, cwd: session.cwd,
        name: session.name || session.thread_id, state: session.app_server_status,
        attachable: Boolean(session.cwd) });
    }
    if (inventory.partial) notes.push('Codex 목록에 오래된 대화 일부가 빠질 수 있습니다.');
  } else notes.push(`Codex 조회 실패: ${results[0].reason.message}`);
  if (results[1].status === 'fulfilled') {
    for (const session of results[1].value) {
      if (matches && !matches(session.cwd)) continue;
      const background = session.kind === 'background' && typeof session.id === 'string' && session.id.length > 0 && !session.id.startsWith('-');
      const id = background ? session.id : session.sessionId;
      if (!id) continue;
      candidates.push({ provider: 'claude', id, cwd: session.cwd,
        name: session.name || id, state: session.state || session.status || 'unknown',
        attachable: background && Boolean(session.cwd) });
    }
  } else notes.push(`Claude 조회 실패: ${results[1].reason.message}`);
  return { candidates, notes };
}

export class ChatWorkspace {
  constructor({ projectName, cliPath, codexBin, claudeBin, socketName, cwd = process.cwd() }) {
    this.projectName = projectName;
    this.cliPath = cliPath;
    this.codexBin = codexBin;
    this.claudeBin = claudeBin;
    this.cwd = cwd;
    this.socketName = socketName || `xm-relay-${process.getuid()}`;
    this.sessionName = `chat-${createHash('sha256').update(projectName || cwd).digest('hex').slice(0, 12)}`;
    this.env = { ...process.env, XM_RELAY_CODEX_BIN: codexBin, XM_RELAY_CLAUDE_BIN: claudeBin };
    delete this.env.TMUX;
  }

  command(args, stdio = 'pipe') {
    const result = spawnSync('tmux', ['-L', this.socketName, '-f', '/dev/null', ...args], {
      cwd: this.cwd, env: this.env, encoding: 'utf8', stdio,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || `tmux exited with ${result.status}`).trim());
    return result.stdout?.trim() || '';
  }

  menuCommand() {
    return [process.execPath, this.cliPath, 'chat', ...(this.projectName ? ['--project', this.projectName] : [])];
  }

  ensure() {
    const probe = spawnSync('tmux', ['-L', this.socketName, 'has-session', '-t', this.sessionName], {
      cwd: this.cwd, env: this.env, encoding: 'utf8',
    });
    if (probe.error) throw probe.error;
    if (probe.status === 1) {
      this.command(['new-session', '-d', '-s', this.sessionName, '-n', 'sessions', '-c', this.cwd,
        '-e', 'XM_RELAY_CHAT_MENU=1', ...this.menuCommand()]);
    } else if (probe.status !== 0) throw new Error(probe.stderr.trim());
    this.command(['set-option', '-t', this.sessionName, 'base-index', MENU_WINDOW]);
    this.command(['set-option', '-g', '-w', 'remain-on-exit', 'on']);
    this.command(['bind-key', '-n', 'F6', 'select-window', '-t', ':0']);
    const menu = this.command(['list-windows', '-t', this.sessionName, '-F', '#{window_index}\t#{pane_dead}'])
      .split('\n').find(row => row.split('\t')[0] === MENU_WINDOW);
    if (!menu) throw new Error('relay chat menu window is missing');
    if (menu.endsWith('\t1')) this.command(['respawn-window', '-k', '-t', `${this.sessionName}:0`,
      '-e', 'XM_RELAY_CHAT_MENU=1', ...this.menuCommand()]);
  }

  open(candidate, daemonSocket) {
    if (!candidate.attachable) throw new Error(candidate.provider === 'claude'
      ? '일반 Claude 터미널에서는 /background를 실행한 뒤 목록을 갱신해 주세요.'
      : 'Codex 세션의 작업 경로를 확인할 수 없습니다.');
    if (!candidate.cwd || !existsSync(candidate.cwd) || !statSync(candidate.cwd).isDirectory()) throw new Error('세션 작업 경로를 확인할 수 없습니다.');
    const key = `${candidate.provider}:${candidate.id}`;
    const existing = this.command(['list-windows', '-t', this.sessionName, '-F', '#{window_id}\t#{@xm_relay_key}\t#{pane_dead}'])
      .split('\n').map(row => row.split('\t')).find(row => row[1] === key);
    const command = candidate.provider === 'codex'
      ? [this.codexBin, 'resume', candidate.id, '--remote', `unix://${daemonSocket}`]
      : [this.claudeBin, 'attach', candidate.id];
    let windowId = existing?.[0];
    if (existing?.[2] === '1') this.command(['respawn-window', '-k', '-t', windowId, '-c', candidate.cwd,
      '-e', 'XM_RELAY_CHAT_MENU=0', ...command]);
    else if (!existing) {
      windowId = this.command(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', this.sessionName,
        '-n', `${candidate.provider}-${displayText(candidate.name)}`, '-c', candidate.cwd,
        '-e', 'XM_RELAY_CHAT_MENU=0', ...command]);
      this.command(['set-option', '-w', '-t', windowId, '@xm_relay_key', key]);
    }
    this.command(['select-window', '-t', windowId]);
    return windowId;
  }

  attach() {
    this.command(['select-window', '-t', `${this.sessionName}:0`]);
    this.command(['attach-session', '-t', this.sessionName], 'inherit');
  }

  detach() {
    this.command(['detach-client', '-s', this.sessionName]);
  }
}

async function menu(workspace, context) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let snapshot = await chatCandidates(context, workspace.projectName);
    while (true) {
      process.stdout.write('\n세션을 선택하면 해당 CLI로 이동합니다. F6으로 이 목록에 돌아옵니다.\n');
      for (const [index, candidate] of snapshot.candidates.entries()) {
        process.stdout.write(`${index + 1}  ${candidate.provider}  ${displayText(candidate.name)}  ${displayState(candidate.state)}${candidate.attachable ? '' : '  접속 불가'}\n`);
        process.stdout.write(`   ${displayText(candidate.id)}  ${displayText(candidate.cwd || '경로 확인 불가')}\n`);
      }
      if (!snapshot.candidates.length) process.stdout.write('표시할 세션이 없습니다.\n');
      for (const note of snapshot.notes) process.stdout.write(`${displayText(note)}\n`);
      const choice = (await input.question('선택 번호 / r 갱신 / q 화면 닫기> ')).trim();
      if (choice === 'q') { workspace.detach(); continue; }
      if (choice === 'r') { snapshot = await chatCandidates(context, workspace.projectName); continue; }
      if (!/^[1-9][0-9]*$/.test(choice)) { process.stdout.write('목록의 번호를 입력해 주세요.\n'); continue; }
      const selected = snapshot.candidates[Number(choice) - 1];
      if (!selected) { process.stdout.write('목록에 없는 번호입니다.\n'); continue; }
      snapshot = await chatCandidates(context, workspace.projectName);
      const current = snapshot.candidates.find(row => row.provider === selected.provider && row.id === selected.id);
      if (!current) { process.stdout.write('선택한 세션이 목록에서 사라졌습니다. 다시 선택해 주세요.\n'); continue; }
      try { workspace.open(current, current.provider === 'codex' ? context.daemonVersion().socketPath : null); }
      catch (error) { process.stdout.write(`${displayText(error.message)}\n`); }
    }
  } finally { input.close(); }
}

export async function runChat(options, context) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('relay chat requires tmux on macOS or Linux');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('relay chat requires an interactive terminal');
  if (options['--project']) context.registryProject(options['--project']);
  const inside = process.env.XM_RELAY_CHAT_MENU === '1';
  const socketName = inside ? basename((process.env.TMUX || '').split(',')[0]) : undefined;
  if (inside && (!socketName.startsWith('xm-relay-') || !/^%[0-9]+$/.test(process.env.TMUX_PANE || ''))) {
    throw new Error('relay chat menu requires its managed tmux context');
  }
  const workspace = new ChatWorkspace({ projectName: options['--project'], cliPath: context.cliPath,
    codexBin: context.codexBin, claudeBin: context.claudeBin, socketName });
  if (inside) {
    workspace.sessionName = workspace.command(['display-message', '-p', '-t', process.env.TMUX_PANE, '#{session_name}']);
    if (!/^chat-[0-9a-f]{12}$/.test(workspace.sessionName)) throw new Error('relay chat menu is outside its managed session');
    return menu(workspace, context);
  }
  workspace.ensure();
  workspace.attach();
}
