# Self-hosted typefaces

`Inter`, `Archivo` and `JetBrains Mono`, latin + latin-ext subsets of the
variable builds. Served from this origin, declared in `/fonts.css`, preloaded
by `index.html`.

Why self-hosted: a `fonts.googleapis.com` stylesheet makes every visitor
contact a third party (IP + User-Agent) before the site has even painted, and
it forces an extra host into the Content-Security-Policy. Both are gone now —
`font-src 'self' data:` and no external font request.

| File | Family | Subset | Covers |
| --- | --- | --- | --- |
| `Inter-latin.woff2` | Inter | latin | body copy, U+0000–00FF |
| `Inter-latin-ext.woff2` | Inter | latin-ext | extended Latin (driver names, accents) |
| `Archivo-latin.woff2` | Archivo | latin | `.display` headings |
| `Archivo-latin-ext.woff2` | Archivo | latin-ext | extended Latin headings |
| `JetBrainsMono-latin.woff2` | JetBrains Mono | latin | `.eyebrow`, `.mono`, timing figures |
| `JetBrainsMono-latin-ext.woff2` | JetBrains Mono | latin-ext | extended Latin mono |

Each file is a **variable** font, so one file per family per subset serves every
weight the stylesheets request (400–950) — no synthetic bold, no per-weight
downloads. `font-display: swap` keeps first paint immediate.

Regenerate (only needed when adding a family or a weight range):

```bash
node scripts/fetch-fonts.js
```

Netlify caches `/assets/*` for a day, so these are fetched once per visitor.
