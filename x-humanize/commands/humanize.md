---
description: Remove AI writing patterns — detect and rewrite AI-generated text into natural human prose (English + Korean)
---

User provided: $ARGUMENTS

Invoke the `humanize` skill to handle this request. Follow `skills/humanize/SKILL.md` exactly.

Interpret the request before editing:
- Empty arguments: ask for text or a file path.
- `audit ...`: report AI-writing patterns only. Do not rewrite.
- `light ...`: make the smallest useful edit.
- `strong ...`: rebuild the prose more aggressively while preserving every fact.
- `voice <file> ...`: read the sample file first, then match that voice.
- `--lang en` / `--lang ko`: force the language instead of auto-detecting it.

If the user passes a file path, read the file and return the humanized result. Do not modify files unless the user explicitly asks.
