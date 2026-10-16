# TCG Lens functional web preview

Smartphone-first PWA preview deployed on Vercel.

Features in this prototype:
- real rear-camera preview via getUserMedia
- FR/EN/JA card search and details through TCGdex
- Cardmarket and TCGplayer card pricing exposed through TCGdex
- Cardmarket sealed-product catalog search and price-guide lookup
- local OCR fallback with Tesseract.js for candidate generation
- BarcodeDetector when available, with manual EAN/UPC/JAN fallback and local registry
- local collection via localStorage
- PWA manifest/service worker and iOS home-screen guidance

The native real-time visual embedding/tracking engine is not implemented in this web preview. OCR and barcode are explicit user-triggered fallbacks.
