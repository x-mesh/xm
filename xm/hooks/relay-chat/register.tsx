import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionReceiveInput } from 'claude-code'

import type { AutoReview, Candidate, ChatLine, Conversation, Pair, PendingCommit, Peer, Picker } from '../../types'
import {
  ago, briefingPrompt, diffLines, lightReviewText, ownSessionName, parseCommitCommand, parseDelivery, parseRelaySend, peerKey,
  sendArgv, sentRequestId, sessionRows, shortName, summarizeTranscript, transcriptPath,
} from './parse'
import { ICON_SVG, LABEL, badgeCells, badgeColumns, cells, displayName, fit, labels, layoutFor, pad, providerOf } from './view'
import type { Who } from './view'

const PANE = 'relay-chat'
const COMMAND = 'relay-chat'
const CONTEXT_COMMAND = 'relay-ctx'
const KEEP_LINES = 200
const SHOWN_LINES = 30
const PROVIDERS = ['codex', 'claude', 'agy', 'cursor'] as const
const SHOWN_COMMITS = 5
const KEEP_COMMITS = 20

const conversations = atom({ plugin: 'xm', key: 'relayChatConversations' } as const, [])
const activeKey = atom({ plugin: 'xm', key: 'relayChatActiveKey' } as const, null)
const picker = atom({ plugin: 'xm', key: 'relayChatPicker' } as const, {
  isOpen: false,
  isLoading: false,
  pending: [],
  candidates: [],
  notes: [],
})
const pair = atom({ plugin: 'xm', key: 'relayChatPair' } as const, null)
const commits = atom({ plugin: 'xm', key: 'relayChatCommits' } as const, [])
const autoReview = atom({ plugin: 'xm', key: 'relayChatAutoReview' } as const, { enabled: false, lastAt: null, skippedSha: null, skippedLines: null })
const quietRequests = atom({ plugin: 'xm', key: 'relayChatQuietRequests' } as const, [])
// The time of the newest peer line the person dismissed from the band; a newer line shows it again.
const bandDismissedAt = atom({ plugin: 'xm', key: 'relayChatBandDismissedAt' } as const, null)
const self = atom({ plugin: 'xm', key: 'relayChatSelf' } as const, null)

// Start values, not measured ones; the manifest's userConfig lets a person change them.
const DEFAULT_AUTO_COOLDOWN_MINUTES = 30
const DEFAULT_AUTO_MAX_LINES = 400
type AutoLimits = { cooldownMs: number; maxLines: number }

// Only a Claude or Codex session answers a review request; Cursor runs one
// read-only turn and AGY cannot be reached from outside its own session.
function canPair(peer: Peer | null): peer is Extract<Peer, { kind: 'xm' }> {
  return peer?.kind === 'xm' && (peer.provider === 'claude' || peer.provider === 'codex')
}

const pairStoreKey = (cwd: string) => `pair:${cwd}`
const autoStoreKey = (cwd: string) => `auto:${cwd}`
// The newest commit a review request covered, so the next seed starts after it.
const reviewedStoreKey = (cwd: string) => `reviewed:${cwd}`
const COMMIT_FORMAT = '--format=%H%x1f%s%x1f%ct'

function asPair(value: unknown): Pair | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const provider = asProviderName(v.provider)
  return typeof v.key === 'string' && typeof v.name === 'string' && provider && typeof v.sessionId === 'string'
    ? { key: v.key, name: v.name, provider, sessionId: v.sessionId }
    : null
}

function asProviderName(value: unknown): Pair['provider'] | null {
  return value === 'claude' || value === 'codex' ? value : null
}

// The pair belongs to the project, so it is kept per session directory and
// outlives the session.
async function loadPair($: EngineInterface) {
  const cwd = await $.session.cwd()
  const saved = asPair(await $.store.get(pairStoreKey(cwd)))
  await update($, pair, () => saved)
  const enabled = (await $.store.get(autoStoreKey(cwd))) === true
  await update($, autoReview, a => ({ ...a, enabled }))
}

async function setAutoReview($: EngineInterface, enabled: boolean) {
  await $.store.set(autoStoreKey(await $.session.cwd()), enabled)
  await update($, autoReview, a => ({ ...a, enabled }))
}

async function setPair($: EngineInterface, conversation: Conversation | null) {
  const storeKey = pairStoreKey(await $.session.cwd())
  if (!conversation || !canPair(conversation.peer)) {
    await $.store.delete(storeKey)
    await update($, pair, () => null)
    return
  }
  const next: Pair = { key: conversation.key, name: conversation.name, provider: conversation.peer.provider, sessionId: conversation.peer.sessionId }
  await $.store.set(storeKey, next)
  await update($, pair, () => next)
  $.ui.toast(`${conversation.name} 세션을 페어로 지정했습니다.`)
  await seedCommits($)
}

function parseCommitLog(stdout: string, root: string, fallbackAt: number): { sha: string; subject: string; at: number; root: string }[] {
  const found: { sha: string; subject: string; at: number; root: string }[] = []
  for (const line of stdout.split('\n')) {
    const [sha = '', subject = '', seconds = ''] = line.split('\x1f')
    if (!/^[0-9a-f]{40}$/.test(sha)) continue
    const at = Number(seconds) > 0 ? Number(seconds) * 1000 : fallbackAt
    found.push({ sha, subject, at, root })
  }
  return found
}

type GitRun = { stdout: string; error: null } | { stdout: null; error: string }

// The failure is kept, not swallowed: a digest that says "no branch" because
// git could not run would send a peer a false picture of this session.
async function gitRun($: EngineInterface, dir: string, args: readonly string[]): Promise<GitRun> {
  try {
    const ran = await $.process.run(['git', '-C', dir, ...args])
    if (ran.exitCode === 0) return { stdout: ran.stdout, error: null }
    return { stdout: null, error: `git ${args[0]}: ${ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`}` }
  } catch (err) {
    return { stdout: null, error: `git ${args[0]}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function git($: EngineInterface, dir: string, args: readonly string[]): Promise<string | null> {
  return (await gitRun($, dir, args)).stdout
}

// Commits are grouped and marked reviewed by repository, so `cd sub && git
// commit` and a commit from the session's own directory land in one place.
async function repoRoot($: EngineInterface, dir: string): Promise<string> {
  return (await git($, dir, ['rev-parse', '--show-toplevel']))?.trim() || dir
}

// Commits made outside this session's Bash tool (the person's own terminal, an
// earlier session) are found in git: everything after the last reviewed commit,
// or else what is not pushed yet, or else the last five.
async function seedCommits($: EngineInterface) {
  const dir = await $.session.cwd()
  const reviewed = await $.store.get(reviewedStoreKey(dir))
  let stdout: string | null = null
  if (typeof reviewed === 'string' && /^[0-9a-f]{40}$/.test(reviewed) && (await git($, dir, ['merge-base', '--is-ancestor', reviewed, 'HEAD'])) !== null) {
    stdout = await git($, dir, ['log', COMMIT_FORMAT, '-n', String(KEEP_COMMITS), `${reviewed}..HEAD`])
  }
  if (stdout === null) stdout = await git($, dir, ['log', COMMIT_FORMAT, '-n', String(KEEP_COMMITS), '@{upstream}..HEAD'])
  if (stdout === null) stdout = await git($, dir, ['log', COMMIT_FORMAT, '-n', String(SHOWN_COMMITS)])
  if (stdout === null) return
  const found = parseCommitLog(stdout, await repoRoot($, dir), await $.clock.now()).reverse()
  if (!found.length) return
  await update($, commits, list => [...list, ...found.filter(f => !list.some(c => c.sha === f.sha))].slice(-KEEP_COMMITS))
}

// Subagent loops and agent-team mailboxes are this session's own work, not a
// conversation with another session.
function isPeerDelivery(e: SessionReceiveInput): boolean {
  if (e.agentId !== undefined || 'teammate' in e.origin) return false
  if (e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message') return true
  return e.text.includes('<cross-session-message')
}

async function refreshStatus($: EngineInterface) {
  const unread = (await read($, conversations)).reduce((sum, c) => sum + c.unread, 0)
  $.ui.status(unread ? `💬 relay ${unread}` : undefined)
}

type Opening = { key: string; name: string; peer: Peer | null; cwd?: string | null }

// A peer's message is announced where the person is looking: a toast with its
// first words, and the band above the prompt until the pane shows it. The
// status line alone ("💬 relay 1") gave no way to see what arrived.
function preview(text: string, width = 80): string {
  return fit(text.replace(/\s+/g, ' ').trim(), width)
}

async function record($: EngineInterface, opening: Opening, line: ChatLine) {
  if (line.by === 'peer') {
    await update($, bandDismissedAt, () => null)
    const who = displayName(opening.name, opening.peer)
    $.ui.toast(line.quiet ? `🔕 ${who}의 자동 검토 답장 · /relay-chat에서 확인` : `💬 ${who}: ${preview(line.text, 60)}`)
  }
  await update($, conversations, list => {
    const found = list.find(c => c.key === opening.key)
    const base: Conversation = found ?? { key: opening.key, name: opening.name, peer: opening.peer, cwd: opening.cwd ?? null, lines: [], unread: 0 }
    const next: Conversation = {
      ...base,
      cwd: base.cwd ?? opening.cwd ?? null,
      lines: [...base.lines, line].slice(-KEEP_LINES),
      // A line the person sent reads the conversation; one the pane sent on its own does not.
      unread: line.by === 'peer' ? base.unread + 1 : line.auto ? base.unread : 0,
    }
    return found ? list.map(c => (c.key === opening.key ? next : c)) : [...list, next]
  })
  await refreshStatus($)
}

async function select($: EngineInterface, key: string) {
  await update($, activeKey, () => key)
  await update($, conversations, list => list.map(c => (c.key === key ? { ...c, unread: 0 } : c)))
  await refreshStatus($)
}

async function openCandidate($: EngineInterface, candidate: Candidate) {
  const peer: Peer = { kind: 'xm', provider: candidate.provider, sessionId: candidate.id }
  const key = peerKey(peer)
  const forPair = (await read($, picker)).forPair === true
  await update($, conversations, list =>
    list.some(c => c.key === key)
      ? list.map(c => (c.key === key ? { ...c, name: candidate.name, cwd: candidate.cwd } : c))
      : [...list, { key, name: candidate.name, peer, cwd: candidate.cwd, lines: [], unread: 0 }],
  )
  await update($, picker, p => ({ ...p, isOpen: false, forPair: false }))
  await select($, key)
  if (!forPair) return
  const conversation = (await read($, conversations)).find(c => c.key === key)
  if (!conversation || !canPair(conversation.peer)) {
    $.ui.toast(`${candidate.name}은(는) 페어로 쓸 수 없습니다. Claude나 Codex 세션을 고르세요.`)
    return
  }
  await setPair($, conversation)
  await requestReview($)
}

// A commit the session made: the newest one in the directory the command named.
async function noteCommit($: EngineInterface, root: string | null) {
  const dir = root ?? await $.session.cwd()
  let ran
  try {
    ran = await $.process.run(['git', '-C', dir, 'log', '-1', COMMIT_FORMAT])
  } catch {
    return
  }
  if (ran.exitCode !== 0) return
  const [sha = '', subject = ''] = ran.stdout.trim().split('\x1f')
  if (!/^[0-9a-f]{40}$/.test(sha)) return
  const at = await $.clock.now()
  const repo = await repoRoot($, dir)
  await update($, commits, list => (list.some(c => c.sha === sha) ? list : [...list, { sha, subject, at, root: repo }].slice(-KEEP_COMMITS)))
  const who = await read($, pair)
  $.ui.toast(`커밋 ${sha.slice(0, 7)} · ${who ? `${who.name}에게 리뷰 요청 가능` : '리뷰 요청 가능'}`)
}

// One request covers every pending commit of one directory, oldest to newest,
// as a command the pair runs in its own session (`xm:review diff <range>`).
async function requestReview($: EngineInterface) {
  const pending = await read($, commits)
  if (!pending.length) return
  const who = await read($, pair)
  if (!who) {
    await loadCandidates($, true)
    return
  }
  const conversation = await pairConversation($, who)
  if (!conversation || !canPair(conversation.peer)) {
    $.ui.toast('페어 대화가 없습니다. 페어를 다시 지정하세요.')
    return
  }
  const batch = pendingGroup(pending)
  if (!batch) return
  const ran = await $.process.run(sendArgv(conversation.peer, `xm:review diff ${batch.range}`, await $.session.id(), { kind: 'command' }))
  if (ran.exitCode !== 0) {
    $.ui.toast(`리뷰 요청 실패 (${conversation.name}): ${ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`}`)
    return
  }
  await record($, conversation, {
    at: await $.clock.now(), by: 'me',
    text: `리뷰 요청 ${batch.range} · 커밋 ${batch.group.length}개: ${batch.group.map(c => c.subject).join(' / ')}`,
  })
  await settleGroup($, batch)
  await select($, conversation.key)
}

type Batch = { group: PendingCommit[]; newest: PendingCommit; range: string }

// The pending commits of the directory the newest one is in, oldest first.
function pendingGroup(pending: readonly PendingCommit[]): Batch | null {
  const newest = [...pending].sort((a, b) => b.at - a.at)[0]
  if (!newest) return null
  const group = pending.filter(c => c.root === newest.root).sort((a, b) => a.at - b.at)
  const first = group[0]
  if (!first) return null
  return { group, newest, range: `${first.sha.slice(0, 7)}~1..${newest.sha.slice(0, 7)}` }
}

async function settleGroup($: EngineInterface, batch: Batch) {
  await update($, commits, list => list.filter(c => !batch.group.some(g => g.sha === c.sha)))
  await markReviewed($, batch.newest)
}

// The marker is kept per session directory, for commits of that directory's repository.
async function markReviewed($: EngineInterface, newest: PendingCommit | undefined) {
  const cwd = await $.session.cwd()
  if (newest && newest.root === await repoRoot($, cwd)) await $.store.set(reviewedStoreKey(cwd), newest.sha)
}

// Dismissed commits are marked reviewed, so the next seed from git does not bring them back.
// The marker is HEAD when HEAD is among them: commit times have one-second
// resolution, so the newest by time can be an older commit of the same second.
async function dismissCommits($: EngineInterface) {
  const root = await repoRoot($, await $.session.cwd())
  const dismissed = (await read($, commits)).filter(c => c.root === root)
  const head = (await git($, root, ['rev-parse', 'HEAD']))?.trim()
  const newest = dismissed.find(c => c.sha === head)
    ?? dismissed.map((c, i) => ({ c, i })).sort((a, b) => b.c.at - a.c.at || b.i - a.i)[0]?.c
  await markReviewed($, newest)
  await update($, commits, () => [])
}

// The pair outlives the session in the store; the conversations do not. A pair
// restored in a new session gets its conversation back from what was stored.
async function pairConversation($: EngineInterface, who: Pair): Promise<Conversation | undefined> {
  const found = (await read($, conversations)).find(c => c.key === who.key)
  if (found) return found
  const peer: Peer = { kind: 'xm', provider: who.provider, sessionId: who.sessionId }
  const restored: Conversation = { key: who.key, name: who.name, peer, cwd: null, lines: [], unread: 0 }
  await update($, conversations, list => (list.some(c => c.key === who.key) ? list : [...list, restored]))
  return (await read($, conversations)).find(c => c.key === who.key)
}

// At the end of a turn with the option on: one light request per cooldown,
// for a diff under the size cap, as a message the pair answers in its own
// context. The reply comes back quiet (see session.receive).
async function autoReviewTick($: EngineInterface, limits: AutoLimits) {
  const auto = await read($, autoReview)
  if (!auto.enabled) return
  const pending = await read($, commits)
  const batch = pendingGroup(pending)
  if (!batch) return
  const now = await $.clock.now()
  if (auto.lastAt !== null && now - auto.lastAt < limits.cooldownMs) return
  const who = await read($, pair)
  const conversation = who ? await pairConversation($, who) : undefined
  if (!conversation || !canPair(conversation.peer)) return
  const shortstat = await git($, batch.newest.root, ['diff', '--shortstat', `${batch.group[0]?.sha}~1`, batch.newest.sha])
  const lines = shortstat === null ? null : diffLines(shortstat)
  if (lines === null || lines > limits.maxLines) {
    if (auto.skippedSha !== batch.newest.sha) {
      await update($, autoReview, a => ({ ...a, skippedSha: batch.newest.sha, skippedLines: lines }))
      $.ui.toast(lines === null ? '자동 리뷰 건너뜀: diff 크기를 읽지 못했습니다' : `자동 리뷰 건너뜀: diff ${lines}줄이 상한 ${limits.maxLines}줄을 넘습니다. 위 버튼으로 요청하세요.`)
    }
    return
  }
  const ran = await $.process.run(sendArgv(conversation.peer, lightReviewText(batch.range), await $.session.id()))
  if (ran.exitCode !== 0) {
    // The cooldown spaces retries too: a pair that went away is not asked every turn.
    await update($, autoReview, a => ({ ...a, lastAt: now }))
    $.ui.toast(`자동 리뷰 요청 실패 (${conversation.name}): ${ran.stderr.trim().split('\n')[0] || `exit ${ran.exitCode}`}`)
    return
  }
  const requestId = sentRequestId(ran.stdout)
  if (requestId) await update($, quietRequests, ids => [...ids, requestId].slice(-20))
  else $.ui.toast('자동 리뷰 요청의 request_id를 읽지 못했습니다. 답장은 모델에게 그대로 전달됩니다.')
  const quiet = requestId !== null
  await record($, conversation, { at: now, by: 'me', quiet, auto: true, text: `자동 검토 요청 ${batch.range} · 커밋 ${batch.group.length}개 · diff ${lines}줄` })
  await update($, autoReview, a => ({ ...a, lastAt: now, skippedSha: null, skippedLines: null }))
  await settleGroup($, batch)
}

// A quiet line goes to the model only when the person asks for it.
async function forwardToModel($: EngineInterface, key: string, at: number) {
  const conversation = (await read($, conversations)).find(c => c.key === key)
  const line = conversation?.lines.find(l => l.at === at && l.quiet && l.by === 'peer')
  if (!conversation || !line) return
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[relay] ${conversation.name}의 검토 의견:\n${line.text}` }] } })
  // Matched by fields: the value read and the one updated are not the same objects.
  await update($, conversations, list => list.map(c => (c.key === key ? { ...c, lines: c.lines.map(l => (l.at === at && l.by === 'peer' && l.quiet ? { ...l, quiet: false } : l)) } : c)))
  $.ui.toast(`${conversation.name}의 검토 의견을 모델에게 전달했습니다.`)
}

// Bumped per load, so a slower earlier load cannot overwrite a newer one.
let loadSeq = 0

const byLastAt = (a: Candidate, b: Candidate) =>
  Number(a.unavailable !== null) - Number(b.unavailable !== null) || (b.lastAt ?? 0) - (a.lastAt ?? 0)

// The CLI explains in English; an AGY row needs its backend's address and CSRF
// token, which only a process inside that AGY session holds.
function unavailableLabel(c: Candidate): string {
  return c.provider === 'agy' && /ANTIGRAVITY_LS_ADDRESS/.test(c.unavailable ?? '') ? 'AGY 세션 안에서만 보낼 수 있음' : c.unavailable ?? ''
}

// Providers are listed in parallel and merged as each answers, so one slow
// inventory does not hold back the others. Rows from the previous load stay
// on screen until their provider answers again.
// `forPair` is set by the review request that opens the picker to choose a
// pair, and kept by a refresh of that open picker; every other opening clears
// it, so a plain add never becomes a pairing.
async function loadCandidates($: EngineInterface, forPair = false) {
  const seq = ++loadSeq
  await update($, picker, p => ({ ...p, isOpen: true, isLoading: true, pending: [...PROVIDERS], notes: [], forPair }))
  const own = await $.session.id()
  const home = await $.env.get('HOME')
  await Promise.all(PROVIDERS.map(async provider => {
    let rows: Candidate[] = []
    let note: string | null = null
    try {
      const ran = await $.process.run(['xm', 'relay', 'sessions', '--provider', provider])
      rows = await Promise.all(sessionRows(ran.stdout, provider, own).map(c => withTranscript($, c, home)))
      if (provider === 'claude') await update($, self, () => ({ id: own, name: ownSessionName(ran.stdout, own) }))
    } catch (error) {
      note = `${provider} 조회 실패: ${error instanceof Error ? error.message : String(error)}`
    }
    if (seq !== loadSeq) return
    await update($, picker, p => {
      // A picker saved by the previous module version survives a reload without `pending`.
      const pending = (p.pending ?? []).filter(x => x !== provider)
      return {
        ...p,
        pending,
        isLoading: pending.length > 0,
        candidates: [...p.candidates.filter(c => c.provider !== provider), ...rows].sort(byLastAt),
        notes: note ? [...p.notes, note] : p.notes,
      }
    })
  }))
}

// The pane names this session at its top, so a person at another session can
// tell which row of their own list to pick.
async function loadSelf($: EngineInterface) {
  const id = await $.session.id()
  let name: string | null = null
  try {
    name = ownSessionName((await $.process.run(['xm', 'relay', 'sessions', '--provider', 'claude'])).stdout, id)
  } catch {
    // An unreadable listing leaves the name null; the pane says it could not read one.
  }
  await update($, self, () => ({ id, name }))
}

// The last 2 MB of a transcript holds its latest title, prompt and reply rows;
// reading by bytes keeps one huge tool result from pushing them out of reach.
async function withTranscript($: EngineInterface, candidate: Candidate, home: string | undefined): Promise<Candidate> {
  if (candidate.provider !== 'claude' || !home || !candidate.cwd) return candidate
  const path = transcriptPath(home, candidate.cwd, candidate.id)
  if (!(await $.fs.exists(path))) return candidate
  const ran = await $.process.run(['tail', '-c', '2000000', path])
  if (ran.exitCode !== 0) return candidate
  const summary = summarizeTranscript(ran.stdout)
  return { ...candidate, ...summary, lastAt: summary.lastAt ?? candidate.lastAt }
}

async function sendTo($: EngineInterface, conversation: Conversation, text: string): Promise<string | null> {
  const peer = conversation.peer
  if (!peer) return '답장 경로가 없는 대화입니다.'
  if (peer.kind === 'native') {
    const sent = await $.session.send({ to: peer.to, text })
    if (!sent.isDelivered) return sent.reason
  } else if (peer.provider === 'cursor') {
    return sendToCursor($, conversation, peer, text)
  } else {
    const ran = await $.process.run(sendArgv(peer, text, await $.session.id()))
    if (ran.exitCode !== 0) return ran.stderr.trim().split('\n')[0] || ran.stdout.trim().split('\n')[0] || `exit ${ran.exitCode}`
  }
  await record($, conversation, { at: await $.clock.now(), by: 'me', text })
  return null
}

function cursorReply(stdout: unknown): string | null {
  if (typeof stdout !== 'string') return null
  try {
    const out = JSON.parse(stdout) as { state?: unknown; reply?: unknown }
    return out.state === 'answered' && typeof out.reply === 'string' ? out.reply : null
  } catch {
    return null
  }
}

async function setWaiting($: EngineInterface, key: string, waiting: boolean) {
  await update($, conversations, list => list.map(c => (c.key === key ? { ...c, waiting } : c)))
}

// A Cursor send runs one cursor-agent turn (10-20 s) and its answer is the reply,
// so the message is recorded first and the answer when the turn returns.
async function sendToCursor($: EngineInterface, conversation: Conversation, peer: Extract<Peer, { kind: 'xm' }>, text: string): Promise<string | null> {
  await record($, conversation, { at: await $.clock.now(), by: 'me', text })
  await setWaiting($, conversation.key, true)
  try {
    const ran = await $.process.run(sendArgv(peer, text, await $.session.id()), { timeoutMs: 200000 })
    if (ran.exitCode !== 0) return ran.stderr.trim().split('\n')[0] || ran.stdout.trim().split('\n')[0] || `exit ${ran.exitCode}`
    const reply = cursorReply(ran.stdout)
    if (reply === null) return 'Cursor 응답에 답이 없습니다.'
    await record($, conversation, { at: await $.clock.now(), by: 'peer', text: reply })
    return null
  } finally {
    await setWaiting($, conversation.key, false)
  }
}

async function say($: EngineInterface, key: string, text: string) {
  drafts.delete(key)
  if (!text.trim()) return
  const conversation = (await read($, conversations)).find(c => c.key === key)
  if (!conversation) return
  const failure = await sendTo($, conversation, text)
  if (failure) $.ui.toast(`전송 실패 (${conversation.name}): ${failure}`)
}

async function broadcast($: EngineInterface, text: string) {
  drafts.delete('all')
  if (!text.trim()) return
  const targets = (await read($, conversations)).filter(c => c.peer)
  const failed: string[] = []
  for (const conversation of targets) {
    const failure = await sendTo($, conversation, text)
    if (failure) failed.push(`${conversation.name}: ${failure}`)
  }
  $.ui.toast(failed.length ? `${targets.length - failed.length}/${targets.length}곳 전송. 실패 ${failed.join(', ')}` : `${targets.length}곳에 전송`)
}

// The text in each message field as the person types it, by conversation key
// ('all' for the broadcast field): a share takes it as its request. Module
// state: a reload drops it, as it drops the field itself.
const drafts = new Map<string, string>()

// The share is written by this session's model, which sends it itself; the
// pane records that send from the model's command like any other.
async function shareContext($: EngineInterface, targets: readonly Conversation[], request: string | null): Promise<string | null> {
  const reachable = targets.flatMap(c => (c.peer && !(c.peer.kind === 'xm' && c.peer.provider === 'cursor') ? [{ name: c.name, peer: c.peer }] : []))
  if (!reachable.length) return targets.some(c => c.peer) ? 'Cursor는 받은 맥락을 세션에 쌓지 않습니다.' : '답장 경로가 없는 대화입니다.'
  const text = briefingPrompt(reachable, request, await $.session.id())
  // A submit from a command.run hook is refused: it would wait on the turn that hook holds.
  $.clock.after(0, () => {
    void $.prompt.submit({ text }).then(
      result => { if (result.drop !== undefined) $.ui.toast(`맥락 공유 요청이 들어가지 못했습니다: ${result.drop}`) },
      (error: unknown) => $.ui.toast(`맥락 공유 요청 실패: ${error instanceof Error ? error.message : String(error)}`),
    )
  })
  return null
}

async function shareContextWith($: EngineInterface, key: string) {
  const conversation = (await read($, conversations)).find(c => c.key === key)
  if (!conversation) return
  const failure = await shareContext($, [conversation], drafts.get(key)?.trim() || null)
  $.ui.toast(failure ? `맥락 공유 실패 (${conversation.name}): ${failure}` : `${conversation.name}에게 보낼 맥락을 모델이 정리합니다.`)
}

async function broadcastContext($: EngineInterface) {
  const targets = await read($, conversations)
  const failure = await shareContext($, targets, drafts.get('all')?.trim() || null)
  $.ui.toast(failure ? `맥락 공유 실패: ${failure}` : '대화 상대 모두에게 보낼 맥락을 모델이 정리합니다.')
}

function clock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// An id is matched from its start only: a short target found in the middle of
// another conversation's UUID would send the message to the wrong session. Every
// match is returned, so a caller can refuse a target that names more than one:
// Codex ids are UUIDv7, and those opened around the same time share a prefix.
function lookup(list: readonly Conversation[], target: string): Conversation[] {
  const exact = list.filter(c => c.name === target)
  if (exact.length) return exact
  return list.filter(c => (c.peer?.kind === 'xm' && c.peer.sessionId.startsWith(target)) || c.name.startsWith(target))
}

// Korean puts the recipient particle after the name, attached or apart
// (`reviewer-33에게 …`, `reviewer-33 에게 …`); it names the target, so it is
// neither part of the name nor the first word of the message.
function splitAddressee(args: string): { target: string; text: string } {
  const [, word = '', after = ''] = /^\s*(\S*)\s*([\s\S]*)$/.exec(args) ?? []
  const [, name] = /^(.+?)(?:에게|한테|께)$/.exec(word) ?? []
  if (name) return { target: name, text: after.trim() }
  const [, rest] = /^(?:에게|한테|께)(?:\s+|$)([\s\S]*)$/.exec(after) ?? []
  return { target: word, text: (rest ?? after).trim() }
}

// An open conversation first, else a live session, opened as a conversation;
// a string is the reason none was found.
async function resolveConversation($: EngineInterface, target: string): Promise<Conversation | string> {
  const open = lookup(await read($, conversations), target)
  if (open.length > 1) return ambiguous(open.map(c => c.name))
  if (open[0]) return open[0]
  await loadCandidates($)
  const sendable = (await read($, picker)).candidates.filter(c => c.unavailable === null)
  const exact = sendable.filter(c => c.name === target)
  const found = exact.length ? exact : sendable.filter(c => c.id.startsWith(target))
  if (found.length > 1) return ambiguous(found.map(c => `${c.name} ${c.id.slice(0, 8)}`))
  const candidate = found[0]
  if (!candidate) return `대화 상대를 찾지 못했습니다: ${target}`
  await openCandidate($, candidate)
  return lookup(await read($, conversations), candidate.id)[0] ?? `대화 상대를 찾지 못했습니다: ${target}`
}

function ambiguous(names: readonly string[]): string {
  return `대화 상대가 여러 개입니다 (${names.join(', ')}). 이름이나 ID 앞부분을 더 길게 입력하세요.`
}

export const register: Register = (on, options) => {
  const limits: AutoLimits = {
    cooldownMs: (Number(options.relayChatAutoReviewCooldownMinutes) || DEFAULT_AUTO_COOLDOWN_MINUTES) * 60_000,
    maxLines: Number(options.relayChatAutoReviewMaxLines) || DEFAULT_AUTO_MAX_LINES,
  }

  on('turn.complete', async ($, e, next) => {
    // Subagent turns and interrupted ones are not a checkpoint of this session's work.
    if (e.agentId === undefined && !e.isAborted) {
      try {
        await autoReviewTick($, limits)
      } catch (error) {
        $.ui.toast(`자동 리뷰 확인 실패: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: '(xm) Relay 대화창 열기, 또는 /relay-chat <상대> <내용>으로 바로 보내기',
      argumentHint: '[상대] [내용]',
    })
    await $.command.register({
      name: CONTEXT_COMMAND,
      description: '(xm) 이 세션의 맥락을 모델이 정리해 상대에게 보내기: /relay-ctx <상대> [요청]',
      argumentHint: '<상대> [요청]',
    })
    await refreshStatus($)
    await loadPair($)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim()
    if (!args) {
      const key = await read($, activeKey)
      if (key) await select($, key)
      await $.ui.open({ id: PANE, title: 'Relay 대화' })
      $.clock.after(0, () => {
        void loadSelf($)
      })
      // With nobody to talk to yet, show the live sessions instead of an empty
      // pane. The timer starts the load after the command answers, so the pane
      // opens at once. With a pair, the unreviewed commits are listed instead.
      if ((await read($, conversations)).length === 0) {
        $.clock.after(0, () => {
          void loadCandidates($)
        })
      } else if (await read($, pair)) {
        $.clock.after(0, () => {
          void seedCommits($)
        })
      }
      return { text: 'Relay 대화창을 열었습니다.' }
    }
    const { target, text } = splitAddressee(args)
    if (!target || !text) return { text: '사용법: /relay-chat <상대 이름 또는 ID 앞부분> <내용>' }
    const conversation = await resolveConversation($, target)
    if (typeof conversation === 'string') return { text: conversation }
    const failure = await sendTo($, conversation, text)
    return { text: failure ? `전송 실패 (${conversation.name}): ${failure}` : `${conversation.name}에게 보냈습니다.` }
  })

  on('command.run', { command: CONTEXT_COMMAND }, async ($, e) => {
    const { target, text } = splitAddressee(e.args.trim())
    if (!target) return { text: '사용법: /relay-ctx <상대 이름 또는 ID 앞부분> [요청]' }
    const conversation = await resolveConversation($, target)
    if (typeof conversation === 'string') return { text: conversation }
    const failure = await shareContext($, [conversation], text || null)
    return { text: failure ? `맥락 공유 실패 (${conversation.name}): ${failure}` : `${conversation.name}에게 보낼 맥락을 모델이 정리합니다.` }
  })

  on('session.receive', async ($, e, next) => {
    if (!isPeerDelivery(e)) return next(e)
    const parsed = parseDelivery(e.text)
    // The answer to an automatic review request stays in the pane: it was not
    // asked for by the model, and the person decides whether it goes in.
    if (parsed.inReplyTo && (await read($, quietRequests)).includes(parsed.inReplyTo)) {
      const opening = parsed.peer ? { key: peerKey(parsed.peer), name: parsed.sender, peer: parsed.peer, cwd: parsed.cwd } : { key: `native:${parsed.sender}`, name: parsed.sender, peer: null }
      await record($, opening, { at: await $.clock.now(), by: 'peer', quiet: true, text: parsed.body })
      await update($, quietRequests, ids => ids.filter(id => id !== parsed.inReplyTo))
      return { consumed: 'auto review reply kept in the relay chat pane' }
    }
    const key = parsed.peer ? peerKey(parsed.peer) : `unknown:${parsed.sender}`
    await record($, { key, name: parsed.sender, peer: parsed.peer, cwd: parsed.cwd }, { at: await $.clock.now(), by: 'peer', text: parsed.body })

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const send = parseRelaySend(e.command)
    const commit = parseCommitCommand(e.command)
    if (!send && !commit) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    if (commit) await noteCommit($, commit.root)
    if (!send) return ran
    // Read only after the command ran: it can write the file before it sends it,
    // and a read taken earlier would record the file's previous message.
    const text = send.message ?? (send.messageFile ? await $.fs.read(send.messageFile).catch(() => undefined) : undefined)
    // A piped command (`xm relay send ... | head`) exits 0 even when the send
    // failed, so read the CLI's own verdict from its JSON output.
    const stdout = (ran.result as { stdout?: unknown } | undefined)?.stdout
    if (typeof stdout === 'string' && /"ok"\s*:\s*false/.test(stdout)) return ran
    const at = await $.clock.now()
    for (const peer of send.peers) {
      await record($, { key: peerKey(peer), name: shortName(peer), peer }, { at, by: 'model', text: text ?? '(내용 확인 불가)' })
    }
    // A Cursor send carries the answer in its own output.
    const reply = cursorReply(stdout)
    const cursorPeer = send.peers.length === 1 && send.peers[0]?.provider === 'cursor' ? send.peers[0] : undefined
    if (reply !== null && cursorPeer) {
      await record($, { key: peerKey(cursorPeer), name: shortName(cursorPeer), peer: cursorPeer }, { at: await $.clock.now(), by: 'peer', text: reply })
    }

    return ran
  })

  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    if (e.origin.kind === 'model' && e.agentId === undefined && sent.isDelivered) {
      const peer: Peer = { kind: 'native', to: e.to }
      await record($, { key: peerKey(peer), name: e.to, peer }, { at: await $.clock.now(), by: 'model', text: e.text })
    }

    return sent
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, conversations)
    const unread = list.filter(c => c.unread > 0)
    const newest = unread
      .map(c => ({ c, line: [...c.lines].reverse().find(l => l.by === 'peer') }))
      .filter((x): x is { c: Conversation; line: ChatLine } => x.line !== undefined)
      .sort((a, b) => b.line.at - a.line.at)[0]
    const dismissedAt = await read($, bandDismissedAt)
    if (!newest || (dismissedAt !== null && newest.line.at <= dismissedAt)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const total = unread.reduce((sum, c) => sum + c.unread, 0)
    const names = labels(list)
    const who = names.get(newest.c.key) ?? displayName(newest.c.name, newest.c.peer)
    const open = async () => {
      await $.ui.open({ id: PANE, title: 'Relay 대화', focus: true })
      await select($, newest.c.key)
      await loadSelf($)
    }
    const dismiss = () => update($, bandDismissedAt, () => newest.line.at)
    // 4 columns of buttons and gaps are kept free of the text.
    const width = Math.max(10, e.props.bodyColumns - cells(who) - 4 - 14 - 10)
    return (
      <Box gap={1}>
        <Text color="warning">{newest.line.quiet ? '🔕' : '💬'}</Text>
        <Box flexShrink={0}><Text bold>{who}</Text></Box>
        <Box flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end">{newest.line.quiet ? '자동 검토 답장' : preview(newest.line.text, width)}</Text>
        </Box>
        <Box flexShrink={0} gap={1}>
          <Text dimColor>{total > 1 ? `외 ${total - 1}건 · /relay-chat` : '/relay-chat'}</Text>
          <Button key="band-open" label="열기" onPress={open} />
          <Button key="band-dismiss" label="닫기" plain dimColor onPress={dismiss} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The mobile surface draws no Input; sending there waits for another surface.
    const Input = 'Input' in elements ? elements.Input : undefined
    // Only the remote surfaces draw Svg. The terminal's runtime table still
    // carries the name but draws it as nothing, so it gets a Raster badge.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const Raster = 'Raster' in elements ? elements.Raster : undefined
    const list = await read($, conversations)
    const key = await read($, activeKey)
    const current = list.find(c => c.key === key)
    const pick: Picker = await read($, picker)
    const who = await read($, pair)
    const pending = await read($, commits)
    const auto = await read($, autoReview)
    const me = await read($, self)
    const now = await $.clock.now()
    const home = await $.env.get('HOME')
    const tilde = (path: string | null) => (path && home && path.startsWith(home) ? `~${path.slice(home.length)}` : path ?? '')
    const lastOf = (c: Conversation) => c.lines.at(-1)
    const ordered = [...list].sort((a, b) => (lastOf(b)?.at ?? 0) - (lastOf(a)?.at ?? 0))
    const talking = new Set(list.map(c => c.key))
    const rows = layoutFor(e.props.bodyColumns)
    // The open conversation sits in a rounded box: two border and two padding columns.
    const chat = layoutFor(e.props.bodyColumns - 4)
    const names = labels(list)
    const name = (c: Conversation) => names.get(c.key) ?? displayName(c.name, c.peer)
    const speaker = (line: ChatLine, c: Conversation) => (line.by === 'me' ? '나' : line.by === 'model' ? '모델' : name(c))
    const icon = (w: Who, id: string) =>
      Svg ? <Svg source={ICON_SVG[w]} alt={LABEL[w]} width={14} height={14} />
        : Raster ? <Raster key={`icon-${id}`} columns={badgeColumns(w)} rows={1} cells={badgeCells(w)} />
          : <Text>{LABEL[w][0]}</Text>
    const cell = (width: number, child: RenderChildren) => <Box width={width} flexShrink={0}>{child}</Box>
    // Each list line is one Button filled to the line's width, so the whole line
    // takes the pointer and the press, not the name alone. A Button holds only
    // text, so the badge stays outside it.
    const rowWidth = e.props.bodyColumns - 2 - 4
    const pickWidth = e.props.bodyColumns - 4 - 4

    return (
      <Box flexDirection="column">
        {me && (
          <Box>
            <Text dimColor>이 세션 </Text>
            <Text bold color="suggestion">{me.name ?? '(이름 확인 불가)'}</Text>
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">{` · ${me.id.slice(0, 8)}${me.name ? ' · 다른 세션의 상대 목록에 이 이름으로 보입니다' : ''}`}</Text>
            </Box>
          </Box>
        )}
        <Box justifyContent="space-between">
          <Text bold>대화 {list.length ? `(${list.length})` : ''}</Text>
          <Box gap={1}>
            {list.filter(c => c.peer && !(c.peer.kind === 'xm' && c.peer.provider === 'cursor')).length >= 2 && (
              <Button key="ctx-all" label="모두에게 맥락 공유" dimColor onPress={() => broadcastContext($)} />
            )}
            <Button key="add" label={pick.isOpen ? '목록 새로고침' : '+ 상대 추가'} onPress={() => loadCandidates($, pick.isOpen && pick.forPair === true)} />
          </Box>
        </Box>

        {pending.length > 0 && (
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="warning" paddingX={1}>
            <Box justifyContent="space-between">
              <Text bold>{`리뷰 대기 커밋 (${pending.length})`}</Text>
              <Box gap={1}>
                <Button key="review-request" variant="primary" label={who ? `리뷰 요청 → ${fit(who.name, 14)}` : '페어 지정 후 리뷰 요청'} onPress={() => requestReview($)} />
                <Button key="review-dismiss" label="지우기" dimColor onPress={() => dismissCommits($)} />
              </Box>
            </Box>
            {pending.slice(-SHOWN_COMMITS).map(c => (
              <Box key={`commit-${c.sha}`}>
                {cell(8, <Text color="warning">{c.sha.slice(0, 7)}</Text>)}
                <Box flexShrink={1} minWidth={0}><Text wrap="truncate-end">{c.subject}</Text></Box>
              </Box>
            ))}
          </Box>
        )}

        {list.length === 0 && !pick.isOpen && <Text dimColor>아직 대화가 없습니다. + 상대 추가로 시작하세요.</Text>}
        {ordered.map(c => {
          const last = lastOf(c)
          const isActive = c.key === key
          return (
            <Box key={`row-${c.key}`}>
              {cell(2, <Text color={isActive ? 'suggestion' : 'subtle'}>{isActive ? '▸' : ' '}</Text>)}
              {cell(4, icon(providerOf(c.peer), `row-${c.key}`))}
              <Button key={`tab-${c.key}`} plain dimColor={!isActive} onPress={() => select($, c.key)}>
                <Text bold={isActive}>{pad(fit(name(c), rows.nameWidth - 1), rows.nameWidth)}</Text>
                <Text color="warning" bold>{pad(c.unread > 0 ? `●${c.unread}` : '', 4)}</Text>
                <Text dimColor>{pad(rows.showTime ? (last ? ago(last.at, now) : '새 대화') : '', rows.showTime ? 9 : 0)}</Text>
                <Text dimColor>
                  {pad(rows.showPreview && last ? `${speaker(last, c)}: ${last.text.replace(/\s+/g, ' ')}` : '', rowWidth - rows.nameWidth - 4 - (rows.showTime ? 9 : 0))}
                </Text>
              </Button>
            </Box>
          )
        })}

        {pick.isOpen && (
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="subtle" paddingX={1}>
            <Box justifyContent="space-between">
              <Text bold>대화 상대 고르기</Text>
              <Button key="pick-close" label="닫기" dimColor onPress={() => update($, picker, p => ({ ...p, isOpen: false, forPair: false }))} />
            </Box>
            {pick.forPair && <Text color="warning">페어로 쓸 Claude나 Codex 세션을 고르세요. 고른 세션에 바로 리뷰를 요청합니다.</Text>}
            {pick.isLoading && <Text dimColor>{`${(pick.pending ?? []).map(p => LABEL[p]).join(', ')} 조회 중…`}</Text>}
            {!pick.isLoading && pick.candidates.length === 0 && <Text dimColor>대화할 수 있는 세션이 없습니다.</Text>}
            {pick.candidates.map(c => {
              const label = `${fit(c.name, chat.nameWidth + 6)} `
              const state = c.unavailable === null
                ? `● ${c.status ?? LABEL[c.provider]}${c.lastAt ? ` · ${ago(c.lastAt, now)}` : ''}${talking.has(`${c.provider}:${c.id}`) ? ' · 대화 중' : ''} `
                : `전송 불가 · ${unavailableLabel(c)}`
              const stateText = fit(state, Math.max(0, pickWidth - cells(label)))
              const rest = pickWidth - cells(label) - cells(stateText)
              // One line of what happened last: the reply, else the prompt, else where it runs.
              const detail = c.lastReply ? `‹ ${c.lastReply}` : c.lastPrompt ? `› ${c.lastPrompt}` : tilde(c.cwd)
              const open = () => openCandidate($, c)
              return (
                <Box key={`cand-${c.provider}-${c.id}`} flexDirection="column">
                  <Box>
                    {cell(4, icon(c.provider, `cand-${c.provider}-${c.id}`))}
                    {c.unavailable === null ? (
                      <Button key={`pick-${c.provider}-${c.id}`} plain onPress={open}>
                        <Text bold>{label}</Text>
                        <Text color={c.status === 'busy' ? 'warning' : c.status === 'idle' ? 'success' : 'subtle'}>{stateText}</Text>
                        <Text dimColor>{pad(c.title && rows.showPreview ? ` ${c.title}` : '', rest)}</Text>
                      </Button>
                    ) : (
                      <Text dimColor wrap="truncate-end">{`${label}${stateText}`}</Text>
                    )}
                  </Box>
                  <Box paddingLeft={4}>
                    {c.unavailable === null ? (
                      <Button key={`pick-detail-${c.provider}-${c.id}`} plain dimColor onPress={open}>
                        <Text>{pad(detail, pickWidth)}</Text>
                      </Button>
                    ) : (
                      <Text dimColor wrap="truncate-end">{detail}</Text>
                    )}
                  </Box>
                </Box>
              )
            })}
            {pick.notes.map(note => (
              <Text color="warning">{note}</Text>
            ))}
          </Box>
        )}

        {current && (
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
            <Box justifyContent="space-between">
              <Box flexShrink={1} minWidth={0}>
                {cell(4, icon(providerOf(current.peer), `head-${current.key}`))}
                <Box flexShrink={0} marginRight={1}><Text bold>{fit(name(current), chat.nameWidth + 6)}</Text></Box>
                <Box flexShrink={1} minWidth={0}><Text dimColor wrap="truncate-end">{tilde(current.cwd)}</Text></Box>
              </Box>
              <Box flexShrink={0} gap={1}>
                {current.peer && !(current.peer.kind === 'xm' && current.peer.provider === 'cursor') && (
                  <Button key={`ctx-${current.key}`} label="맥락 공유" dimColor onPress={() => shareContextWith($, current.key)} />
                )}
                {who?.key === current.key ? (
                  <>
                    <Text color="success">◆ 페어</Text>
                    <Button key="pair-clear" label="페어 해제" dimColor onPress={() => setPair($, null)} />
                  </>
                ) : canPair(current.peer) && (
                  <Button key="pair-set" label="페어 지정" dimColor onPress={() => setPair($, current)} />
                )}
              </Box>
            </Box>
            {who?.key === current.key && (
              <Box gap={1}>
                <Button key="auto-toggle" label={auto.enabled ? '자동 리뷰 켬' : '자동 리뷰 끔'} dimColor={!auto.enabled} onPress={() => setAutoReview($, !auto.enabled)} />
                <Box flexShrink={1} minWidth={0}>
                  <Text dimColor wrap="truncate-end">
                    {auto.enabled
                      ? (auto.skippedSha && pending.some(c => c.sha === auto.skippedSha)
                        ? `diff ${auto.skippedLines ?? '?'}줄이 상한 ${limits.maxLines}줄을 넘어 자동 요청을 멈췄습니다 · 위 버튼으로 요청하세요`
                        : `턴이 끝나면 ${Math.round(limits.cooldownMs / 60_000)}분 간격으로 가벼운 검토를 요청하고, 답장은 이 창에만 둡니다`)
                      : (pending.length ? `리뷰 대기 커밋 ${pending.length}개 · 위 상자의 리뷰 요청 버튼으로 보냅니다` : '리뷰할 새 커밋이 없습니다 · 커밋하면 위에 리뷰 요청 버튼이 나옵니다')}
                  </Text>
                </Box>
              </Box>
            )}
            {current.lines.length === 0 && <Text dimColor>아직 메시지가 없습니다.</Text>}
            {current.lines.slice(-SHOWN_LINES).map(line => {
              const color = line.by === 'peer' ? 'suggestion' : line.by === 'me' ? 'success' : 'subtle'
              const forward = line.quiet && line.by === 'peer'
                ? <Button key={`forward-${current.key}-${line.at}`} label="모델에게 전달" dimColor onPress={() => forwardToModel($, current.key, line.at)} />
                : null
              const marker = line.quiet ? '🔕 ' : ''
              return chat.stackLines ? (
                <Box flexDirection="column">
                  <Box gap={1}>
                    <Text dimColor>{clock(line.at)}</Text>
                    <Text color={color} bold wrap="truncate-end">{marker + speaker(line, current)}</Text>
                    {forward}
                  </Box>
                  <Box paddingLeft={2}><Text dimColor={line.by === 'model' || line.quiet === true}>{line.text}</Text></Box>
                </Box>
              ) : (
                <Box>
                  {cell(6, <Text dimColor>{clock(line.at)}</Text>)}
                  {cell(12, <Text color={color} bold wrap="truncate-end">{fit(marker + speaker(line, current), 11)}</Text>)}
                  <Box flexGrow={1} flexShrink={1} minWidth={0}><Text dimColor={line.by === 'model' || line.quiet === true}>{line.text}</Text></Box>
                  {forward && <Box flexShrink={0} marginLeft={1}>{forward}</Box>}
                </Box>
              )
            })}
            {current.waiting && <Text dimColor>{`${LABEL[providerOf(current.peer)]} 응답 대기 중…`}</Text>}
            {current.peer && Input ? (
              // The field sits in its own frame in the composer's border color, with
              // the composer's prompt mark: a hint in a bare field read as a message.
              <Box marginTop={1} borderStyle="round" borderColor="promptBorder" paddingX={1}>
                <Input key={`say-${current.key}`} label="❯ " placeholder={`${fit(name(current), 14)}에게 보낼 메시지`} submitLabel="보내기" autoFocus onInput={(value: string) => { drafts.set(current.key, value) }} onSubmit={(value: string) => say($, current.key, value)} />
              </Box>
            ) : (
              !current.peer && <Text dimColor>답장 경로가 없는 대화입니다.</Text>
            )}
          </Box>
        )}

        {Input && list.filter(c => c.peer).length >= 2 && (
          <Box marginTop={1} borderStyle="round" borderColor="promptBorder" paddingX={1}>
            <Input key="say-all" label="모두에게 ❯ " placeholder="열린 대화 전체에 보낼 메시지" submitLabel="보내기" onInput={(value: string) => { drafts.set('all', value) }} onSubmit={(value: string) => broadcast($, value)} />
          </Box>
        )}
      </Box>
    )
  })
}
