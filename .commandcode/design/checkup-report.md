# Checkup report — Factory Console

Surface: `ui-app/src/App.tsx`. Vitals only; prescriptions in [review-report.md](review-report.md).

| Vital | Score | Evidence |
|---|---|---|
| Hierarchy | **Yellow** | View title, panel title and table content were all 12-13px with no weight contrast, so the eye had no entry point. |
| Density | **Green** | Operator-density tables, 7-8px row padding, no decorative whitespace. |
| Colour discipline | **Yellow** | Clay brand plus an invented amber for notices; links used the theme's blue accent, a third hue. |
| Type system | **Red** | No scale. 10, 11, 12, 13, 14 and 20px all in play with no rule binding them. |
| State coverage | **Yellow** | Empty states existed but named nothing. Hover existed. Focus relied on the browser default. No loading state on Fleet or Gate fetch. |
| Responsive | **Green** | Single-column shell below 760px, drawer rail, sticky composer. |
| Access | **Yellow** | Status carried by colour alone in chips; table row actions were keyboard reachable but with no visible focus treatment beyond the UA default. |

## Critical

None. Nothing blocked shipping.

## Prescriptions applied

1. Named the type scale and removed the 20px number.
2. Replaced colour-only status with dot plus word.
3. Made empty states say what belongs in the space and what fills it.
4. Dropped the third hue so notices use the brand tint.

## Left open

- No skeleton or spinner while `/api/crews` and `/api/gate` are in flight; the
  previous values stay on screen instead, which is quiet but can look stale.
- Focus is still the browser default. Worth a dedicated `a11y` pass.
