# Agent Catalog

x-kit includes a catalog of 37 specialist agents at `x-kit/agents/`. These provide domain expertise for broadcast/fan-out operations across all x-kit tools.

## Commands

| Command | Description |
|---------|-------------|
| `x-kit agents list` | List all available specialist agents |
| `x-kit agents match "<topic>"` | Find best agents for a topic (auto-selects by tag/keyword matching) |
| `x-kit agents get <name>` | Show a specialist agent's full rules |
| `x-kit agents get <name> --slim` | Show the slim version (~30 lines) |

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
x-kit/agents/
  catalog.json       ← Index: name, description, tags per agent
  rules/             ← Full agent rules (~240 lines each)
  slim/              ← Slim versions (~30 lines each, for prompt injection)
```
