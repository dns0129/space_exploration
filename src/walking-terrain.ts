import * as THREE from 'three';
import type { WorldConfig } from '../shared/flight-state.mjs';
import { sampleSurface } from '../shared/spatial-frame.mjs';
import { surfaceProfile } from '../shared/surface.mjs';
import type { BodyId } from './solar-system';

export const PATCH_HALF_EXTENT_M = 48;
export const PATCH_SPACING_M = 0.5;
const cells = Math.round(PATCH_HALF_EXTENT_M * 2 / PATCH_SPACING_M);
let topology: Uint32Array | undefined;
export function terrainTopology() {
  if (topology) return topology;
  topology = new Uint32Array(cells * cells * 6);
  let i = 0;
  for (let z = 0; z < cells; z++) for (let x = 0; x < cells; x++) {
    const a = z * (cells + 1) + x, b = a + 1, c = a + cells + 1, d = c + 1;
    topology.set([a,b,c,b,d,c], i); i += 6;
  }
  return topology;
}
export interface TerrainBuild {
  vertices: Float32Array;
  renderPositions: Float32Array;
  renderRadials: Float32Array;
  renderColors: Float32Array;
  renderNormals: Float32Array;
  centerRadialM: number[];
  right: number[];
  forward: number[];
  originRadialM: number[];
}
/** Identical sampling is used by Node's fallback and the browser worker. */
export function buildWalkingTerrain(config: WorldConfig, bodyId: BodyId, radialM: number[], originRadialM: number[]): TerrainBuild {
  const body = config.bodies.find(candidate => candidate.id === bodyId)!;
  const center = new THREE.Vector3().fromArray(sampleSurface(config, body, radialM).surfaceRadialM);
  const up = center.clone().normalize();
  const right = new THREE.Vector3(Math.abs(up.y) < 0.9 ? 0 : 1, Math.abs(up.y) < 0.9 ? 1 : 0, 0).cross(up).normalize();
  const forward = up.clone().cross(right).normalize();
  const vertices = new Float32Array((cells + 1) ** 2 * 3), point = new THREE.Vector3();
  const local = new THREE.Vector3(), direction = new THREE.Vector3();
  const renderPositions = new Float32Array(vertices.length), renderRadials = new Float32Array(vertices.length), renderColors = new Float32Array(vertices.length);
  const ground = new THREE.Color(surfaceProfile(bodyId).ground), tint = new THREE.Color('#70834f'), color = new THREE.Color();
  const coordinates: [number,number,number] = [0,0,0];
  const origin = new THREE.Vector3().fromArray(originRadialM);
  for (let z = 0; z <= cells; z++) for (let x = 0; x <= cells; x++) {
    point.copy(center).addScaledVector(right, x * PATCH_SPACING_M - PATCH_HALF_EXTENT_M)
      .addScaledVector(forward, z * PATCH_SPACING_M - PATCH_HALF_EXTENT_M);
    const sample = sampleSurface(config, body, point.toArray(coordinates));
    const offset = (z * (cells + 1) + x) * 3;
    point.fromArray(sample.surfaceRadialM);
    local.copy(point).sub(center).toArray(renderPositions, offset);
    direction.copy(point).normalize().toArray(renderRadials, offset);
    color.copy(ground).multiplyScalar(.72 + sample.heightM / 1000 * 3);
    if (bodyId === 'earth') color.lerp(tint,.16);
    color.toArray(renderColors,offset);
    point.sub(origin).toArray(vertices,offset);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(renderPositions,3));
  geometry.setIndex(new THREE.BufferAttribute(terrainTopology(),1));
  geometry.computeVertexNormals();
  const renderNormals = geometry.getAttribute('normal').array as Float32Array;
  geometry.dispose();
  return { vertices, renderPositions, renderRadials, renderColors, renderNormals,
    centerRadialM: center.toArray(), right: right.toArray(), forward: forward.toArray(), originRadialM: [...originRadialM] };
}
