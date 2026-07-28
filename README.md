# Iconographer

A camera-first **PWA** that reads the iconography of an artwork — a blessing gesture, a
saint's attribute, a god's emblem, an allegorical object — crops each symbol out of your
photo and explains what it means in plain English. Built to be installed on iOS via Safari's
**Add to Home Screen** and behave like a native app.

It is **symbol-first, not figure-first**: the goal is to explain each individual symbol on
its own terms, not to announce "this painting is Saint Jerome." A likely figure is offered
only as soft secondary context, and withheld whenever the evidence is thin.

## How it works

1. Open the app → the cached shell loads instantly.
2. Tap **Scan artwork** → iOS opens the rear camera directly (or pick from your library).
3. The photo is POSTed to `/api/analyze`, which asks **Google Gemini** (vision) to locate the
   concrete visual elements — each with a bounding box — returned as strict JSON. Gemini is
   explicitly told *not* to interpret meaning.
4. Each detected element is matched against a local reference set
   ([`data/symbols.json`](data/symbols.json) — 218 symbols across gestures, poses, objects,
   animals, plants, garments, colors, monograms, and scene types).
5. The frontend crops each matched symbol out of your photo using its bounding box and shows
   one card per symbol: the crop, the standalone meaning, and any figures that symbol is
   commonly associated with.
6. Anything detected but not in the reference set is listed plainly under "also detected."
   **It never invents a meaning** — every explanation comes from the reference data.

## Stack

- **Astro 5** (static app shell) + vanilla TS for interactivity
- **`@astrojs/netlify`** adapter — the shell is static; only `/api/analyze` runs as a
  serverless function (`export const prerender = false`). Chosen over Vercel because
  Netlify's free tier explicitly permits commercial use (Vercel's Hobby tier doesn't).
- **Gemini API** (`gemini-flash-lite-latest` by default, free tier) for image analysis —
  see the note in [`.env.example`](.env.example) about picking a model with actual quota
  on your Google Cloud project
- Reference data: a single JSON file (no database)

## Local development

```bash
npm install
cp .env.example .env      # then add your GEMINI_API_KEY
npm run gen:icons         # generates public/icons/* (only needed if you change the emblem)
npm run dev               # http://localhost:4321
```

Get a free Gemini key at <https://aistudio.google.com/app/apikey>. Without a key the UI still
works but analysis returns a clear "server not configured" error.

## Deploy to Netlify (free tier)

Netlify's free plan permits commercial use, unlike Vercel's Hobby plan — see the discussion
in this project's history if you're deciding between them.

**Via CLI (no GitHub needed):**

```bash
npx netlify login
npx netlify init          # links this folder to a new Netlify site
npx netlify env:set GEMINI_API_KEY "your-key-here"
npx netlify deploy --prod
```

**Via GitHub:** push this folder to a repo, then in the Netlify dashboard choose
**Add new site → Import an existing project**, pick the repo (framework: **Astro**,
auto-detected), and add `GEMINI_API_KEY` under **Site configuration → Environment variables**
before the first deploy.

Either way you get a free `*.netlify.app` HTTPS URL immediately, and can attach a custom
domain for free under **Domain management** once you own one.

## PWA / iOS specifics

- [`public/manifest.webmanifest`](public/manifest.webmanifest) — name, `short_name`,
  `start_url`, `display: standalone`, theme/background colors, and icons (192–512 + maskable).
- iOS meta tags live in [`src/layouts/Base.astro`](src/layouts/Base.astro):
  `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`,
  `apple-mobile-web-app-title`, and every `apple-touch-icon` size. `viewport-fit=cover` +
  `env(safe-area-inset-*)` make it full-bleed around the notch and home indicator.
- iOS builds the splash screen from the icon + `background_color` — no separate config needed.
- [`public/sw.js`](public/sw.js) — service worker: cache-first app shell for instant/offline
  loads, **network-only for `/api/*`** (analysis needs the network), and an offline fallback
  page. The UI also shows a graceful "you're offline" state when a scan can't reach the server.
- Capture uses `<input type="file" accept="image/*" capture="environment">` so **Scan artwork**
  opens the camera; **Choose from library** removes `capture` to open the photo picker.

## Expanding the reference set

Add entries to [`data/symbols.json`](data/symbols.json) following
[`data/symbols.schema.json`](data/symbols.schema.json):

```json
{
  "id": "kebab-case-id",
  "name": "lowercase symbol name",
  "category": "Gesture | Pose | Attribute | Object | Animal | Plant | Garment | Color | Monogram | Scene",
  "aliases": ["plain-english phrasings a vision model might return"],
  "meaning": "What this symbol means, true on its own without naming any figure.",
  "figures": [
    { "name": "Saint N", "note": "what the symbol means specifically for them" }
  ]
}
```

Two rules keep the data honest:

- **`meaning` must stand alone.** It is what the app shows first, so it has to make sense
  without knowing who is depicted. Figure-specific nuance belongs in `figures`.
- **`aliases` are what actually drive recall.** The vision model rarely returns your formal
  name — it says "hand raised in blessing," not "benediction gesture (Latin)." Add the
  phrasings you'd expect a describer to use.

### Matching behavior

Matching lives in [`src/lib/iconography.ts`](src/lib/iconography.ts) and is tiered:
exact match, then whole-word containment, then significant-word overlap. Some deliberate
properties worth knowing before you edit the data:

- **Containment is word-boundary only.** "across" must never match "cross," nor "donkey"
  match "key."
- **Generic head-nouns are non-diagnostic.** A bare `robe`, `bird`, `flower`, `tree`, `hat`,
  `fruit`, or `staff` returns *no match* — the qualifier carries the meaning ("red robe,"
  "white bird"). Don't rely on them in a `name`.
- **Ties are resolved as "no match."** If two symbols fit equally well the app says nothing
  rather than guessing, and the element still surfaces under "also detected."
- **Figure suggestion is diluted by ambiguity.** A symbol listing one figure is a strong vote
  for it; one listing five splits its weight five ways, so common symbols can't single-handedly
  name a figure.

After editing, re-run the self-check — every `name` and `alias` should resolve back to its own
entry, and no two entries should share a name or alias.
