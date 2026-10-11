import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

type Point = [number, number, number];

/** Original axial expedition ship inspired by the supplied ring-and-spine concept.
 * No image maps: seams, ribs, tanks, fasteners and glazing are actual geometry.
 * -Z is the bow; every point remains inside the navigation model's unit sphere.
 */
export function createStarshipHull() {
  const group = new THREE.Group();
  group.name = "TERRA / axial ring expedition vessel";
  const metal = (color: number, metalness: number, roughness: number) => {
    const material = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    material.onBeforeCompile = shader => {
      shader.vertexShader = `varying vec3 vHullPosition;\n${shader.vertexShader}`
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHullPosition = position;");
      shader.fragmentShader = `varying vec3 vHullPosition;\n${shader.fragmentShader}`
        .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
          vec3 p = vHullPosition * 42000.0;
          float filtered = 1.0 - smoothstep(0.3, 1.2, max(length(dFdx(p)), length(dFdy(p))));
          roughnessFactor = clamp(roughnessFactor + sin(p.z + sin(p.x * 0.03)) * 0.035 * filtered, 0.18, 1.0);
        `);
    };
    material.customProgramCacheKey = () => "terra-hull-filtered-machining-v1";
    return material;
  };
  const titanium = metal(0x909a9e, 0.62, 0.34);
  const armor = metal(0x4c575e, 0.55, 0.43);
  const graphite = metal(0x222c33, 0.42, 0.48);
  const recess = metal(0x0a1015, 0.24, 0.65);
  const ceramic = metal(0xb2bab9, 0.18, 0.52);
  const bronze = metal(0x958269, 0.7, 0.37);
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x15343d, metalness: 0.12, roughness: 0.13,
    clearcoat: 1, clearcoatRoughness: 0.06, emissive: 0x163941, emissiveIntensity: 0.16, side: THREE.DoubleSide });
  const cyan = new THREE.MeshBasicMaterial({ color: 0x9bdde7, toneMapped: false });
  const amber = new THREE.MeshBasicMaterial({ color: 0xd1a56a, toneMapped: false });
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, position: Point = [0, 0, 0], rotation: Point = [0, 0, 0]) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    flat.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(1, 1, 1)));
    const bucket = batches.get(material) ?? [];
    bucket.push(flat); batches.set(material, bucket);
  };
  const box = (size: Point, position: Point, material: THREE.Material, rotation: Point = [0, 0, 0]) =>
    add(new THREE.BoxGeometry(...size), material, position, rotation);
  const bevel = (size: Point, position: Point, material: THREE.Material, radius = 0.002, rotation: Point = [0, 0, 0]) =>
    add(new RoundedBoxGeometry(...size, 1, radius), material, position, rotation);
  const cylinder = (top: number, bottom: number, length: number, position: Point, material: THREE.Material, segments = 64) =>
    add(new THREE.CylinderGeometry(top, bottom, length, segments), material, position, [Math.PI / 2, 0, 0]);
  const torus = (radius: number, tube: number, z: number, material: THREE.Material, x = 0, y = 0) =>
    add(new THREE.TorusGeometry(radius, tube, 8, 128), material, [x, y, z]);
  const spar = (a: Point, b: Point, width: number, depth: number, material: THREE.Material) => {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const geometry = new RoundedBoxGeometry(width, start.distanceTo(end), depth, 1, Math.min(width, depth) * 0.12);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize()));
    add(geometry, material, start.add(end).multiplyScalar(0.5).toArray());
  };
  const panel = (points: Point[], material: THREE.Material, both = false) => {
    const vertices: number[] = [];
    for (let i = 1; i < points.length - 1; i++) vertices.push(...points[0], ...points[i], ...points[i + 1]);
    if (both) for (let i = 1; i < points.length - 1; i++) vertices.push(...points[0], ...points[i + 1], ...points[i]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(vertices.length / 3 * 2), 2));
    geometry.computeVertexNormals(); add(geometry, material);
  };
  const annulus = (inner: number, outer: number, depth: number, z: number, material: THREE.Material,
    start = 0, end = Math.PI * 2) => {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, outer, start, end, false);
    if (end - start >= Math.PI * 2 - 0.001) {
      const hole = new THREE.Path(); hole.absarc(0, 0, inner, 0, Math.PI * 2, true); shape.holes.push(hole);
    } else {
      shape.lineTo(Math.cos(end) * inner, Math.sin(end) * inner);
      shape.absarc(0, 0, inner, end, start, true); shape.closePath();
    }
    add(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.0015,
      bevelSize: 0.0015, bevelSegments: 2,
      curveSegments: Math.max(3, Math.ceil((end - start) / (Math.PI * 2) * 96)), steps: 1 }), material, [0, 0, z - depth / 2]);
  };

  // Deep rectangular-section ring, segmented pressure modules and separate rim pipes.
  annulus(0.315, 0.408, 0.073, -0.275, graphite);
  for (const z of [-0.319, -0.231]) {
    for (let i = 0; i < 32; i++) {
      const a = i * Math.PI / 16 + 0.009, b = (i + 1) * Math.PI / 16 - 0.009;
      annulus(0.325, 0.4, 0.012, z, i % 4 === 0 ? titanium : armor, a, b);
      const angle = (a + b) / 2;
      for (const radius of [0.337, 0.387]) cylinder(0.0023, 0.0023, 0.002,
        [Math.cos(angle) * radius, Math.sin(angle) * radius, z + (z < -0.275 ? -0.009 : 0.009)], bronze, 8);
    }
    torus(0.318, 0.0024, z, titanium); torus(0.405, 0.0025, z, titanium);
  }
  for (let i = 0; i < 32; i++) {
    const angle = i * Math.PI / 16;
    bevel([0.017, 0.018, 0.07], [Math.cos(angle) * 0.411, Math.sin(angle) * 0.411, -0.275],
      titanium, 0.002, [0, 0, angle - Math.PI / 2]);
  }
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI / 4 + i * Math.PI / 2;
    const radial = (r: number, z: number): Point => [Math.cos(angle) * r, Math.sin(angle) * r, z];
    spar(radial(0.105, -0.272), radial(0.318, -0.275), 0.025, 0.034, armor);
    spar(radial(0.11, -0.21), radial(0.318, -0.248), 0.01, 0.01, titanium);
    spar(radial(0.15, -0.295), radial(0.305, -0.295), 0.006, 0.009, bronze);
    box([0.012, 0.005, 0.012], radial(0.414, -0.323), amber, [0, 0, angle]);
  }

  // Narrow forward neck, faceted spear bow and five-piece sloping bridge canopy.
  cylinder(0.072, 0.078, 0.28, [0, 0, -0.46], graphite);
  for (const z of [-0.577, -0.535, -0.373]) {
    cylinder(0.079, 0.079, 0.016, [0, 0, z], titanium); torus(0.081, 0.0028, z, bronze);
  }
  const sections = [
    { z: -0.961, w: 0.005, lo: -0.004, hi: 0.003 },
    { z: -0.837, w: 0.043, lo: -0.02, hi: 0.018 },
    { z: -0.736, w: 0.082, lo: -0.031, hi: 0.053 },
    { z: -0.593, w: 0.066, lo: -0.036, hi: 0.045 },
  ];
  const cross = (s: typeof sections[number]): Point[] => [
    [-s.w * 0.7, s.hi, s.z], [s.w * 0.7, s.hi, s.z], [s.w, s.hi * 0.4, s.z],
    [s.w * 0.86, s.lo, s.z], [-s.w * 0.86, s.lo, s.z], [-s.w, s.hi * 0.4, s.z],
  ];
  for (let s = 0; s < sections.length - 1; s++) {
    const a = cross(sections[s]), b = cross(sections[s + 1]);
    for (let face = 0; face < a.length; face++) panel([a[face], b[face], b[(face + 1) % a.length], a[(face + 1) % a.length]], face < 2 ? ceramic : armor);
  }
  panel(cross(sections[3]).reverse(), graphite);
  // The forward panes follow the same angular, sloped canopy as the walkable bridge.
  for (const side of [-1, 1]) {
    panel([[side * 0.003, 0.022, -0.827], [side * 0.036, 0.022, -0.827],
      [side * 0.053, 0.055, -0.737], [side * 0.003, 0.055, -0.737]], glass);
    panel([[side * 0.039, 0.023, -0.813], [side * 0.072, 0.031, -0.735],
      [side * 0.055, 0.055, -0.733]], glass);
    spar([side * 0.003, 0.024, -0.827], [side * 0.003, 0.057, -0.736], 0.0025, 0.0025, graphite);
    spar([side * 0.037, 0.024, -0.827], [side * 0.055, 0.057, -0.736], 0.0025, 0.0025, titanium);
    // Thin radiator wings behind the bridge, including exposed root structure.
    panel([[side * 0.058, -0.011, -0.64], [side * 0.151, -0.008, -0.531],
      [side * 0.055, -0.011, -0.563]], titanium, true);
    spar([side * 0.071, -0.008, -0.63], [side * 0.13, -0.005, -0.55], 0.003, 0.003, graphite);
    bevel([0.006, 0.008, 0.03], [side * 0.058, 0.035, -0.667], cyan);
  }

  // Long segmented service spine: ribs, inset armor, pipes and maintenance rails.
  cylinder(0.104, 0.107, 0.87, [0, 0, 0.19], recess, 64);
  for (let segment = 0; segment < 7; segment++) {
    const z = -0.173 + segment * 0.113;
    for (let side = 0; side < 8; side++) {
      const angle = side * Math.PI / 4, x = Math.sin(angle), y = Math.cos(angle);
      bevel([0.075, 0.023, 0.104], [x * 0.105, y * 0.105, z], side % 3 === 0 ? titanium : armor, 0.003, [0, 0, -angle]);
      bevel([0.059, 0.0025, 0.076], [x * 0.118, y * 0.118, z], graphite, 0.001, [0, 0, -angle]);
      box([0.016, 0.002, 0.008], [x * 0.12, y * 0.12, z - 0.031], bronze, [0, 0, -angle]);
    }
    torus(0.116, 0.0045, z + 0.055, graphite);
  }
  for (const angle of [Math.PI / 4, Math.PI * 3 / 4, Math.PI * 5 / 4, Math.PI * 7 / 4]) {
    const x = Math.sin(angle) * 0.129, y = Math.cos(angle) * 0.129;
    cylinder(0.0038, 0.0038, 0.79, [x, y, 0.2], titanium, 12);
    cylinder(0.0018, 0.0018, 0.76, [x * 1.075, y * 1.075, 0.2], bronze, 8);
  }
  for (const side of [-1, 1]) {
    bevel([0.165, 0.009, 0.292], [side * 0.199, -0.048, 0.29], graphite, 0.002);
    for (let i = 0; i < 11; i++) box([0.15, 0.003, 0.004], [side * 0.199, -0.041, 0.165 + i * 0.025], titanium);
    spar([side * 0.075, -0.035, 0.22], [side * 0.264, -0.048, 0.29], 0.008, 0.008, armor);
  }
  // Communications mast with a dish, articulated booms and compact sensor pods.
  spar([0, 0.1, 0.025], [0, 0.235, 0.025], 0.024, 0.024, titanium);
  bevel([0.079, 0.008, 0.047], [0, 0.24, 0.025], ceramic);
  spar([-0.05, 0.12, 0.35], [-0.072, 0.219, 0.35], 0.008, 0.008, titanium);
  add(new THREE.SphereGeometry(0.034, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), ceramic,
    [-0.072, 0.218, 0.35], [0, 0, -0.4]);

  // Bulbous reactor/drive assembly and the two prominent upper propellant tanks.
  add(new THREE.SphereGeometry(0.151, 64, 32), titanium, [0, 0, 0.661]);
  cylinder(0.171, 0.157, 0.206, [0, 0, 0.808], graphite, 96);
  for (let i = 0; i < 36; i++) {
    const angle = i * Math.PI / 18;
    bevel([0.013, 0.011, 0.182], [Math.sin(angle) * 0.166, Math.cos(angle) * 0.166, 0.81],
      armor, 0.002, [0, 0, -angle]);
  }
  for (const z of [0.722, 0.782, 0.866, 0.915]) torus(0.171, 0.004, z, titanium);
  cylinder(0.143, 0.143, 0.011, [0, 0, 0.918], recess, 96);
  torus(0.13, 0.006, 0.925, bronze);
  cylinder(0.099, 0.112, 0.018, [0, 0, 0.934], graphite, 64);
  torus(0.085, 0.004, 0.944, cyan);
  cylinder(0.079, 0.079, 0.003, [0, 0, 0.944], cyan, 64);
  cylinder(0.055, 0.055, 0.004, [0, 0, 0.948], graphite, 64);
  torus(0.037, 0.003, 0.952, cyan);
  cylinder(0.029, 0.029, 0.003, [0, 0, 0.953], recess, 48);
  for (let i = 0; i < 20; i++) {
    const a = i * Math.PI / 10;
    spar([Math.sin(a) * 0.052, Math.cos(a) * 0.052, 0.952],
      [Math.sin(a + 0.08) * 0.083, Math.cos(a + 0.08) * 0.083, 0.946], 0.0025, 0.003, titanium);
  }
  for (const side of [-1, 1]) {
    spar([side * 0.077, 0.086, 0.59], [side * 0.108, 0.194, 0.635], 0.023, 0.023, graphite);
    add(new THREE.SphereGeometry(0.082, 48, 32), ceramic, [side * 0.112, 0.194, 0.635]);
    torus(0.082, 0.0026, 0.635, titanium, side * 0.112, 0.194);
    cylinder(0.012, 0.012, 0.021, [side * 0.112, 0.194, 0.72], bronze, 16);
    bevel([0.144, 0.012, 0.055], [side * 0.214, -0.051, 0.662], ceramic, 0.002, [0, side * 0.12, side * -0.1]);
    box([0.009, 0.009, 0.017], [side * 0.278, -0.045, 0.68], amber);
  }

  let surface!: THREE.Mesh;
  for (const [material, geometries] of batches) {
    const merged = mergeGeometries(geometries);
    geometries.forEach(geometry => geometry.dispose());
    if (!merged) throw new Error("Incompatible starship hull attributes");
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = "TERRA hull / " + (material === glass ? "bridge glazing" : "manufactured geometry");
    group.add(mesh);
    if (material === titanium) surface = mesh;
  }
  return { group, surface };
}

/** Small analytical HDR reflection probe for broad celestial/albedo fill.
 * This is lighting, never a tiled or magnified surface image. PMREM supplies
 * continuous reflections at each material's actual roughness. Shared by hulls.
 */
export function createStarshipReflection(renderer: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  const geometry = new THREE.SphereGeometry(5, 24, 16);
  const material = new THREE.ShaderMaterial({ side: THREE.BackSide,
    vertexShader: `varying vec3 direction;
      void main(){ direction = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 direction;
      void main(){
        vec3 d = normalize(direction);
        float albedo = smoothstep(-0.25, 0.65, dot(d, normalize(vec3(-0.4, 0.7, 0.25))));
        vec3 energy = mix(vec3(0.14, 0.17, 0.2), vec3(0.88, 0.94, 1.0), albedo);
        gl_FragColor = vec4(energy, 1.0);
      }` });
  scene.add(new THREE.Mesh(geometry, material));
  const generator = new THREE.PMREMGenerator(renderer);
  const target = generator.fromScene(scene, 0, 0.1, 10);
  generator.dispose(); geometry.dispose(); material.dispose();
  return target;
}
