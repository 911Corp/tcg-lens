/**
 * v0.4.3 — rear camera with the right orientation and the widest field of view.
 *
 * iOS can deliver a landscape stream (e.g. 1920 × 1280) while the phone is held upright: the card then fills the
 * short side of the frame and its top/bottom fall outside (diagnostic 2026-10-21: bottom border and number cut,
 * wrong rectangle). We ask for the sensor's native 4:3 format first, check the orientation actually delivered
 * (videoWidth / videoHeight of a probe <video>) against the screen, and try the next format when it does not match.
 */
(function () {
  const portraitScreen = () => (window.matchMedia ? window.matchMedia('(orientation: portrait)').matches : window.innerHeight >= window.innerWidth);
  const dims = stream => new Promise(resolve => {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.srcObject = stream;
    const done = () => resolve({ w: v.videoWidth, h: v.videoHeight });
    v.addEventListener('loadedmetadata', done, { once: true });
    v.play?.().catch(() => {});
    setTimeout(done, 1500);
  });
  const TRIES = [
    { width: { ideal: 1920 }, height: { ideal: 1440 } },  // native 4:3 (landscape terms: the browser rotates for portrait)
    { width: { ideal: 1440 }, height: { ideal: 1920 } },  // 4:3 in portrait terms
    { width: { ideal: 1920 }, height: { ideal: 1080 } },
    { width: { ideal: 1280 }, height: { ideal: 1920 } },
  ];
  window.openRearCamera = async function openRearCamera() {
    const wantPortrait = portraitScreen();
    let firstOk = null;
    for (const size of TRIES) {
      let s;
      try { s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, ...size }, audio: false }); }
      catch (e) { if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') throw e; continue; }
      const { w, h } = await dims(s);
      if (!w || !h || (h >= w) === wantPortrait) return s;
      firstOk ??= size;
      s.getTracks().forEach(t => t.stop()); // iOS: one camera stream at a time
    }
    // No format matched the screen orientation: keep the widest one that worked.
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, ...(firstOk || {}) }, audio: false });
  };
})();
