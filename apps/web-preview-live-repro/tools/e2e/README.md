# Browser E2E harness (fake camera)

Chromium with `--use-file-for-fake-video-capture=<clip.y4m>` plays a camera clip into the app; each script drives the
page with playwright-core and prints what a user would see. Clips are built with ffmpeg from reference images (see
the generators in the session notes: a card composited on a textured table, slight motion, 10 fps, 720 × 1280).

| Script | What it checks |
|---|---|
| `ident.mjs <clip> <url> <tag>` | time to identification, sheet text 6 s later |
| `dismiss.mjs <clip> <url> gone\|x` | result disappears when the card leaves / ✕ closes it |
| `multi.mjs <clip> <url>` | multi-card mode: per-card decisions, total, “Add all” |
| `prop.mjs <clip> <url> <tag> [confirm]` | calibrated proposals, confirmation, on-device memory |
| `zone.mjs <clip> <url> <tag>` | zone checks between artwork twins (REGION_CHECK telemetry) |
| `soak.mjs <clip> <url> <seconds>` | endurance: heap, ticks/s, long tasks, worker state, locks, errors |
| `perf.mjs`, `prof2.mjs` | long tasks, CPU profile of the main thread |
| `bc.mjs` | barcode → sealed product pop-up |
| `en.mjs` | English UI: residual French text, live language switch |
| `coll.mjs` | quick add, collection panel, CSV export |
| `vis.mjs`, `heal.mjs` | background/foreground camera recovery, frame-worker self-healing |

Run with `PLAYWRIGHT_MODULE=…/playwright-core/index.mjs` (or `NODE_PATH`) and the Chromium path in the scripts
(`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`). Profiles live in `/tmp/claude-0/ui/profile-*`.
