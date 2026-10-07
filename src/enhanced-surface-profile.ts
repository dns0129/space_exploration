import type { CelestialBody } from "./solar-system";
import { proceduralBodyProfile } from "./procedural-body";
import { SURFACE_MAPS } from "./body-textures";
import type { EnhancedSurfaceProfile } from "./enhanced-surface";

const cloudWorlds = new Set(["venus", "jupiter", "saturn", "uranus", "neptune"]);
const iceWorlds = new Set([
  "europa", "ganymede", "callisto", "mimas", "enceladus", "tethys", "dione", "rhea",
  "iapetus", "miranda", "ariel", "umbriel", "titania", "oberon", "triton",
]);
const profiles = new WeakMap<CelestialBody, EnhancedSurfaceProfile>();

/** Reconstruct fine material; source imagery and unobserved geography keep their original provenance. */
export function enhancedSurfaceProfile(body: CelestialBody): EnhancedSurfaceProfile {
  const cached = profiles.get(body);
  if (cached) return cached;
  const procedural = proceduralBodyProfile(body);
  const family = body.id === "sun" || body.kind === "star" ? "star"
    : cloudWorlds.has(body.id) || body.surfaceStyle === 6 ? "gas"
    : iceWorlds.has(body.id) || body.surfaceStyle === 1 ? "ice" : "rock";
  const profile: EnhancedSurfaceProfile = {
    bodyId: body.id,
    family,
    seed: procedural.seed,
    offset: SURFACE_MAPS[body.id]?.offset ?? 0,
    // Existing material shaders apply tint/stellar temperature after sampling the raw composite.
    tint: [1, 1, 1],
    strength: family === "gas" ? 0.16 : family === "star" ? 0.24 : family === "ice" ? 0.22 : 0.28,
  };
  profiles.set(body, profile);
  return profile;
}
