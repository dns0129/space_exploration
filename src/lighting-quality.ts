import type { RenderQuality } from "./earth-detail";

/** Effect costs are independent of canvas resolution and texture fidelity. */
export function lightingQuality(quality: RenderQuality, compact = false, effectLevel = 2) {
  const level = Math.min(effectLevel, quality === "standard" ? 0 : quality === "high" || compact ? 1 : 2);
  return {
    level,
    shadowSize: level === 2 ? 2048 : level === 1 ? 1024 : 512,
    atmosphereSteps: level === 2 ? 12 : level === 1 ? 8 : 6,
    cloudSteps: level === 2 ? 8 : level === 1 ? 6 : 4,
    bloomStrength: level === 2 ? 0.055 : level === 1 ? 0.025 : 0,
    bloomScale: level === 2 ? 0.5 : 0.25,
  };
}
export type LightingQuality = ReturnType<typeof lightingQuality>;
