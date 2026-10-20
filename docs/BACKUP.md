# Sauvegarde et restauration (21/10/2026, v0.4.2)

| Élément | Où | Restauration |
|---|---|---|
| Code, données de l’app, modèles (`apps/web-preview-live-repro/data`), historique | GitHub `911Corp/tcg-lens` (branche `main`) + `tcg-lens-v0.4.2.bundle` | `git clone https://github.com/911Corp/tcg-lens` ou `git clone tcg-lens-v0.4.2.bundle tcg-lens` |
| Base canonique PostgreSQL 16 (cartes FR/EN/JA, prix, scellés, codes-barres) | `Documents\TCG-Lens-Sauvegarde\base-de-donnees\tcglens-db.dump.part00…12` (13 × 29 Mo) | recoller puis `createdb tcglens && pg_restore -d tcglens tcglens-db.dump` |
| Données d’entraînement (cache des descripteurs par image, recadrages caméra t-/q-/extra, descripteurs de zones, groupes de jumelles) | `Documents\TCG-Lens-Sauvegarde\entrainement\tcg-lens-training.tar.gz.part00…29` (30 × 29 Mo) | recoller puis `tar -xzf tcg-lens-training.tar.gz -C /tmp` → `/tmp/tcg-lens-deep`, `/tmp/claude-0/cal` |
| Images de référence (2,3 Go) | non sauvegardées | `node apps/web-preview-live-repro/tools/fetch-ref-images.mjs` |

Recoller les morceaux :
- Windows (PowerShell, dans le dossier) :
  `cmd /c "copy /b tcglens-db.dump.part00+tcglens-db.dump.part01+…+tcglens-db.dump.part12 tcglens-db.dump"`
  (ou, plus simple : `Get-Content tcglens-db.dump.part* -Encoding Byte -ReadCount 0 | Set-Content tcglens-db.dump -Encoding Byte` en PowerShell 5,
  `Get-Content … -AsByteStream` en PowerShell 7)
- Linux / macOS / Git Bash : `cat tcglens-db.dump.part* > tcglens-db.dump`

Empreintes SHA-256 des fichiers recollés :
- `tcglens-db.dump` : `75f8afd78b36129b65c9af2376ccf32c9930370c623591c4d0a7ad67c9db4e37`
- `tcg-lens-training.tar.gz` : `66e0d6d711ea9c084edc169dcf52043489e048b69dc79633d5d5645a93317fa5`

Vérifier : `certutil -hashfile tcglens-db.dump SHA256` (Windows) ou `sha256sum tcglens-db.dump`.

Reconstruire sans les données d’entraînement : `tools/deep/embed-references.mjs` (≈ 30 min), `camera-crops.mjs`,
`train-and-export.py`, `calibrate-proposals.py`, `region-jobs.py` → `region-crops.mjs` (≈ 45 min) → `train-regions.py`.
