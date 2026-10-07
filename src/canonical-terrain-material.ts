import * as THREE from "three";
import { canonicalTerrainSampling, surfaceProfile, terrainHeightField } from "../shared/surface.mjs";
import type { CelestialBody } from "./solar-system";

const heightTextures = new Map<string, THREE.DataTexture>();

/** Tiny immutable height fields are shared by every rendering of a body. */
export function createCanonicalTerrainUniforms(body: CelestialBody): Record<string, THREE.IUniform> {
  const field = terrainHeightField(body.id);
  const key = field ? body.id : "empty";
  let texture = heightTextures.get(key);
  if (!texture) {
    texture = new THREE.DataTexture(field?.data ?? new Uint8Array(1), field?.width ?? 1, field?.height ?? 1, THREE.RedFormat);
    texture.colorSpace = THREE.NoColorSpace;
    texture.flipY = false;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    heightTextures.set(key, texture);
  }
  const tilt = field?.tiltRad ?? THREE.MathUtils.degToRad(body.axialTiltDeg);
  const yaw = field?.yawRad ?? (body.id === "earth" ? -1.8 : -0.4);
  const offset = field?.mapOffset ?? 0;
  const worldToMap = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationZ(-tilt));
  worldToMap.premultiply(new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(-yaw)));
  if (offset) worldToMap.premultiply(new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(offset * Math.PI * 2)));
  const solid = surfaceProfile(body.id).solid;
  return {
    canonicalHeightMap: { value: texture },
    canonicalHeightScaleKm: { value: field?.heightScaleKm ?? 0 },
    canonicalHeightOffsetKm: { value: field?.heightOffsetKm ?? (solid ? 0.065 : 0) },
    canonicalHeightReady: { value: field ? 1 : 0 },
    canonicalWorldToMap: { value: worldToMap },
    canonicalFineSeed: { value: field?.fineSeed ?? [...body.id].reduce((sum, c) => sum + c.charCodeAt(0), 0) * 0.17 },
    canonicalFineEnabled: { value: Number(field?.fineEnabled ?? (solid && body.id !== "earth")) },
    canonicalRadiusKm: { value: body.radiusKm },
    canonicalColor: { value: new THREE.Color(body.color) },
  };
}

export function disposeCanonicalTerrainTextures() {
  heightTextures.forEach(texture => texture.dispose());
  heightTextures.clear();
}

export const canonicalTerrainVertexSampling = /* glsl */ `
  ${canonicalTerrainSampling}
  uniform float canonicalRadiusKm;
`;

export const canonicalTerrainFragmentSampling = /* glsl */ `
  ${canonicalTerrainSampling}
  uniform float canonicalRadiusKm;
  uniform vec3 canonicalColor;
  vec2 canonicalTerrainShadingWeights(vec3 radial) {
    float footprint = max(length(dFdx(radial)), length(dFdy(radial)));
    return vec2(1.0) - smoothstep(vec2(0.45), vec2(1.1), footprint * vec2(2200.0, 14000.0));
  }
  vec3 canonicalTerrainWorldNormal(vec3 radial) {
    radial = normalize(radial);
    vec3 east = cross(vec3(0.0, 1.0, 0.0), radial);
    if (dot(east, east) < 0.00001) east = cross(vec3(1.0, 0.0, 0.0), radial);
    east = normalize(east);
    vec3 north = normalize(cross(radial, east));
    // The same world-space height field supplies both geometry and relief.
    // The fine metre-scale field is filtered by the actual screen footprint.
    float angle = max(0.0001, max(length(dFdx(radial)), length(dFdy(radial))));
    vec2 weights = canonicalTerrainShadingWeights(radial);
    float eastHeight = canonicalTerrainHeightFilteredKm(normalize(radial + east * angle), weights.x, weights.y)
      - canonicalTerrainHeightFilteredKm(normalize(radial - east * angle), weights.x, weights.y);
    float northHeight = canonicalTerrainHeightFilteredKm(normalize(radial + north * angle), weights.x, weights.y)
      - canonicalTerrainHeightFilteredKm(normalize(radial - north * angle), weights.x, weights.y);
    vec3 slope = (east * eastHeight + north * northHeight) / max(2.0 * angle * canonicalRadiusKm, 0.0001);
    return normalize(radial - slope);
  }
  vec3 canonicalProceduralGround(vec3 radial) {
    radial = normalize(radial);
    vec2 weights = canonicalTerrainShadingWeights(radial);
    float height = canonicalTerrainHeightFilteredKm(radial, weights.x, weights.y);
    float feature = clamp((height - canonicalHeightOffsetKm) / max(canonicalHeightScaleKm, 0.0001), 0.0, 1.0);
    return canonicalColor * (0.45 + feature * 0.75);
  }
`;
