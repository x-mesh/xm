# Voice Calibration

How to analyze a writing sample and reproduce its voice in the rewrite.

## When to use

- User provides 2-3 paragraphs of their own writing alongside text to humanize
- User points to a file ("use my style from `notes.md`")
- User explicitly asks "match my voice" / "내 문체에 맞춰서"

If no sample is provided, fall back to the default PERSONALITY pass in SKILL.md Step 4.

## Analysis checklist

Read the sample first. Note these dimensions:

### 1. Sentence rhythm
- Average length (count characters or words)
- Variance (do they mix 5-word sentences with 30-word sentences?)
- Sentence shape (subject-led, fragment-led, question-led?)

Record as a range, not an average. "10-45 words, mostly 15-25" beats "average 22 words".

### 2. Word choice level
- Casual ("stuff", "thing", "kind of") vs academic ("element", "component", "approximately")
- Korean: 한자어 vs 고유어 비율, 영어 단어 직접 사용 여부
- Slang or jargon density

### 3. Paragraph openings
- Jump straight into content?
- Set context first?
- Start with a question or claim?
- Use transitional connectors ("So,", "But,", "한편,") or skip them?

### 4. Punctuation habits
- Em-dash count per 100 words
- Parenthetical aside frequency
- Semicolon usage (rare in human writing — heavy semicolons are an AI signal even in samples)
- Korean: ~네, ~지, ~거든, ~잖아 같은 어말 어미 빈도

### 5. Recurring phrases / verbal tics
- Words that appear 3+ times in the sample
- Distinctive openers ("Look,", "그러니까,", "Honestly,")
- Personal pronouns ("I", "we", or impersonal)

### 6. Transition style
- Explicit connectors ("therefore", "however") vs implicit (just start the next point)
- Korean: "그래서", "근데", "그러면" 같은 구어체 vs "따라서", "그러나" 격식체

### 7. Korean-specific
- Sentence-ending register: ~다 (plain) / ~요 (polite) / ~습니다 (formal) / ~지 (casual) / ~네 (interactive)
- 반말/존댓말 일관성

## Application rules

### Match, do not upgrade

If the sample uses casual register, the rewrite must use casual register. Common failures:
- Sample says "stuff" → rewrite says "elements" (FAIL — upgraded)
- Sample says "근데" → rewrite says "그러나" (FAIL — formalized)
- Sample writes 8-word fragments → rewrite produces 25-word complete sentences (FAIL — smoothed)

### Match sentence-length variance

If sample variance is high (some short, some long), produce high variance. If sample variance is low (all medium), do not artificially inject short fragments.

Target: rewrite's sentence-length variance within ±20% of sample's.

### Replace AI patterns with sample patterns

Do not just delete AI patterns. Replace with what the sample would have written.

Example:
- Source AI text: "It's not just about speed; it's about reliability."
- Sample uses casual register with short sentences.
- Bad rewrite: "Speed and reliability both matter." (deleted pattern but generic)
- Good rewrite: "Yeah, fast. But also doesn't crash." (matches sample voice)

### Korean voice calibration extras

- Match the sample's 어말 어미 distribution. If sample uses ~지 / ~거든 mix, do not output only ~다 endings.
- Match Sino-Korean vs native ratio. If sample says "쓰다" not "사용하다", rewrite says "쓰다".
- If sample omits subjects, the rewrite omits subjects.

## Failure modes

- **Over-fitting** — copying the sample's exact phrasing into the rewrite. Match patterns, not words.
- **Cherry-picking** — fixating on one feature (e.g., em-dashes) and ignoring others (e.g., sentence length).
- **Tonal mismatch** — applying sample's casual voice to text whose content is technical reference. Voice and register can mismatch when content demands; check before forcing.
- **Sample too short** — fewer than 2 paragraphs is not enough signal. Ask the user for more, or fall back to default voice.

## Output note (developer mode)

When voice calibration is used, append to the rewrite output:

```
**Voice features matched:**
- Sentence length: short (5-10 words) mixed with mid (20-30 words)
- Register: casual, occasional fragments
- Recurring openers: "Look,", "Honestly,"
- Punctuation: minimal em-dashes, frequent commas
```

This shows the user what was matched and lets them correct the calibration if needed.
