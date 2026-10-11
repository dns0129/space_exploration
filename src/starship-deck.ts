import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { STATION_OBSTACLES, STATION_ROOMS, STATION_WALLS } from "../shared/station-layout.mjs";
import { createShip } from "./ship-model";

type Point = [number, number, number];

/** Filtered, metre-scale surface finish. No tiled wall/floor images or baked lighting. */
function finish(color: number, metalness: number, roughness: number, grain = 0.025, contact = false) {
  const material = new THREE.MeshStandardMaterial({ color, metalness, roughness, envMapIntensity: 0.65 });
  material.onBeforeCompile = shader => {
    shader.vertexShader = `varying vec3 vFinishPosition;\n${shader.vertexShader}`
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFinishPosition = position;");
    shader.fragmentShader = `varying vec3 vFinishPosition;\n${shader.fragmentShader}`
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        // Fade sub-millimetre machining marks when smaller than a screen pixel.
        vec3 p = vFinishPosition * 850.0;
        float visibility = 1.0 - smoothstep(0.3, 1.2, max(length(dFdx(p)), length(dFdy(p))));
        float brushing = sin(p.x * 1.7 + sin(p.z * 0.07)) * 0.55 + sin(p.z * 2.3) * 0.25;
        roughnessFactor = clamp(roughnessFactor + brushing * ${grain.toFixed(4)} * visibility, 0.12, 1.0);
      `);
    if (contact) {
      // Analytic contact shading follows the actual furniture footprints, not a baked image.
      const distances = STATION_OBSTACLES.map(obstacle => {
        const center = [(obstacle.minX + obstacle.maxX) / 2, (obstacle.minZ + obstacle.maxZ) / 2];
        const half = [(obstacle.maxX - obstacle.minX) / 2, (obstacle.maxZ - obstacle.minZ) / 2];
        return `contactDistance = min(contactDistance, length(max(abs(vFinishPosition.xz - vec2(${center.map(n => n.toFixed(4))})) - vec2(${half.map(n => n.toFixed(4))}), 0.0)));`;
      }).join("\n");
      shader.fragmentShader = shader.fragmentShader.replace("#include <aomap_fragment>", `#include <aomap_fragment>
        float contactDistance = 10.0;
        ${distances}
        float contactShade = mix(0.48, 1.0, smoothstep(0.0, 0.75, contactDistance));
        reflectedLight.indirectDiffuse *= contactShade;
        reflectedLight.indirectSpecular *= contactShade;
        reflectedLight.directDiffuse *= contactShade;
        reflectedLight.directSpecular *= contactShade;
      `);
    }
  };
  material.customProgramCacheKey = () => `starship-finish-${grain}-${contact}`;
  return material;
}

/** Static architecture stays within the existing shared collision footprints. */
export function buildStarshipDeck(scene: THREE.Scene, renderer: THREE.WebGLRenderer,
  textures: Set<THREE.Texture>, projectionMaterial: THREE.Material) {
  RectAreaLightUniformsLib.init();
  const studio = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(studio, 0.06);
  studio.dispose();
  pmrem.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.3;
  scene.add(new THREE.HemisphereLight(0xdce7ed, 0x26333b, 0.35));
  for (const room of STATION_ROOMS) {
    const width = room.maxX - room.minX, length = room.maxZ - room.minZ;
    const light = new THREE.RectAreaLight(0xe4edf2, room.id === "docking" ? 2 : 2.7,
      width * 0.5, length * 0.62);
    light.position.set((room.minX + room.maxX) / 2, room.height - 0.3, (room.minZ + room.maxZ) / 2);
    light.rotation.x = -Math.PI / 2;
    scene.add(light);
  }
  const titanium = finish(0x64717a, 0.82, 0.31, 0.045);
  const ceramic = finish(0x8e979b, 0.22, 0.48);
  const graphite = finish(0x172027, 0.52, 0.4);
  const recess = finish(0x070e13, 0.3, 0.66);
  const deck = finish(0x27323a, 0.38, 0.61, 0.035, true);
  const inset = finish(0x172128, 0.28, 0.69, 0.035, true);
  const brass = finish(0x968064, 0.78, 0.32);
  const fabric = finish(0x354c51, 0.03, 0.92, 0.018);
  const gasket = new THREE.MeshStandardMaterial({ color: 0x05090c, roughness: 0.95 });
  const screen = new THREE.MeshPhysicalMaterial({ color: 0x01070a, metalness: 0, roughness: 0.32,
    clearcoat: 0.28, clearcoatRoughness: 0.22, envMapIntensity: 0.08 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xb6d0d6, roughness: 0.065, metalness: 0,
    transparent: true, opacity: 0.025, depthWrite: false, side: THREE.DoubleSide });
  const luminous = (color: number) => new THREE.MeshBasicMaterial({ color, toneMapped: false });
  const warm = luminous(0xe3d5b8), white = luminous(0xc7d8dd), cyan = luminous(0x70b4c2);
  const cyanDim = luminous(0x1b4858), amber = luminous(0xc89857);
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const part = (geometry: THREE.BufferGeometry, material: THREE.Material, position: Point,
    rotation: Point = [0, 0, 0]) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    flat.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(1, 1, 1)));
    if (flat !== geometry) geometry.dispose();
    const bucket = batches.get(material) ?? [];
    bucket.push(flat); batches.set(material, bucket);
  };
  const box = (size: Point, position: Point, material: THREE.Material, rotation: Point = [0, 0, 0]) =>
    part(new THREE.BoxGeometry(...size), material, position, rotation);
  const bevel = (size: Point, position: Point, material: THREE.Material, radius = 0.045,
    rotation: Point = [0, 0, 0]) => part(new RoundedBoxGeometry(...size, 1, radius), material, position, rotation);
  const ring = (radius: number, thickness: number, position: Point, material: THREE.Material,
    rotation: Point = [Math.PI / 2, 0, 0]) =>
    part(new THREE.TorusGeometry(radius, thickness, 6, 72), material, position, rotation);
  const tube = (radius: number, length: number, position: Point, material: THREE.Material,
    rotation: Point = [0, 0, 0]) => part(new THREE.CylinderGeometry(radius, radius, length, 12), material, position, rotation);
  const strut = (a: Point, b: Point, width: number, depth: number, material: THREE.Material) => {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const geometry = new RoundedBoxGeometry(width, start.distanceTo(end), depth, 1, 0.035);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize()));
    part(geometry, material, start.add(end).multiplyScalar(0.5).toArray());
  };
  // Small, crisp identification plates only; instrumentation below is actual geometry.
  const label = (title: string, subtitle: string, position: Point, width: number,
    rotation: Point = [0, 0, 0]) => {
    const canvas = document.createElement("canvas");
    canvas.width = 2048; canvas.height = 256;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#141e25"; context.fillRect(0, 0, 2048, 256);
    context.fillStyle = "#ced9db"; context.font = "500 90px sans-serif";
    context.fillText(title, 82, 112);
    context.fillStyle = "#82989f"; context.font = "44px sans-serif";
    context.fillText(subtitle, 85, 204);
    context.fillStyle = "#bba27a"; context.fillRect(30, 45, 6, 160);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    textures.add(texture);
    const height = width / 8;
    const offset = new THREE.Vector3(0, 0, -0.048).applyEuler(new THREE.Euler(...rotation));
    bevel([width + 0.1, height + 0.08, 0.06], new THREE.Vector3(...position).add(offset).toArray(), titanium, 0.018, rotation);
    part(new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }), position, rotation);
  };
  // Recessed glass displays, thin vector traces, physical bezel and fasteners.
  const display = (width: number, height: number, position: Point, rotation: Point, variant = 0) => {
    const matrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation));
    const origin = new THREE.Vector3(...position);
    const at = (x: number, y: number, z: number): Point => new THREE.Vector3(x, y, z).applyMatrix4(matrix).add(origin).toArray();
    bevel([width + 0.12, height + 0.12, 0.1], at(0, 0, -0.035), graphite, 0.03, rotation);
    bevel([width + 0.035, height + 0.035, 0.025], at(0, 0, 0.023), gasket, 0.014, rotation);
    bevel([width, height, 0.018], at(0, 0, 0.034), screen, 0.012, rotation);
    const line = (x: number, y: number, w: number, h: number, material = cyan) =>
      box([w, h, 0.002], at(x, y, 0.045), material, rotation);
    const edge = Math.min(width, height) * 0.085;
    line(-width * 0.28, height * 0.35, width * 0.27, edge * 0.24, white);
    line(width * 0.32, height * 0.35, width * 0.12, edge * 0.24, amber);
    line(0, height * 0.24, width * 0.86, edge * 0.12, cyanDim);
    for (let i = 0; i < 5; i++) {
      const x = -width * 0.36 + i * width * 0.18;
      line(x, -height * 0.34, width * 0.095, edge * 0.25, i === variant % 5 ? amber : cyanDim);
    }
    if (variant % 2 === 0) {
      const center = at(-width * 0.2, -height * 0.02, 0.046);
      for (const r of [0.15, 0.25]) ring(height * r, edge * 0.065, center, cyanDim, rotation);
      ring(height * 0.2, edge * 0.075, center, cyan, rotation);
      line(-width * 0.2, -height * 0.02, height * 0.04, height * 0.04, white);
      for (let i = 0; i < 6; i++) {
        line(width * 0.24, height * (0.14 - i * 0.065), width * (0.12 + (i % 3) * 0.045), edge * 0.15,
          i === 3 ? amber : cyan);
      }
    } else {
      for (let i = 0; i < 9; i++) {
        const barHeight = height * (0.12 + Math.sin(i * 1.8 + variant) * 0.045 + i * 0.015);
        line(-width * 0.36 + i * width * 0.09, -height * 0.13 + barHeight / 2,
          width * 0.035, barHeight, i === 7 ? amber : cyan);
      }
      line(0, -height * 0.16, width * 0.82, edge * 0.1, cyanDim);
    }
    for (const side of [-1, 1]) {
      tube(0.008, 0.008, at(side * (width / 2 + 0.028), height / 2 + 0.028, 0.02), titanium,
        [Math.PI / 2 + rotation[0], rotation[1], rotation[2]]);
    }
  };

  for (const room of STATION_ROOMS) {
    const width = room.maxX - room.minX, length = room.maxZ - room.minZ;
    const x = (room.minX + room.maxX) / 2, z = (room.minZ + room.maxZ) / 2;
    box([width, 0.24, length], [x, -0.14, z], recess);
    // Flush raised-edge metal panels, wide service channels and restrained inlays.
    const stepX = room.id === "corridor" ? 2 : 3.5;
    for (let tx = room.minX; tx < room.maxX; tx += stepX) {
      for (let tz = room.minZ; tz < room.maxZ; tz += 4) {
        const w = Math.min(stepX, room.maxX - tx), l = Math.min(4, room.maxZ - tz);
        const px = tx + w / 2, pz = tz + l / 2;
        bevel([w - 0.026, 0.07, l - 0.026], [px, -0.035, pz], deck, 0.016);
        bevel([w - 0.16, 0.012, l - 0.16], [px, -0.004, pz], inset, 0.005);
        for (const s of [-1, 1]) box([0.045, 0.006, Math.min(l - 0.4, 0.28)],
          [px + s * (w / 2 - 0.14), 0.003, pz + l / 2 - 0.25], titanium);
      }
    }
    box([width, 0.2, length], [x, room.height + 0.1, z], recess);
    for (let rib = room.minZ + 1.2; rib < room.maxZ; rib += 4.4) {
      bevel([width - 0.25, 0.2, 0.38], [x, room.height - 0.1, rib], titanium, 0.045);
      for (const side of [-1, 1]) {
        const lightX = x + side * Math.min(width * 0.3, 5.1);
        bevel([0.76, 0.15, 2.65], [lightX, room.height - 0.075, rib + 1.4], graphite, 0.055);
        bevel([0.46, 0.025, 2.35], [lightX, room.height - 0.16, rib + 1.4], white, 0.009);
        // Louver dividers make the fixture a built object instead of a luminous bar.
        for (let i = -1; i <= 1; i++) box([0.48, 0.03, 0.025],
          [lightX, room.height - 0.18, rib + 1.4 + i * 0.65], graphite);
      }
      for (let cx = room.minX + 0.5; cx < room.maxX - 0.5; cx += 3) {
        const w = Math.min(2.8, room.maxX - cx - 0.25);
        if (w > 0) bevel([w, 0.04, Math.min(3.5, room.maxZ - rib)],
          [cx + w / 2, room.height - 0.025, rib + Math.min(3.5, room.maxZ - rib) / 2 + 0.25], graphite, 0.018);
      }
    }
  }
  for (const wall of STATION_WALLS) {
    const length = wall.to - wall.from, center = (wall.from + wall.to) / 2;
    const at = (along: number, y: number, offset = 0): Point => wall.axis === "x"
      ? [wall.fixed + wall.inward * offset, y, along] : [along, y, wall.fixed + wall.inward * offset];
    const size = (span: number, height: number, thickness: number): Point => wall.axis === "x"
      ? [thickness, height, span] : [span, height, thickness];
    const window = wall.roomId === "observation" && wall.axis === "x" && wall.fixed === 27
      || wall.roomId === "control" && wall.axis === "z" && wall.fixed === -40
      || wall.roomId === "docking" && wall.axis === "z" && wall.fixed === 34;
    if (window) {
      bevel(size(length, 0.68, 0.58), at(center, 0.34, -0.04), graphite, 0.07);
      bevel(size(length, 0.32, 0.6), at(center, wall.height - 0.16, -0.04), titanium, 0.06);
      bevel(size(length, 0.12, 0.48), at(center, 0.71, 0.07), titanium, 0.045);
      const panes = Math.ceil(length / 4.7), span = length / panes;
      for (let i = 0; i < panes; i++) {
        const along = wall.from + (i + 0.5) * span;
        box(size(span - 0.16, wall.height - 1.04, 0.025), at(along, (wall.height + 0.4) / 2), glass);
        bevel(size(span - 0.28, 0.33, 0.018), at(along, 0.36, 0.26), inset, 0.008);
        box(size(span - 0.45, 0.012, 0.035), at(along, 0.64, 0.29), cyan);
      }
      for (let i = 0; i <= panes; i++) {
        const along = wall.from + i * span;
        bevel(size(0.2, wall.height, 0.56), at(along, wall.height / 2, -0.02), titanium, 0.055);
        box(size(0.075, wall.height - 0.9, 0.02), at(along, wall.height / 2 + 0.2, 0.28), gasket);
        box(size(0.034, 0.11, 0.025), at(along, 0.94, 0.3), amber);
      }
    } else {
      box(size(length, wall.height, 0.38), at(center, wall.height / 2, -0.1), recess);
      const count = Math.ceil(length / 3.2), span = length / count;
      for (let i = 0; i < count; i++) {
        const along = wall.from + (i + 0.5) * span;
        bevel(size(span - 0.065, wall.height - 0.58, 0.13), at(along, wall.height / 2, 0.1), titanium, 0.035);
        bevel(size(span - 0.16, wall.height - 1.45, 0.06), at(along, wall.height / 2 + 0.17, 0.18), ceramic, 0.025);
        // A shallow service recess breaks up the large pressure-wall panels.
        bevel(size(span * 0.5, 0.28, 0.024), at(along, 2.7, 0.226), graphite, 0.01);
        box(size(span * 0.37, 0.013, 0.027), at(along, 2.72, 0.242), titanium);
        box(size(0.025, 0.055, 0.03), at(along + span * 0.19, 2.67, 0.245), amber);
        bevel(size(span - 0.34, 0.52, 0.022), at(along, 0.51, 0.22), graphite, 0.01);
        // Recessed ventilation slots and removable panel locks.
        for (let slot = 0; slot < 5; slot++) box(size(span * 0.48, 0.012, 0.024),
          at(along, 0.36 + slot * 0.061, 0.235), recess);
        for (const s of [-1, 1]) {
          box(size(0.055, 0.16, 0.025), at(along + s * (span / 2 - 0.18), 1.45, 0.222), graphite);
          box(size(0.015, 0.055, 0.028), at(along + s * (span / 2 - 0.18), 1.45, 0.24), brass);
        }
        box(size(span - 0.38, 0.055, 0.1), at(along, wall.height - 0.47, 0.17), recess);
        box(size(span - 0.65, 0.015, 0.025), at(along, wall.height - 0.49, 0.24), warm);
      }
      bevel(size(length, 0.18, 0.3), at(center, wall.height - 0.18, 0.13), graphite, 0.035);
    }
    bevel(size(length, 0.12, 0.23), at(center, 0.08, 0.17), graphite, 0.025);
  }
  // Low-output guide strips, inset into a continuous central service spine.
  for (const side of [-1, 1]) {
    box([0.12, 0.008, 51], [side * 1.1, 0.003, -1.5], gasket);
    box([0.025, 0.008, 51], [side * 1.1, 0.007, -1.5], cyan);
  }
  for (let z = -15; z < 23; z += 4) {
    for (const side of [-1, 1]) box([0.035, 0.007, 0.34], [side * 0.12, 0.008, z], cyan, [0, side * 0.58, 0]);
  }
  for (const z of [-18, 12]) {
    for (const side of [-1, 1]) {
      bevel([0.25, 3.65, 0.52], [side * 2.87, 1.825, z], graphite, 0.05);
      bevel([0.12, 3.35, 0.57], [side * 2.8, 1.78, z], titanium, 0.03);
      strut([side * 2.85, 3.45, z], [side * 2.25, 4.02, z], 0.24, 0.5, titanium);
      box([0.035, 0.32, 0.045], [side * 2.7, 2.85, z + 0.3], amber);
    }
    bevel([4.6, 0.23, 0.55], [0, 4.04, z], titanium, 0.04);
    const ceiling = z === 12 ? 6 : 4.8;
    box([6, ceiling - 4.16, 0.4], [0, (ceiling + 4.16) / 2, z], graphite);
    box([5.4, 0.012, 0.36], [0, 0.006, z], titanium);
  }
  // Octagonal overhead ribs keep the corridor readable without narrowing its floor.
  for (let z = -14; z < 12; z += 5.2) {
    for (const side of [-1, 1]) {
      strut([side * 2.82, 3.3, z], [side * 2.22, 4.08, z], 0.18, 0.22, titanium);
      bevel([0.15, 0.72, 0.23], [side * 2.8, 3.18, z], titanium, 0.03);
    }
  }
  bevel([0.28, 0.3, 24], [3, 4.1, -2], graphite, 0.045);
  bevel([0.24, 0.14, 23.6], [3.02, 3.86, -2], titanium, 0.035);
  // A cantilever bracket carries the sign over the open observation entrance.
  bevel([0.2, 0.36, 0.12], [3.08, 3.77, -2], titanium, 0.025);
  label("02  /  COMMAND", "驾驶室    ·    FLIGHT OPERATIONS", [0, 3.69, -17.68], 2.85);
  label("01  /  HANGAR", "停泊区    ·    SHUTTLE BAY", [0, 3.69, 11.68], 2.85, [0, Math.PI, 0]);
  label("03  /  OBSERVATORY", "观测舱    ·    PANORAMIC LOUNGE", [3.27, 3.65, -2], 3.25, [0, -Math.PI / 2, 0]);

  // Hangar: tie-down berth, gantry, side-wall lockers; the walking aisle stays clear.
  bevel([10.3, 0.04, 10.2], [-6.2, 0.012, 25], graphite, 0.012);
  for (const side of [-1, 1]) {
    box([0.035, 0.013, 10.2], [-6.2 + side * 5.2, 0.042, 25], amber);
    box([10.4, 0.013, 0.035], [-6.2, 0.042, 25 + side * 5.1], amber);
    for (let i = 0; i < 8; i++) box([0.1, 0.015, 0.38], [-6.2 + side * 4.75, 0.045, 21.4 + i], brass, [0, 0.6, 0]);
    bevel([0.24, 0.34, 12], [-6.2 + side * 4, 5.4, 25], titanium, 0.04);
    for (const z of [22, 28]) {
      bevel([0.52, 0.06, 0.65], [-6.2 + side * 3.9, 0.055, z], titanium, 0.02);
      ring(0.12, 0.025, [-6.2 + side * 3.9, 0.1, z], brass);
    }
  }
  bevel([8.4, 0.3, 0.4], [-6.2, 5.25, 25], graphite, 0.045);
  const shuttle = createShip();
  shuttle.group.scale.setScalar(4.8);
  shuttle.group.position.set(-6.2, shuttle.landingFootOffset * 4.8, 25);
  shuttle.gear.visible = true; shuttle.exhaust.visible = false;
  scene.add(shuttle.group);
  ring(1.4, 0.018, [0, 0.027, 24], amber);
  label("TERRA  /  DECK 01", "远航星舰    ·    CREW ACCESS", [9.2, 2.8, 12.27], 3.5);
  for (let z = 15; z < 31; z += 3) {
    bevel([0.26, 2.25, 2.64], [13.82, 1.3, z], graphite, 0.05);
    bevel([0.025, 2.07, 1.15], [13.67, 1.3, z - 0.62], titanium, 0.012);
    bevel([0.025, 2.07, 1.15], [13.67, 1.3, z + 0.62], titanium, 0.012);
    box([0.045, 0.25, 0.055], [13.64, 1.35, z - 0.1], brass);
    box([0.045, 0.025, 0.14], [13.64, 2.08, z], cyan);
  }

  // Command island: faceted plinth, metallic lip, lens array and restrained projection.
  bevel([6.3, 0.16, 5.7], [0, 0.08, -30.5], recess, 0.06);
  bevel([5.4, 0.92, 4.8], [0, 0.58, -30.5], titanium, 0.17);
  bevel([5.5, 0.35, 4.9], [0, 0.49, -30.5], graphite, 0.08);
  bevel([6.3, 0.13, 5.7], [0, 1.105, -30.5], titanium, 0.06);
  bevel([6.05, 0.055, 5.45], [0, 1.19, -30.5], graphite, 0.025);
  ring(1.38, 0.055, [0, 1.235, -30.5], brass);
  ring(1.23, 0.017, [0, 1.245, -30.5], cyan);
  tube(1.14, 0.025, [0, 1.23, -30.5], screen);
  for (let i = 0; i < 12; i++) {
    const angle = i * Math.PI / 6;
    tube(0.08, 0.025, [Math.cos(angle) * 1.05, 1.255, -30.5 + Math.sin(angle) * 1.05], cyanDim);
  }
  for (const side of [-1, 1]) display(1.7, 0.5, [0, 1.245, -30.5 + side * 2.2], [-Math.PI / 2, 0, side < 0 ? Math.PI : 0], 1);
  const projection = new THREE.Group();
  projection.position.set(0, 2.45, -30.5);
  projection.add(new THREE.Mesh(new THREE.SphereGeometry(0.92, 64, 40), projectionMaterial));
  const orbit = new THREE.Mesh(new THREE.TorusGeometry(1.19, 0.006, 6, 96), cyan);
  orbit.rotation.x = Math.PI / 2.3; projection.add(orbit);
  scene.add(projection);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.07, 1.2, 40, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x57a8b5, transparent: true, opacity: 0.028,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  beam.position.set(0, 1.86, -30.5); scene.add(beam);
  for (const side of [-1, 1]) {
    for (const [index, z] of [-24.1, -29.5, -35.1].entries()) {
      bevel([3.7, 0.12, 3.2], [side * 11.1, 0.06, z], recess, 0.04);
      bevel([3.4, 0.84, 2.65], [side * 11.1, 0.53, z - 0.1], graphite, 0.14);
      bevel([3.65, 0.18, 2.9], [side * 11.1, 1.02, z], titanium, 0.07);
      display(2.7, 1.6, [side * 11.1, 1.17, z - 0.28], [-Math.PI / 2 + 0.15, 0, 0], index);
      // Stowed operator seat remains inside the same console collision footprint.
      bevel([1.05, 0.17, 0.66], [side * 11.1, 0.64, z + 1.17], fabric, 0.065);
      bevel([1.1, 0.54, 0.13], [side * 11.1, 0.93, z + 1.4], graphite, 0.045);
      tube(0.09, 0.55, [side * 11.1, 0.32, z + 1.17], titanium);
    }
  }
  // The helm is low and tilted, leaving the forward view free of a billboard.
  bevel([4.45, 0.64, 0.82], [0, 0.32, -38.7], graphite, 0.11);
  bevel([4.6, 0.12, 0.86], [0, 0.75, -38.7], titanium, 0.045);
  for (const [i, x] of [-1.32, 0, 1.32].entries()) display(1.14, 0.47,
    [x, 1.02, -38.64], [-0.65, 0, 0], i);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) bevel([0.18, 0.045, 0.11], [side * (0.7 + i * 0.27), 0.85, -38.32],
      i === 0 ? brass : graphite, 0.018);
    tube(0.07, 0.18, [side * 2.08, 0.94, -38.64], graphite, [0.2, 0, side * -0.2]);
    bevel([0.14, 0.085, 0.18], [side * 2.1, 1.05, -38.63], titanium, 0.032);
  }
  ring(0.68, 0.012, [0, 0.012, -36], brass);
  label("TERRA  /  FLIGHT CONTROL", "NAVIGATION   ·   PROPULSION   ·   ATTITUDE", [0, 0.57, -38.275], 2.1);
  label("COMMAND  /  02", "驾驶室    ·    SYSTEMS ONLINE", [-13.73, 2.9, -20.5], 2.8, [0, Math.PI / 2, 0]);

  // Lounge furniture: upholstered modules, seams, aluminium supports and a real backrest.
  bevel([9.9, 0.12, 1.85], [16, 0.18, 7.5], graphite, 0.045);
  for (const x of [11.5, 14.5, 17.5, 20.5]) bevel([0.14, 0.32, 1.6], [x, 0.29, 7.5], titanium, 0.025);
  for (let i = 0; i < 5; i++) {
    const x = 12 + i * 2;
    bevel([1.9, 0.22, 1.57], [x, 0.55, 7.4], fabric, 0.075);
    bevel([1.9, 0.7, 0.23], [x, 0.93, 8.23], fabric, 0.075, [-0.12, 0, 0]);
    box([1.7, 0.008, 0.008], [x, 0.666, 6.7], brass);
  }
  for (const x of [11.13, 20.87]) bevel([0.22, 0.22, 1.8], [x, 0.75, 7.5], titanium, 0.06);
  label("OBSERVATORY  /  03", "观测舱    ·    PANORAMIC DECK", [14, 3.4, -13.72], 4.2);

  // One draw per material for the rigid deck; no per-frame reconstruction.
  for (const [material, geometries] of batches) {
    const geometry = mergeGeometries(geometries);
    geometries.forEach(item => item.dispose());
    if (geometry) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = "Starship deck / manufactured surfaces";
      scene.add(mesh);
    }
  }
  return { environment, projection };
}
