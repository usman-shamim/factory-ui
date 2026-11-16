# Review report — Factory Console

Surface: `ui-app/src/App.tsx`, product register. Reviewed 2026-11-16 before the deslop pass.

## Gut reaction

Competent and trustworthy, but visibly generated in the Fleet view. The tables
look like an operator built them; the three statistic cards look like a template
did. The one thing that gave it away was three equal bordered boxes each holding a
big number, which is exactly the shape a model reaches for when asked to "show
status".

## Lenses

| Lens | Score | Note |
|---|---|---|
| First impression | 5/10 | The room stream reads as Claude, which is the point. Fleet broke the spell. |
| Hierarchy | 5/10 | No entry point. Everything sat between 11 and 13px, and the only large thing was a number with no meaning attached. |
| Colour voice | 7/10 | Clay is earned (CDS brand), amber was not. |
| Type voice | 4/10 | System stack is right for product UI; the scale was absent. |
| Interaction feel | 7/10 | Destructive action confirmed, disabled states present, optimistic notice on send. |
| Composition | 5/10 | Two identical panels in Fleet meant nothing outranked anything. |
| Copy | 6/10 | Accurate, except em dashes and empty states that named nothing. |

## The three things that mattered

1. **Fleet led with numbers instead of the verdict.** An operator opens Fleet to
   ask "can I dispatch?". The answer is a sentence, not three counters.
2. **Two equal panels.** The active lanes and the queued backlog are not peers;
   the lanes are the job, the backlog is the queue behind it.
3. **Colour doing work alone.** Initialised / not initialised was a pill in clay
   or amber. Recolouring the same pill would not have fixed it.

## Verdict

**Ship after deslop.** Nothing was broken, nothing was inaccessible enough to
block, but the Fleet composition was a category reflex and had to go.
