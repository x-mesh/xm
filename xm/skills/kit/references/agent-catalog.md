# Agent Catalog

xm includes a catalog of 37 specialist agents at `xm/agent-catalog/`. These provide domain expertise for broadcast/fan-out operations across all xm tools.

> **Why `agent-catalog/` and not `agents/`?** Claude Code recursively auto-registers every `*.md` under a plugin's `agents/` directory as a native subagent, which would load all 74 specialist files (rules + slim) into standing context on every session. These agents are on-demand only — accessed through the CLI below — so they live outside `agents/` to suppress that auto-registration.

## Commands

| Command | Description |
|---------|-------------|
| `xm agents list` | List all available specialist agents |
| `xm agents match "<topic>"` | Find best agents for a topic (auto-selects by tag/keyword matching) |
| `xm agents get <name>` | Show a specialist agent's full rules |
| `xm agents get <name> --slim` | Show the slim version (~30 lines) |

## CLI

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/agent-catalog.mjs list
node ${CLAUDE_PLUGIN_ROOT}/lib/agent-catalog.mjs match "결제 API 설계" --count 5
node ${CLAUDE_PLUGIN_ROOT}/lib/agent-catalog.mjs get security --slim
```

## How Plugins Use It

| Plugin | Usage |
|--------|-------|
| **x-op** | refine/brainstorm/persona broadcast — auto-select specialists per topic |
| **x-review** | `--specialists` flag enhances lens prompts with domain expertise |
| **x-solver** | decompose/constrain fan-out — inject relevant specialists |
| **x-build** | research phase — select domain experts for investigation |

## Structure

```
xm/agent-catalog/    ← NOT `agents/` — avoids Claude Code native auto-registration
  catalog.json       ← Index: name, description, tags per agent
  rules/             ← Full agent rules (~240 lines each)
  slim/              ← Slim versions (~30 lines each, for prompt injection)
```
