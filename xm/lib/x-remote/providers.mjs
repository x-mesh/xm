import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { isSensitivePrompt } from './protocol.mjs';

function questionFromBlocks(blocks = []) {
  for (const block of blocks) {
    if (block?.type !== 'tool_use' || block?.name !== 'AskUserQuestion') continue;
    return { decisionId: block.id, original: block.input, sensitive: isSensitivePrompt(block.input) };
  }
  return null;
}

export class ManagedProvider extends EventEmitter {
  constructor({ sessionId = randomUUID(), cwd = process.cwd() } = {}) {
    super(); this.sessionId = sessionId; this.cwd = cwd; this.child = null;
  }
  interrupt() { if (this.child && !this.child.killed) this.child.kill('SIGINT'); }
}

export class ClaudeProvider extends ManagedProvider {
  static command(prompt) {
    return ['claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'], {
      type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '',
    }];
  }

  start(prompt) {
    const [cmd, args, initial] = ClaudeProvider.command(prompt);
    this.resultSeen = false;
    this.wire(spawn(cmd, args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] }));
    this.child.stdin.write(JSON.stringify(initial) + '\n');
    return this;
  }

  wire(child) {
    this.child = child;
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    createInterface({ input: this.child.stderr }).on('line', (line) => this.emit('progress', { original: line }));
    this.child.on('error', (error) => this.emit('failed', { original: error.message }));
    this.child.on('exit', (code, signal) => { if (!this.resultSeen) this.emit(code === 0 ? 'complete' : 'failed', { code, signal }); });
  }

  onLine(line) {
    let msg; try { msg = JSON.parse(line); } catch { this.emit('output', { original: line }); return; }
    if (msg.session_id) this.providerSessionId = msg.session_id;
    const blocks = msg.message?.content || [];
    const question = questionFromBlocks(blocks);
    if (question) { this.emit(question.sensitive ? 'localRequired' : 'decision', question); return; }
    for (const block of blocks) if (block?.type === 'text') this.emit('output', { original: block.text });
    if (msg.type === 'result') { this.resultSeen = true; this.emit(msg.is_error ? 'failed' : 'complete', { original: msg.result || '', sessionId: msg.session_id }); }
    else this.emit('progress', { original: msg });
  }

  steer(text) {
    if (!this.child?.stdin?.writable) throw new Error('Claude session stdin is not writable');
    this.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: this.providerSessionId || '' }) + '\n');
  }

  resume(text) {
    if (this.child?.stdin?.writable && !this.child.killed && this.child.exitCode == null) return this.steer(text);
    if (!this.providerSessionId) throw new Error('Claude provider session id is unavailable');
    this.resultSeen = false;
    this.wire(spawn('claude', ['-p', '--resume', this.providerSessionId, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', text], { cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe'] }));
  }
  resumeFrom(providerSessionId, text) { this.providerSessionId = providerSessionId; this.resume(text); return this; }

  answer(decisionId, text) {
    if (!this.child?.stdin?.writable) throw new Error('Claude session stdin is not writable');
    this.child.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: decisionId, content: String(text) }] },
      parent_tool_use_id: null,
      session_id: this.providerSessionId || '',
    }) + '\n');
  }
}

export class CodexProvider extends ManagedProvider {
  constructor(options = {}) { super(options); this.nextId = 1; this.threadId = null; }
  static startParams(cwd) { return { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' }; }
  send(method, params = {}) {
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server stdin is not writable');
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return id;
  }
  notify(method, params = {}) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  start(prompt) {
    this.child = spawn('codex', ['app-server'], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    createInterface({ input: this.child.stderr }).on('line', (line) => this.emit('progress', { original: line }));
    this.child.on('error', (error) => this.emit('failed', { original: error.message }));
    this.child.on('exit', (code, signal) => this.emit(code === 0 ? 'complete' : 'failed', { code, signal }));
    this.initId = this.send('initialize', { clientInfo: { name: 'x-remote', version: '0.1.0' }, capabilities: {} });
    this.initialPrompt = prompt;
    return this;
  }
  resumeFrom(threadId, prompt) {
    this.resumeThreadId = threadId;
    this.child = spawn('codex', ['app-server'], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    createInterface({ input: this.child.stderr }).on('line', (line) => this.emit('progress', { original: line }));
    this.child.on('error', (error) => this.emit('failed', { original: error.message }));
    this.child.on('exit', (code, signal) => this.emit(code === 0 ? 'complete' : 'failed', { code, signal }));
    this.initId = this.send('initialize', { clientInfo: { name: 'x-remote', version: '0.1.0' }, capabilities: {} });
    this.initialPrompt = prompt;
    return this;
  }
  onLine(line) {
    let msg; try { msg = JSON.parse(line); } catch { this.emit('output', { original: line }); return; }
    if (msg.id === this.initId && msg.result) {
      this.notify('initialized');
      this.threadStartId = this.resumeThreadId
        ? this.send('thread/resume', { threadId: this.resumeThreadId, ...CodexProvider.startParams(this.cwd) })
        : this.send('thread/start', CodexProvider.startParams(this.cwd));
      return;
    }
    if (msg.id === this.threadStartId && msg.result) {
      this.threadId = msg.result.thread?.id || msg.result.threadId;
      this.steer(this.initialPrompt);
      return;
    }
    if (msg.method === 'item/tool/requestUserInput' || msg.method?.includes('requestUserInput')) {
      const original = msg.params?.questions || msg.params;
      this.emit(isSensitivePrompt(original) ? 'localRequired' : 'decision', { decisionId: String(msg.id), original, requestId: msg.id });
      return;
    }
    if (msg.method?.includes('approval')) {
      this.emit('progress', { original: msg.params, note: 'approval request observed despite approvalPolicy=never' });
      return;
    }
    const method = msg.method || '';
    if (method === 'turn/started') this.activeTurnId = msg.params?.turn?.id || msg.params?.turnId;
    if (method.includes('completed') && method.includes('turn')) { this.activeTurnId = null; this.emit('complete', { original: msg.params }); }
    else if (method.includes('output') || method.includes('delta')) this.emit('output', { original: msg.params });
    else this.emit('progress', { original: msg });
  }
  steer(text) {
    if (!this.threadId) throw new Error('Codex thread is not ready');
    const input = [{ type: 'text', text }];
    if (this.activeTurnId) this.send('turn/steer', { threadId: this.threadId, expectedTurnId: this.activeTurnId, input });
    else this.send('turn/start', { threadId: this.threadId, input });
  }
  resume(text) { this.steer(text); }
  answer(requestId, answer, questions = []) {
    let values;
    try { values = typeof answer === 'string' && answer.trim().startsWith('{') ? JSON.parse(answer) : null; } catch { throw new Error('decision JSON is invalid'); }
    if (!values) {
      if (questions.length !== 1) throw new Error('multiple questions require a JSON object keyed by question id');
      values = { [questions[0].id]: answer };
    }
    const answers = {};
    for (const question of questions) {
      const value = values[question.id];
      if (value == null) throw new Error(`answer missing for question: ${question.id}`);
      answers[question.id] = { answers: Array.isArray(value) ? value.map(String) : [String(value)] };
    }
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { answers } }) + '\n');
  }
  interrupt() {
    if (this.threadId && this.activeTurnId) this.send('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId });
    else super.interrupt();
  }
}

export function createProvider(name, options) {
  if (name === 'claude') return new ClaudeProvider(options);
  if (name === 'codex') return new CodexProvider(options);
  throw new Error(`unsupported provider: ${name}`);
}
