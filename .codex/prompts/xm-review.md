---
description: "Multi-perspective code review orchestrator — PR diff analysis with severity-rated findings and LGTM verdict"
---

<Purpose>
x-review takes a PR diff, file, or directory as input and runs multiple review agents in parallel. Each agent reports findings from a dedicated perspective (security, logic, performance, test coverage) in severity + file:line format. The leader then produces a consolidated report with an LGTM / Request Changes / Block verdict.
</Purpose>

<Use_When>
- User wants to review a PR, file, or directory
- User says "review", "code review", "check PR", "analyze diff", "review"
- User says "check security vulnerabilities", "find performance issues", "check test coverage"
- Other xm skills need a code quality gate
</Use_When>

<Do_Not_Use_When>
- Simple single-line questions that don't need multi-agent review
- Structured problem solving (use x-solver instead)
- Full project lifecycle management (use x-build instead)
</Do_Not_Use_When>

# x-review — Multi-Perspective Code Review

Parallel review orchestrator built on Claude Code native Agent tool.
No external dependencies. Only requires `git` and `gh` CLI.

## Mode Detection

Read mode from `.xm/config.json` (`mode` field). Default: `developer`.

**Developer mode**: Use technical terms (verdict, LGTM, Critical/High/Medium/Low, findings). Concise.

**Normal mode**: Use plain Korean for all user-facing output.
- "verdict" → "결과", "LGTM" → "통과", "Request Changes" → "수정 필요", "Block" → "차단"
- "finding" → "발견", "Critical" → "심각", "High" → "높음", "Medium" → "보통", "Low" → "낮음"
- "severity" → "심각도", "lens" → "관점", "challenge stage" → "재확인", "consensus elevation" → "합의 승격"
- Use "~하세요" style, lead with key information

## Arguments

User provided: $ARGUMENTS

## AskUserQuestion Dark-Theme Rule

See `references/ask-user-question-rule.md` — the `question` field is invisible on dark terminals; put context in markdown, use `header`/`label`/`description` for user-facing text.

## Routing

First word of `$ARGUMENTS`:
- `diff` → [Phase 1: TARGET — diff mode]
- `pr` → [Phase 1: TARGET — pr mode]
- `file` → [Phase 1: TARGET — file mode]
- `full` → [Phase 1: TARGET — full mode]
- `list` → [Subcommand: list]
- Empty input → [Smart Router]
- Natural language → [Smart Router] (interpret intent, then route)
- Unrecognized input → [Subcommand: list] (safe fallback for typos/unsupported commands)

### Smart Router (empty input or natural language)

When called without arguments, **automatically determines the review scope**. Runs immediately without asking the user.

**Step 1: Context detection (order = routing priority)**

```bash
# Priority 1: PR detection (highest priority)
BRANCH=$(git branch --show-current 2>/dev/null)
PR_NUM=$(gh pr view --json number -q .number 2>/dev/null || echo "")
BASE=$(git merge-base main HEAD 2>/dev/null || git merge-base master HEAD 2>/dev/null || echo "")

# Priority 2: Last reviewed commit (for main branch)
LAST_REVIEW=$(jq -r '.reviewed_commit // empty' .xm/review/last-result.json 2>/dev/null || echo "")

# Priority 3: Last release commit
if [ -z "$LAST_REVIEW" ]; then
  LAST_REVIEW=$(git log --grep="^release:" --format=%H -1 2>/dev/null || echo "")
fi

# Priority 4: Last tag
if [ -z "$LAST_REVIEW" ]; then
  TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
  [ -n "$TAG" ] && LAST_REVIEW=$(git rev-parse -- "$TAG" 2>/dev/null || echo "")
fi

# Priority 5: Fallback
if [ -z "$LAST_REVIEW" ]; then
  LAST_REVIEW="HEAD~10"
fi

# Validate reference point — only hex SHA or HEAD~N allowed
if ! echo "$LAST_REVIEW" | grep -qE '^[0-9a-f]{7,40}$|^HEAD~[0-9]+$'; then
  LAST_REVIEW="HEAD~10"
fi
```

**Step 2: Routing (top to bottom, first match wins)**

| Priority | Condition | Review scope | Rationale |
|---------|------|----------|------|
| 1 | PR exists | `gh pr diff {PR_NUM}` | PR = natural unit of review |
| 2 | Feature branch (no PR) | `diff {BASE}..HEAD` | Entire branch = unit of work |
| 3 | Main + reference point exists | `diff {LAST_REVIEW}..HEAD` | Since last review/release/tag |
| 4 | Fallback | `diff HEAD~10` | Reasonable default |
| — | Unrecognized input | [Subcommand: list] | Safe fallback for typos/unsupported commands |

**Step 3: Pre-run summary + large diff guard**
```
🔍 리뷰 범위: {ref:0:7}..HEAD ({N} 커밋, {M} 파일, +{add}/-{del} 줄)
   기준: {마지막 리뷰 / 릴리스 커밋 / 태그 / HEAD~10}
```

| Diff size | Behavior |
|----------|------|
| 0 lines | Output "변경 사항이 없습니다", exit |
| 1-500 lines | Run immediately |
| 500-2000 lines | AskUserQuestion: choose `--preset thorough` (4 lenses) or `--preset quick` (2 lenses) |
| 2000+ lines | Force `--preset quick` (override: `--force-full`) |

**Save reference point after review:**

After Phase 4 completes, write the `reviewed_commit` field to `last-result.json`:
```json
{
  "reviewed_commit": "{commit hash of HEAD}",
  ...existing fields
}
```
This value becomes priority 1 reference point for the next Smart Router run.

**Natural language mapping:**
| User says | Route to |
|-----------|----------|
| "review this PR", "PR 리뷰" | `pr` (auto-detect) |
| "review the code", "코드 리뷰" | Smart Router (auto scope) |
| "check security", "보안 검사" | `diff --lenses "security"` |
| "review this file", "이 파일 리뷰" | `file` (ask for path) |
| "full review", "전체 리뷰" | `full` |

---

## Subcommand: list

```
x-review — Multi-Perspective Code Review Orchestrator

Commands:
  (no args)                     Smart detect: PR, branch diff, or recent commit
  diff [ref]                    Review git diff (default: HEAD~1)
  pr [number]                   Review GitHub PR (auto-detect from branch)
  file <path>                   Review specific file(s)
  full                          Full codebase review (split by lens)

Options:
  --lenses "security,logic,perf,tests"
                                Review perspectives (default: all 4)
  --severity critical|high|medium|low
                                Minimum severity to show (default: low)
  --format markdown|github-comment
                                Output format (default: markdown)
  --agents N                    Number of review agents (default: from shared config)
  --thorough                    Enhanced recall: dedicated recall agent, 10 observations max

Lenses (default 4 + extended 3):
  security       Injection, auth, secrets, OWASP Top 10
  logic          Bugs, edge cases, off-by-one, null handling
  perf           N+1, memory leaks, complexity, blocking I/O
  tests          Missing tests, untested paths, test quality
  architecture   Module boundaries, coupling, SRP (--agents 5+)
  docs           Public API docs, outdated comments (--agents 6+)
  errors         Error handling, recovery paths (--agents 7+)
  migrations     Schema drift, missing migrations, ORM sync (--agents 8+)

Presets:
  --preset quick       security + logic (2 agents, ~2min)
  --preset standard    4 core lenses (~5min)
  --preset security    security × 3 agents (redundant verification)
  (default)            all 7 lenses, 7 agents

Examples:
  /xm:review                                     Smart detect: PR or diff
  /xm:review diff
  /xm:review pr                                  Auto-detect PR from branch
  /xm:review diff --preset quick
  /xm:review diff --lenses "security,logic" --severity high
  /xm:review pr 142 --format github-comment
```

---

## Review Workflow (Phase 1-4)

See `references/review-workflow.md` — full pipeline:
- **Phase 1: TARGET** — collect diff/PR/file content, auto-detect language. `### full` mode uses Lens-first split: each agent scans all files with one lens (file-group split prohibited).
- **Phase 2: ASSIGN** — select lenses (default 7 or preset), distribute to agents
- **Phase 3: REVIEW** — fan-out N agents with Universal Principles + lens prompts (`lenses/{name}.md`)
- **Phase 4: SYNTHESIZE** — parse → dedupe+consensus → Self-Verify (Chain-of-Verification: agents include code snippet 3-5 lines; leader verifies claim against snippet — do not re-read the file; contradicted findings tagged `[CoVe-removed]`, inconclusive tagged `[CoVe-downgraded]`) → challenge → recall boost → verdict (include verdict rationale in output) → output (markdown / github-comment)
- **Phase 5: REVIEW-FIX CONTRACT** — every finding gets a stable `F#` ID; Request Changes / Block output MUST include a triage checklist that classifies each Medium+ finding as `fix_now`, `backlog`, `accept_risk`, or `false_positive` before any review-fix edits start.

---

## Severity Definitions

See `references/finding-severity.md` — Critical/High/Medium/Low criteria shared with CLAUDE.md. x-review applies these across all 7 lenses.

> **Note (x-review specific):** Medium applies only to issues **introduced by this diff**. Low includes findings that **follow an existing repo-wide pattern**.

---

## Data Directory

See `references/data-directory.md` — writes `last-result.md` and `last-result.json` under `.xm/review/`, appends to `history/`, saves `reviewed_commit` to JSON after every review. `last-result.json.findings[]` MUST preserve output order so `F1`, `F2`, ... are stable for `.xm/review/triage.json`.

---

## Shared Config Integration

x-review references shared settings in `.xm/config.json`:

| Setting | Key | Default | Effect |
|---------|-----|---------|--------|
| Agent count | `agent_max_count` | `4` | Default agent count when `--agents` is not specified |

`--agents` takes precedence over shared config when explicitly provided.

---

## Usage From x-build

See `references/x-build-integration.md` — verdict→gate mapping (LGTM/Request Changes/Block), x-eval review-quality rubric scoring, x-memory auto-save for recurring Critical/High findings.

---

## Trace Recording

See `references/trace-recording.md` — session_start/session_end are automatic via `.claude/hooks/trace-session.mjs`; emit best-effort `agent_step` entries for long sub-operations.

---

## Natural Language Mapping

| User says | Command |
|-----------|---------|
| "Review this PR" | `pr` (prompt for PR number) |
| "Review the code" | `diff` (default HEAD~1) |
| "Review this file" | `file <path>` |
| "Check security only" | `diff --lenses "security"` |
| "Show critical ones only" | `diff --severity high` |
| "GitHub comment format" | `diff --format github-comment` |

## Interaction Protocol

**CRITICAL: x-review MUST use AskUserQuestion at key decision points.**

Rules:
1. Before starting review → AskUserQuestion to confirm target (file/PR/diff) and lens selection
2. After showing review results → AskUserQuestion for verdict confirmation (LGTM or request changes)
3. For multi-lens review → show each lens result, then AskUserQuestion before final synthesis

Anti-patterns:
- ❌ Auto-detect diff and immediately start reviewing
- ❌ Show findings and declare LGTM without user confirmation
- ✅ Show target + selected lenses, AskUserQuestion("이 설정으로 리뷰를 시작할까요?")
| "Usage" | `list` |

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The change is small, no need for full review" | Small changes cause big regressions. The lens checks apply to one-line changes too — they just take thirty seconds. |
| "Tests pass, so it's good" | Tests catch correctness. They don't catch architecture, security, performance, or readability issues. Reviewing only test results is half a review. |
| "AI-generated code is probably fine" | AI code needs more scrutiny, not less. It's confident and plausible even when wrong. Severity-label every finding; don't rubber-stamp. |
| "I don't want to be pedantic" | That's what severity labels exist for (Critical/High/Medium/Low). Silencing real findings to be polite is dishonest review. |
| "The author knows what they're doing" | Author expertise doesn't catch author blind spots — that's literally what review is for. Every "they know better" approval you give is a bug that will reach production with no outside check. |
| "I'll mark it LGTM and move on" | LGTM without cited evidence is not a review. State what you checked and what you found (including "nothing") — or don't approve. |
| "This issue is outside the diff, not my problem" | True most of the time — but when a change *worsens* an existing problem, it becomes the reviewer's problem. Don't hide behind "pre-existing". |

---
<!-- [See: data-directory] -->

# x-review Data Directory

State persistence layout and JSON/MD schemas for review artifacts.

## Directory Layout

Review state is stored in `.xm/review/`.

```
.xm/review/
├── last-result.json                    # Latest review result (JSON)
├── last-result.md                      # Latest review result (Markdown, human-readable)
└── history/
    └── {YYYY-MM-DD}-{ref-slug}.md      # Past review reports
```

## Review Result MD Save (MANDATORY)

After every review completes, save the Phase 4 final output as an MD file under `.xm/review/`. **This step cannot be skipped.**

1. `last-result.md` — latest review result (overwrite)
2. `history/{YYYY-MM-DD}-{ref-slug}.md` — preserve history

**ref-slug generation:**
- `diff HEAD~1` → `head-1`
- `pr 142` → `pr-142`
- `diff main..HEAD` → `main-head`
- `full` → `full`
- `file src/auth.ts` → `file-src-auth-ts`

**MD file content:** Save Phase 4 final output (verdict, findings, summary table, observations) as-is.
Prepend metadata at the top of the file:
```markdown
# x-review: {target} — {verdict}
- Date: {YYYY-MM-DD HH:MM}
- Branch: {branch}
- Lenses: {lenses}
- Agents: {N}
- Findings: {count} (Critical: {n}, High: {n}, Medium: {n}, Low: {n})

---
{Phase 4 output}
```

## last-result.json Schema

```json
{
  "timestamp": "ISO8601",
  "target": { "type": "diff|pr|file", "ref": "HEAD~1|142|src/auth.ts" },
  "lenses": ["security", "logic", "perf", "tests"],
  "agents": 4,
  "verdict": "LGTM|Request Changes|Block",
  "findings": [
    {
      "severity": "Critical|High|Medium|Low",
      "file": "src/auth.ts",
      "line": 42,
      "description": "SQL injection via unsanitized user input",
      "fix": "Use parameterized query",
      "lenses": ["security", "logic"],
      "consensus": true
    }
  ],
  "summary": {
    "security": { "total": 2, "critical": 1, "high": 1, "medium": 0, "low": 0 },
    "logic":    { "total": 1, "critical": 0, "high": 1, "medium": 0, "low": 0 },
    "perf":     { "total": 1, "critical": 0, "high": 0, "medium": 1, "low": 0 },
    "tests":    { "total": 0, "critical": 0, "high": 0, "medium": 0, "low": 0 }
  }
}
```

## Applies to

Phase 4 finalization writes `.xm/review/last-result.{md,json}` + appends to history.

---
<!-- [See: review-workflow] -->

# Review Workflow

End-to-end x-review pipeline from target collection to final verdict. The orchestrator (leader) executes Phases 1-4 sequentially; Phase 3 dispatches lens agents in parallel. See `lenses/*.md` for per-lens agent prompts.

## Phase 1: TARGET

Collect review target content from a diff, PR, or file.

### diff [ref]

```bash
git diff HEAD~1    # default when no ref provided
git diff {ref}     # use the specified ref
```

Run via Bash tool. Store the entire result as `{diff_content}`.
Auto-detect language from file extensions (`.ts`, `.py`, `.go`, etc.).

### pr [number]

```bash
gh pr diff {number}
```

Run via Bash tool. Store the result as `{diff_content}`.

If `number` is omitted, auto-detect from current branch:
```bash
gh pr view --json number -q .number 2>/dev/null
```
- If PR found → use that number automatically
- If no PR → AskUserQuestion: "Please enter the PR number"

### file <path>

Read the file directly via Read tool. If the path is a directory, list child files and read each one (non-recursive, respecting .gitignore).
Store the result as `{diff_content}`.

### full

Full codebase review. Targets entire source, not a diff.

1. Collect files to review:
   ```bash
   git ls-files --cached | grep -E '\.(ts|js|py|go|java|rs|mjs)$' | head -100
   ```
2. **Lens-first split** — assign agents by lens, not by file group:
   - Default 4 lenses (security, logic, perf, tests) × full file list
   - Each agent scans all files with **one lens** (file-group × 7-lens split is prohibited)
   - Agent count = min(lens count, `agent_max_count`)
   - If 20+ files, split files in half per lens and assign 2 agents each
3. Merge results into Phase 4: SYNTHESIZE

`full` mode is expensive — confirm before running:
```
전체 리뷰 대상: {N}개 파일, {렌즈}개 렌즈, ~{agent_count}개 에이전트
예상 토큰: ~{token}K
계속할까요? (AskUserQuestion)
```

---

## Phase 2: ASSIGN

Assign review perspectives using `--lenses` option or automatically.

### Default 7 Perspectives

| Agent | Lens | Focus Area |
|-------|------|------------|
| Agent 1 | security | Injection, XSS, CSRF, auth/authz, hardcoded secrets, OWASP Top 10 |
| Agent 2 | logic | Bugs, edge cases, off-by-one, null/undefined handling, type errors |
| Agent 3 | perf | N+1 queries, memory leaks, complexity, blocking I/O, unnecessary recomputation |
| Agent 4 | tests | Missing tests, untested paths, test quality, boundary value tests |
| Agent 5 | architecture | Module boundaries, coupling, single responsibility principle |
| Agent 6 | docs | Inline comments, public API docs, change history |
| Agent 7 | errors | Error handling, recovery paths, failure propagation |
| Agent 8 | migrations | Schema drift, missing migrations, ORM/DB sync |

### Optional Lenses (opt-in via `--lenses`)

| Lens | Focus Area |
|------|------------|
| silent-failures | Empty catch, swallowed errors, `|| null` fallbacks, ignored promise rejections, discarded return values |
| type-design | `any` overuse, missing discriminated unions, nullable leaks, over-broad enums (typed languages only: TS / Python typed / Go / Rust) |
| comments-stale | Stale / contradictory comments, TODO without ticket, commented-out code, "what" comments instead of "why" |

These are NOT in the default preset — invoke explicitly: `--lenses "silent-failures,type-design"`.

### When --lenses Is Specified

`--lenses "security,logic"` → Use only the specified lenses; agent count = lens count.

**--lenses + --agents interaction:**
- `--lenses "security" --agents 3` → runs security as 3 independent agents (redundant verification, Self-Consistency effect)
- `--lenses "security,logic" --agents 4` → security ×2 + logic ×2 (evenly distributed per lens)
- `--lenses "security,logic,perf"` (no --agents) → 3 agents, 1 per lens

### Presets (quick start)

| Preset | Lenses | Agents | Use case |
|--------|------|---------|------|
| `--preset quick` | security, logic | 2 | Fast core check (~2 min) |
| `--preset standard` | security, logic, perf, tests | 4 | Code quality focused (~5 min) |
| `--preset security` | security only | 3 | Security focused (Self-Consistency) |
| (default, no preset) | **all 7** | **7** | **Full review (default)** |

### Agent Count

- Default: agent count = lens count (**7 lenses = 7 agents**)
- `--preset quick` → 2, `--preset standard` → 4
- When `--agents N` is specified: N agents (lenses assigned to fit N)
- If `--agents N` is less than lens count: assign highest-priority lenses first (security > logic > perf > errors > tests > architecture > docs)

---

## Phase 3: REVIEW

Fan-out — send the diff + dedicated perspective prompt to each agent simultaneously.

**Invoke N Agent tools simultaneously in a single message:**

```
Agent tool 1: {
  description: "x-review: security",
  prompt: "## Code Review: Security\n\n{diff_content}\n\n[perspective prompt]",
  run_in_background: true,
  model: "sonnet"
}
Agent tool 2: {
  description: "x-review: logic",
  prompt: "## Code Review: Logic\n\n{diff_content}\n\n[perspective prompt]",
  run_in_background: true,
  model: "sonnet"
}
... (N agents)
```

### Universal Review Principles

The following principles are injected at the `{universal_principles}` position in all perspective prompts.

```
## Universal Review Principles

1. **Context determines severity** — The same pattern varies in severity depending on exposure scope, data sensitivity, and call frequency. Always ask first: "Where does this code run, with what data, and how often?"
2. **A finding without evidence is noise** — Show "this code does X" not "this code could do X." If you cannot trace a concrete path in the diff, do not report it.
3. **No fix direction, no finding** — A finding whose Fix is "be careful" is not actionable. If you cannot suggest a specific code change, it is not a finding.
4. **Review only changed code** — Do not report issues in existing code outside the diff. Exception: when a change worsens an existing problem.
5. **One finding, one problem** — Do not bundle multiple issues into a single finding. "This is wrong AND that is wrong" is two findings.
6. **When in doubt, downgrade** — If you hesitate between two severity levels, choose the lower one. Over-reporting erodes trust faster than under-reporting. A consistently accurate Low is more valuable than an inflated Medium.
```

### Lens Prompts

Each lens provides a specialized agent prompt. The orchestrator selects lenses per `--lenses` flag or preset, prepends `{universal_principles}` (above), and dispatches N agents in parallel. See individual files for prompt contents and severity calibration rules.

- `lenses/security.md` — OWASP + trust-boundary validation
- `lenses/logic.md` — boundary values + conditional intent
- `lenses/performance.md` — measurable bottlenecks, I/O > CPU
- `lenses/tests.md` — behavior over implementation, risky paths first
- `lenses/architecture.md` — blast radius, YAGNI abstractions
- `lenses/docs.md` — why not what, API contracts, stale doc detection
- `lenses/errors.md` — visible failures, fail-fast, caller-specific info
- `lenses/migrations.md` — ORM vs schema sync, reversibility
- `lenses/silent-failures.md` — swallowed errors, default-value traps
- `lenses/type-design.md` — any/unknown at boundaries (typed languages only)
- `lenses/comments-stale.md` — contradictory comments, TODO hygiene

---

## Phase 4: SYNTHESIZE

Once all agents complete, the leader generates a consolidated report.

### 1. Parse

Parse findings from each agent's result:
```
[Severity] file:line — description
→ Why: ...
→ Fix: ...
```

Skip `[Info]` lines.

### 2. Deduplicate + Consensus Promotion

- If different agents report the same issue at the same `file:line` → merge into one and list all source lenses
- Merged findings are marked as "consensus"

**Consensus promotion rules:**
| Agent Count | Action |
|-------------|--------|
| 1 | Keep original severity |
| 2 | Promote severity one level (Medium → High) + `[consensus]` tag |
| 3+ | Promote to maximum severity (up to Critical) + `[strong consensus]` tag |

Promotion caps at Critical. Order: Low → Medium → High → Critical.
Preserve pre-promotion severity in parentheses: `[High←Medium] [consensus] file:line — issue`

### 2.5. Self-Verify (Chain-of-Verification)

After deduplication, each finding is self-verified before challenge. For each High+ finding, the leader generates a verification question and checks the code independently:

For each finding with severity >= High:
1. **Generate verification question:** "Does {file}:{line} actually do {claimed behavior}?"
2. **Verify against agent output:** Review agents must include the relevant code snippet (3-5 lines around the finding) in their output. The leader verifies the claim against this snippet — **do not re-read the file.** Only use Read tool for findings that have no snippet.
3. **Result:**
   - Verified → keep finding as-is
   - Contradicted → remove finding + tag `[CoVe-removed]`
   - Inconclusive → downgrade one level + tag `[CoVe-downgraded]`

CoVe-removed findings are excluded from Step 3 Challenge. CoVe-downgraded findings proceed to Challenge with their new severity.

This catches false positives where the agent claimed a vulnerability/bug that doesn't actually exist in the code. Only applies to High+ to limit cost — Low/Medium findings are validated in the Challenge step.

### 3. Challenge (Severity Validation)

Before sorting, the leader validates each finding's severity:

1. **Why-line check** — Does the Why line cite a specific criterion from the severity calibration?
   - If Why is vague ("could be a problem", "best practice") → downgrade one level
   - If Why is missing → downgrade one level

2. **Context check** — Does the finding account for existing defenses?
   - If the code already has guards (try/catch, optional chaining, ORM, auth middleware) that the finding ignores → downgrade one level or remove

3. **Reachability check** — Is the problem actually reachable in production?
   - If the finding requires conditions that cannot occur given the call site (e.g., internal-only function, caller already validates) → downgrade one level or remove

4. **Impact check** — What is the actual blast radius?
   - "Function crashes" in a CLI tool (user retries) vs. in a server (service down) → adjust severity to match actual impact

Downgrade is capped at removal (cannot go below Low).
Mark challenged findings with `[↓ severity←original] [challenged]` tag.
Example: `[Low←Medium] [challenged] file:line — description`

If all findings are removed after challenge, verdict is LGTM regardless of original counts.

### 3.5. Recall Boost (Completeness Check)

After challenge filtering, the leader does a **second pass** to catch issues that strict severity rules might have filtered out.

**Mode selection:**

| Flag | Behavior | Observation limit | Agent |
|------|----------|:-----------------:|-------|
| (default) | Leader second pass, 6 categories | 5 | Leader only |
| `--thorough` | Dedicated recall agent, 6 categories, aggressive promotion | 10 | Separate agent via Agent tool |

When `--thorough` is active, spawn a **separate recall agent** (not the leader) via Agent tool. The agent receives: (1) the full diff, (2) the list of already-reported findings, and (3) the recall boost prompt below. This provides genuine "fresh eyes" — a different context window from the leader who applied severity filters.

**Prompt for the recall boost pass:**
```
Review the diff one more time with fresh eyes. Ignore the findings already reported.
Look specifically for:

1. **Incomplete implementations** — Stubs, placeholder comments, TODO-equivalent code blocks
   that have no actionable instruction. (e.g., a command handler that is just a comment)
2. **Internal contradictions** — Two parts of the same file that say different things
   (e.g., a config table says X, but the prose says Y)
3. **Broken cross-references** — A section references a path, command, or identifier
   that doesn't match the actual definition elsewhere in the diff
4. **Silent behavior changes** — Default value changes, parameter reordering, removed
   validations, or loosened constraints that alter runtime behavior without explicit mention
5. **Missing error paths** — New I/O, network, or parsing operations introduced without
   error handling (no try/catch, no error return check, no fallback)
6. **Off-by-one and boundary gaps** — Loop bounds, array slicing, range checks, or
   pagination logic where ±1 changes the result set (e.g., < vs <=, 0-index vs 1-index)

For each issue found, output as:
[Observation] file:line — description
→ Fix: specific change

Observations do NOT affect the verdict. They are informational.
If nothing found, output: No additional observations.
```

**Promotion rules:**
- Observations are appended to the report **after** the verdict section
- Observations do NOT count toward verdict thresholds (not Critical/High/Medium/Low)
- Observations use the `[Observation]` tag — a distinct category, not a severity level
- Maximum 5 observations per review (10 with `--thorough`)
- **Auto-promotion criteria** — an observation is promoted to a severity-rated finding when ANY of:
  1. (all modes) It describes a defect that would be **Medium or higher** if severity-rated
  2. (`--thorough` only, additional) The recall agent flags it as `[Promote]` with explicit severity justification
- Promoted observations are re-evaluated: apply the same Challenge rules (Why-line, context, reachability, impact). If they survive challenge, the verdict is recalculated.

**Why this exists:** x-review's "when in doubt, downgrade" principle optimizes for precision (no false positives) at the cost of recall. This pass recovers recall without inflating severity — observations are advisory, not blocking. The 3 added categories (4-6) target the most common recall gaps identified in A/B benchmarks.

### 4. Sort

Sort by Critical → High → Medium → Low.
Within the same severity, consensus findings come first.

### 5. Apply --severity Filter

`--severity high` → Show only High and above. Counts are based on pre-filter totals.

### 6. Verdict

| Condition | Verdict | Meaning |
|-----------|---------|------|
| 0 Critical, 0 High, Medium ≤ 3 | LGTM ✅ | Ready to merge |
| 0 Critical, High 1-2 or Medium > 3 | Request Changes 🔄 | Fix then re-review |
| 1+ Critical or High > 2 | Block 🚫 | Merge blocked — must fix |

Include verdict rationale in output: "Verdict: Request Changes 🔄 — 1 High finding (LGTM requires: 0 High)"

### 7. Review-Fix Contract

When the verdict is `Request Changes` or `Block`, the report MUST include a review-fix contract before the Summary:

1. Assign stable finding IDs in output order: `F1`, `F2`, ...
2. Require triage for every Medium, High, and Critical finding.
3. Do not instruct the implementer to edit code until triage is complete.
4. Triage decisions are limited to:
   - `fix_now` — fix in this review-fix loop
   - `backlog` — defer; allowed for Medium/Low only
   - `accept_risk` — allowed only with concrete evidence
   - `false_positive` — allowed only with concrete evidence
5. Review-fix edits are limited to files listed in `.xm/review/triage.json` `fix_scope.allowed_files`.
6. Unrelated issues discovered during review-fix are not fixed in place. If they do not affect the current fix, capture them with `x-build later add` and continue the current fix.

Recommended gate commands:

```bash
x-build verify-review-fix --init
# edit .xm/review/triage.json
x-build verify-review-fix
```

This turns review feedback into a bounded fix loop instead of an open-ended second implementation pass.

### 8. Output Format

#### format: markdown (default)

```
🔍 [x-review] Complete — {N} agents, {M} findings

Verdict: {LGTM ✅ | Request Changes 🔄 | Block 🚫}

## Critical ({count})
[F1] [Critical] src/auth.ts:42 — SQL injection via unsanitized user input (security, logic)
  → Fix: Use parameterized query: db.query('SELECT * FROM users WHERE id = $1', [id])

## High ({count})
[F2] [High] src/api/handler.ts:88 — Unhandled promise rejection propagates silently (errors)
  → Fix: Add .catch() or use await with try/catch

## Medium ({count})
[F3] [Medium] src/utils/cache.ts:15 — O(n²) lookup in hot path (perf)
  → Fix: Convert to Map for O(1) lookup

## Low ({count})
[F4] [Low] src/models/user.ts:3 — Missing JSDoc for exported UserSchema (docs)
  → Fix: Add /** @param ... @returns ... */ above function signature

## Review-Fix Triage Required

Run `x-build verify-review-fix --init`, edit `.xm/review/triage.json`, then run `x-build verify-review-fix` before applying review fixes.

| Finding | Required? | Allowed Decisions |
|---------|-----------|-------------------|
| F1 | yes | fix_now / accept_risk / false_positive |
| F2 | yes | fix_now / accept_risk / false_positive |
| F3 | yes | fix_now / backlog / accept_risk / false_positive |
| F4 | no | optional |

## Summary
| Lens | Findings | Critical | High | Medium | Low |
|------|---------|----------|------|--------|-----|
| security | 2 | 1 | 1 | 0 | 0 |
| logic | 1 | 0 | 1 | 0 | 0 |
| perf | 1 | 0 | 0 | 1 | 0 |
| tests | 0 | 0 | 0 | 0 | 0 |
| **Total** | **4** | **1** | **2** | **1** | **0** |

## Observations ({count})
[Observation] src/commands/export.ts:45 — Export handler has only a comment stub, no implementation instruction
  → Fix: Add explicit output format definition matching the import handler pattern

[Observation] src/config.ts:12 — Config docs say "timeout in ms" but code uses seconds
  → Fix: Align docs to match code: "timeout in seconds"
```

#### format: github-comment

````
<!-- x-review -->
## Code Review

**Verdict: Block 🚫** — 1 critical finding requires attention before merge.

<details>
<summary>🔴 Critical (1)</summary>

**`src/auth.ts:42`** — SQL injection via unsanitized user input *(security, logic)*
> Fix: Use parameterized query: `db.query('SELECT * FROM users WHERE id = $1', [id])`

</details>

<details>
<summary>🟠 High (2)</summary>

**`src/api/handler.ts:88`** — Unhandled promise rejection *(errors)*
> Fix: Add `.catch()` or use `await` with `try/catch`

**`src/models/user.ts:21`** — Missing null check before property access *(logic)*
> Fix: Add `if (!user) return null;` guard

</details>

<details>
<summary>📊 Summary</summary>

| Lens | Findings | Critical | High | Medium | Low |
|------|---------|----------|------|--------|-----|
| security | 2 | 1 | 1 | 0 | 0 |
| logic | 1 | 0 | 1 | 0 | 0 |
| perf | 1 | 0 | 0 | 1 | 0 |
| tests | 0 | 0 | 0 | 0 | 0 |

*Generated by [x-review](https://github.com/x-mesh/xm:kit)*
</details>
````

## Applies to

Orchestrator runs through this workflow on every x-review invocation.

---
<!-- [See: x-build-integration] -->

# x-review — x-build Integration

How x-review is consumed as a quality gate in x-build's Verify phase, with x-eval scoring and x-memory persistence.

## Usage From x-build

Used as a quality gate in x-build's Verify phase:

```
# Full diff review in the Verify phase
/xm:review diff HEAD~{step_count}

# If Request Changes / Block:
x-build verify-review-fix --init
# edit .xm/review/triage.json
x-build verify-review-fix

# Then apply only fix_now changes, run quality, and re-review
x-build quality
/xm:review diff
```

## x-build Verdict-to-Gate Mapping

| x-review Verdict | x-build Action |
|------------------|----------------|
| LGTM | `x-build gate pass "x-review LGTM"` |
| Request Changes | Run Review-Fix Gate, apply only triaged `fix_now` changes, then re-review |
| Block | `x-build gate fail "Critical issues found"` — blocks phase next |

## Review-Fix Gate

`x-build verify-review-fix` prevents the common LLM loop where review feedback turns into an unbounded second implementation pass.

Required sequence:

1. `x-build verify-review-fix --init` creates `.xm/review/triage.json` from `.xm/review/last-result.json` and records the current changed-file baseline.
2. Triage every Medium+ finding:
   - `fix_now` for issues fixed in this loop
   - `backlog` for Medium/Low deferral only
   - `accept_risk` or `false_positive` only with evidence
3. Keep `fix_scope.allowed_files` narrow. Add test files only when they verify a `fix_now` finding.
4. Run `x-build verify-review-fix` before and after applying fixes.
5. Any new changed file outside `fix_scope.allowed_files` after the baseline fails the gate.
6. Capture unrelated, non-blocking findings with `x-build later add` instead of editing them in the review-fix loop.

Critical/High findings cannot be moved to `backlog`; they must be fixed, accepted with evidence, or marked false-positive with evidence.

## x-eval Scoring Integration

After review completion, findings can be auto-scored via x-eval:

```
/xm:eval score ".xm/review/last-result.json" --rubric review-quality
```

`review-quality` rubric criteria:
- **coverage** (0.30): Were all perspectives sufficiently covered
- **actionability** (0.30): Are findings specific and fixable
- **accuracy** (0.25): Are there no false positives
- **severity-calibration** (0.15): Are severity levels appropriate

## x-memory Integration

Recurring Critical/High findings are auto-saved to x-memory:
```
x-memory save --type failure --title "SQL injection in auth module"
  --why "x-review detected SQLi in 3 consecutive reviews"
  --tags "security,auth,recurring"
```

Condition: Auto-suggested when Critical/High is found 2+ times at the same file/pattern.

## Applies to

Invoked from x-build Verify phase; results feed x-eval scoring, x-memory auto-save, and the Review-Fix Gate.
