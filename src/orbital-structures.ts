import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { CelestialBody } from "./solar-system";
import type { PlanetModel } from "./planet-models";
import { orbitPosition } from "../shared/solar-orbits.mjs";

/** Original fictional megastructure; unit radius bounds the complete 360 km span.
 * Local +Y is the tower axis and all three berth approaches face local +Z.
 * Keep the group unrotated: navigation uses this same station-local frame.
 */
export function createStationModel(body: CelestialBody): PlanetModel {
  const group = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0xa7b8ca, emissive: 0x172536, emissiveIntensity: 0.24, metalness: 0.64, roughness: 0.38 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x26364a, emissive: 0x071522, emissiveIntensity: 0.28, metalness: 0.78, roughness: 0.42 });
  const armor = new THREE.MeshStandardMaterial({ color: 0x586f84, emissive: 0x0b1c30, emissiveIntensity: 0.3, metalness: 0.6, roughness: 0.48 });
  const solar = new THREE.MeshStandardMaterial({ color: 0x123b69, emissive: 0x0b3e70, emissiveIntensity: 0.6, metalness: 0.5, roughness: 0.28, side: THREE.DoubleSide });
  const gold = new THREE.MeshStandardMaterial({ color: 0xbda168, emissive: 0x34220a, emissiveIntensity: 0.18, metalness: 0.7, roughness: 0.4 });
  const cyan = new THREE.MeshBasicMaterial({ color: 0x65ddff });
  const amber = new THREE.MeshBasicMaterial({ color: 0xffbb62 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x3386a2, emissive: 0x0d5c7c, emissiveIntensity: 0.3, metalness: 0.25, roughness: 0.16, transparent: true, opacity: 0.48, depthWrite: false, side: THREE.DoubleSide });
  const pieces = new Map<THREE.Material, THREE.BufferGeometry[]>();
  function add(geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rotation = new THREE.Euler()) {
    geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(rotation), new THREE.Vector3(1, 1, 1)));
    const batch = pieces.get(material) ?? [];
    batch.push(geometry); pieces.set(material, batch);
  }
  const horizontalRing = new THREE.Euler(Math.PI / 2, 0, 0);
  const alongX = new THREE.Euler(0, 0, Math.PI / 2);
  // Twin habitat decks, continuous light ribbons and individually armored sectors.
  add(new THREE.TorusGeometry(0.585, 0.061, 10, 96), hull, 0, 0.035, 0, horizontalRing);
  add(new THREE.TorusGeometry(0.585, 0.028, 8, 96), frame, 0, -0.065, 0, horizontalRing);
  for (const y of [-0.012, 0.082]) add(new THREE.TorusGeometry(0.62, 0.006, 5, 96), cyan, 0, y, 0, horizontalRing);
  add(new THREE.TorusGeometry(0.585, 0.007, 5, 96), amber, 0, -0.093, 0, horizontalRing);
  for (let sector = 0; sector < 20; sector++) {
    const angle = sector * Math.PI * 2 / 20;
    const x = Math.cos(angle), z = Math.sin(angle);
    const tangent = new THREE.Euler(0, -angle - Math.PI / 2, 0);
    add(new THREE.BoxGeometry(0.142, 0.056, 0.094), armor, x * 0.585, 0.095, z * 0.585, tangent);
    add(new THREE.BoxGeometry(0.1, 0.004, 0.043), frame, x * 0.585, 0.125, z * 0.585, tangent);
    add(new THREE.BoxGeometry(0.065, 0.006, 0.006), sector % 5 === 0 ? amber : cyan, x * 0.639, 0.036, z * 0.639, tangent);
    // Tall rib plates establish thickness when seen almost edge-on.
    add(new THREE.BoxGeometry(0.012, 0.15, 0.085), gold, x * 0.585, 0.022, z * 0.585, tangent);
  }
  for (let spoke = 0; spoke < 8; spoke++) {
    const angle = spoke * Math.PI / 4;
    const x = Math.cos(angle), z = Math.sin(angle);
    const radial = new THREE.Euler(0, -angle, 0);
    add(new THREE.BoxGeometry(0.39, 0.07, 0.064), frame, x * 0.397, 0.018, z * 0.397, radial);
    add(new THREE.BoxGeometry(0.36, 0.008, 0.011), cyan, x * 0.397, 0.057, z * 0.397, radial);
    add(new THREE.BoxGeometry(0.16, 0.096, 0.083), hull, x * 0.37, 0.03, z * 0.37, radial);
    add(new THREE.BoxGeometry(0.008, 0.101, 0.09), gold, x * 0.4, 0.03, z * 0.4, radial);
  }

  // Central main-control deck: panoramic blue windows above the service hull.
  add(new THREE.CylinderGeometry(0.23, 0.27, 0.18, 32), hull, 0, 0.06, 0);
  add(new THREE.CylinderGeometry(0.205, 0.235, 0.10, 32), frame, 0, -0.072, 0);
  add(new THREE.TorusGeometry(0.25, 0.014, 6, 48), gold, 0, 0.128, 0, horizontalRing);
  add(new THREE.CylinderGeometry(0.221, 0.221, 0.082, 32, 1, true), glass, 0, 0.213, 0);
  add(new THREE.CylinderGeometry(0.15, 0.15, 0.07, 24), frame, 0, 0.21, 0);
  for (const y of [0.168, 0.258]) {
    add(new THREE.CylinderGeometry(0.239, 0.239, 0.016, 32), hull, 0, y, 0);
    add(new THREE.TorusGeometry(0.236, 0.004, 5, 48), cyan, 0, y + 0.01, 0, horizontalRing);
  }
  for (let window = 0; window < 12; window++) {
    const angle = window * Math.PI / 6;
    const x = Math.cos(angle), z = Math.sin(angle);
    const tangent = new THREE.Euler(0, -angle - Math.PI / 2, 0);
    add(new THREE.BoxGeometry(0.009, 0.086, 0.012), hull, x * 0.222, 0.213, z * 0.222, tangent);
    add(new THREE.BoxGeometry(0.054, 0.022, 0.008), window % 3 === 0 ? amber : cyan, x * 0.16, 0.213, z * 0.16, tangent);
  }

  // Observation cupola with crossed structural arches and visible interior deck.
  add(new THREE.CylinderGeometry(0.183, 0.183, 0.025, 32), armor, 0, 0.284, 0);
  add(new THREE.SphereGeometry(0.18, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), glass, 0, 0.298, 0);
  for (let rib = 0; rib < 4; rib++) {
    add(new THREE.TorusGeometry(0.182, 0.005, 5, 40, Math.PI), hull, 0, 0.298, 0, new THREE.Euler(0, rib * Math.PI / 4, 0));
  }
  add(new THREE.TorusGeometry(0.181, 0.004, 5, 48), cyan, 0, 0.30, 0, horizontalRing);
  add(new THREE.CylinderGeometry(0.057, 0.07, 0.04, 16), frame, 0, 0.321, 0);
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.007, 16), cyan, 0, 0.345, 0);
  add(new THREE.CylinderGeometry(0.007, 0.011, 0.18, 8), gold, -0.13, 0.39, -0.14);
  add(new THREE.SphereGeometry(0.017, 8, 6), amber, -0.13, 0.485, -0.14);

  // Rear solar/radiator wings leave the forward docking approach unobstructed.
  for (const sign of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.019, 0.019, 0.78, 8), frame, sign * 0.595, -0.012, -0.1, alongX);
    add(new THREE.BoxGeometry(0.34, 0.018, 0.43), solar, sign * 0.76, -0.008, -0.1);
    for (let row = 0; row <= 10; row++) add(new THREE.BoxGeometry(0.342, 0.006, 0.004), gold, sign * 0.76, 0.006, -0.315 + row * 0.043);
    for (const dx of [-0.172, -0.085, 0, 0.085, 0.172]) add(new THREE.BoxGeometry(0.004, 0.006, 0.435), frame, sign * 0.76 + dx, 0.006, -0.1);
    add(new THREE.BoxGeometry(0.012, 0.009, 0.435), cyan, sign * 0.939, 0.008, -0.1);
    add(new THREE.SphereGeometry(0.011, 8, 6), amber, sign * 0.983, -0.012, -0.1);
  }

  // Three recessed berths, each with a broad pad, gantry and sequential beacons.
  // Main berth center: (0, -0.14, 0.82); its unobstructed approach is from +Z.
  for (const [bay, x] of [-0.23, 0, 0.23].entries()) {
    add(new THREE.BoxGeometry(0.17, 0.04, 0.49), frame, x, -0.175, 0.66);
    add(new THREE.BoxGeometry(0.136, 0.006, 0.43), armor, x, -0.152, 0.684);
    for (const edge of [-1, 1]) {
      add(new THREE.BoxGeometry(0.012, 0.062, 0.49), hull, x + edge * 0.079, -0.146, 0.66);
      add(new THREE.BoxGeometry(0.004, 0.006, 0.447), cyan, x + edge * 0.071, -0.112, 0.681);
      add(new THREE.BoxGeometry(0.018, 0.116, 0.028), hull, x + edge * 0.079, -0.097, 0.884);
      add(new THREE.BoxGeometry(0.006, 0.099, 0.032), cyan, x + edge * 0.068, -0.097, 0.884);
      for (let beacon = 0; beacon < 5; beacon++) {
        add(new THREE.BoxGeometry(0.02, 0.007, 0.013), amber, x + edge * 0.059, -0.145, 0.53 + beacon * 0.073);
      }
    }
    add(new THREE.BoxGeometry(0.176, 0.02, 0.028), hull, x, -0.031, 0.884);
    add(new THREE.BoxGeometry(0.136, 0.005, 0.032), cyan, x, -0.043, 0.884);
    add(new THREE.BoxGeometry(0.134, 0.104, 0.023), armor, x, -0.096, 0.435);
    add(new THREE.BoxGeometry(0.085, 0.045, 0.004), cyan, x, -0.077, 0.45);
    for (let stripe = 0; stripe <= bay; stripe++) add(new THREE.BoxGeometry(0.007, 0.004, 0.029), amber, x + (stripe - bay / 2) * 0.017, -0.146, 0.825);
  }

  // Static material batches keep the detailed exterior to eight draw calls.
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
