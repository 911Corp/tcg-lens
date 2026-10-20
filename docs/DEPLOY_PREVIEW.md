# Mobile-browser preview (Vercel, separate project)

The camera needs HTTPS, so the preview is served by Vercel. It is a **test preview**, not production:
production stays blocked until the physical Gold Validation Set and device benchmarks pass. Pages are
`noindex`; card images are loaded from TCGdex (not redistributed).

## Via GitHub (import once, then every push redeploys)
1. vercel.com → Add New… → Project → Import `911Corp/tcg-lens`, branch `v0.3.1-data-freshness`.
2. **Root Directory**: `apps/web-preview-live-repro` · Framework preset: **Other** · no build command,
   no output directory (static files + `api/*.js` functions).
3. Project name: something new (e.g. `tcg-lens-v032-preview`) so existing projects are untouched. Deploy.
4. Open the URL on the phone (Safari / Chrome), tap “Ouvrir la caméra”, allow the camera.

The canonical candidate pool (`apps/web-preview-live-repro/data/candidate-pool-{fr,en,ja}.json`) is
committed for this preview. Regenerate it with `npm run build:coverage` after each data refresh.

## Via token
`VERCEL_TOKEN=… scripts/deploy-preview.sh` (creates/links the separate project, deploys, smoke-tests the API).

## Check after deploy
- `/` loads; `/api/visual-cards?lang=fr&size=8` → 200; `/api/candidate-lookup?lang=en&number=199&total=165` → Charizard ex.
