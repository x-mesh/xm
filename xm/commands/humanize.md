---
description: Remove AI writing patterns — detect and rewrite AI-generated text into natural human prose (English + Korean). `ui` mode edits Korean or English UI strings, checking meaning before form.
allowed-tools: Read(/${CLAUDE_PLUGIN_ROOT}/skills/humanize/**)
---

User provided: $ARGUMENTS

Read `${CLAUDE_PLUGIN_ROOT}/skills/humanize/SKILL.md` in full with the Read tool before you do anything else, then follow it for the arguments above. Do not call the Skill tool for `humanize`: it returns this command again, not that file. Resolve the relative paths that file names against `${CLAUDE_PLUGIN_ROOT}/skills/humanize/`.

Interpret the request before editing:
- Empty arguments: ask for text or a file path.
- `audit ...`: report AI-writing patterns only. Do not rewrite.
- `light ...`: make the smallest useful edit.
- `strong ...`: rebuild the prose more aggressively while preserving every fact.
- `ui ...`: UI-string mode (Korean or English). Load `${CLAUDE_PLUGIN_ROOT}/skills/humanize/references/ui-meaning.md`, then `ui-strings-ko.md` for Korean or `ui-strings-en.md` for English, and follow `## UI String Mode`. A string array in gets a bare JSON array out. Files or a screen in get a report that opens by stating that no file was changed. Prose change-rate guardrails do not apply.
- A request that names a screen, a feature, or UI source files in a codebase ("설정 화면 문구 다듬어줘", "improve the wording on the billing page") is `ui` mode even without the token. Judge every user-visible string in that area, and settle the names the screen uses for one thing before judging single strings.
- `voice <file> ...`: read the sample file first, then match that voice.
- `--lang en` / `--lang ko`: force the language instead of auto-detecting it.

If the user passes a file path, read the file and return the humanized result. Do not modify files unless the user explicitly asks. When asked to apply `ui` results, apply only the edits you already showed.
