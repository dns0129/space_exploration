import * as THREE from "three";
import lowTextureManifest from "../shared/texture-variants.json";
import { SURFACE_MAPS } from "./body-textures";
import { textureWidth } from "./graphics-settings";
import type { GraphicsSettings } from "./graphics-settings";
import type { BodyId } from "./solar-system";

const lowTextureSources = new Set(lowTextureManifest);
const surfaceMapsByFile = new Map(Object.values(SURFACE_MAPS).map(map => [map.file, map]));
const surfaceRetryMs = 20_000;
const surfaceIdleMs = 60_000;

type SurfaceEntry = {
  used: number;
  texture?: THREE.Texture;
  loading?: Promise<void>;
  retryAt?: number;
};

/** Owns scene image textures. The scene detaches materials before releasing their maps. */
export class SceneTextures {
  private readonly loader = new THREE.TextureLoader();
  private readonly resident = new Map<THREE.Texture, boolean>();
  private readonly surfaceMaps = new Map<string, SurfaceEntry>();
  private disposed = false;

  constructor(
    private readonly capabilities: THREE.WebGLRenderer["capabilities"],
    private readonly compact: boolean,
    private readonly graphics: () => GraphicsSettings,
    private readonly waitForWork: (file: string) => Promise<void>,
  ) {}

  get maximumWidth() {
    return Math.min(this.capabilities.maxTextureSize, textureWidth(this.graphics(), this.compact));
  }

  private anisotropy(sky = false) {
    return Math.min(sky ? 4 : this.graphics().anisotropy, this.capabilities.getMaxAnisotropy());
  }

  updateAnisotropy() {
    const surfaceLevel = this.anisotropy();
    const skyLevel = this.anisotropy(true);
    for (const [texture, sky] of this.resident) {
      const level = sky ? skyLevel : surfaceLevel;
      if (texture.anisotropy === level) continue;
      texture.anisotropy = level;
      texture.needsUpdate = true;
    }
  }

  private lowVariant(file: string) {
    return this.maximumWidth <= 2048 && lowTextureSources.has(file) ? `low/${file}` : file;
  }

  private surfaceFile(file: string) {
    const map = surfaceMapsByFile.get(file);
    const compact = this.compact || (map && this.maximumWidth < map.width);
    return this.lowVariant(compact && map?.compactFile ? map.compactFile : file);
  }

  atlasMap(id: BodyId) {
    const map = SURFACE_MAPS[id];
    if (!map) return;
    const compact = map.compactFile ?? map.file;
    const file = lowTextureSources.has(compact) ? `low/${compact}` : compact;
    return { file, key: this.surfaceFile(map.file) === file ? map.file : `atlas/${file}` };
  }

  private assertOpen() {
    if (this.disposed) throw new Error("场景已关闭");
  }

  private async decode(file: string) {
    this.assertOpen();
    const texture = await this.loader.loadAsync(`${import.meta.env.BASE_URL}textures/${file}`);
    try {
      await this.waitForWork(file);
      this.assertOpen();
      const image = texture.image as HTMLImageElement;
      await image.decode?.().catch(() => undefined);
      await this.waitForWork(file);
      this.assertOpen();
      return texture;
    } catch (error) {
      texture.dispose();
      throw error;
    }
  }

  private async prepare(file: string, { sky = false, monochrome = false, smooth = false } = {}) {
    let texture = await this.decode(file);
    try {
      this.assertOpen();
      const image = texture.image as HTMLImageElement;
      const width = Math.min(image.width, this.maximumWidth);
      const height = Math.max(1, Math.round(image.height * width / image.width));
      if (monochrome || width < image.width) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", monochrome ? { willReadFrequently: true } : undefined)!;
        if (smooth) context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, width, height);
        if (monochrome) {
          // Single-channel density, elevation and radiance maps upload bottom-up.
          const rgba = context.getImageData(0, 0, width, height).data;
          const data = new Uint8Array(width * height);
          for (let y = 0; y < height; y++) {
            const source = (height - 1 - y) * width * 4;
            for (let x = 0; x < width; x++) data[y * width + x] = rgba[source + x * 4];
          }
          canvas.width = canvas.height = 1;
          texture.dispose();
          texture = new THREE.DataTexture(data, width, height, THREE.RedFormat);
          texture.generateMipmaps = true;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.magFilter = THREE.LinearFilter;
        } else texture.image = canvas;
      }
      if (!monochrome) texture.colorSpace = THREE.SRGBColorSpace;
      if (!sky) texture.wrapS = THREE.RepeatWrapping;
      texture.anisotropy = this.anisotropy(sky);
      texture.name = file;
      texture.needsUpdate = true;
      this.resident.set(texture, sky);
      return texture;
    } catch (error) {
      texture.dispose();
      throw error;
    }
  }

  loadSky(file: string) {
    return this.prepare(file, { sky: true, smooth: true });
  }

  loadEarth(file: string, monochrome = false) {
    return this.prepare(this.lowVariant(file), { monochrome });
  }

  private async loadSurface(file: string) {
    const primary = this.surfaceFile(file);
    try {
      return await this.prepare(primary, { smooth: true });
    } catch (error) {
      const compact = surfaceMapsByFile.get(file)?.compactFile;
      const fallback = compact && this.lowVariant(compact);
      if (!fallback || fallback === primary || this.disposed) throw error;
      await this.waitForWork(primary);
      return this.prepare(fallback, { smooth: true });
    }
  }

  surface(key: string | undefined) {
    return key === undefined ? undefined : this.surfaceMaps.get(key)?.texture;
  }

  requestSurface(key: string, file: string, onReady: () => void, retry = false): SurfaceEntry {
    const now = performance.now();
    let entry = this.surfaceMaps.get(key);
    if (!entry) this.surfaceMaps.set(key, entry = { used: now });
    entry.used = now;
    if (entry.texture || entry.loading || (!retry && now < (entry.retryAt ?? 0))) return entry;
    const requested = entry;
    requested.loading = this.loadSurface(file).then(texture => {
      if (this.surfaceMaps.get(key) !== requested) {
        this.release(texture);
        return;
      }
      requested.texture = texture;
      requested.retryAt = undefined;
      onReady();
    }).catch(() => {
      if (this.surfaceMaps.get(key) !== requested) return;
      requested.retryAt = performance.now() + surfaceRetryMs;
      console.warn(`Surface map ${file} unavailable; keeping the procedural surface.`);
    }).finally(() => { requested.loading = undefined; });
    return entry;
  }

  private bytes(texture: THREE.Texture) {
    const { width = 1, height = 1 } = texture.image ?? {};
    return width * height * (texture.format === THREE.RedFormat ? 1 : 4)
      * (texture.generateMipmaps ? 4 / 3 : 1);
  }

  trimSurfaceMaps(budget: number, pinned: ReadonlySet<string | undefined>, atlas: boolean,
    detach: (texture: THREE.Texture) => void) {
    const now = performance.now();
    let used = 0;
    for (const texture of this.resident.keys()) used += this.bytes(texture);
    const entries = [...this.surfaceMaps].filter(([, entry]) => entry.texture);
    if (used > budget) entries.sort((a, b) => a[1].used - b[1].used);
    let count = entries.length;
    for (const [key, entry] of entries) {
      if (pinned.has(key) || (used <= budget && now - entry.used < surfaceIdleMs)) continue;
      const texture = entry.texture!;
      detach(texture);
      used -= this.bytes(texture);
      count--;
      this.release(texture);
      entry.texture = undefined;
      // A returning atlas node can request its image immediately.
      entry.retryAt = atlas || key.startsWith("atlas/") ? undefined : now + surfaceRetryMs;
    }
    return { used, count };
  }

  clearSurfaceMaps() {
    for (const entry of this.surfaceMaps.values()) if (entry.texture) this.release(entry.texture);
    this.surfaceMaps.clear();
  }

  release(texture: THREE.Texture) {
    if (this.resident.delete(texture)) texture.dispose();
  }

  dispose() {
    this.disposed = true;
    this.surfaceMaps.clear();
    for (const texture of this.resident.keys()) texture.dispose();
    this.resident.clear();
  }
}
