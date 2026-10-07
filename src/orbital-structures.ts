import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { CelestialBody } from "./solar-system";
import type { PlanetModel } from "./planet-models";
import { orbitPosition } from "../shared/solar-orbits.mjs";

/** Original fictional facility; unit radius bounds the complete 120 km span. */
export function createStationModel(body: CelestialBody): PlanetModel {
  const group = new THREE.Group();
  group.rotation.set(0.55, 0.2, 0);
  const hull = new THREE.MeshStandardMaterial({ color: 0xcbd5dd, metalness: 0.65, roughness: 0.38 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x657789, metalness: 0.8, roughness: 0.42 });
  const solar = new THREE.MeshStandardMaterial({ color: 0x153e78, emissive: 0x071a3b, emissiveIntensity: 0.4, metalness: 0.55, roughness: 0.3, side: THREE.DoubleSide });
  const gold = new THREE.MeshStandardMaterial({ color: 0xc49c50, metalness: 0.75, roughness: 0.4 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x9fe9ff });
  const pieces = new Map<THREE.Material, THREE.BufferGeometry[]>();
  function add(geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rotation = new THREE.Euler()) {
    geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(rotation), new THREE.Vector3(1, 1, 1)));
    const batch = pieces.get(material) ?? [];
    batch.push(geometry); pieces.set(material, batch);
  }
  const alongX = new THREE.Euler(0, 0, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.045, 0.045, 1.96, 16), frame, 0, 0, 0, alongX);
  for (const x of [-0.24, 0, 0.24]) {
    add(new THREE.CylinderGeometry(0.095, 0.095, 0.22, 24), hull, x, 0, 0, alongX);
    for (const dx of [-0.095, 0.095]) add(new THREE.TorusGeometry(0.098, 0.012, 8, 24), gold, x + dx, 0, 0, new THREE.Euler(0, Math.PI / 2, 0));
    for (const z of [-0.097, 0.097]) add(new THREE.BoxGeometry(0.13, 0.025, 0.008), glow, x, 0.025, z);
  }
  for (const x of [-0.7, -0.43, 0.43, 0.7]) {
    add(new THREE.BoxGeometry(0.018, 0.025, 1.16), frame, x, 0, 0);
    for (const sign of [-1, 1]) {
      add(new THREE.BoxGeometry(0.235, 0.018, 0.45), solar, x, 0, sign * 0.32);
      for (let row = 0; row <= 9; row++) add(new THREE.BoxGeometry(0.237, 0.005, 0.004), gold, x, 0.012, sign * (0.095 + row * 0.05));
      for (const dx of [-0.118, 0, 0.118]) add(new THREE.BoxGeometry(0.004, 0.005, 0.45), gold, x + dx, 0.012, sign * 0.32);
    }
  }
  add(new THREE.CylinderGeometry(0.055, 0.055, 0.35, 20), hull, 0, 0.21, 0);
  add(new THREE.SphereGeometry(0.13, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), hull, 0, 0.42, 0, new THREE.Euler(Math.PI, 0, 0));
  add(new THREE.CylinderGeometry(0.009, 0.009, 0.18, 8), gold, 0, 0.46, 0);
  for (const x of [-0.98, 0.98]) add(new THREE.SphereGeometry(0.015, 8, 6), glow, x, 0, 0);
  let surface!: THREE.Mesh;
  for (const [material, geometries] of pieces) {
    const merged = mergeGeometries(geometries)!;
    geometries.forEach(geometry => geometry.dispose());
    const mesh = new THREE.Mesh(merged, material);
    group.add(mesh);
    if (material === hull) surface = mesh;
  }
  return { body, group, surface, layers: {}, spinning: [], timeUniforms: [] };
}

/** Sparse broad belt + illustrative local rocks near the Ceres exploration waypoint. */
export function createAsteroidBelt(unitsKm: number, auKm: number, ceres: number[]) {
  const group = new THREE.Group();
  let seed = 7391;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const positions = new Float32Array(12000 * 3);
  const colors = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const angle = random() * Math.PI * 2;
    // Leave the prominent Kirkwood gaps visible in the schematic particle distribution.
    let au: number;
    do { au = 2.1 + random() * 1.2; } while (Math.abs(au - 2.5) < 0.025 || Math.abs(au - 2.82) < 0.025 || Math.abs(au - 2.95) < 0.02);
    const radius = au * auKm / unitsKm;
    // Independent orbital planes form a broad belt around the ecliptic.
    // A Rayleigh distribution favours modest inclinations, with a sparse tail;
    // these are illustrative particles, not a measured asteroid catalogue.
    const inclinationDeg = Math.min(30, 6 * Math.sqrt(-2 * Math.log(1 - random())));
    const ascendingNodeDeg = random() * 360;
    positions.set(orbitPosition(radius, angle * 180 / Math.PI, inclinationDeg, ascendingNodeDeg), i);
    const brightness = 0.25 + random() * 0.4;
    colors.set([brightness, brightness * 0.85, brightness * 0.68], i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 1.15, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.4, depthWrite: false }));
  group.add(points);
  const rock = new THREE.IcosahedronGeometry(1, 1);
  const vertex = rock.getAttribute("position");
  for (let i = 0; i < vertex.count; i++) {
    // Deform by position, so duplicated triangle vertices retain closed seams.
    const x = vertex.getX(i), y = vertex.getY(i), z = vertex.getZ(i);
    const roughness = 0.83 + 0.16 * Math.sin(x * 13 + y * 7) * Math.cos(z * 11);
    vertex.setXYZ(i, x * roughness, y * roughness, z * roughness);
  }
  rock.computeVertexNormals();
  const rocks = new THREE.InstancedMesh(rock, new THREE.MeshStandardMaterial({ color: 0x8a7c6a, roughness: 0.95, flatShading: true }), 180);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < rocks.count; i++) {
    const angle = random() * Math.PI * 2, distance = (i < 24 ? 700 + random() * 1800 : 2500 + random() * 15000) / unitsKm;
    const radius = (8 + random() * 28) / unitsKm;
    matrix.compose(new THREE.Vector3(ceres[0] + Math.cos(angle) * distance, ceres[1] + (random() - 0.5) * distance * 0.3, ceres[2] + Math.sin(angle) * distance), new THREE.Quaternion().setFromEuler(new THREE.Euler(random() * 6, random() * 6, random() * 6)), new THREE.Vector3(radius, radius * (0.6 + random() * 0.4), radius * (0.7 + random() * 0.5)));
    rocks.setMatrixAt(i, matrix);
  }
  group.add(rocks);
  return group;
}
