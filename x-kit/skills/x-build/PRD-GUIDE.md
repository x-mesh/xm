# PRD Section Quality Criteria

Apply these criteria when writing each section of a PRD.

## Goal

One sentence. If it needs 'and,' it's two projects.

- Good: 'Enable users to authenticate via JWT with refresh token rotation'
- Bad: 'Improve the auth system and add better error handling and logging'

## Success Criteria

Each must be measurable and binary (pass/fail).

- Good: '[SC1] Login API responds in <200ms at p95 under 100 concurrent users'
- Bad: '[SC1] System should be fast and reliable'

## Constraints

Only hard constraints — things that are NOT negotiable.

- Good: '[C1] Must use PostgreSQL (existing production DB)'
- Bad: '[C1] Should use a modern database' (this is a preference, not a constraint)

## Requirements Traceability

Every R# maps to at least one SC#. Unmapped requirements are scope creep.

## Out of Scope

Be specific. 'Not building X' is better than 'keeping it simple.'

- Good: 'No mobile app, no real-time notifications, no multi-tenancy'
- Bad: 'Anything not mentioned above'

## Risks

Each risk needs likelihood + impact + mitigation. 'Things might go wrong' is not a risk.

- Good: 'JWT secret rotation may cause active sessions to invalidate — mitigate with grace period'
- Bad: 'Security risks'

## Architecture

Must include ASCII diagram with standard format (■ Diagram / ■ Purpose / ■ Legend / ■ Key Notes). Select type from the 23-type guide.

- Good: ASCII diagram with labeled edges + Legend + Key Notes
- Bad: 'Standard 3-tier architecture' (no diagram) or Mermaid (not rendered in dashboard)

## Key Scenarios

Must include happy path + failure path as numbered steps with specific commands/outputs.

- Good: '1. User runs `xm dashboard` 2. Browser opens at :19841 3. Home shows 5 projects'
- Bad: 'User can start the dashboard and see projects'

## Data Model & API Contracts

Must show entity fields and at least one API response shape.

- Good: 'GET /api/projects → [{ id, name, current_phase, created_at }]'
- Bad: 'API returns project data'

## Decisions & Assumptions

Must have at least 1 decision with rejected alternative, and 1 assumption with consequence-if-wrong.

- Good: 'Chose Bun over Express — rejected because Express needs npm deps. Assumption: .xm < 10MB — if wrong, API >100ms target fails'
- Bad: 'We decided on the best approach'

## Acceptance Criteria

Each item must be testable by running a command or checking a state.

- Good: '[ ] npm test passes with >80% coverage on auth module'
- Bad: '[ ] Code is well-tested'
