export class CameraAdapter {
  constructor(video) { this.video = video; this.stream = null; }
  async attach(stream) {
    this.stream = stream; this.video.srcObject = stream;
    if (this.video.readyState < 2 || !this.video.videoWidth) {
      await Promise.race([
        new Promise(resolve => this.video.addEventListener('loadeddata', resolve, { once: true })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('camera_metadata_timeout')), 3500)),
      ]);
    }
    await this.video.play();
    if (!this.video.videoWidth || !this.video.videoHeight) throw new Error('camera_zero_dimension');
    return { width: this.video.videoWidth, height: this.video.videoHeight };
  }
  frameCallback(callback) {
    if (this.video.requestVideoFrameCallback) return { kind: 'video', id: this.video.requestVideoFrameCallback((at) => callback(at)) };
    return { kind: 'raf', id: requestAnimationFrame(callback) };
  }
  cancel(handle) {
    if (!handle) return;
    if (handle.kind === 'video' && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(handle.id);
    if (handle.kind === 'raf') cancelAnimationFrame(handle.id);
  }
}
