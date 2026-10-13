/** Adaptive resolution with a sharpness floor and steady recovery, targeting a 60 Hz frame budget. */
export class RenderBudget {
  ratio = 1;
  effectLevel = 2;
  private maximumEffectLevel = 2;
  private ceiling = 1;
  private averageMs = 16.7;
  private windowSeconds = 0;
  private healthySeconds = 0;
  private slowFrames = 0;
  private sampledFrames = 0;
  private minimumRatio = 0.5;
  private holdSeconds = 0;
  private targetMs = 16.7;
  private adaptive = true;
  configure(quality: boolean | "standard" | "high" | "ultra", deviceRatio: number, width: number, height: number, minimumRatio = 0.5,
    options?: { renderScale: number; maxFps: number; adaptive: boolean; preset: string }) {
    this.maximumEffectLevel = quality === "standard" || quality === false ? 0 : quality === "ultra" ? 2 : 1;
    this.effectLevel = this.maximumEffectLevel;
    if (options?.preset === 'custom') this.effectLevel = this.maximumEffectLevel = 2;
    this.adaptive = options?.adaptive ?? true;
    this.targetMs = 1000 / Math.min(options?.maxFps || 60, 60);
    this.minimumRatio = minimumRatio;
    const ultra = quality === "ultra", high = quality === true || quality === "high" || ultra;
    const pixelLimit = ultra ? 8_300_000 : high ? 2_100_000 : 1_200_000;
    this.ceiling = Math.min(high ? Math.min(deviceRatio, ultra ? 2 : 1.5) : 1,
      Math.sqrt(pixelLimit / Math.max(1, width * height)));
    this.ceiling *= options?.renderScale ?? 1;
    this.ratio = this.ceiling;
    this.averageMs = this.targetMs;
    this.windowSeconds = -1.5;
    this.healthySeconds = 0;
    this.slowFrames = this.sampledFrames = 0;
  }
  /** A still image needs no frame budget: return to full sharpness. Returns true if the ratio changed. */
  rest() {
    if (this.ratio >= this.ceiling && this.effectLevel === this.maximumEffectLevel) return false;
    this.ratio = this.ceiling;
    this.effectLevel = this.maximumEffectLevel;
    this.windowSeconds = -1.5;
    this.healthySeconds = this.slowFrames = this.sampledFrames = 0;
    return true;
  }
  /** Ignore frames briefly, e.g. while a large texture uploads, so one stall doesn't blur the view. */
  hold(seconds: number) {
    this.holdSeconds = Math.max(this.holdSeconds, seconds);
  }
  sample(seconds: number) {
    if (!this.adaptive) return false;
    if (seconds <= 0 || seconds > 1) return false;
    if (this.holdSeconds > 0) {
      this.holdSeconds -= seconds;
      return false;
    }
    this.averageMs += (seconds * 1000 - this.averageMs) * (1 - Math.exp(-seconds * 2));
    this.sampledFrames++;
    if (seconds * 1000 > this.targetMs * 1.44) this.slowFrames++;
    this.windowSeconds += seconds;
    if (this.windowSeconds < 1) return false;
    this.windowSeconds = 0;
    const missedFraction = this.slowFrames / this.sampledFrames;
    this.slowFrames = this.sampledFrames = 0;
    const previous = this.ratio;
    const previousEffect = this.effectLevel;
    if (this.averageMs > this.targetMs * 1.14 || missedFraction > 0.045) {
      if (this.effectLevel > 0) this.effectLevel--;
      else this.ratio = Math.max(Math.min(this.minimumRatio, this.ceiling), this.ratio * 0.82);
      this.healthySeconds = 0;
    } else if (this.averageMs < this.targetMs * 1.032 && missedFraction <= 0.02) {
      // Recover sharpness steadily once frames are healthy again.
      if (++this.healthySeconds >= 3) {
        this.ratio = Math.min(this.ceiling, this.ratio * 1.08);
        if (previous >= this.ceiling) this.effectLevel = Math.min(this.maximumEffectLevel, this.effectLevel + 1);
        this.healthySeconds = 0;
      }
    } else this.healthySeconds = 0;
    return previousEffect !== this.effectLevel || Math.abs(previous - this.ratio) > 0.001;
  }
}
