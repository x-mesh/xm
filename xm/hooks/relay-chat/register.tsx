import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionReceiveInput } from 'claude-code'

import type { Candidate, ChatLine, Conversation, Peer, Picker } from '../../types'
import {
  ago, parseDelivery, parseRelaySend, peerKey, sendArgv, sessionRows, shortName, summarizeTranscript, transcriptPath,
} from './parse'
import { BADGE_COLUMNS, ICON_SVG, LABEL, badgeCells, displayName, fit, labels, layoutFor, providerOf } from './view'
import type { Who } from './view'

const PANE = 'relay-chat'
const COMMAND = 'relay-chat'
const KEEP_LINES = 200
const SHOWN_LINES = 30
const PROVIDERS = ['codex', 'claude', 'agy', 'cursor'] as const

const conversations = atom({ plugin: 'xm', key: 'relayChatConversations' } as const, [])
const activeKey = atom({ plugin: 'xm', key: 'relayChatActiveKey' } as const, null)
const picker = atom({ plugin: 'xm', key: 'relayChatPicker' } as const, {
  isOpen: false,
  isLoading: false,
  pending: [],
  candidates: [],
  notes: [],
})

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

async function record($: EngineInterface, opening: Opening, line: ChatLine) {
  await update($, conversations, list => {
    const found = list.find(c => c.key === opening.key)
    const base: Conversation = found ?? { key: opening.key, name: opening.name, peer: opening.peer, cwd: opening.cwd ?? null, lines: [], unread: 0 }
    const next: Conversation = {
      ...base,
      cwd: base.cwd ?? opening.cwd ?? null,
      lines: [...base.lines, line].slice(-KEEP_LINES),
      unread: line.by === 'peer' ? base.unread + 1 : 0,
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
  await update($, conversations, list =>
    list.some(c => c.key === key)
      ? list.map(c => (c.key === key ? { ...c, name: candidate.name, cwd: candidate.cwd } : c))
      : [...list, { key, name: candidate.name, peer, cwd: candidate.cwd, lines: [], unread: 0 }],
  )
  await update($, picker, p => ({ ...p, isOpen: false }))
  await select($, key)
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
async function loadCandidates($: EngineInterface) {
  const seq = ++loadSeq
  await update($, picker, p => ({ ...p, isOpen: true, isLoading: true, pending: [...PROVIDERS], notes: [] }))
  const own = await $.session.id()
  const home = await $.env.get('HOME')
  await Promise.all(PROVIDERS.map(async provider => {
    let rows: Candidate[] = []
    let note: string | null = null
    try {
      const ran = await $.process.run(['xm', 'relay', 'sessions', '--provider', provider])
      rows = await Promise.all(sessionRows(ran.stdout, provider, own).map(c => withTranscript($, c, home)))
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
  if (!text.trim()) return
  const conversation = (await read($, conversations)).find(c => c.key === key)
  if (!conversation) return
  const failure = await sendTo($, conversation, text)
  if (failure) $.ui.toast(`전송 실패 (${conversation.name}): ${failure}`)
}

async function broadcast($: EngineInterface, text: string) {
  if (!text.trim()) return
  const targets = (await read($, conversations)).filter(c => c.peer)
  const failed: string[] = []
  for (const conversation of targets) {
    const failure = await sendTo($, conversation, text)
    if (failure) failed.push(`${conversation.name}: ${failure}`)
  }
  $.ui.toast(failed.length ? `${targets.length - failed.length}/${targets.length}곳 전송. 실패 ${failed.join(', ')}` : `${targets.length}곳에 전송`)
}

function clock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// An id is matched from its start only: a short target found in the middle of
// another conversation's UUID would send the message to the wrong session.
function lookup(list: readonly Conversation[], target: string): Conversation | undefined {
  return list.find(c => c.name === target)
    ?? list.find(c => (c.peer?.kind === 'xm' && c.peer.sessionId.startsWith(target)) || c.name.startsWith(target))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: '(xm) Relay 대화창 열기, 또는 /relay-chat <상대> <내용>으로 바로 보내기',
      argumentHint: '[상대] [내용]',
    })
    await refreshStatus($)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim()
    if (!args) {
      const key = await read($, activeKey)
      if (key) await select($, key)
      await $.ui.open({ id: PANE, title: 'Relay 대화' })
      // With nobody to talk to yet, show the live sessions instead of an empty
      // pane. The timer starts the load after the command answers, so the pane
      // opens at once.
      if ((await read($, conversations)).length === 0) {
        $.clock.after(0, () => {
          void loadCandidates($)
        })
      }
      return { text: 'Relay 대화창을 열었습니다.' }
    }
    const [target = '', ...rest] = args.split(/\s+/)
    const text = args.slice(target.length).trim()
    if (!rest.length || !text) return { text: '사용법: /relay-chat <상대 이름 또는 ID 앞부분> <내용>' }
    let conversation = lookup(await read($, conversations), target)
    if (!conversation) {
      await loadCandidates($)
      const candidate = (await read($, picker)).candidates.find(c => c.unavailable === null && (c.name === target || c.id.startsWith(target)))
      if (!candidate) return { text: `대화 상대를 찾지 못했습니다: ${target}` }
      await openCandidate($, candidate)
      conversation = lookup(await read($, conversations), candidate.id)
    }
    if (!conversation) return { text: `대화 상대를 찾지 못했습니다: ${target}` }
    const failure = await sendTo($, conversation, text)
    return { text: failure ? `전송 실패 (${conversation.name}): ${failure}` : `${conversation.name}에게 보냈습니다.` }
  })

  on('session.receive', async ($, e, next) => {
    if (!isPeerDelivery(e)) return next(e)
    const parsed = parseDelivery(e.text)
    const key = parsed.peer ? peerKey(parsed.peer) : `unknown:${parsed.sender}`
    await record($, { key, name: parsed.sender, peer: parsed.peer, cwd: parsed.cwd }, { at: await $.clock.now(), by: 'peer', text: parsed.body })
    $.ui.toast(`💬 ${parsed.sender}: ${parsed.body.slice(0, 60)}`)

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const send = parseRelaySend(e.command)
    if (!send) return next(e)
    const readMessageFile = () => send.messageFile ? $.fs.read(send.messageFile).catch(() => undefined) : Promise.resolve(undefined)
    // The command can write the file before it sends it, so the bytes read after
    // it ran are what went out; the earlier read covers a command that removed it.
    const before = await readMessageFile()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const text = send.message ?? (await readMessageFile()) ?? before
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
        : Raster ? <Raster key={`icon-${id}`} columns={BADGE_COLUMNS} rows={1} cells={badgeCells(w)} />
          : <Text>{LABEL[w][0]}</Text>
    const cell = (width: number, child: RenderChildren) => <Box width={width} flexShrink={0}>{child}</Box>

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold>대화 {list.length ? `(${list.length})` : ''}</Text>
          <Button key="add" label={pick.isOpen ? '목록 새로고침' : '+ 상대 추가'} onPress={() => loadCandidates($)} />
        </Box>

        {list.length === 0 && !pick.isOpen && <Text dimColor>아직 대화가 없습니다. + 상대 추가로 시작하세요.</Text>}
        {ordered.map(c => {
          const last = lastOf(c)
          const isActive = c.key === key
          return (
            <Box key={`row-${c.key}`}>
              {cell(2, <Text color={isActive ? 'suggestion' : 'subtle'}>{isActive ? '▸' : ' '}</Text>)}
              {cell(3, icon(providerOf(c.peer), `row-${c.key}`))}
              {cell(rows.nameWidth, <Button key={`tab-${c.key}`} label={fit(name(c), rows.nameWidth - 1)} plain dimColor={!isActive} onPress={() => select($, c.key)} />)}
              {cell(4, c.unread > 0 ? <Text color="warning" bold>{`●${c.unread}`}</Text> : <Text> </Text>)}
              {rows.showTime && cell(9, <Text dimColor wrap="truncate-end">{last ? ago(last.at, now) : '새 대화'}</Text>)}
              {rows.showPreview && last && (
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text dimColor wrap="truncate-end">
                    {speaker(last, c)}: {last.text.replace(/\s+/g, ' ')}
                  </Text>
                </Box>
              )}
            </Box>
          )
        })}

        {pick.isOpen && (
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="subtle" paddingX={1}>
            <Box justifyContent="space-between">
              <Text bold>대화 상대 고르기</Text>
              <Button key="pick-close" label="닫기" dimColor onPress={() => update($, picker, p => ({ ...p, isOpen: false }))} />
            </Box>
            {pick.isLoading && <Text dimColor>{`${(pick.pending ?? []).map(p => LABEL[p]).join(', ')} 조회 중…`}</Text>}
            {!pick.isLoading && pick.candidates.length === 0 && <Text dimColor>대화할 수 있는 세션이 없습니다.</Text>}
            {pick.candidates.map(c => (
              <Box key={`cand-${c.provider}-${c.id}`} flexDirection="column" marginTop={1}>
                <Box>
                  {cell(3, icon(c.provider, `cand-${c.provider}-${c.id}`))}
                  <Box flexShrink={0} marginRight={1}>
                    {c.unavailable === null ? (
                      <Button key={`pick-${c.provider}-${c.id}`} label={fit(c.name, chat.nameWidth + 6)} onPress={() => openCandidate($, c)} />
                    ) : (
                      <Text dimColor>{fit(c.name, chat.nameWidth + 6)}</Text>
                    )}
                  </Box>
                  <Box flexShrink={1} minWidth={0}>
                    {c.unavailable === null ? (
                      <Text color={c.status === 'busy' ? 'warning' : c.status === 'idle' ? 'success' : 'subtle'} wrap="truncate-end">
                        {`● ${c.status ?? LABEL[c.provider]}${c.lastAt ? ` · ${ago(c.lastAt, now)}` : ''}${talking.has(`${c.provider}:${c.id}`) ? ' · 대화 중' : ''}`}
                      </Text>
                    ) : (
                      <Text dimColor wrap="truncate-end">{`전송 불가 · ${unavailableLabel(c)}`}</Text>
                    )}
                  </Box>
                </Box>
                <Box flexDirection="column" paddingLeft={2}>
                  {c.title && <Text wrap="truncate-end">{c.title}</Text>}
                  <Text dimColor wrap="truncate-end">{tilde(c.cwd)}</Text>
                  {c.lastPrompt && (
                    <Box>
                      {cell(7, <Text color="subtle">› 입력</Text>)}
                      <Box flexShrink={1} minWidth={0}><Text wrap="truncate-end">{c.lastPrompt}</Text></Box>
                    </Box>
                  )}
                  {c.lastReply && (
                    <Box>
                      {cell(7, <Text color="subtle">‹ 응답</Text>)}
                      <Box flexShrink={1} minWidth={0}><Text wrap="truncate-end">{c.lastReply}</Text></Box>
                    </Box>
                  )}
                </Box>
              </Box>
            ))}
            {pick.notes.map(note => (
              <Text color="warning">{note}</Text>
            ))}
          </Box>
        )}

        {current && (
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
            <Box>
              {cell(3, icon(providerOf(current.peer), `head-${current.key}`))}
              <Box flexShrink={0} marginRight={1}><Text bold>{fit(name(current), chat.nameWidth + 6)}</Text></Box>
              <Box flexShrink={1} minWidth={0}><Text dimColor wrap="truncate-end">{tilde(current.cwd)}</Text></Box>
            </Box>
            {current.lines.length === 0 && <Text dimColor>주고받은 메시지가 없습니다.</Text>}
            {current.lines.slice(-SHOWN_LINES).map(line => {
              const color = line.by === 'peer' ? 'suggestion' : line.by === 'me' ? 'success' : 'subtle'
              return chat.stackLines ? (
                <Box flexDirection="column">
                  <Box gap={1}>
                    <Text dimColor>{clock(line.at)}</Text>
                    <Text color={color} bold wrap="truncate-end">{speaker(line, current)}</Text>
                  </Box>
                  <Box paddingLeft={2}><Text dimColor={line.by === 'model'}>{line.text}</Text></Box>
                </Box>
              ) : (
                <Box>
                  {cell(6, <Text dimColor>{clock(line.at)}</Text>)}
                  {cell(12, <Text color={color} bold wrap="truncate-end">{fit(speaker(line, current), 11)}</Text>)}
                  <Box flexGrow={1} flexShrink={1} minWidth={0}><Text dimColor={line.by === 'model'}>{line.text}</Text></Box>
                </Box>
              )
            })}
            {current.waiting && <Text dimColor>{`${LABEL[providerOf(current.peer)]} 응답 대기 중…`}</Text>}
            {current.peer && Input ? (
              <Input key={`say-${current.key}`} placeholder={`${fit(name(current), 14)}에게 보낼 내용`} submitLabel="보내기" onSubmit={(value: string) => say($, current.key, value)} />
            ) : (
              !current.peer && <Text dimColor>답장 경로가 없는 대화입니다.</Text>
            )}
          </Box>
        )}

        {Input && list.filter(c => c.peer).length >= 2 && (
          <Box marginTop={1}>
            <Input key="say-all" label="모두에게 " placeholder="열린 대화 전체에 보낼 내용" submitLabel="보내기" onSubmit={(value: string) => broadcast($, value)} />
          </Box>
        )}
      </Box>
    )
  })
}
