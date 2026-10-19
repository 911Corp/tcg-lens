import { clamp } from './config.js';

export class FrameQuality {
  score(canvas) {
    if (!canvas?.width || !canvas?.height) return { score: 0, sharpness: 0, exposure: 1, glare: 1 };
    const width = 96;
    const height = Math.max(96, Math.round(width * canvas.height / canvas.width));
    const sample = document.createElement('canvas');
    sample.width = width; sample.height = height;
    const ctx = sample.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    const gray = new Float32Array(width * height);
    let luminance = 0, glare = 0, dark = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      gray[p] = y; luminance += y;
      if (y > 247) glare++;
      if (y < 18) dark++;
    }
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const lap = 4 * gray[p] - gray[p - 1] - gray[p + 1] - gray[p - width] - gray[p + width];
      sum += lap; sum2 += lap * lap; n++;
    }
    const mean = sum / Math.max(1, n);
    const variance = Math.max(0, sum2 / Math.max(1, n) - mean * mean);
    const avgLum = luminance / (width * height);
    const exposurePenalty = Math.abs(avgLum - 132) / 132;
    const glareRatio = glare / (width * height);
    const darkRatio = dark / (width * height);
    const sharpness = clamp(Math.log10(variance + 1) / 3.25, 0, 1);
    const score = clamp(sharpness - exposurePenalty * 0.18 - glareRatio * 0.72 - darkRatio * 0.28, 0, 1);
    return { score, sharpness, exposure: exposurePenalty, glare: glareRatio, dark: darkRatio };
  }
}
