import * as THREE from "three";
import { getBody } from "./solar-system";
import type { BodyId } from "./solar-system";
import { stellarDiskVisibility } from "./light-occlusion";

/** Visible illuminants are independent of the artistic colour of a star's disc. */
export const BARNARD_LIGHT_COLOR = "#ffd0a8";
export type LightBody = { id?: string; kind?: string; radius: number; position: number[] };
export interface StellarSample {
  body: LightBody;
  direction: THREE.Vector3;
  color: THREE.Color;
  visibility: number;
  energy: number;
}
export function stellarColor(id?: string) {
  if (!id || id === "sun") return new THREE.Color(0xffffff);
  return new THREE.Color(id === "barnard-star" ? BARNARD_LIGHT_COLOR : getBody(id as BodyId)?.color ?? "#ffffff");
}

/** Finite-disc eclipses at the actual receiver, shared by hulls, terrain and optics. */
export function stellarVisibility(bodies: readonly LightBody[], point: THREE.Vector3, source: LightBody, ignoreId?: string) {
  const ray = new THREE.Vector3().fromArray(source.position).sub(point), distance = ray.length();
  if (distance <= source.radius) return 1;
  ray.normalize();
  const angularRadius = Math.asin(Math.min(1, source.radius / distance));
  const center = new THREE.Vector3(), perpendicular = new THREE.Vector3();
  let visibility = 1;
  for (const body of bodies) {
    if (body === source || body.kind === "star" || (ignoreId !== undefined && body.id === ignoreId)) continue;
    center.fromArray(body.position).sub(point);
    const along = center.dot(ray), length = center.length();
    if (along <= 0 || along >= distance || length < 1e-12) continue;
    const separation = Math.atan2(perpendicular.copy(center).cross(ray).length(), along);
    visibility = Math.min(visibility, stellarDiskVisibility(angularRadius, Math.asin(Math.min(1, body.radius / length)), separation));
    if (visibility === 0) break;
  }
  return visibility;
}

/** Flux ranks binary sources; a compressed display response keeps remote exploration readable.
 * Fictional stellar radii are artistic, so those systems use a calibrated unit flux. */
export function sampleStellarLighting(bodies: readonly LightBody[], point: THREE.Vector3, unitsKm: number, ignoreId?: string): StellarSample[] {
  const ranked = bodies.filter(body => body.kind === "star").map(body => {
    const distanceKm = Math.max(1, new THREE.Vector3().fromArray(body.position).distanceTo(point) * unitsKm);
    const metadata = body.id ? getBody(body.id as BodyId) : undefined;
    const flux = metadata?.systemId === "echo-rift" ? 1
      : Math.pow(body.radius * unitsKm / 695700, 2) * Math.pow((metadata?.temperatureK ?? 5772) / 5772, 4)
        / Math.pow(distanceKm / 149597870.7, 2);
    return { body, flux };
  }).sort((a, b) => b.flux - a.flux).slice(0, 2);
  const reference = ranked[0]?.flux ?? 1;
  const response = THREE.MathUtils.clamp(Math.pow(Math.max(reference, 1e-12), 0.08), 0.65, 1.6);
  return ranked.map(({ body, flux }) => ({ body,
    direction: new THREE.Vector3().fromArray(body.position).sub(point).normalize(),
    color: stellarColor(body.id), visibility: stellarVisibility(bodies, point, body, ignoreId),
    energy: response * flux / Math.max(reference, 1e-12),
  }));
}

/** Common orbital radiance contract. Secondary irradiance is already visibility-weighted. */
export const stellarShader = /* glsl */ `
  uniform vec3 lightTint, secondarySunDirection, secondaryIrradiance;
  uniform float stellarEnergy, stellarVisibility;
  vec3 stellarDiffuse(vec3 n, vec3 geometric, vec3 sun) {
    float primary = max(dot(n, sun), 0.0) * smoothstep(-0.12, 0.04, dot(geometric, sun));
    float secondary = max(dot(n, secondarySunDirection), 0.0)
      * smoothstep(-0.12, 0.04, dot(geometric, secondarySunDirection));
    return lightTint * primary * stellarEnergy * stellarVisibility + secondaryIrradiance * secondary;
  }
`;
export function stellarUniforms(id?: string) {
  return { lightTint: { value: stellarColor(id) }, stellarEnergy: { value: 1 }, stellarVisibility: { value: 1 },
    secondarySunDirection: { value: new THREE.Vector3() }, secondaryIrradiance: { value: new THREE.Color(0, 0, 0) } };
}
