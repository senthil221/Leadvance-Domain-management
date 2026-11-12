# Domain Engine design system

Three scales. Every size, gap and colour in `src/app/globals.css` and the components comes from them.

## Audit: the 5 biggest hierarchy and density problems (before)

1. **Colour was decoration, not signal.** The six KPI tiles each had their own hue (blue, purple, teal, green, grey), and so did their sparklines. Needs action showed ten counts in red, amber and blue pills. The Connections hero sat on a pink gradient, the cause chips were tinted, ESPs were blue and green, and every client had its own colour. With everything coloured, the one thing actually broken (41 dead domains) looked like any other line.
2. **No type ladder.** There were 22 font sizes, from 8.5 to 48px, many only half a pixel apart (11, 11.5, 12, 12.5, 13, 13.5). Card titles ("Needs action", "Sending", "Clients") were 13px/500, the same as the rows under them, so cards didn't read as sections. Headline numbers came in four sizes (48, 26, 23, 18).
3. **Spacing had no rhythm.** Padding, margins and gaps used every value from 1 to 14px, plus 18, 20, 22 and 30. Cards side by side had different insets (10, 12, 14 and 18px), so their edges and baselines didn't line up.
4. **Too many boxes.** A floating work panel (border and shadow) held cards (border, radius and shadow, KPI tiles only). The cards held tinted chips with their own icon tiles. Three or four layers of chrome before any data, and the shadows were used unevenly.
5. **The first screen didn't lead with the work.** At 390 wide the Connections hero alone filled the first screen. Needs action came after the hero, all six KPIs, the chart and the insights. On Smartlead at 390 the toolbar stacked four rows deep before the table.

## Space

`--s-2 2` · `--s-4 4` · `--s-8 8` · `--s-12 12` · `--s-16 16` · `--s-24 24` · `--s-32 32` · `--s-48 48` (px).
1px is a hairline (borders, grid dividers), not spacing. In Tailwind classes use the 4px steps (`gap-1`, `gap-2`, `gap-3`, `gap-4`, `gap-6`, `gap-8`, `gap-12`), never the half steps.

## Type

| Token | Size / line | Use |
|---|---|---|
| `--fs-11` | 11 / 16 | axis labels, counts, eyebrows |
| `--fs-12` | 12 / 16 | meta, footnotes, secondary controls |
| `--fs-13` | 13 / 20 | body, tables, controls; card titles at 600 |
| `--fs-16` | 16 / 24 | page title, numbers inside a panel |
| `--fs-24` | 24 / 32 | headline numbers (KPI tiles) |
| `--fs-40` | 40 / 44 | the one hero number on a page |

Weights: 400 body, 500 emphasis, 600 titles and figures. In components: `text-[length:var(--fs-12)]`.

## Colour: five tokens

| Token | Light | Dark | Job |
|---|---|---|---|
| `--canvas` | `#ffffff` | `#121214` | cards, panels, text on solid fills |
| `--ink` | `#18181b` | `#ececef` | text, figures, the primary action, selection |
| `--muted` | `#6b6b74` | `#9d9da6` | secondary text, icons, quiet marks |
| `--line` | `#e4e4e7` | `#26262b` | borders, dividers |
| `--alert` | `#c4262e` | `#f0595f` | the only hue: needs you, failed, burned |

Every other colour name (`--surface-*`, `--faint`, `--brand-*`, `--success-*`, `--warning-*`, `--danger-*`, `--info-*`, `--violet-*`, `--cat-*`, shadows, focus ring) is a `color-mix` of these five. None is picked by hand.

- Healthy, in progress and resting get no hue: ink or muted.
- Warning is alert at half strength. Danger is alert at full strength.
- The primary button is ink. Chart series are steps of ink, then of alert.
- No gradients. Shadows only on floating layers (menus, popovers, sheets) and on the selected segment of a toggle.

Exception: the brand mark's colour comes from Settings (the client's logo), not from the UI tokens.
