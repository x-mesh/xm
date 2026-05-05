# English AI Writing Patterns

English pattern catalog adapted from Wikipedia's "Signs of AI writing" (WikiProject AI Cleanup) via `blader/humanizer` (MIT), with x-mesh additions for agent-era prose.

Severity guide:
- **High** — instantly reads as AI; always rewrite.
- **Medium** — noticeable; rewrite unless context demands it.
- **Low** — minor tic; rewrite if dense in the text.

## Content Patterns

### EN-1 — Significance inflation (High)
**Watch:** stands/serves as, testament/reminder, vital/significant/crucial/pivotal/key role, underscores/highlights importance, reflects broader, symbolizing ongoing/enduring/lasting, marking/shaping the, key turning point, evolving landscape, focal point, indelible mark, deeply rooted.

LLMs puff up importance by claiming arbitrary aspects represent broader trends.

- Before: "established in 1989, marking a pivotal moment in the evolution of regional statistics"
- After: "established in 1989 to collect regional statistics independently from Spain's national office"

### EN-2 — Notability name-dropping (Medium)
**Watch:** independent coverage, local/regional/national media outlets, written by a leading expert, active social media presence.

- Before: "cited in The New York Times, BBC, Financial Times, and The Hindu"
- After: "In a 2024 NYT interview, she argued that AI regulation should focus on outcomes."

### EN-3 — Superficial -ing analyses (High)
**Watch:** highlighting/underscoring/emphasizing, ensuring, reflecting/symbolizing, contributing to, cultivating/fostering, encompassing, showcasing.

- Before: "blue, green, and gold resonates with regional beauty, symbolizing bluebonnets, reflecting community connection"
- After: "blue, green, and gold colors. The architect chose these to reference local bluebonnets and the Gulf coast."

### EN-4 — Promotional/advertisement language (High)
**Watch:** boasts a, vibrant, rich (figurative), profound, enhancing its, exemplifies, commitment to, natural beauty, nestled, in the heart of, groundbreaking (figurative), renowned, breathtaking, must-visit, stunning.

- Before: "Nestled within the breathtaking region, [town] stands as a vibrant town with rich cultural heritage"
- After: "[Town] is in the Gonder region, known for its weekly market and 18th-century church."

### EN-5 — Vague attributions / weasel words (High)
**Watch:** Industry reports, Observers have cited, Experts argue, Some critics argue, several sources/publications.

- Before: "Experts believe it plays a crucial role in the regional ecosystem."
- After: "supports several endemic fish species, according to a 2019 survey by the Chinese Academy of Sciences."

If the source has no citation, do not invent one — flag "(source needed)".

### EN-6 — Formulaic challenges/future sections (Medium)
**Watch:** Despite its... faces several challenges, Despite these challenges, Challenges and Legacy, Future Outlook.

- Before: "Despite challenges typical of urban areas, [town] continues to thrive"
- After: "Traffic congestion increased after 2015 when three new IT parks opened. The municipal corporation began a stormwater drainage project in 2022."

## Language and Grammar Patterns

### EN-7 — AI vocabulary words (High)
**High-frequency:** Actually, additionally, align with, crucial, delve, emphasizing, enduring, enhance, fostering, garner, highlight (verb), interplay, intricate, key (adj), landscape (abstract), pivotal, showcase, tapestry, testament, underscore (verb), valuable, vibrant.

These cluster — finding 2+ in one paragraph is a strong AI signal.

- Before: "an enduring testament to Italian colonial influence is the widespread adoption of pasta in the local culinary landscape"
- After: "Pasta dishes, introduced during Italian colonization, remain common, especially in the south."

### EN-8 — Copula avoidance (High)
**Watch:** serves as / stands as / marks / represents [a], boasts / features / offers [a].

- Before: "Gallery 825 serves as LAAA's exhibition space and boasts over 3,000 sq ft."
- After: "Gallery 825 is LAAA's exhibition space. It has 3,000 sq ft across four rooms."

### EN-9 — Negative parallelisms / tailing negations (High)
**Watch:** "Not only X, but Y", "It's not just X, it's Y", trailing fragments like ", no guessing" or ", no wasted motion".

- Before: "It's not just about the beat; it's part of the aggression."
- After: "The heavy beat adds to the aggressive tone."
- Before: "The options come from the selected item, no guessing."
- After: "The options come from the selected item — the user does not have to guess." (or rewrite without trailing fragment)

### EN-10 — Rule of three (Medium)
LLMs force ideas into groups of three.

- Before: "The event features keynote sessions, panel discussions, and networking opportunities."
- After: "The event includes talks and panels, with informal networking between sessions."

Three is fine when the source actually has three things. The pattern is when the count is forced.

### EN-11 — Synonym cycling / elegant variation (Medium)
LLMs substitute synonyms to avoid repetition penalties, producing protagonist → main character → central figure → hero in four sentences.

- Before: "The protagonist faces challenges. The main character must overcome obstacles. The central figure triumphs."
- After: "The protagonist faces many challenges but eventually triumphs."

### EN-12 — False ranges (Medium)
"From X to Y" where X and Y are not on a meaningful scale.

- Before: "from the Big Bang to dark matter, from black holes to galaxy formation"
- After: "covers the Big Bang, star formation, and current theories about dark matter."

### EN-13 — Passive voice / subjectless fragments (Medium)
- Before: "No configuration file needed. Results are preserved automatically."
- After: "You do not need a configuration file. The system preserves results automatically."

## Style Patterns

### EN-14 — Em-dash overuse (High)
LLMs use em-dashes to mimic punchy sales writing.

- Before: "promoted by Dutch institutions—not by the people—yet this continues—even in official documents"
- After: "promoted by Dutch institutions, not by the people, yet this continues in official documents."

Em-dashes survive in dialogue, true asides, or when the user's voice sample uses them.

### EN-15 — Boldface overuse (Medium)
- Before: "blends **OKRs**, **KPIs**, and **BMC**"
- After: "blends OKRs, KPIs, and the Business Model Canvas"

### EN-16 — Inline-header lists (High)
- Before:
  - **Performance:** Performance improved.
  - **Security:** Security strengthened with encryption.
- After: "The update speeds up load times and adds end-to-end encryption."

### EN-17 — Title Case headings (Low)
- Before: "Strategic Negotiations And Partnerships"
- After: "Strategic negotiations and partnerships"

### EN-18 — Emojis as bullet markers (Medium)
- Before: "🚀 Launch Phase: 💡 Key Insight:"
- After: "Launch phase. Key insight:"

Skip if the user's voice sample uses emojis.

### EN-19 — Curly quotes inserted by AI (Low)
Smart quotes inserted into otherwise technical text. Match source convention.

### EN-26 — Hyphenated word-pair overuse (Medium)
**Watch:** cross-functional, data-driven, client-facing, customer-centric, end-to-end, world-class.

- Before: "cross-functional, data-driven, client-facing teams"
- After: "teams that work across functions and rely on data" (or drop the hyphens)

### EN-27 — Persuasive authority tropes (Medium)
**Watch:** "At its core,", "What truly matters is", "The reality is".

- Before: "At its core, what matters is collaboration."
- After: "Collaboration matters."

### EN-28 — Signposting announcements (Medium)
**Watch:** "Let's dive in", "Here's what you need to know", "Without further ado".

- Before: "Let's dive in. Here's what you need to know about caching."
- After: "Caching matters because…" (start with the content)

### EN-29 — Fragmented headers (Low)
- Before: "## Performance" + "Speed matters."
- After: Let the heading do the work, or merge into prose.

## Communication Patterns

### EN-20 — Chatbot artifacts (High)
**Watch:** "I hope this helps!", "Let me know if you have questions", "Feel free to ask".
Remove entirely.

### EN-21 — Cutoff/availability disclaimers (High)
**Watch:** "While details are limited in available sources", "Based on my training data".
Find sources or remove.

### EN-22 — Sycophantic tone (High)
**Watch:** "Great question!", "You're absolutely right!", "What an interesting topic!".
Respond directly without flattery.

## Filler and Hedging

### EN-23 — Filler phrases (Medium)
- "In order to" → "To"
- "Due to the fact that" → "Because"
- "At this point in time" → "Now"
- "In the event that" → "If"

### EN-24 — Excessive hedging (Medium)
- Before: "could potentially possibly be considered"
- After: "may be" (or drop the hedge entirely if certain)

### EN-25 — Generic conclusions (High)
- Before: "The future looks bright. Exciting times lie ahead."
- After: Specific plans, dates, or outcomes — or remove the conclusion.

### EN-30 — Balanced-but-empty conclusions (Medium)
**Watch:** "opportunities and challenges", "balance innovation with responsibility", "a nuanced approach is needed", "only time will tell".

The sentence sounds thoughtful but makes no concrete judgment.

- Before: "AI agents present both opportunities and challenges, so teams need a balanced approach."
- After: "Use agents for reversible work first. Keep approvals on deploys, permission changes, and data deletion."

### EN-31 — Over-smoothed paragraph rhythm (Medium)
Every paragraph opens with context, gives three points, then lands on a tidy conclusion. Humans often leave a rough edge: a caveat, a sharper claim, a shorter sentence, or a concrete next step.

- Before: "This shift is important because it improves speed, consistency, and collaboration. As a result, teams can work more effectively."
- After: "This mostly saves review time. The collaboration story is less clear until teams decide who owns the agent's output."
