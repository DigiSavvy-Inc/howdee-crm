# Design notes

How the app's interface is put together, and the rules for new UI. The tokens below are the ones
defined in [`src/app.css`](../src/app.css); that file is the source of truth, so when it and this
page disagree, the CSS wins and this page needs an update.

## How styling works

- Global **tokens** (CSS custom properties) and base element styles live in `src/app.css`.
- Each component carries its own **scoped `<style>`** and uses tokens by name. Don't write raw
  hex colours, pixel sizes or shadows in a component when a token exists.
- Two layers of names:
  - **Foundation tokens**: the palette (`--color-*`, `--neutral-*`, status colours), spacing,
    type, radii, shadows, motion.
  - **App aliases** on top (`--bg`, `--surface`, `--text`, `--muted`, `--border`, `--accent`,
    `--link`, `--danger`, `--btn-primary-bg`, ...). Prefer an alias when one fits the role, so a
    future palette change lands in one place.
- **Light is the default.** Dark mode follows the operating system unless the user forces a mode
  (`data-theme="light"` or `"dark"` on `<html>`). The dark values are declared twice in
  `app.css` (system and manual); keep the two blocks identical. Only raw values and a few aliases
  change in dark mode; derived tokens resolve from them.

## Colour

Palette, light mode (dark-mode values in `app.css`):

| Token | Light | Use |
| --- | --- | --- |
| `--color-1` | `#1a9ec4` | The accent: focus outline, link underline, nav underline, checked controls |
| `--color-2` … `--color-4` | `#bdc8ea`, `#b7d4cc`, `#e8c7ab` | Secondary accents |
| `--neutral-1` … `--neutral-10` | `#ffffff` → `#1f1f1f` | Surfaces (low numbers) to text (high numbers) |
| `--success` | `#247052` | State only |
| `--warning` | `#926318` | State only |
| `--error` | `#b34846` | State only |

Every palette colour has a `-transparent` twin: the same colour at 20% (`--color-1-transparent`,
`--success-transparent`, ...). Use those for tints.

The roles you will reach for most:

| Alias | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | neutral-2 | neutral-1 | Page background |
| `--surface` | neutral-1 | neutral-2 | Cards, popovers, dialogs, toasts |
| `--surface-subtle` | neutral-2 | neutral-3 | Table headers, quiet fills |
| `--text` | neutral-10 | neutral-10 | Body text |
| `--muted` | neutral-7 | neutral-7 | Secondary text |
| `--border`, `--border-muted` | neutral-4, neutral-3 | same tokens | Dividers and outlines |
| `--accent` | color-1 | color-1 | Accent marks (not text on white) |
| `--danger`, `--warn` | error, warning | same tokens | Status |
| `--btn-primary-bg` | `#147793` | `#147793` | Solid primary fills, with `--btn-primary-text` (white) |
| `--backdrop` | neutral-10 at 20% | neutral-1 at 20% | Behind dialogs and drawers |

Contrast rules, already built into the tokens (WCAG AA):

- `--color-1` is too light for white text on it or for text on white. So **links are body-colour
  text with a `--color-1` underline** (1px, 2px on hover), and **solid primary buttons use the
  darker `--btn-primary-bg`**, not `--accent`. Text on a solid `--color-1` fill uses
  `--accent-text`.
- **Status colours are never text on their own tint.** A status badge keeps body text and shows
  the state as a tint plus a full-colour edge; the label carries the meaning.
- Check contrast for any new pairing you introduce, in light and dark.

**Charts** use their own sequential ramp, `--viz-1` (most) to `--viz-3` (least), with separate
dark-mode steps. Status colours are never a series colour, and any chart with two or more series
has a visible legend so colour is never the only cue.

## Type

One family: **Inter** (variable, bundled under `static/fonts/inter/`, see
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)). There is **no serif** anywhere in the app.
Font roles all point at the same family so they can diverge later without touching components:

| Role | Token | Weights |
| --- | --- | --- |
| Interface | `--font-ui` | `--weight-ui-regular` 400, `-medium` 500, `-heavy` 600 |
| Headings | `--font-brand` | 400 / 500 / 700 |
| Long-form text | `--font-editorial` | 400 / 500 / 700 |
| Tables and numbers | `--font-data` | 400 / 500 / 600 |
| Code | `--font-mono` | system monospace stack |

Text steps (size / line height):

| Step | Size | Line | Typical use |
| --- | --- | --- | --- |
| `xxs` | 10px | 14px | Tiny labels |
| `xs` | 12px | 15px | Badges, table headers, captions |
| `s` | 14px | 19px | Controls, tables, notices |
| `m` | 15px | 23px | Body (the page default) |
| `l` | 23px | 31px | Section titles |
| `xl` | 35px | 39px | Page titles |
| `xxl` | 46px | 50px | Display |

Use them as `font-size: var(--size-s); line-height: var(--line-s);` and pair with the matching
`--letter-spacing-<step>`. A separate `--tracking-xs` … `--tracking-xl` scale exists for small
adjustments (buttons use `--tracking-l`). On phones (≤ 768px) form fields are forced to 16px so iOS
does not zoom into them.

## Spacing

| Token | Value |
| --- | --- |
| `--space-zero` | 0px |
| `--space-xxs` | 4px |
| `--space-xs` | 7px |
| `--space-s` | 11px |
| `--space-m` | 15px |
| `--space-l` | 22px |
| `--space-xl` | 29px |
| `--space-xxl` | 44px |

Cards pad with `--card-pad` (`--space-m` vertical, `--space-l` horizontal) and stack with
`--card-gap` (`--space-l`). Use the scale; don't invent in-between values.

## Radius

| Token | Value | Where it is used |
| --- | --- | --- |
| `--radius-xs` | 5px | |
| `--radius-s` | 9px | Buttons, fields, notices (alias `--radius`) |
| `--radius-m` | 13px | Cards, stat groups (alias `--radius-lg`) |
| `--radius-l` | 19px | |
| `--radius-xl` | 29px | |
| `--radius-full` | 9999px | Badges and pills |

## Edges and shadows

Edges are drawn with **box-shadow, not `border`**, so they never change an element's size:

- `--border-shadow-s` / `-m` / `-l`: a hairline ring in `--border-default-color`. Outside the box
  in light mode, inset in dark mode.
- Elevation, smallest to largest: `--shadow-s` (cards, stat groups, button hover), `--shadow-m`,
  `--shadow-l`. Raise floating layers higher than the cards beneath them. Dark mode has its own
  shadow values.
- A card is `--border-shadow-s` plus `--shadow-s` on `--surface` with `--radius-m`.

## Motion and focus

- `--motion-duration` (160ms) for controls, menus and popovers; `--motion-large-duration` (280ms)
  for dialogs, drawers, toasts and navigation. Both use the same ease-out curve.
- `prefers-reduced-motion: reduce` turns transitions and animations off globally. Don't work around
  it.
- Keyboard focus is a 2px `--color-1` outline with a 2px offset (no offset on fields); buttons
  and fields add `--focus-halo`. Never remove the outline without a visible replacement.

## Base elements and shared classes

`app.css` styles plain elements, so most markup needs no classes:

- `<button>` is the primary button. `.secondary` is a light accent tint; `.danger` is the
  destructive fill. Disabled buttons go grey.
- `<input>`, `<select>`, `<textarea>` get the field look, an error ring on `aria-invalid="true"`
  or `:user-invalid`, and a read-only and disabled state.
- `<table>` uses the data font and hairline row dividers; wrap wide tables in `.table-wrap` so they
  scroll inside their own box instead of the page.
- `.card`, `.card.danger-soft`, `.badge` (with `.sent`, `.sending`, `.failed`, `.draft`), `.muted`.
- `.notice`, `.notice.ok`, `.notice.warn`, `.notice.err`: the one notice box. Keep `role="status"`
  or `role="alert"` on it. If there is nothing to act on, a plain `.muted` line is enough.
- Links inside navigation, tabs, pills and buttons-as-links are listed in `app.css` to drop the
  underline; add a new UI link class there rather than overriding it locally.

## Shared components

Reuse these before writing a new one (all in `src/lib/components/`):

- `StatGroup` + `StatCell`: a row of numbers as one card split by dividers. It reflows by its own
  width.
- `BulkBar`: the selection bar for tables with checkboxes.
- `Modal`: dialogs. `StickyActions`: Save / Preview on long editor forms.
- `Breadcrumbs`: the trail on detail pages.
- `SearchSelect`: a searchable picker. `ColorField`: a colour input with swatches and a contrast
  warning.
- `Icon`: every icon. `SortCaret`: sortable column headers.

## Icons

- One icon set, in `src/lib/icons/glyphs.ts`, rendered by `Icon.svelte`: a 24px grid, stroke only,
  round caps and joins, `currentColor`.
- Sizes 16, 20, 24 and 32. The stroke is 1.5 at 16px, 1.75 at 20 and 24px, 2 at 32px.
- Icons are decorative (`aria-hidden`) unless you pass `label`. Give a `label` only to an
  icon-only control that has no `aria-label` of its own.
- Need a new icon? Draw it in the same style and add it to `glyphs.ts`; only `path`, `circle`,
  `rect`, `line`, `polyline` and `polygon` elements are allowed (a test checks this).
- **No emoji, dingbats or decorative Unicode shapes in the interface.** A test scans `src/` for
  them.

## House rules for new UI

1. **Tokens, not literals.** Colours, spacing, radii, shadows, type and motion come from
   `app.css`. If you truly need a new token, add it there (with its dark-mode value) instead of
   hard-coding it in a component.
2. **Match an existing page first.** Lists, detail pages and editors already have patterns (the
   contacts list, a contact page, a campaign page). Copy their structure before inventing one.
3. **Accessible by default.** Real buttons and links, labels on every field, visible focus,
   keyboard paths for every action (including anything you can drag), AA contrast in both modes.
4. **Works on a phone.** Layouts reflow at 768px; wide content scrolls in its own box; touch
   targets are comfortable; drag-and-drop always has a button alternative.
5. **One way to say a state.** Status uses the badge or notice classes and the status colours,
   never a one-off box or colour.
6. **Calm and plain.** Neutral surfaces, one accent, little decoration. Copy is short, specific
   and sentence case.
7. **Check light and dark** before you call it done.
