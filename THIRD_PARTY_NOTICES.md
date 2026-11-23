# Third-party notices

This project is licensed under the GNU Affero General Public License, version 3 (see
[LICENSE](LICENSE)). The files below are bundled in this repository and keep their own terms.

## Inter (typeface)

- Files: `static/fonts/inter/InterVariable.woff2`, `static/fonts/inter/InterVariable-Italic.woff2`
- Source: the Inter project, https://github.com/rsms/inter (version 4.1, variable font)
- Copyright (c) 2016 The Inter Project Authors
- Licence: SIL Open Font License, Version 1.1. The full text ships next to the fonts in
  [`static/fonts/inter/LICENSE.txt`](static/fonts/inter/LICENSE.txt).

The fonts are served unmodified as web fonts by the app (declared in `src/app.css`).

## Icon set

- Files: [`src/lib/icons/glyphs.ts`](src/lib/icons/glyphs.ts), rendered by
  `src/lib/components/Icon.svelte`
- Source: drawn for this project. It is not taken from an icon library.
- Licence: part of this project, under the same GNU Affero General Public License, version 3.

## npm dependencies

Packages installed from npm (listed in `package.json` and `package-lock.json`) are not bundled in
this repository; each carries its own licence in its package. For example, the block editor,
`@digisavvy/block-editor`, is published under the MIT licence.
