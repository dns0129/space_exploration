import * as THREE from "three";
export function createShip() {
  const group = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({
    color: "#b4c6d2",
    metalness: 0.2,
    roughness: 0.45,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: "#182c40",
    metalness: 0.6,
    roughness: 0.25,
  });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.14, 0.7, 12), [
    hull,
    hull,
    dark,
  ]);
  body.rotation.x = -Math.PI / 2;
  group.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.061, 0.22, 12), hull);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -0.46;
  group.add(nose);
  const wingShape = new THREE.Shape();
  wingShape.moveTo(-0.13, -0.2);
  wingShape.lineTo(-0.65, 0.28);
  wingShape.lineTo(-0.22, 0.35);
  wingShape.lineTo(0.22, 0.35);
  wingShape.lineTo(0.65, 0.28);
  wingShape.lineTo(0.13, -0.2);
  wingShape.closePath();
  const wings = new THREE.Mesh(
    new THREE.ExtrudeGeometry(wingShape, { depth: 0.028, bevelEnabled: false }),
    hull,
  );
  wings.rotation.x = Math.PI / 2;
  group.add(wings);
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), dark);
  cockpit.scale.set(0.65, 0.55, 1.6);
  cockpit.position.set(0, 0.07, -0.13);
  group.add(cockpit);
  const glow = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.08, 1.5, 3),
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const exhaust = new THREE.Group();
  for (const x of [-0.17, 0.17]) {
    const engine = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.06, 0.2, 12),
      dark,
    );
    engine.rotation.x = Math.PI / 2;
    engine.position.set(x, 0, 0.3);
    group.add(engine);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.6, 12), glow);
    flame.rotation.x = Math.PI / 2;
    flame.position.set(x, 0, 0.66);
    exhaust.add(flame);
  }
  group.add(exhaust);
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 8, 8),
    new THREE.MeshBasicMaterial({ color: "#78e5ff" }),
  );
  beacon.position.set(0, 0.07, -0.5);
  group.add(beacon);
  return { group, exhaust };
}
