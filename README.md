# frontier-tavern-site

The public face of **Frontier Tavern**: the promotional page and the game's
**update relay**, served as a Render static site at
`https://frontier-tavern.onrender.com`.

- `index.html` — the promo page (screenshots in `img/`).
- `update/manifest.json` — the version manifest the in-game self-updater polls.
  Build zips are attached to this repo's **GitHub Releases** (they are never
  committed to git).
- `render.yaml` — Render Blueprint; the site auto-redeploys on every push.

## Cutting a release

From the (private) game repo:

```sh
node tools/release/publish.mjs \
  --win  FrontierTavern/Builds/Windows \
  --mac  FrontierTavern/Builds/Mac/FrontierTavern.app \
  --out  FrontierTavern/Builds/release \
  --notes "What changed." \
  --base-url https://github.com/Luminary-Analytics/frontier-tavern-site/releases/download/vN \
  --upload Luminary-Analytics/frontier-tavern-site \
  --site   ../frontier-tavern-site
```

Then commit + push this repo — Render redeploys and every installed copy of
the game offers the update on its next launch.
