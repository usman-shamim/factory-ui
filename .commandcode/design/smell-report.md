# Smell report — Factory Console

Surface: `ui-app/src/App.tsx` (product register: monitor + operate)
Audited: 2026-11-16, commit `24ad732`, before the deslop pass.

| # | Smell | Severity | Location | Finding | After |
|---|---|---|---|---|---|
| 1 | Stat monument | HIGH | Fleet, `sCards` | Three 20px numbers ("2", "2", "0") filling space where a verdict belongs. A number alone proves nothing. | One capacity strip: "2 of 2 lanes free" with the reason inline. |
| 2 | Feature tile grid | HIGH | Fleet, `sCards` | Three equal bordered cards with a label, a number and a caption, no priority between them. | Strip leads with the lane verdict; crew and queue counts become muted trailing meta. |
| 3 | Equal cards, no priority | MEDIUM | Fleet | "Active lanes" and "Queued backlog" were the same bordered panel. The operator's primary surface did not outrank the backlog. | Active lanes keeps the panel; backlog becomes a borderless section beneath it. |
| 4 | Accent rail | MEDIUM | `row()` | 2px clay stripe down the selected room row simulated structure. | Selected background plus weight change, no stripe. |
| 5 | Pill chips | MEDIUM | Gate, `sOkChip`/`sWarnChip` | Rounded pills carrying state in colour alone. | Dot plus the word, so shape and text carry the state too. |
| 6 | Default type | MEDIUM | Whole surface | No scale, no weight contrast; one oversized number doing the hierarchy work. | 10/11/12/13 scale, section titles at weight 600, body at 12. |
| 7 | Third hue | LOW | `noticeBar` | Amber invented alongside the clay brand hue. | Clay tint at 14%, one accent for the whole surface. |
| 8 | Copy tics | LOW | findings message, notice | Em dashes interrupting prose; empty states that named nothing. | Full stops and colons; empty states now say what belongs there. |

## Domain default trap

A developer tool rendered as dark-plus-mono is the category reflex. Not triggered
here: the palette and component language are inherited from the Claude Design
System fork the repo is built on, so the visual direction is a deliberate
dependency choice, not a guess from the industry. No recolour pass was needed.
