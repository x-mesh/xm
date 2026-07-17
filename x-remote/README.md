# x-remote

`x-remote` is a term-mesh-independent, Linux-first control plane for x-kit-managed Claude and Codex sessions. A host daemon makes one outbound WebSocket connection to a central Bun gateway; the gateway mirrors semantic events to Discord and routes steer, interrupt, resume, and decision commands back to the host.

## 1-host PoC

```text
Discord <-> Bun gateway + SQLite <==== outbound WSS ==== Linux host agent
                                                 |-- codex app-server
                                                 `-- claude stream-json
```

The gateway does not expose a plaintext secret prompt. Credential-like questions produce a `decision.local_required` event whose original prompt is withheld.

## Setup

On the gateway host:

```bash
export DISCORD_BOT_TOKEN=...
export DISCORD_CHANNEL_ID=...
export DISCORD_ALLOWED_USER_IDS=123456789012345678
export XM_REMOTE_HOST_TOKEN=...
xm remote gateway start
```

On the Linux agent host (Node 22+ and Claude/Codex CLI installed):

```bash
xm remote host enroll --gateway wss://gateway.example --token "$XM_REMOTE_HOST_TOKEN" --host-id linux-1
xm remote host start
xm remote run --provider codex --prompt "Run the repository tests and report failures"
```

The PoC intentionally does not adopt pre-existing tmux or shell sessions. A later optional term-mesh adapter can publish/consume the same `XK-REMOTE-v1` envelope without changing the core.
