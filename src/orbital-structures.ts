import * as THREE from "three";
import { createStarshipHull } from "./starship-hull.ts";
import type { CelestialBody } from "./solar-system";
import type { PlanetModel } from "./planet-models";
import { orbitPosition } from "../shared/solar-orbits.mjs";

/** Fictional starship, bounded by a unit radius.
 * Local -Z points forward; the aft hangar approaches from +Z.
 * Keep the group unrotated: navigation uses this same station-local frame.
 */
export function createStationModel(body: CelestialBody): PlanetModel {
  const { group, surface } = createStarshipHull();
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
  const semimajorAxes = new Float64Array(count);
  const eccentricities = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let a: number;
    // Major Jupiter resonances: 3:1, 5:2, 7:3 and 2:1.
    do { a = 2.1 + random() * 1.2; } while (
      [[2.50, 0.025], [2.82, 0.018], [2.96, 0.014], [3.27, 0.025]]
        .some(([center, width]) => Math.abs(a - center) < width));
    const eccentricity = 0.03 + random() ** 1.5 * 0.25;
    semimajorAxes[i] = a;
    eccentricities[i] = eccentricity;
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
  geometry.userData.orbits = { semimajorAxes, eccentricities };
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
