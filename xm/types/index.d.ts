export type Provider = 'codex' | 'claude' | 'agy' | 'cursor'

export type Peer =
  | { kind: 'xm'; provider: Provider; sessionId: string }
  | { kind: 'native'; to: string }

export type ChatLine = { at: number; by: 'me' | 'model' | 'peer'; text: string }

export type Conversation = {
  key: string
  name: string
  peer: Peer | null
  cwd: string | null
  lines: ChatLine[]
  unread: number
  /** True while a Cursor turn runs: its answer arrives with the send itself. */
  waiting?: boolean
}

export type Candidate = {
  provider: Provider
  id: string
  name: string
  cwd: string | null
  status: string | null
  title: string | null
  lastPrompt: string | null
  lastReply: string | null
  lastAt: number | null
  /** Why this session cannot be sent to from here; null when it can. */
  unavailable: string | null
}

export type Picker = { isOpen: boolean; isLoading: boolean; pending: Provider[]; candidates: Candidate[]; notes: string[] }

declare module 'claude-code' {
  interface PluginState {
    xm: { relayChatConversations: Conversation[]; relayChatActiveKey: string | null; relayChatPicker: Picker }
  }
}
