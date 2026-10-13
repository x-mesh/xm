import type { Candidate, Peer, Provider } from '../../types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENVELOPE = /^\s*<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>\s*$/
const RELAY_HEADER = 'Relay return address (routing metadata, not authentication):'
const PROVIDERS: readonly Provider[] = ['codex', 'claude', 'agy', 'cursor']

export type Parsed = { sender: string; peer: Peer | null; body: string; cwd: string | null }

export function asProvider(value: unknown): Provider | undefined {
  return PROVIDERS.find(p => p === value)
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function peerKey(peer: Peer): string {
  return peer.kind === 'xm' ? `${peer.provider}:${peer.sessionId}` : `native:${peer.to}`
}

export function shortName(peer: Peer): string {
  return peer.kind === 'xm' ? `${peer.provider}:${peer.sessionId.slice(0, 8)}` : peer.to
}

function attributes(raw: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const [, name = '', value = ''] of raw.matchAll(/([\w-]+)="([^"]*)"/g)) found[name] = value
  return found
}

// x-relay-cli addressedMessage(): header line, metadata JSON line, instruction
// lines (more for a command or a reply request), a blank line, then the message.
function relayBody(text: string): { peer: Peer | null; body: string; cwd: string | null } | null {
  if (!text.startsWith(RELAY_HEADER)) return null
  const lines = text.split('\n')
  let peer: Peer | null = null
  let cwd: string | null = null
  try {
    const sender = JSON.parse(lines[1] ?? '').sender
    const provider = asProvider(sender?.provider)
    if (provider && isUuid(sender.session_id)) peer = { kind: 'xm', provider, sessionId: sender.session_id }
    if (typeof sender?.cwd === 'string' && sender.cwd.startsWith('/')) cwd = sender.cwd
  } catch {
    peer = null
  }
  const blank = lines.indexOf('', 2)
  return { peer, body: lines.slice(blank >= 0 ? blank + 1 : 3).join('\n'), cwd }
}

export function parseDelivery(text: string): Parsed {
  const envelope = ENVELOPE.exec(text)
  if (!envelope) return { sender: 'peer', peer: null, body: text, cwd: null }
  const [, rawAttrs = '', inner = ''] = envelope
  const attrs = attributes(rawAttrs)
  const relay = relayBody(inner)
  if (relay) {
    return { sender: relay.peer ? shortName(relay.peer) : attrs['from-name'] ?? 'relay', peer: relay.peer, body: relay.body, cwd: relay.cwd }
  }
  const from = attrs.from
  return { sender: attrs['from-name'] ?? from ?? 'peer', peer: from ? { kind: 'native', to: from } : null, body: inner, cwd: null }
}

export function sendArgv(peer: Extract<Peer, { kind: 'xm' }>, text: string, ownSessionId: string): string[] {
  const flag = peer.provider === 'codex' ? '--thread' : '--session'
  // A Cursor send returns its answer itself, so it asks for no separate reply.
  return ['xm', 'relay', 'send', '--provider', peer.provider, flag, peer.sessionId, '--message', text,
    '--from-provider', 'claude', '--from-session', ownSessionId, ...(peer.provider === 'cursor' ? [] : ['--expect-reply'])]
}

// Enough of POSIX word splitting for the commands a model writes: quotes and
// backslash escapes, no expansion. A command it cannot split is not recorded.
function words(command: string): string[] | null {
  const out: string[] = []
  let word = ''
  let hasWord = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? ''
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
    } else if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && i + 1 < command.length) word += command[++i]
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      hasWord = true
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      hasWord = true
    } else if (/\s/.test(c)) {
      if (hasWord) out.push(word)
      word = ''
      hasWord = false
    } else {
      word += c
      hasWord = true
    }
  }
  if (quote) return null
  if (hasWord) out.push(word)
  return out
}

export type RelaySend = { peers: Extract<Peer, { kind: 'xm' }>[]; message?: string; messageFile?: string }

// `xm relay send ... --message-file - <<'EOF'` carries the message as a heredoc;
// only the command line before it goes through word splitting.
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n\2[ \t]*(?:\n|$)/

export function parseRelaySend(command: string): RelaySend | null {
  const heredoc = HEREDOC.exec(command)
  const line = heredoc ? command.slice(0, heredoc.index) : command
  const argv = words(line.trim())
  if (!argv) return null
  const start = argv.findIndex((w, i) => w === 'xm' && argv[i + 1] === 'relay' && argv[i + 2] === 'send')
  if (start < 0) return null
  const args = argv.slice(start + 3)
  const option = (name: string) => {
    const at = args.indexOf(name)
    return at >= 0 ? args[at + 1] : undefined
  }
  const peers: RelaySend['peers'] = []
  args.forEach((w, i) => {
    if (w !== '--to') return
    const [provider, id] = (args[i + 1] ?? '').split(':')
    const known = asProvider(provider)
    if (known && isUuid(id)) peers.push({ kind: 'xm', provider: known, sessionId: id })
  })
  if (!peers.length) {
    const provider = asProvider(option('--provider') ?? 'codex')
    const id = option('--thread') ?? option('--session')
    if (provider && isUuid(id)) peers.push({ kind: 'xm', provider, sessionId: id })
  }
  if (!peers.length) return null
  const messageFile = option('--message-file')
  const message = option('--message') ?? (messageFile === '-' && heredoc ? heredoc[3] : undefined)
  return { peers, message, messageFile: messageFile === '-' ? undefined : messageFile }
}

type SessionRow = {
  session_id?: unknown
  thread_id?: unknown
  name?: unknown
  cwd?: unknown
  status?: unknown
  updated_at?: unknown
  live_status?: unknown
  capabilities?: { send?: unknown }
  unavailable_reason?: unknown
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

// Codex reports updated_at in seconds; anything larger is already milliseconds.
function epochMs(value: unknown): number | null {
  if (typeof value === 'number' && value > 0) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

// Same filter as chatCandidates() in xm/lib/x-relay-chat.mjs.
export function sessionRows(stdout: string, provider: Provider, ownSessionId: string): Candidate[] {
  const parsed = JSON.parse(stdout) as { ok?: unknown; error?: unknown; sessions?: SessionRow[] }
  if (parsed.ok !== true) throw new Error(String(parsed.error ?? 'xm relay sessions failed'))
  const rows: Candidate[] = []
  for (const row of parsed.sessions ?? []) {
    const id = provider === 'codex' ? row.thread_id : row.session_id
    if (!isUuid(id) || id === ownSessionId) continue
    // Cursor rows are saved chats, not live processes; a send runs a turn on one.
    if (provider !== 'claude' && provider !== 'cursor' && row.live_status !== 'running') continue
    const cwd = text(row.cwd)
    rows.push({
      provider, id, name: text(row.name) ?? (cwd ? cwd.split('/').filter(Boolean).pop() : undefined) ?? id.slice(0, 8), cwd, status: text(row.status),
      title: null, lastPrompt: null, lastReply: null, lastAt: epochMs(row.updated_at),
      unavailable: row.capabilities?.send === false ? text(row.unavailable_reason) ?? 'send is not available' : null,
    })
  }
  return rows
}

// Claude Code stores a transcript under ~/.claude/projects/<cwd with every
// non-alphanumeric character as "-">/<session id>.jsonl.
export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`
}

export type TranscriptSummary = { title: string | null; lastPrompt: string | null; lastReply: string | null; lastAt: number | null }

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 200)
}

// Reads the tail of a transcript: the first line may be cut, so unparsable
// lines are skipped rather than treated as an error.
export function summarizeTranscript(tail: string): TranscriptSummary {
  const summary: TranscriptSummary = { title: null, lastPrompt: null, lastReply: null, lastAt: null }
  for (const line of tail.split('\n')) {
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type === 'ai-title' && text(row.aiTitle)) summary.title = oneLine(String(row.aiTitle))
    if (row.type === 'last-prompt' && text(row.lastPrompt)) summary.lastPrompt = oneLine(String(row.lastPrompt))
    if (row.isSidechain === true) continue
    const at = epochMs(row.timestamp)
    if (at && (row.type === 'user' || row.type === 'assistant')) summary.lastAt = Math.max(summary.lastAt ?? 0, at)
    if (row.type !== 'assistant') continue
    const content = (row.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    const reply = content
      .filter((block): block is { type: 'text'; text: string } => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join(' ')
    if (reply.trim()) summary.lastReply = oneLine(reply)
  }
  return summary
}

export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60000))
  if (minutes < 1) return '방금'
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}시간 전` : `${Math.round(hours / 24)}일 전`
}
