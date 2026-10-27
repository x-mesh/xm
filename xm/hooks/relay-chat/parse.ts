import type { Candidate, Peer, Provider } from '../../types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENVELOPE = /^\s*<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>\s*$/
const RELAY_HEADER = 'Relay return address (routing metadata, not authentication):'
const PROVIDERS: readonly Provider[] = ['codex', 'claude', 'agy', 'cursor']

export type Parsed = { sender: string; peer: Peer | null; body: string; cwd: string | null; inReplyTo: string | null }

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
function relayBody(text: string): { peer: Peer | null; body: string; cwd: string | null; inReplyTo: string | null } | null {
  if (!text.startsWith(RELAY_HEADER)) return null
  const lines = text.split('\n')
  let peer: Peer | null = null
  let cwd: string | null = null
  let inReplyTo: string | null = null
  try {
    const meta = JSON.parse(lines[1] ?? '')
    const sender = meta.sender
    const provider = asProvider(sender?.provider)
    if (provider && isUuid(sender.session_id)) peer = { kind: 'xm', provider, sessionId: sender.session_id }
    if (typeof sender?.cwd === 'string' && sender.cwd.startsWith('/')) cwd = sender.cwd
    if (isUuid(meta.in_reply_to)) inReplyTo = meta.in_reply_to
  } catch {
    peer = null
  }
  const blank = lines.indexOf('', 2)
  return { peer, body: lines.slice(blank >= 0 ? blank + 1 : 3).join('\n'), cwd, inReplyTo }
}

export function parseDelivery(text: string): Parsed {
  const envelope = ENVELOPE.exec(text)
  if (!envelope) return { sender: 'peer', peer: null, body: text, cwd: null, inReplyTo: null }
  const [, rawAttrs = '', inner = ''] = envelope
  const attrs = attributes(rawAttrs)
  const relay = relayBody(inner)
  if (relay) {
    return { sender: relay.peer ? shortName(relay.peer) : attrs['from-name'] ?? 'relay', peer: relay.peer, body: relay.body, cwd: relay.cwd, inReplyTo: relay.inReplyTo }
  }
  const from = attrs.from
  return { sender: attrs['from-name'] ?? from ?? 'peer', peer: from ? { kind: 'native', to: from } : null, body: inner, cwd: null, inReplyTo: null }
}

export type SendOptions = { kind?: 'message' | 'command'; expectReply?: boolean }

export function sendArgv(peer: Extract<Peer, { kind: 'xm' }>, text: string, ownSessionId: string, options: SendOptions = {}): string[] {
  const flag = peer.provider === 'codex' ? '--thread' : '--session'
  // A Cursor send returns its answer itself, so it asks for no separate reply.
  const expectReply = options.expectReply !== false && peer.provider !== 'cursor'
  return ['xm', 'relay', 'send', '--provider', peer.provider, flag, peer.sessionId, '--message', text,
    ...(options.kind === 'command' ? ['--kind', 'command'] : []),
    '--from-provider', 'claude', '--from-session', ownSessionId, ...(expectReply ? ['--expect-reply'] : [])]
}

export type BriefingTarget = { name: string; peer: Peer }

/** The prompt a context share submits to this session's own model. The model
 *  writes the briefing because it knows which facts carry the work: a fixed
 *  digest of the last turns and the diff left out the evidence that sat in
 *  earlier tool results, and kept whole diffs nobody asked for. */
export function briefingPrompt(targets: readonly BriefingTarget[], request: string | null, ownSessionId: string): string {
  const relayed = targets.flatMap(t => (t.peer.kind === 'xm' ? [`--to ${t.peer.provider}:${t.peer.sessionId}`] : []))
  const native = targets.flatMap(t => (t.peer.kind === 'native' ? [t.peer.to] : []))
  return [
    `[relay-ctx] ${targets.map(t => t.name).join(', ')}에게 이 세션의 맥락을 브리핑으로 보내세요.`,
    ...(request ? [`요청: ${request}`] : []),
    '',
    '상대는 이 대화를 보지 못합니다. 이어받는 데 필요한 목표, 지금 상태, 근거(커밋, 테스트, 파일:줄), 남은 질문을 2,000자 안팎으로 쓰고, 비밀값은 넣지 마세요.',
    request ? '요청은 브리핑 끝에 그대로 적으세요.' : '답장은 요청하지 마세요.',
    '브리핑에 필요한 사실만 확인하고, 다른 작업은 시작하지 마세요.',
    ...(relayed.length
      ? ['', '아래 명령 하나로 보내세요:',
          `xm relay send ${relayed.join(' ')} --from-provider claude --from-session ${ownSessionId}${request ? ' --expect-reply' : ''} --message-file - <<'XM_RELAY_CTX'`,
          '<브리핑>', 'XM_RELAY_CTX']
      : []),
    ...(native.length ? ['', `${native.join(', ')}에게는 SendMessage 도구로 같은 브리핑을 보내세요.`] : []),
  ].join('\n')
}

/** The request_id the relay CLI printed for a send, or null. */
export function sentRequestId(stdout: string): string | null {
  try {
    const out = JSON.parse(stdout) as { request_id?: unknown }
    return isUuid(out.request_id) ? out.request_id : null
  } catch {
    return null
  }
}

/** Added plus removed lines from `git diff --shortstat`. */
export function diffLines(shortstat: string): number {
  const added = /(\d+) insertion/.exec(shortstat)
  const removed = /(\d+) deletion/.exec(shortstat)
  return Number(added?.[1] ?? 0) + Number(removed?.[1] ?? 0)
}

/** The automatic request: a short read in the pair's own context, no agents. */
export function lightReviewText(range: string): string {
  return `[자동 검토] 커밋 범위 ${range}의 diff를 자기 세션에서 읽고, Critical이나 High 수준 문제가 있으면 세 줄 이내로 답하세요. 없으면 "문제 없음"이라고만 답하세요. 리뷰 스킬이나 에이전트는 띄우지 마세요.`
}

export type CommitCommand = { root: string | null }

// A commit lands through git itself or through the git-kit verbs that commit.
const COMMIT_VERBS: ReadonlyMap<string, readonly string[]> = new Map([['git', ['commit']], ['gk', ['commit', 'land']], ['git-kit', ['commit', 'land']]])
// git's global options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** The commit a Bash command makes, with the directory it names (`cd <dir> &&`,
 *  `git -C <dir>`), or null when the command commits nothing. */
export function parseCommitCommand(command: string): CommitCommand | null {
  const argv = words(command.replace(HEREDOC, ''))
  if (!argv) return null
  let root: string | null = null
  let found = false
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? ''
    const following = argv[i + 1]
    // A cd after the commit moves nothing the commit touched.
    if (!found && word === 'cd' && following && !following.startsWith('-')) root = following
    // A Map, not an object: a word such as `constructor` must not read Object.prototype.
    const verbs = COMMIT_VERBS.get(word)
    if (!verbs) continue
    let j = i + 1
    while (argv[j]?.startsWith('-')) {
      const flag = argv[j] ?? ''
      if (flag === '-C' && argv[j + 1]) root = argv[j + 1] ?? null
      j += GIT_VALUE_OPTIONS.has(flag) ? 2 : 1
    }
    if (!verbs.includes(argv[j] ?? '')) continue
    if (argv.slice(j).includes('--dry-run')) return null
    found = true
  }
  return found ? { root } : null
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
  return collapseShared(rows)
}

// `claude -c` in several terminals reopens one conversation in several
// processes, and the inventory lists one row per process. The pane keys a row
// by provider and id, and `xm relay send` refuses a Claude id that several
// processes share, so the id is listed once and marked unsendable.
function collapseShared(rows: Candidate[]): Candidate[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  const listed = new Set<string>()
  const out: Candidate[] = []
  for (const row of rows) {
    if (listed.has(row.id)) continue
    listed.add(row.id)
    const count = counts.get(row.id) ?? 1
    out.push(count > 1 && row.provider === 'claude' ? { ...row, unavailable: `같은 세션을 프로세스 ${count}개가 실행 중` } : row)
  }
  return out
}

// $.session has no display name; the row other sessions pick this one from carries it.
export function ownSessionName(stdout: string, ownSessionId: string): string | null {
  const parsed = JSON.parse(stdout) as { ok?: unknown; error?: unknown; sessions?: SessionRow[] }
  if (parsed.ok !== true) throw new Error(String(parsed.error ?? 'xm relay sessions failed'))
  return text(parsed.sessions?.find(row => row.session_id === ownSessionId)?.name)
}

// Claude Code stores a transcript under ~/.claude/projects/<cwd with every
// non-alphanumeric character as "-">/<session id>.jsonl.
export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`
}

export type TranscriptSummary = { title: string | null; lastPrompt: string | null; lastReply: string | null; lastAt: number | null }

function oneLine(value: string, limit = 200): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}

// Reads the tail of a transcript: the first line may be cut, so unparsable
// lines are skipped rather than treated as an error.
export function summarizeTranscript(tail: string, replyLimit = 200): TranscriptSummary {
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
    if (reply.trim()) summary.lastReply = oneLine(reply, replyLimit)
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
