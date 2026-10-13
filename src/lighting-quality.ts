import type { RenderQuality } from "./earth-detail";
import type { GraphicsSettings, GraphicsLevel } from "./graphics-settings";

/** Effect costs are independent of canvas resolution and texture fidelity. */
export function lightingQuality(quality: RenderQuality, compact = false, effectLevel = 2, settings?: GraphicsSettings) {
  const level = Math.min(effectLevel, settings?.preset === 'custom' ? compact ? 1 : 2 : quality === "standard" ? 0 : quality === "high" || compact ? 1 : 2);
  const rank = (value: GraphicsLevel) => value === 'high' ? 2 : value === 'medium' ? 1 : value === 'low' ? 0 : -1;
  const shadow = settings ? Math.min(level, rank(settings.shadows)) : level;
  const atmosphere = settings ? Math.min(level, rank(settings.atmosphere)) : level;
  const cloud = settings ? Math.min(level, rank(settings.clouds)) : level;
  const reflection = settings ? Math.min(level, rank(settings.reflections)) : level;
  return {
    level,
    shadowsEnabled: shadow >= 0,
    reflectionLevel: reflection + 1,
    shadowSize: shadow === 2 ? 2048 : shadow === 1 ? 1024 : 512,
    atmosphereSteps: atmosphere === 2 ? 12 : atmosphere === 1 ? 8 : 6,
    cloudSteps: cloud === 2 ? 8 : cloud === 1 ? 6 : 4,
    bloomStrength: settings?.bloom === false ? 0 : level === 2 ? 0.055 : level === 1 ? 0.025 : 0,
    bloomScale: level === 2 ? 0.5 : 0.25,
  };
}
export type LightingQuality = ReturnType<typeof lightingQuality>;
