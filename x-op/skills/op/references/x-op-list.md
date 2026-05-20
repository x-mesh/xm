# x-op — list output

Output this catalog verbatim for `x-op list` (and as the safe fallback for unrecognized commands).

```
x-op — Strategy Orchestration

Strategies:
  refine <topic>          Diverge → converge → verify rounds
  tournament <topic>      Compete → anonymous vote → winner
  chain <topic>           A→B→C sequential pipeline (conditional branching)
  review --target <file>  Multi-perspective code review
  debate <topic>          Pro vs Con → verdict
  red-team --target <f>   Attack → defend → re-attack
  brainstorm <topic>      Free ideation → cluster → vote [--analogical|--lateral]
  distribute <topic>      Split → parallel execute → merge
  council <topic>         N-party deliberation → weighted consensus
  socratic <topic>        Question-driven deep inquiry
  persona <topic>         Multi-persona perspective analysis
  scaffold <topic>        Design → dispatch → integrate (top-down)
  compose "A | B | C"     Strategy piping / chaining
  decompose <topic>       Recursive decompose → leaf parallel → bottom-up
  hypothesis <topic>      Generate → falsify → adopt surviving hypotheses
  investigate <topic>     Multi-angle investigation → synthesize → gap analysis
  monitor --target <f>    Observe → analyze → auto-dispatch (1-shot watchdog)

Options:
  --rounds N              Round count (default 4)
  --preset quick|thorough|deep
  --agents N              Number of agents (default: agent_max_count)
  --model sonnet|opus     Agent model
  --vote                  Enable dot voting (brainstorm)
  --target <file>         Review/red-team target
  --personas "a,b,c"      Persona roles (persona strategy)
  --bracket single|double Tournament bracket type
  --weights "role:N"      Council weighted voting
  --dry-run               Show execution plan only
  --resume                Resume from checkpoint
  --explain               Include decision trace
  --pipe <strategy>       Chain strategies (compose)
  --angles "a,b,c"       Investigation angles (investigate)
  --depth shallow|deep|exhaustive  Investigation depth (investigate)

Examples:
  /xm:op refine "Payment API design" --rounds 4
  /xm:op tournament "Login implementation" --agents 4 --bracket double
  /xm:op debate "Monolith vs microservices"
  /xm:op review --target src/auth.ts
  /xm:op brainstorm "v2 feature ideas" --vote
  /xm:op socratic "Why microservices?" --rounds 4
  /xm:op persona "Auth redesign" --personas "engineer,security,pm"
  /xm:op scaffold "Plugin system" --agents 4
  /xm:op investigate "Auth system" --target src/auth/ --depth deep
  /xm:op investigate "Redis vs Memcached" --angles "performance,ecosystem,ops,cost"
  /xm:op compose "brainstorm | tournament | refine" --topic "v2 plan"
  /xm:op refine "API design" --dry-run
  /xm:op tournament "Login" --explain
  /xm:op decompose "Implement payment system" --agents 6
  /xm:op hypothesis "Why is latency spiking?" --rounds 3
```
