export type Provider = 'codex' | 'claude' | 'agy' | 'cursor'

export type Peer =
  | { kind: 'xm'; provider: Provider; sessionId: string }
  | { kind: 'native'; to: string }

export type ChatLine = {
  at: number
  by: 'me' | 'model' | 'peer'
  text: string
  /** Kept out of the model: an automatic review exchange, shown in the pane until forwarded. */
  quiet?: boolean
  /** Sent by the pane on its own (an automatic review request), not by the person. */
  auto?: boolean
}

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

export type Picker = {
  isOpen: boolean
  isLoading: boolean
  pending: Provider[]
  candidates: Candidate[]
  notes: string[]
  /** Opened to choose the pair: the picked session becomes it and gets the pending review request. */
  forPair?: boolean
}

/** The session that reviews this project's commits; kept in `$.store` per project directory. */
export type Pair = { key: string; name: string; provider: Provider; sessionId: string }

/** A commit this session made that no review request has covered yet. */
export type PendingCommit = { sha: string; subject: string; at: number; root: string }

/** The automatic review option of this project: on or off, when it last asked, and the commit it skipped as too large. */
export type AutoReview = { enabled: boolean; lastAt: number | null; skippedSha: string | null; skippedLines: number | null }

declare module 'claude-code' {
  interface PluginState {
    xm: {
      relayChatConversations: Conversation[]
      relayChatActiveKey: string | null
      relayChatPicker: Picker
      relayChatPair: Pair | null
      relayChatCommits: PendingCommit[]
      relayChatAutoReview: AutoReview
      /** request_ids of automatic review requests whose replies stay in the pane. */
      relayChatQuietRequests: string[]
      relayChatBandDismissedAt: number | null
    }
  }
}
