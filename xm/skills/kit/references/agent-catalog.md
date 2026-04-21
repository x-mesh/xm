# Agent Catalog

xm includes a catalog of 37 specialist agents at `xm/agents/`. These provide domain expertise for broadcast/fan-out operations across all xm tools.

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
xm/agents/
  catalog.json       ← Index: name, description, tags per agent
  rules/             ← Full agent rules (~240 lines each)
  slim/              ← Slim versions (~30 lines each, for prompt injection)
```
