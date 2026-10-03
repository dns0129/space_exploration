import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Original compact explorer: swept wings, twin nacelles and an illuminated canopy. */
export function createShip() {
  const group = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: "#d2d6cc", metalness: 0.35, roughness: 0.48 });
  const dark = new THREE.MeshStandardMaterial({ color: "#23313e", metalness: 0.5, roughness: 0.36 });
  const trim = new THREE.MeshStandardMaterial({ color: "#c27c39", metalness: 0.4, roughness: 0.4 });
  const glass = new THREE.MeshStandardMaterial({ color: "#20475b", emissive: "#123846", emissiveIntensity: 0.6, metalness: 0.7, roughness: 0.18 });
  const lights = new THREE.MeshBasicMaterial({ color: "#8cf2e5" });
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const part = (geometry: THREE.BufferGeometry, material: THREE.Material, position = new THREE.Vector3(), rotation = new THREE.Euler(), scale = new THREE.Vector3(1, 1, 1)) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    flat.applyMatrix4(new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(rotation), scale));
    if (flat !== geometry) geometry.dispose();
    const batch = batches.get(material) ?? [];
    batch.push(flat);
    batches.set(material, batch);
  };
  const box = (size: number[], position: number[], material: THREE.Material, roll = 0) =>
    part(new THREE.BoxGeometry(...size as [number, number, number]), material,
      new THREE.Vector3(...position as [number, number, number]), new THREE.Euler(0, 0, roll));
  part(new THREE.CylinderGeometry(0.11, 0.18, 0.85, 12), hull, new THREE.Vector3(), new THREE.Euler(-Math.PI / 2, 0, 0));
  part(new THREE.ConeGeometry(0.112, 0.34, 12), hull, new THREE.Vector3(0, 0, -0.58), new THREE.Euler(-Math.PI / 2, 0, 0));
  box([0.18, 0.055, 0.72], [0, -0.14, -0.02], dark);
  part(new THREE.CircleGeometry(0.18, 12), dark, new THREE.Vector3(0, 0, 0.427));
  box([0.18, 0.12, 0.015], [0, 0, 0.438], trim);
  for (let vent = 0; vent < 4; vent++) box([0.15, 0.01, 0.01], [0, -0.04 + vent * 0.027, 0.449], dark);
  part(new THREE.SphereGeometry(0.13, 16, 12), glass, new THREE.Vector3(0, 0.115, -0.2), new THREE.Euler(), new THREE.Vector3(0.78, 0.62, 1.75));
  box([0.014, 0.022, 0.37], [0, 0.185, -0.2], trim);
  for (const side of [-1, 1]) {
    const wing = new THREE.Shape();
    wing.moveTo(side * 0.13, -0.26);
    wing.lineTo(side * 1.0, 0.15);
    wing.lineTo(side * 0.87, 0.37);
    wing.lineTo(side * 0.16, 0.23);
    wing.closePath();
    part(new THREE.ExtrudeGeometry(wing, { depth: 0.032, bevelEnabled: false }), hull,
      new THREE.Vector3(0, -0.02, 0), new THREE.Euler(Math.PI / 2, 0, 0));
    box([0.28, 0.015, 0.11], [side * 0.64, -0.006, 0.17], trim);
    box([0.06, 0.045, 0.22], [side * 0.94, 0, 0.14], dark);
    part(new THREE.CylinderGeometry(0.075, 0.1, 0.56, 12), hull,
      new THREE.Vector3(side * 0.48, 0.015, 0.18), new THREE.Euler(-Math.PI / 2, 0, 0));
    part(new THREE.CylinderGeometry(0.082, 0.082, 0.1, 12), dark,
      new THREE.Vector3(side * 0.48, 0.015, 0.46), new THREE.Euler(Math.PI / 2, 0, 0));
    part(new THREE.TorusGeometry(0.082, 0.012, 6, 16), trim, new THREE.Vector3(side * 0.48, 0.015, 0.51));
    box([0.024, 0.06, 0.09], [side * 0.11, 0.145, 0.25], trim, side * 0.2);
    for (let vent = 0; vent < 4; vent++) box([0.1, 0.008, 0.014], [side * 0.19, 0.145, 0.12 + vent * 0.04], dark);
    part(new THREE.SphereGeometry(0.018, 8, 6), lights, new THREE.Vector3(side * 0.97, 0.035, 0.14));
  }
  // Static hull details share five draw calls instead of one call per panel.
  for (const [material, geometry] of batches) {
    const merged = mergeGeometries(geometry)!;
    geometry.forEach((part) => part.dispose());
    group.add(new THREE.Mesh(merged, material));
  }
  const exhaust = new THREE.Group();
  exhaust.position.z = 0.51;
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 1.6, 3), transparent: true,
    opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending });
  const flames: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const flame = new THREE.ConeGeometry(0.075, 0.6, 12).toNonIndexed();
    flame.rotateX(Math.PI / 2).translate(side * 0.48, 0.015, 0.3);
    flames.push(flame);
  }
  exhaust.add(new THREE.Mesh(mergeGeometries(flames)!, glow));
  flames.forEach((geometry) => geometry.dispose());
  group.add(exhaust);
  const gear = new THREE.Group();
  for (const [x, z] of [[-0.42, 0.15], [0.42, 0.15], [0, -0.4]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.021, 0.24, 8), dark);
    leg.position.set(x, -0.25, z);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.025, 0.15), trim);
    foot.position.set(x, -0.38, z);
    gear.add(leg, foot);
  }
  gear.visible = false;
  group.add(gear);
  return { group, exhaust, gear };
}
