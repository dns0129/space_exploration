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

/** Statistical main-belt sample, not a catalogue or a realtime ephemeris.
 * Gaps are in semimajor axis; eccentric orbits overlap them in physical space.
 * No artificial swarm is placed around Ceres (which is rendered separately).
 */
export function createAsteroidBelt(unitsKm: number, auKm: number) {
  const group = new THREE.Group();
  let seed = 7391;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const count = 12000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const diameters = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let a: number;
    // Major Jupiter resonances: 3:1, 5:2, 7:3 and 2:1.
    do { a = 2.1 + random() * 1.2; } while (
      [[2.50, 0.025], [2.82, 0.018], [2.96, 0.014], [3.27, 0.025]]
        .some(([center, width]) => Math.abs(a - center) < width));
    const eccentricity = 0.03 + random() ** 1.5 * 0.25;
    const meanAnomaly = random() * Math.PI * 2;
    let eccentricAnomaly = meanAnomaly;
    // Kepler's equation: uniform mean anomaly gives correct dwell time.
    for (let step = 0; step < 6; step++) eccentricAnomaly -=
      (eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly) - meanAnomaly) /
      (1 - eccentricity * Math.cos(eccentricAnomaly));
    const anomaly = Math.atan2(Math.sqrt(1 - eccentricity ** 2) * Math.sin(eccentricAnomaly), Math.cos(eccentricAnomaly) - eccentricity);
    const radius = a * (1 - eccentricity * Math.cos(eccentricAnomaly)) * auKm / unitsKm;
    const inclination = Math.min(30, 6 * Math.sqrt(-2 * Math.log(1 - random())));
    const node = random() * 360;
    const perihelion = random() * 360;
    positions.set(orbitPosition(radius, node + perihelion + anomaly * 180 / Math.PI, inclination, node), i * 3);
    // Truncated power law: many small bodies, few large ones; no enlarged rocks.
    diameters[i] = Math.min(200, 2 / Math.sqrt(1 - random())) / unitsKm;
    // Dark carbonaceous material is more common toward the outer main belt.
    const carbonaceous = random() < (a - 2.1) / 1.2;
    const albedo = carbonaceous ? 0.035 + random() * 0.045 : 0.12 + random() * 0.16;
    colors.set([albedo, albedo * 0.96, albedo * 0.90], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("diameter", new THREE.BufferAttribute(diameters, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { viewportHeight: { value: 1 }, au: { value: auKm / unitsKm } },
    vertexColors: true, transparent: true, depthWrite: false,
    vertexShader: `
      attribute float diameter;
      uniform float viewportHeight;
      uniform float au;
      varying vec3 reflected;
      varying float coverage;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        float pixels = diameter * projectionMatrix[1][1] * viewportHeight / (2.0 * max(0.00001, -mvPosition.z));
        gl_PointSize = clamp(pixels, 1.0, 64.0);
        coverage = min(1.0, pixels * pixels);
        vec3 sunDirection = normalize(mat3(modelViewMatrix) * -position);
        float phaseAngle = acos(clamp(dot(sunDirection, normalize(-mvPosition.xyz)), -1.0, 1.0));
        float phase = (sin(phaseAngle) + (3.14159265 - phaseAngle) * cos(phaseAngle)) / 3.14159265;
        float solarFlux = au * au / dot(position, position);
        reflected = color * phase * solarFlux;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      varying vec3 reflected;
      varying float coverage;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        float edge = 1.0 - smoothstep(0.35, 0.5, length(gl_PointCoord - 0.5));
        if (coverage * edge < 0.0001) discard;
        #include <logdepthbuf_fragment>
        gl_FragColor = vec4(reflected, coverage * edge);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const points = new THREE.Points(geometry, material);
  const viewport = new THREE.Vector2();
  points.onBeforeRender = renderer => {
    material.uniforms.viewportHeight.value = renderer.getDrawingBufferSize(viewport).y;
  };
  group.add(points);
  return group;
}
