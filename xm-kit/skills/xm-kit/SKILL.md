---
name: xm-kit
description: x-mesh toolkit — list available tools and their status
---

<Purpose>
Show available x-mesh tools and their installation status.
</Purpose>

<Use_When>
- User asks "what tools are available"
- User says "xm-kit", "x-mesh tools"
</Use_When>

<Do_Not_Use_When>
- User wants a specific tool (use xm-build or xm-op directly)
</Do_Not_Use_When>

# xm-kit — x-mesh Toolkit

Show available tools:

```
x-mesh Toolkit (xm-kit)

Bundled tools (available now):
  /xm-build    Phase-based project harness — lifecycle, DAG, cost forecasting
  /xm-op       Strategy orchestration — refine, tournament, debate, review
  /xm-agent    Agent primitives — fan-out, delegate, broadcast, collect

Coming soon:
  /xm-handoff  Session handoff between agents
  /xm-solve    Structured problem solving

Install bundle:     /plugin install xm-kit@xm-kit
Install individual: /plugin install xm-kit@xm-build
```
