import type { RenderQuality } from './earth-detail';

export type GraphicsLevel = 'off' | 'low' | 'medium' | 'high';
export interface GraphicsSettings {
  preset: RenderQuality | 'custom';
  baseQuality: RenderQuality;
  antialias: 0 | 2 | 4 | 8;
  maxFps: 0 | 30 | 60 | 90 | 120 | 144 | 240;
  renderScale: number;
  adaptive: boolean;
  textures: 'low' | 'medium' | 'high' | 'ultra';
  anisotropy: 1 | 4 | 8 | 16;
  shadows: GraphicsLevel;
  reflections: GraphicsLevel;
  atmosphere: Exclude<GraphicsLevel, 'off'>;
  clouds: Exclude<GraphicsLevel, 'off'>;
  bloom: boolean;
}
export const GRAPHICS_EVENT = 'voyager-graphics-change';
const storageKey = 'voyager-graphics-v1';
let sessionSettings: GraphicsSettings | undefined;
export function graphicsPreset(quality: RenderQuality): GraphicsSettings {
  const level = quality === 'standard' ? 'low' : quality === 'ultra' ? 'high' : 'medium';
  return { preset: quality, baseQuality: quality, antialias: quality === 'standard' ? 0 : quality === 'high' ? 2 : 4,
    maxFps: 60, renderScale: 1, adaptive: true,
    textures: quality === 'standard' ? 'low' : quality === 'high' ? 'medium' : 'ultra',
    anisotropy: quality === 'standard' ? 4 : quality === 'high' ? 8 : 16,
    shadows: level, reflections: quality === 'standard' ? 'off' : level, atmosphere: level, clouds: level,
    bloom: quality !== 'standard' };
}
export function normalizeGraphics(value: unknown): GraphicsSettings {
  const input = value && typeof value === 'object' ? value as Partial<GraphicsSettings> : {};
  const base = ['standard','high','ultra'].includes(input.baseQuality ?? '') ? input.baseQuality! : 'high';
  const result = graphicsPreset(base);
  const choices = { preset: ['standard','high','ultra','custom'], antialias: [0,2,4,8], maxFps: [0,30,60,90,120,144,240],
    textures: ['low','medium','high','ultra'], anisotropy: [1,4,8,16],
    shadows: ['off','low','medium','high'], reflections: ['off','low','medium','high'],
    atmosphere: ['low','medium','high'], clouds: ['low','medium','high'] };
  for (const [key, allowed] of Object.entries(choices)) {
    const entry = input[key as keyof GraphicsSettings];
    if ((allowed as unknown[]).includes(entry)) Object.assign(result, { [key]: entry });
  }
  if (typeof input.renderScale === 'number' && Number.isFinite(input.renderScale))
    result.renderScale = Math.min(1.5, Math.max(0.5, Math.round(input.renderScale * 100) / 100));
  for (const key of ['adaptive','bloom'] as const) if (typeof input[key] === 'boolean') result[key] = input[key];
  return result;
}
export function readGraphics(): GraphicsSettings {
  if (sessionSettings) return { ...sessionSettings };
  try { return normalizeGraphics(JSON.parse(localStorage.getItem(storageKey) ?? 'null')); }
  catch { return graphicsPreset('high'); }
}
export function writeGraphics(settings: GraphicsSettings) {
  const safe = normalizeGraphics(settings);
  sessionSettings = safe;
  try { localStorage.setItem(storageKey, JSON.stringify(safe)); } catch { /* Session settings still apply. */ }
  window.dispatchEvent(new CustomEvent<GraphicsSettings>(GRAPHICS_EVENT, { detail: safe }));
  return safe;
}
export function textureWidth(settings: GraphicsSettings, compact = false) {
  return Math.min(compact ? 4096 : Infinity,
    settings.textures === 'low' ? 2048 : settings.textures === 'medium' ? 4096 : 8192);
}
export function textureBudgetBytes(settings: GraphicsSettings, compact = false) {
  const mib = settings.textures === 'low' ? 256 : settings.textures === 'medium' ? 512 : settings.textures === 'high' ? 1024 : 1536;
  return Math.min(compact ? 384 : Infinity, mib) * 1024 * 1024;
}

/** The browser owns display synchronization. This adds a stable upper bound without changing the physics clock. */
export class FrameLimiter {
  private previous: number | undefined;
  reset() { this.previous = undefined; }
  accepts(now: number, maximum: number, force = false) {
    if (!maximum || force || this.previous === undefined) { this.previous = now; return true; }
    const interval = 1000 / maximum, elapsed = now - this.previous;
    // RAF timestamps often fall just below an exact refresh boundary.
    if (elapsed < interval - 0.6) return false;
    this.previous += Math.max(1, Math.floor((elapsed + 0.6) / interval)) * interval;
    return true;
  }
}
