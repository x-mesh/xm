---
name: remote
description: Discord에서 Linux host의 managed Claude/Codex session을 모니터링하고 steer/interrupt/decision 입력을 전달한다
model: sonnet
allowed-tools:
  - Bash
---

# x-remote

term-mesh 없이 원격 Linux host에서 x-kit이 시작한 Claude/Codex session을 Discord로 관찰하고 제어한다.

## Safety contract

- PoC의 agent command 권한은 고정된 full-access다.
  - Codex: `approvalPolicy=never`, `sandbox=danger-full-access`
  - Claude: `--dangerously-skip-permissions`
- 개별 shell command를 Discord 승인 대상으로 만들지 않는다.
- requirement, 질문, phase gate, review/merge decision은 원문을 Discord로 전달한다.
- password, token, secret, credential 입력은 Discord에 노출하거나 받지 않고 `local input required`로 표시한다.
- x-remote가 직접 시작한 managed session만 제어한다. 기존 tmux/shell process는 adopt하지 않는다.

## Commands

```bash
xm remote gateway start|stop|status
xm remote host enroll --gateway wss://gateway.example --token TOKEN [--host-id NAME]
xm remote host start|stop|status
xm remote run --provider codex|claude --prompt "..." [--cwd PATH]
xm remote sessions
xm remote steer SESSION "..."
xm remote interrupt SESSION
xm remote resume SESSION "..."
```

Gateway start에는 `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_ALLOWED_USER_IDS`, `XM_REMOTE_HOST_TOKEN`이 필요하다. `DISCORD_ALLOWED_USER_IDS`는 comma-separated Discord user ID allowlist다. Public Linux 배포에서는 Bun gateway의 `/host` WebSocket을 TLS reverse proxy 뒤에 둔다.

Discord 명령:

```text
!xr sessions
!xr steer <session> <text>
!xr interrupt <session>
!xr resume <session> <text>
!xr decide <decision> <text>
```
