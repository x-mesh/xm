import type { Peer, Provider } from '../../types'

export type Who = Provider | 'unknown'

export function providerOf(peer: Peer | null): Who {
  if (!peer) return 'unknown'
  return peer.kind === 'native' ? 'claude' : peer.provider
}

// The terminal draws no Svg. A Raster badge, white glyphs on the provider's
// color, works in any truecolor terminal without a graphics protocol. Each glyph
// is one cell wide, as Raster requires, and the badge is as wide as its glyphs:
// a one-glyph mark padded to two cells would sit off center, so it takes a cell
// of margin on each side instead.
const BADGE: Record<Who, { glyphs: string; background: number }> = {
  claude: { glyphs: ' ✻ ', background: 0xd97757 },
  codex: { glyphs: '>_', background: 0x10a37f },
  agy: { glyphs: 'AG', background: 0x4285f4 },
  cursor: { glyphs: 'Cu', background: 0x334155 },
  unknown: { glyphs: ' ? ', background: 0x6b7280 },
}
const WHITE = 0xffffff

/** The cells a badge takes; the row keeps four for it whatever this is. */
export function badgeColumns(w: Who): number {
  return [...BADGE[w].glyphs].length
}

/** Raster `cells`: base64 of little-endian u32 [codePoint, foreground, background] per cell. */
export function badgeCells(w: Who): string {
  const { glyphs, background } = BADGE[w]
  const bytes = new Uint8Array(badgeColumns(w) * 12)
  const view = new DataView(bytes.buffer)
  ;[...glyphs].forEach((ch, i) => {
    view.setUint32(i * 12, ch.codePointAt(0) ?? 0x20, true)
    view.setUint32(i * 12 + 4, WHITE, true)
    view.setUint32(i * 12 + 8, background, true)
  })
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">${body}</svg>`

export const ICON_SVG: Record<Who, string> = {
  claude: svg('<g stroke="#d97757" stroke-width="2" stroke-linecap="round"><path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4"/></g>'),
  codex: svg('<rect x="1" y="1" width="14" height="14" rx="3" fill="#10a37f"/><path d="M4.5 5.5 7 8l-2.5 2.5M8.5 11h3" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  agy: svg('<path d="M8 2 14.5 13.5h-13Z" fill="#4285f4"/>'),
  cursor: svg('<rect x="1" y="1" width="14" height="14" rx="3" fill="#334155"/><path d="M5 4.5 11.5 8 8.4 8.9 7 12Z" fill="#fff"/>'),
  unknown: svg('<circle cx="8" cy="8" r="6.5" fill="none" stroke="#888" stroke-width="1.5"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1M8 11.5v.1" fill="none" stroke="#888" stroke-width="1.5" stroke-linecap="round"/>'),
}

export const LABEL: Record<Who, string> = { claude: 'Claude', codex: 'Codex', agy: 'AGY', cursor: 'Cursor', unknown: 'unknown sender' }

function isWide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || code >= 0x1f300
}

/** Terminal cells a string takes: Hangul, CJK and emoji take two. */
export function cells(text: string): number {
  let width = 0
  for (const ch of text) width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return width
}

/** `text` cut to `width` cells and filled with spaces to exactly that width. A
 *  Button is pressable only where it draws, so a row filled to its width can be
 *  pressed anywhere along the line. */
export function pad(text: string, width: number): string {
  const w = Math.max(0, width)
  const cut = fit(text, w)
  return cut + ' '.repeat(Math.max(0, w - cells(cut)))
}

/** Cut `text` to at most `width` cells, ending in "…" when cut. */
export function fit(text: string, width: number): string {
  if (cells(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

type Named = { key: string; name: string; peer: Peer | null; cwd: string | null }

function baseLabel(c: Named): string {
  const name = displayName(c.name, c.peer)
  const id = c.peer?.kind === 'xm' ? c.peer.sessionId : null
  const isId = id !== null && (name === id || name === id.slice(0, 8))
  const project = c.cwd?.split('/').filter(Boolean).pop()
  return isId && project ? project : name
}

/** Display names keyed by conversation: the project directory instead of a bare
 *  session id, with the end of the id when two names collide. A Codex id is a
 *  UUIDv7 whose leading characters are a timestamp, so its start would collide too. */
export function labels(all: readonly Named[]): Map<string, string> {
  const bases = new Map(all.map(c => [c.key, baseLabel(c)]))
  const counts = new Map<string, number>()
  for (const base of bases.values()) counts.set(base, (counts.get(base) ?? 0) + 1)
  const idsByBase = new Map<string, string[]>()
  for (const c of all) {
    const id = c.peer?.kind === 'xm' ? c.peer.sessionId : null
    const base = bases.get(c.key) ?? c.name
    if (id) idsByBase.set(base, [...(idsByBase.get(base) ?? []), id])
  }
  const tailLength = new Map<string, number>()
  for (const [base, ids] of idsByBase) {
    let n = 4
    while (n < 36 && new Set(ids.map(id => id.slice(-n))).size < ids.length) n += 1
    tailLength.set(base, n)
  }
  return new Map(all.map(c => {
    const base = bases.get(c.key) ?? c.name
    const id = c.peer?.kind === 'xm' ? c.peer.sessionId : null
    const collides = (counts.get(base) ?? 0) > 1
    return [c.key, collides && id ? `${base}#${id.slice(-(tailLength.get(base) ?? 4))}` : base]
  }))
}

/** A name without the "provider:" prefix older records carry; the icon says the provider. */
export function displayName(name: string, peer: Peer | null): string {
  const provider = peer?.kind === 'xm' ? peer.provider : null
  return provider && name.startsWith(`${provider}:`) ? name.slice(provider.length + 1) : name
}

export type Layout = { nameWidth: number; showTime: boolean; showPreview: boolean; stackLines: boolean }

// Column budget of a conversation row: marker 2, icon 4, name, unread 4, time 9,
// then the preview takes what is left. Narrow panes drop the preview, then the
// time; chat lines stack sender over text before the text column gets too thin.
export function layoutFor(columns: number): Layout {
  const nameWidth = columns >= 70 ? 18 : columns >= 44 ? 14 : 10
  return {
    nameWidth,
    showTime: columns >= 2 + 4 + nameWidth + 4 + 9,
    showPreview: columns >= 2 + 4 + nameWidth + 4 + 9 + 16,
    stackLines: columns < 48,
  }
}
