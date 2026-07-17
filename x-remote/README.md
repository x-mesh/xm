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

대화형 설정과 상태 진단은 다음으로 시작할 수 있습니다.

```bash
xm remote
```

설정 wizard만 실행하려면:

```bash
xm remote setup
```

wizard는 Discord bot token, channel ID, 허용 user ID, host token, gateway URL과 host ID를 입력받아 `~/.xm/remote/gateway.json`과 `host.json`에 mode `600`으로 저장합니다. 저장 후 gateway/host를 바로 시작할 수도 있습니다. token은 로그에 기록하지 않지만 터미널 입력 시 화면에 표시될 수 있으므로 안전한 터미널에서 입력하세요.

설정 유효성 및 현재 실행 상태는 다음으로 확인합니다.

```bash
xm remote doctor
```

`doctor`는 Discord bot token/channel 접근, ID 형식, host enrollment, Bun/Node 22+/Claude/Codex CLI, gateway/host process와 local health를 검사합니다.

On the gateway host:

```bash
export DISCORD_BOT_TOKEN=...
export DISCORD_CHANNEL_ID=...
export DISCORD_ALLOWED_USER_IDS=123456789012345678
export XM_REMOTE_HOST_TOKEN=...
xm remote gateway start
xm remote gateway restart
xm remote gateway stop

xm remote host start
xm remote host restart
xm remote host stop

# gateway와 host를 함께 제어
xm remote start|stop|restart
```

On the Linux agent host (Node 22+ and Claude/Codex CLI installed):

```bash
xm remote host enroll --gateway wss://gateway.example --token "$XM_REMOTE_HOST_TOKEN" --host-id linux-1
xm remote host start
xm remote run --provider codex --prompt "Run the repository tests and report failures"
```

The PoC intentionally does not adopt pre-existing tmux or shell sessions. A later optional term-mesh adapter can publish/consume the same `XK-REMOTE-v1` envelope without changing the core.

## Discord output policy

`host.heartbeat` is retained for gateway liveness but is not posted to Discord. Provider `session.progress`/`session.output` metadata, hook responses, injected context, and internal trace text are filtered. Human-facing output is grouped per session in a short batching window to reduce Discord rate limits; decisions, errors, completion, and session lifecycle events are sent immediately.

## Claude Remote Control relationship

Native Claude Remote Control is a separate Anthropic surface:

```bash
claude remote-control --name linux-1
```

or from an existing Claude Code session:

```text
/remote-control
```

It exposes that local Claude session to `claude.ai/code` and the Claude mobile app. `x-remote` does not adopt an arbitrary existing Claude session; use `xm remote run --provider claude ...` when Discord steer/decision control is required. A managed x-remote session can be continued after host restart with `xm remote resume SESSION TEXT` or Discord `!xr resume SESSION TEXT`.
