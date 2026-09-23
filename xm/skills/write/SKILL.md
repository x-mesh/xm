---
name: write
description: Write GitHub-facing and release documents from repository evidence — PR and issue bodies (published with gh after one confirmation), release notes, changelog entries, and commit messages (text only, for xm:ship). Concise maintainer prose, no invented claims.
---

<Purpose>
Write the documents a change leaves behind: pull requests, issues, GitHub release notes,
changelog entries, and release commit messages. Every sentence must trace back to evidence in
the repository or the session. The output should read like a maintainer wrote it after doing
the work, not like a generated report.

Publishing is split by owner. `pr` and `issue` have no other owner in xm, so this skill
publishes them with `gh` after one confirmation. `commit`, `changelog`, and `release` belong to
the release transaction owned by `xm:ship`, so this skill returns text only for them.
</Purpose>

<Use_When>
- User asks to write, open, or revise a PR or issue: "PR 올려줘", "PR 본문 정리", "이슈 만들어줘", "open a PR", "file an issue"
- User asks for release notes or a changelog entry without cutting a release
- `xm:ship` needs its commit message, changelog entry, or release notes
- An existing PR or issue body reads like a generated report and needs rewriting
</Use_When>

<Do_Not_Use_When>
- Cutting a release (version bump, tag, push) — use `xm:ship`, which calls this skill for its documents
- Writing README or `docs/` prose — use `xm:humanize` for prose cleanup
- Filing a bug that belongs to another registered x-kit project — use `xm:toss`
- Posting a PR review or inline comments — use `xm:review`
</Do_Not_Use_When>

## Wiring

```
after: x-review
```

## Modes

| Mode | Output | Publishes? |
|------|--------|------------|
| `pr [<number>]` | PR title + body. With a number: revise that PR's body | Yes — `gh pr create` / `gh pr edit` after one confirmation |
| `issue [<number>] [<text>]` | Issue title + body. With a number: revise that issue's body | Yes — `gh issue create` / `gh issue edit` after one confirmation |
| `release [<tag>]` | GitHub release title + notes | No — text only |
| `changelog [<range>]` | Entries for the project's changelog | No — text only |
| `commit [<range>]` | Commit message | No — text only |

Modes combine: `commit changelog release --range v1.4.0..HEAD --version 1.5.0` returns all three
under separate headings from one evidence pass. `xm:ship` calls this skill this way.

When the caller is `xm:ship` (arguments contain `--for ship`), return text only for every mode,
ask no questions, and skip the publish step. Only read-only `gh` is allowed for evidence:
`gh pr list|view`, `gh issue list|view`, `gh release list|view`, `gh repo view`. Run no other
`gh` command: ship already holds the user's consent and owns every write.

## Step 1: Gather Evidence

Collect before writing. Run independent reads in one Bash call.

| Mode | Evidence |
|------|----------|
| `pr` | `GK_AGENT=1 git-kit context --include=diff,log,remotes`, `GK_AGENT=1 git-kit diff --digest <base>..HEAD`, `GK_AGENT=1 git-kit log --body <base>..HEAD`, existing body via `gh pr view <n> --json title,body` when revising |
| `issue` | The user's report, reproduction steps, exact error text, `git rev-parse --short HEAD`, OS and version when relevant. Existing body via `gh issue view <n> --json title,body` when revising |
| `release`, `changelog`, `commit` | `GK_AGENT=1 git-kit log --body <range>`, `GK_AGENT=1 git-kit diff --digest <range>`, the existing `CHANGELOG.md` sections for format, and the version passed by the caller |

Base branch for `pr`: use the base that `git-kit context` reports. If it reports none, use
`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`. Never assume `main`.

Test evidence: list only commands that ran in this session and passed, with their result. A
review verdict counts only when `xm recall show review --last` covers the current HEAD or the
PR range. If nothing ran, omit the "Tested with" block. Do not write "tests pass" from
inspection.

Missing facts: omit them or mark them unknown. Ask one focused question only when the document
is useless without the answer, for example an issue with no observed behavior.

## Step 2: Write

### Document language

Match the repository, not the chat. Read the last few PR titles (`gh pr list --state all --limit 5 --json title`),
`CHANGELOG.md`, and recent commit subjects. If they are English, write English even when the
user speaks Korean. Session output-style rules (Korean tone, mode-specific phrasing) apply to
your chat replies, never to the document body.

### Style rules (all modes)

- Keep code, commands, paths, identifiers, and error messages exactly as they appear.
- Start with the concrete change or problem. Do not open with "This PR", "This issue", or a generic summary sentence.
- Plain sentences over labels, slogans, and abstract design claims.
- No inflated wording: robust, seamless, comprehensive, production-ready, best practice, enterprise-grade, key improvement, ensures — unless the evidence states it specifically.
- No fake certainty. Replace "guarantees" or "eliminates all" with the measured result or the exact constraint.
- Say each fact once. No summary that repeats the body, no concluding paragraph.
- No sections added to look complete. A short body with no headings beats a long template.
- No emoji, decorative separators, motivational endings, or tables for a few simple facts.
- Bullets only for genuinely parallel items. Prose when the changes form one story.
- Do not state motivation, impact, compatibility, performance, or security effects the evidence does not show.
- Titles are short and specific. Follow the repository's commit convention, e.g. `fix(prune): avoid repeated chain verification`.

### PR

Pick the shortest format that lets a reviewer understand the change.

Small PR:

```markdown
<one or two sentences: the change and why it is needed>

<optional: test command or one limitation>
```

Normal PR:

```markdown
<what changed and why, one short paragraph>

<the important implementation detail or user-visible behavior, one short paragraph>

Tested with:
- `<command>`

<only if needed: known limitation, follow-up, migration note, or review question>
```

The body answers, in order: what changed, why, what the reviewer should look at, how it was
checked, known limitation or follow-up. For a large PR, state the review boundary in prose —
which changes carry logic and which are mechanical. No commit list, file inventory, or
implementation diary.

### Issue

Choose the type from the evidence.

Bug:

```markdown
<one sentence: the observed problem>

### Reproduction

1. `<step>`

### Expected

<what should happen>

### Actual

<what happens, with the exact error>

### Environment

- Version/commit: `<value>`
```

Feature or task:

```markdown
<the capability or outcome needed>

<why current behavior is insufficient, with a concrete example>

### Done when

- <observable outcome>
```

Omit any section without evidence. Keep the reporter's uncertain diagnosis marked as a
hypothesis. "Done when" lists observable behavior, never "make it robust".

### Release notes

```markdown
<one or two sentences: what this release changes for users>

- <user-visible change>
- <user-visible change>

<only if needed: upgrade or migration note>
```

Title: copy the form of past release titles (`gh release list --limit 3`), e.g. `xm v2.23.9`.
With no past releases, use the tag. Group by user-visible effect, not by commit. Drop internal
refactors, CI, and test-only changes unless they change behavior. If `CHANGELOG.md` has an entry
for this version, derive the notes from it so the two never disagree.

### Changelog

Follow the file's existing format exactly: headings, categories (`Added` / `Changed` / `Fixed` /
`Removed`), bold scope prefixes, line style. Read the latest versioned section as the template.
One entry per user-visible change: what changed and the reason a reader needs. Keep entries
already under `## [Unreleased]`, and add only what they miss. Return the entries, not the file.

### Commit message

```
release: {name}@{version}

- {plugin}: {change summary}
```

`--version` is either one version (standalone: `release: v1.5.0` unless the repository's past
release commits use another form) or a comma-separated `name@version` list (marketplace): the
subject lists every entry, `release: x-build@3.13.1, xm@2.27.4`. Each bullet names one plugin.
A plugin with several changes gets several bullets.

| Allowed | Forbidden |
|---------|-----------|
| What changed (files, sections, commands added/removed/modified) | Why it changed (rationale, motivation) |
| User-visible behavior change one-liners | Session context ("Karpathy judge caught X", "behavioral test showed Y") |
| File path + concrete diff summary | Learning narrative ("self-demonstration", "this release proves Z") |
| Version delta | Process notes ("shipped after consensus", "reverted v1") |

Test: strip the bullet text. Could a developer see the code change and confirm the bullet
describes it? If the bullet describes why or how the decision was made, it fails. Rationale
belongs in the PR body or the changelog.

### Revising an existing body

1. Keep factual details unless they are wrong or unsupported.
2. Remove duplicated summaries, ceremonial headings, and intent claims the code does not show.
3. Turn noun lists into a sentence when the items are one change.
4. Keep exact commands, numbers, error messages, and limitations that matter to review.
5. If the result still reads like a report, shorten it again before adding detail.

## Step 3: Publish (`pr` and `issue` only)

Skip this step for `release`, `changelog`, `commit`, and whenever `--for ship` is set.

1. Show the final title and body, plus the target: repository, base and head for a PR, the
   number when editing. Then ask once with AskUserQuestion: publish / edit first / cancel.
2. PR only: if the branch has no upstream or is ahead of it, include the push in the same
   question. On approval run `GK_AGENT=1 git-kit push`. Branch on `state`. If it is not `ok`,
   report the error and stop — do not fall back to raw `git push`.
3. Pass the title and body through quoted heredocs, never inline, so backticks and `$` in
   either survive the shell:

```bash
TITLE=$(cat <<'EOF'
<title>
EOF
) && BODY=$(mktemp) && cat > "$BODY" <<'EOF'
<body>
EOF
gh pr create --base <base> --head <branch> --title "$TITLE" --body-file "$BODY"
```

   To revise, set both variables again in the same Bash call, because each call starts a fresh
   shell:

```bash
TITLE=$(cat <<'EOF'
<title>
EOF
) && BODY=$(mktemp) && cat > "$BODY" <<'EOF'
<body>
EOF
gh pr edit <n> --title "$TITLE" --body-file "$BODY"   # or gh issue edit <n>
```

   Edit the body when asked to edit. Never post a comment instead.
4. Re-read what GitHub saved (`gh pr view <n> --json url,title,body` or `gh issue view`) and
   compare it with the approved text. Report the URL.

If `gh` is missing or unauthenticated, say so, print the title and body, and stop. Do not
switch to the GitHub web UI or another tool.

## Output

Chat reply for a draft: title and body as separate fenced blocks, then one line naming evidence
you could not find (for example "no test ran in this session"). For `--for ship`: one heading per
requested mode (`### commit`, `### changelog`, `### release`) with the text in a fenced block,
nothing else. The `### release` block starts with one line `Title: <release title>`, then a blank
line, then the notes.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Tests probably pass, I'll list `bun test` under Tested with." | Listing a command you did not run is a false claim a reviewer will rely on. List only commands that ran in this session. |
| "A complete template looks more professional." | Empty or padded sections make the reviewer read more to learn less. Omit every section without evidence. |
| "The user writes Korean, so the PR body should be Korean." | The document belongs to the repository. Match its PR titles, changelog, and commits. |
| "I'll explain the motivation — it's obviously for performance." | Motivation not shown in commits, issues, or the user's words is invented. Omit it or ask one question. |
| "The user said open a PR, so I can push and create without showing the text." | A PR is public and hard to retract. Show the final text and ask once, then publish. |
| "`gh pr comment` is close enough to editing the body." | The user asked for the body. A comment leaves the old body in place and adds noise. |
| "I'll add a commit list so the reviewer has everything." | GitHub already shows commits. Describe the change and the review boundary instead. |
| "Ship asked for release notes; I'll publish them to save a step." | Ship owns the tag and the release. Return text; publishing twice or before the tag breaks the release. |
| "The changelog entry and release notes can be written independently." | They then disagree. Derive the notes from the changelog entry for the same version. |

## Red Flags

- A "Tested with" line with no matching command in this session → invented verification
- A body that opens with "This PR" or ends with a summary paragraph → report shape, rewrite
- `gh pr create` without a prior confirmation in this run → skipped the publish gate
- Any `gh` command outside the read-only list during `--for ship` → ownership violation
- A heading with one line under it → section added for looks

## Verification

After publishing:
- `gh pr view <n> --json title,body` (or `gh issue view`) returns the approved title and body verbatim
- For a new PR, `gh pr view --json baseRefName,headRefName` matches the base and head you showed the user
- No comment was created when the request was an edit: `gh pr view <n> --json comments` has no new entry from this run
