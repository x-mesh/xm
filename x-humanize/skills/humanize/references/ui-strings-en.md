# English UI String Rules (`ui` mode)

Rule set for `humanize ui` when the target language is English. Targets are short
strings shown as-is in app and web screens and in CLI output. Run the meaning pass
in `ui-meaning.md` first; this file decides form.

Prose patterns (`patterns-en.md`) remove signs of AI writing. This file removes
signs of copy written from the implementation outward: vague names, filler,
inconsistent casing, and errors that do not say what to do.

## Role

Edit, do not redesign. Keep the meaning and change only the wording. Do not add a
condition, warning, or side effect the source and its evidence do not state.

## Input and output

Input and output follow the JSON contract in `ui-strings-ko.md`, with `en` as the
edited field. `type` and `context` are optional; when `type` is missing, infer it
from the `key` and say so in `note`. Use E codes from this file and M codes from
`ui-meaning.md` in `rules`. Group items by `key` prefix minus the last segment, as
the Korean file defines, and judge E1-2 and E1-4 inside a group. Judge terminology
across the whole input (`Term inventory` in `ui-meaning.md`).

`loc` and `group` are optional and come with file or screen input. Do not invent
a `key` the source lacks. Every edited item cites at least one code: E codes, M
codes, `G-P` for a name chosen in the term inventory, and `O-1` for spelling,
spacing, and punctuation that do not change meaning. List `O-1` edits last, and
group a repeated deviation into one row with a count. For file or screen input,
answer with the report defined in `ui-meaning.md` instead of the array.

## Principles

1. **A label names, a description explains.** A toggle label names the setting.
   What happens when it is on belongs to the description.
2. **Buttons say the action.** Use the verb that happens on click (`Delete`,
   `Save draft`), not a generic `OK` or `Submit`, unless the dialog only
   acknowledges information.
3. **Keep implementation words inside.** `coordinator`, `peer`, `daemon`, `socket`,
   `mirror`, and `pane` are design words. Name what the user sees.
4. **One casing per product.** Follow the project's existing convention. If none is
   visible, use sentence case.
5. **Errors say what failed and what to do next.** No blame, no `Oops`.

## Rules by type

| type | Form | Length | Period |
|------|------|--------|--------|
| `section_header` | Noun phrase | ≤ 3 words | No |
| `toggle_label` | Noun phrase or short verb phrase that names the state (`Clipboard history`, `Show hidden files`) | ≤ 5 words | No |
| `select_label` | Noun phrase | ≤ 4 words | No |
| `select_option` | Noun phrase. Do not repeat the label's words | ≤ 3 words | No |
| `desc` | Complete sentence, present tense | ≤ 2 sentences | Yes |
| `button` | Verb or verb + object (`Save`, `Try again`, `Delete workspace`) | ≤ 3 words | No |
| `menu_item` | Verb phrase or noun. Append `…` when it opens a dialog that needs input (`Save As…`) | ≤ 4 words | No |
| `dialog_body` | Complete sentences. Imperative allowed | ≤ 2 sentences | Yes |
| `empty_state` | One sentence for the situation + one for the next action | 2 sentences | Yes |
| `error` | What failed + what to do. CLI errors too | ≤ 2 sentences | Yes |
| `cli_help` | Follow the tool's existing style. Default: lowercase verb phrase (`show current status`) | One line, ≤ 50 chars | No |
| `cli_progress` | `<Verb>ing <object>…` (`Syncing with remote…`) | One line | No |
| `cli_done` | `<Past participle> <object>` or `<Object> <past participle>`, optionally with a value (`Saved {path}`) | One line | No |
| `table_header` | Name of the value the column holds. Noun phrase | — | No |
| `tab` | Name of what the tab collects. Noun phrase | — | No |
| `badge` | State name. One form for all states shown in the same place (`Pending`, `Done`, `On hold`) | — | No |
| `tooltip` | Complete sentence. Do not repeat words already on screen | ≤ 2 sentences | Match only the other tooltips on the same screen. Leave them when they agree. Follow the majority when they differ |
| `legend` | What the mark stands for. Noun phrase, one notation per legend | — | No |
| `placeholder` | Name or example of what to type. Noun phrase | — | No |
| `notification` | Read outside the app. Say what happened and how many first; use the screen's terms | — | Yes for sentences |

Length and sentence limits are targets. Do not cut meaning or join unrelated facts
to meet one; record the overrun in `note`.

A dropdown description states what the setting decides, not what one option does.

## E1 — always fix

| Code | Pattern | Example | Fix |
|------|---------|---------|-----|
| E1-1 | Toggle or select label is a sentence or instruction | `Allow the app to save copied text to the paste shelf` | Name it: `Clipboard history` |
| E1-2 | Label and description or options repeat each other | Label `Session restore` + option `Restore previous session` | Options `Restore` / `Start fresh` |
| E1-3 | Implementation term exposed | `Mirror peer workspaces` | `Show workspaces from other computers (read-only)` |
| E1-4 | Mixed casing or mixed endings in one group | `Save Draft` next to `Delete workspace` | One convention |
| E1-5 | Filler: `Please`, `Simply`, `Just`, `Click here`, `Note that` | `Please click here to retry` | `Try again` |
| E1-6 | `successfully` or `has been` in a status | `File has been saved successfully.` | `File saved` |
| E1-7 | Error without the failed object or next step | `An error occurred.` | `Couldn't save settings. Check disk space and try again.` |
| E1-8 | Generic button where the action is specific | `OK` on a delete confirmation | `Delete` |
| E1-9 | Dropdown description covers only one option | `Opens new tabs next to the current tab` | Describe the setting |
| E1-10 | Three dots instead of an ellipsis in progress or menu items | `Loading...` | `Loading…` |

E1-2 keeps the word that tells a label apart from its siblings, even when the
description repeats it. E1-3 also covers names only the team knows, such as an
incident nickname or an internal code name; flag them when the replacement is
unknown.

## E2 — fix when repeated in a group

| Code | Pattern | Fix |
|------|---------|-----|
| E2-1 | `in order to`, `allows you to`, `enables you to`, `is able to` | Direct verb |
| E2-2 | `utilize`, `functionality`, `leverage` | `use`, `feature`, or the actual verb |
| E2-3 | Noun stacks of 4+ words (`workspace notification order setting`) | Add a preposition or verb |
| E2-4 | `your` / `the user's` on every string | Drop where the owner is obvious |
| E2-5 | Parenthetical abbreviations or duplicated terms | Keep the term users know |
| E2-6 | Every description starts with `This setting` / `This option` | Start with the effect |

## Do not touch

- Product names and proper nouns (`term-mesh`, `Command Palette`)
- Shortcuts (`Cmd+Q`, `Ctrl+Shift+P`)
- Environment variables, file paths, CLI flags, code identifiers
- Numbers, durations, units (`7 days` stays `7 days`)
- Placeholders (`{count}`, `{name}`, `%@`, `%1$s`). Rewrite around plural forms
  instead of writing `item(s)`.

## Glossary

Read `.xm/ui-glossary.json` first; an entry's `en` value overrides the defaults.
Pick one word per concept and keep it across screens. This table is only a
start: build the term inventory from the input, and record a name chosen there
as `G-P`.

| Code | Concept | Use | Note |
|------|---------|-----|------|
| GE-1 | enable / disable | `Turn on` / `Turn off` in descriptions; the setting name alone in labels | Do not mix with `activate` |
| GE-2 | delete / remove | `Delete` destroys; `Remove` takes out of a list | Do not swap them |
| GE-3 | sign in / log in | One pair per product | |
| GE-4 | settings / preferences | One word per product | |
| GE-5 | cancel / close | `Cancel` abandons a change; `Close` dismisses a view | |
| GE-6 | retry / try again | One word per product | Two words for one action read as two actions |

## Reference examples

| before | after | rules |
|--------|-------|-------|
| `Compare with single agent` (run-mode option; nothing is compared) | `Single agent` | M-2 |
| `Next thing your service needs` (textarea for the request) | `Request` | M-1 |
| `Boundaries of autonomous execution` (box listing what the user decides) | `What you decide` | M-4 |
| `Please click here to try again.` (`button`) | `Try again` | E1-5 |
| `Settings have been saved successfully.` (`cli_done`) | `Saved settings` | E1-6 |
| `Retry` (`button`) | `Retry` | none — already clear |
| `Max attempts` (`select_label`) | `Max attempts` | none — already clear |

## Self-check

- [ ] The meaning pass ran first and its self-check passed.
- [ ] `after` adds no behavior or condition the evidence does not state.
- [ ] Numbers, shortcuts, environment variables, and placeholders are unchanged.
- [ ] Buttons name the action; status lines contain no `successfully`.
- [ ] One casing convention per group.
- [ ] Already-clear strings are unchanged with empty `rules`.
- [ ] Every edited item cites a code, and no label lost the word that tells it apart.
- [ ] Array input: the output is one bare JSON array with no prose or code fence.
  File or screen input: the report, opening with the statement that no file was changed.
