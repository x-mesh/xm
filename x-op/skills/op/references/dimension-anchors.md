# Dimension Anchors

Reference for tagging x-op agent outputs with structured dimensions.

Agents must tag output by dimension before generating content. This prevents overlap and improves coverage.

## Dimension Anchors by Strategy Category

| Category | Strategies | Dimension Pool |
|----------|-----------|---------------|
| Argument/analysis | refine, tournament, debate, council, socratic, hypothesis, investigate | `feasibility`, `scalability`, `maintainability`, `cost`, `risk`, `performance`, `security`, `dx` |
| Code analysis | review, red-team, monitor | `correctness`, `security`, `performance`, `resilience`, `testability`, `readability` |
| Task decomposition | scaffold, decompose, distribute, chain | `scope-clarity`, `dependency-minimality`, `parallelizability`, `testability`, `interface-completeness` |
| Ideation | brainstorm, persona | `novelty`, `feasibility`, `impact`, `effort`, `risk` |

## Assignment rule

The leader pre-assigns dimensions to agents before generation. Agents do not freely pick dimensions.

- Deterministic strategies (`review`, `red-team`, `monitor`, `scaffold`, `decompose`, `distribute`, `chain`): use fixed dimensions where possible.
- Exploratory strategies (`debate`, `refine`, `tournament`, `brainstorm`, `council`, `socratic`, `persona`, `hypothesis`, `investigate`): select the most relevant dimensions for the topic; diversity across trials is acceptable.

## Agent Output Quality Contract

1. **Evidence-based** — Every claim cites a source: file:line with code quoted, command output, executed test result, cited URL plus quoted passage, or another agent's output referenced by ID/phase.
2. **Falsifiable** — Claims can be proven wrong.
3. **Dimension-tagged** — Claims identify the dimension they address.

## Applies to

x-op strategies and x-eval scoring of x-op outputs.
