# Bundled webfonts

Both faces are licensed under the **SIL Open Font License 1.1** (`OFL.txt`, which
carries both copyright notices), not under the repository's MIT licence, and are
committed to this repository on purpose: the console is served by its own local
server on 127.0.0.1 with a CSP that forbids remote loads (`font-src 'self'`), and
it works offline, so a font that is fetched from the network at runtime is a font
that never arrives.

| Face | Role | Upstream |
|---|---|---|
| Zen Kaku Gothic New (400, 700) | Japanese UI text, headings, labels | <https://github.com/googlefonts/zen-kakugothic> — Copyright 2022 The Zen Kaku Gothic Project Authors |
| M PLUS 1 Code (400, 500) | Terminal labels, paths, counts, ids (Latin only) | <https://github.com/coz-m/MPLUS_FONTS> — Copyright 2021 The M+ FONTS Project Authors |

`fonts.css` carries the `@font-face` rules with the upstream `unicode-range`
splits intact, so a screen of Japanese pulls only the subsets it actually needs.
M PLUS 1 Code keeps only the `latin` / `latin-ext` / `vietnamese` subsets — it
sets ASCII identifiers and never Japanese, and its ~116 CJK subsets would be
2.7 MB of dead weight.

Regenerate with `node tools/fetch-fonts.mjs` from `ui/` (needs network; the
output is what ships).
