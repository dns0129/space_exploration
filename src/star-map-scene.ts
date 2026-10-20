import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GalaxySky } from "./galaxy-sky";
import type { HdrPipeline } from "./hdr-pipeline";
import { getBody } from "./solar-system";
import type { BodyId } from "./solar-system";
import type { PlanetModel } from "./planet-models";
import { MAP_SYSTEMS, mapPrimary, mapBodies, mapChildren, isMapStar } from "./star-map-data";
import type { MapSelection, MapTarget } from "./star-map-data";

type Node = {
  key: string; body: BodyId; target: MapTarget; root: THREE.Group; visual?: THREE.Group;
  position: THREE.Vector3; radius: number; currentRadius: number; orbit: number; phase: number;
  live: boolean; label: HTMLButtonElement; materials: [THREE.ShaderMaterial, THREE.ShaderMaterial][]; loading?: Promise<void>;
};

/** One renderer and one RAF, shared with flight and detailed observation. */
export class StarMapScene {
  active = false;
  paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 600);
  private readonly controls: OrbitControls;
  private readonly sky = new GalaxySky(true);
  private readonly nodes = new Map<string, Node>();
  private readonly rings = new THREE.Group();
  private readonly sphere = new THREE.SphereGeometry(1, 48, 32);
  private readonly ringGeometry = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 193 }, (_, i) =>
    new THREE.Vector3(Math.cos(i / 192 * Math.PI * 2), 0, Math.sin(i / 192 * Math.PI * 2))));
  private readonly ringMaterial = new THREE.LineBasicMaterial({ color: 0x6fa2bb, transparent: true, opacity: 0.21, depthWrite: false });
  private readonly raycaster = new THREE.Raycaster();
  private readonly point = new THREE.Vector3();
  private readonly desiredCamera = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private selection: MapSelection = { group: "solar" };
  private flat = false;
  private moving = true;
  private width = 1;
  private height = 1;
  private extent = 16;
  private destroyed = false;
  private dirty = true;
  private readonly lastPosition = new THREE.Vector3();
  private readonly lastQuaternion = new THREE.Quaternion();
  private pointer?: { id: number; x: number; y: number; moved: boolean };

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly hdr: HdrPipeline, private readonly labels: HTMLElement,
    texture: THREE.Texture, private readonly modelFor: (id: BodyId) => Promise<PlanetModel>,
    private readonly select: (target: MapTarget) => void) {
    this.sky.setTexture(texture);
    this.sky.setView([0.2, 0.45, -0.1], 0.38);
    this.scene.add(this.sky.mesh, this.rings, new THREE.AmbientLight(0x9eb8d2, 0.35));
    const light = new THREE.DirectionalLight(0xfff2de, 2.5);
    light.position.set(-3, 6, 5);
    this.scene.add(light);
    this.camera.position.set(0, 42, 45);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.45;
    this.controls.zoomSpeed = 0.6;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 180;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener("start", () => { this.moving = false; });
    renderer.domElement.addEventListener("pointerdown", this.pointerDown);
    renderer.domElement.addEventListener("pointermove", this.pointerMove);
    renderer.domElement.addEventListener("pointerup", this.pointerUp);
    renderer.domElement.addEventListener("pointercancel", this.pointerCancel);
  }

  show(selection: MapSelection) {
    this.active = true;
    this.controls.enabled = true;
    this.selection = selection;
    this.dirty = true;
    for (const node of this.nodes.values()) { node.live = false; node.label.hidden = true; }
    for (const line of this.rings.children) if (line.userData.ownedGeometry) (line as THREE.Line).geometry.dispose();
    this.rings.clear();
    this.rings.scale.setScalar(this.reducedMotion.matches ? 1 : 0.85);
    if (selection.galaxy) {
      for (const system of MAP_SYSTEMS) {
        this.node(`system:${system.id}`, mapPrimary(system.id), new THREE.Vector3(...system.position),
          system.id === "betelgeuse" ? 0.85 : 0.55, { body: mapPrimary(system.id), group: system.id });
      }
      const points = MAP_SYSTEMS.slice(1).flatMap(system => [new THREE.Vector3(), new THREE.Vector3(...system.position)]);
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.LineSegments(geometry, this.ringMaterial);
      line.userData.ownedGeometry = true;
      this.rings.add(line);
      this.extent = 13;
    } else if (selection.parent) {
      const children = mapChildren(selection.parent).sort((a, b) => (a.orbitRadiusKm ?? 0) - (b.orbitRadiusKm ?? 0));
      this.node(selection.parent, selection.parent, new THREE.Vector3(), 1.6, { body: selection.parent });
      children.forEach((body, i) => {
        const orbit = children.length === 1 ? 5.4 : 3.8 + i * 1.65;
        const phase = 0.5 + i * 2.399;
        this.node(body.id, body.id, new THREE.Vector3(Math.cos(phase) * orbit, 0, Math.sin(phase) * orbit),
          body.kind === "station" ? 0.3 : 0.29 + Math.min(0.19, body.radiusKm / 22000), { body: body.id }, orbit, phase);
        this.ring(orbit);
      });
      this.extent = Math.max(6, 4.8 + (children.length - 1) * 1.65);
    } else {
      const bodies = mapBodies(selection.group).filter(body => !body.parentId);
      if (selection.group === "solar") bodies.sort((a, b) => a.distanceFromSunMillionKm - b.distanceFromSunMillionKm);
      const primary = mapPrimary(selection.group);
      this.node(primary, primary, new THREE.Vector3(), selection.group === "black-hole" ? 0.35 : 1, { body: primary });
      let order = 0;
      for (const body of bodies) {
        if (body.id === primary) continue;
        const orbit = 3.1 + order * 1.65;
        const phase = 0.35 + order * 2.399;
        this.node(body.id, body.id, new THREE.Vector3(Math.cos(phase) * orbit, Math.sin(order * 2.3) * 0.12,
          Math.sin(phase) * orbit), isMapStar(body.id) ? 0.65 : body.radiusKm > 20000 ? 0.53 : 0.32,
        { body: body.id }, orbit, phase);
        this.ring(orbit);
        order++;
      }
      this.extent = Math.max(5, 3.9 + (order - 1) * 1.65);
    }
    this.reset();
    this.labels.dataset.level = selection.galaxy ? "galaxy" : selection.parent ? "orbit" : "system";
    this.labels.dataset.group = selection.group;
    this.labels.dataset.parent = selection.parent ?? "";
  }

  private node(key: string, body: BodyId, position: THREE.Vector3, radius: number, target: MapTarget, orbit = 0, phase = 0) {
    let node = this.nodes.get(key);
    if (!node) {
      const label = document.createElement("button");
      label.type = "button";
      label.className = "map-node";
      label.dataset.mapBody = body;
      label.style.setProperty("--node-color", getBody(body).color);
      label.innerHTML = '<span class="map-node-hit" aria-hidden="true"></span><span class="map-node-copy"><b></b><small></small></span>';
      const root = new THREE.Group();
      root.position.copy(position).multiplyScalar(0.65);
      node = { key, body, target, root, position, radius, currentRadius: 0, orbit, phase, live: true, label, materials: [] };
      this.nodes.set(key, node);
      const ownedNode = node;
      label.addEventListener("click", () => { if (this.active && ownedNode.live) this.select(ownedNode.target); });
      this.labels.append(label);
      this.scene.add(root);
    }
    node.position.copy(position);
    node.radius = radius;
    node.orbit = orbit;
    node.phase = phase;
    node.target = target;
    node.live = true;
    node.label.hidden = false;
    node.label.querySelector("b")!.textContent = target.group ? MAP_SYSTEMS.find(system => system.id === target.group)!.name : getBody(body).name;
    node.label.querySelector("small")!.textContent = target.group ? MAP_SYSTEMS.find(system => system.id === target.group)!.type
      : isMapStar(body) ? "中心天体" : this.selection.parent === body ? getBody(body).tags[0]
        : this.selection.parent ? getBody(body).kind === "station" ? "轨道设施" : "天然卫星" : `${mapChildren(body).filter(item => item.kind !== "station").length} 颗已收录卫星`;
    node.label.setAttribute("aria-label", target.group ? `进入${MAP_SYSTEMS.find(system => system.id === target.group)!.name}`
      : isMapStar(body) || this.selection.parent ? `查看${getBody(body).name}` : `进入${getBody(body).name}轨道`);
    node.label.dataset.central = String(orbit === 0 && !target.group);
    if (!node.visual && !node.loading) {
      const current = node;
      node.loading = this.modelFor(body).then(model => {
        if (this.destroyed) return;
        const visual = model.group.clone(true);
        visual.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return;
          if (object.geometry instanceof THREE.SphereGeometry) {
            const radius = object.geometry.parameters.radius;
            object.geometry = this.sphere;
            object.scale.multiplyScalar(radius);
          }
          const clone = (material: THREE.Material) => {
            const copy = material.clone();
            if (copy instanceof THREE.ShaderMaterial && material instanceof THREE.ShaderMaterial) {
              // Uniform cloning must not duplicate GPU textures for every map occurrence.
              for (const [name, uniform] of Object.entries(material.uniforms))
                if (uniform.value instanceof THREE.Texture) copy.uniforms[name].value = uniform.value;
              current.materials.push([copy, material]);
            }
            return copy;
          };
          object.material = Array.isArray(object.material) ? object.material.map(clone) : clone(object.material);
        });
        current.visual = visual;
        current.root.add(visual);
        this.dirty = true;
        delete current.label.dataset.loading;
      }).catch(() => {
        if (!this.destroyed) {
          current.label.dataset.loading = "error";
          current.label.querySelector("small")!.textContent = "材质未加载 · 可点击重试";
        }
      }).finally(() => { current.loading = undefined; });
      node.label.dataset.loading = "true";
    }
  }

  private ring(radius: number) {
    const ring = new THREE.Line(this.ringGeometry, this.ringMaterial);
    ring.scale.setScalar(radius);
    this.rings.add(ring);
  }

  setProjection(flat: boolean) {
    this.flat = flat;
    this.controls.enableRotate = !flat;
    this.controls.mouseButtons.LEFT = flat ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    this.controls.touches.ONE = flat ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
    this.reset();
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.camera.aspect = width / Math.max(height, 1);
    // Keep the orbital centre in the clear part of the viewport beside the dossier.
    const sidePanel = width > 760 || width > height;
    this.camera.setViewOffset(width, height, sidePanel ? -145 : 0, sidePanel ? 0 : 115, width, height);
    this.camera.updateProjectionMatrix();
    this.reset();
  }

  reset() {
    const sidePanel = this.width > 760 || this.width > this.height;
    const availableWidth = Math.max(160, this.width - (sidePanel ? 340 : 48));
    const availableHeight = Math.max(140, this.height - (sidePanel ? 170 : 340));
    const lens = 1 / Math.tan(THREE.MathUtils.degToRad(21));
    const fit = Math.max(3, this.height / availableWidth * lens + 0.72, this.height / availableHeight * lens + 0.3);
    const distance = this.extent * fit;
    this.desiredCamera.set(0, this.flat ? distance : distance * 0.7, this.flat ? 0.001 : distance * 0.714);
    this.moving = true;
  }

  zoom(factor: number) {
    this.desiredCamera.copy(this.camera.position).sub(this.controls.target).multiplyScalar(factor).clampLength(6, 180);
    this.moving = true;
  }

  hide() { this.active = false; this.controls.enabled = false; this.pointer = undefined; }

  update(delta: number) {
    const step = this.reducedMotion.matches ? 1 : 1 - Math.exp(-delta * 6);
    this.rings.scale.lerp(this.point.setScalar(1), step);
    if (this.moving) {
      this.controls.target.lerp(this.center, step);
      this.camera.position.lerp(this.desiredCamera, step);
      if (this.camera.position.distanceToSquared(this.desiredCamera) < 0.0001) this.moving = false;
    }
    this.controls.update();
    this.camera.updateMatrixWorld();
    const moved = this.camera.position.distanceToSquared(this.lastPosition) > 1e-10
      || 1 - Math.abs(this.camera.quaternion.dot(this.lastQuaternion)) > 1e-10;
    this.lastPosition.copy(this.camera.position);
    this.lastQuaternion.copy(this.camera.quaternion);
    if (this.paused && !this.moving && !this.dirty && !moved) return;
    this.dirty = false;
    for (const node of this.nodes.values()) {
      node.currentRadius = THREE.MathUtils.lerp(node.currentRadius, node.live ? node.radius : 0, step);
      node.root.visible = node.currentRadius > 0.002;
      if (!node.root.visible) continue;
      if (node.live && node.orbit && !this.paused) {
        node.phase += delta * 0.025 / Math.sqrt(node.orbit);
        node.position.x = Math.cos(node.phase) * node.orbit;
        node.position.z = Math.sin(node.phase) * node.orbit;
      }
      node.root.position.lerp(node.position, step);
      node.root.scale.setScalar(node.currentRadius);
      if (node.visual && !this.paused) node.visual.rotation.y += delta * 0.025;
      for (const [material, source] of node.materials) {
        const uniforms = material.uniforms;
        // Quality/layer updates replace source maps; map views keep the same live imagery.
        for (const [name, uniform] of Object.entries(source.uniforms))
          if (name !== "planetCenter" && name !== "bodyRadius" && name !== "uTime") uniforms[name].value = uniform.value;
        if (uniforms.planetCenter) uniforms.planetCenter.value.copy(node.root.position);
        if (uniforms.bodyRadius) uniforms.bodyRadius.value = node.currentRadius;
        if (!this.paused && uniforms.uTime) uniforms.uTime.value += delta;
      }
      if (!node.live) continue;
      this.point.copy(node.root.position).project(this.camera);
      const x = (this.point.x * 0.5 + 0.5) * this.width;
      const y = (-this.point.y * 0.5 + 0.5) * this.height;
      const visible = this.point.z < 1 && this.point.z > -1 && x > 8 && x < this.width - 8 && y > 45 && y < this.height - 25;
      node.label.hidden = !visible;
      node.label.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0)`;
      const pixels = node.currentRadius / this.camera.position.distanceTo(node.root.position) * this.height / (2 * Math.tan(THREE.MathUtils.degToRad(21)));
      node.label.style.setProperty("--node-radius", `${Math.max(10, pixels).toFixed(1)}px`);
    }
    this.hdr.setBridgeLook(false);
    this.hdr.begin();
    try { this.renderer.render(this.scene, this.camera); }
    finally { this.hdr.finish(); }
    this.renderer.domElement.dataset.renderMode = "star-map";
    this.renderer.domElement.dataset.mapProjection = this.flat ? "2d" : "3d";
    this.renderer.domElement.dataset.mapMoving = String(this.moving);
  }

  private pointerDown = (event: PointerEvent) => {
    if (!this.active) return;
    if (this.pointer) { this.pointer.moved = true; return; }
    this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  };
  private pointerMove = (event: PointerEvent) => {
    if (this.pointer && Math.hypot(event.clientX - this.pointer.x, event.clientY - this.pointer.y) > 8) this.pointer.moved = true;
  };
  private pointerCancel = () => { this.pointer = undefined; };
  private pointerUp = (event: PointerEvent) => {
    const pointer = this.pointer;
    this.pointer = undefined;
    if (!this.active || !pointer || pointer.id !== event.pointerId || pointer.moved) return;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1,
      1 - (event.clientY - bounds.top) / bounds.height * 2), this.camera);
    const hits = this.raycaster.intersectObjects([...this.nodes.values()].filter(node => node.live).map(node => node.root), true);
    if (!hits.length) return;
    const node = [...this.nodes.values()].find(candidate => {
      let root: THREE.Object3D | null = hits[0].object;
      while (root && root !== candidate.root) root = root.parent;
      return root === candidate.root;
    });
    if (node?.live) this.select(node.target);
  };

  dispose() {
    this.destroyed = true;
    this.controls.dispose();
    this.sky.dispose();
    this.sphere.dispose();
    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
    for (const child of this.rings.children) if (child.userData.ownedGeometry) (child as THREE.Line).geometry.dispose();
    for (const node of this.nodes.values()) {
      node.visual?.traverse(object => {
        if (object instanceof THREE.Mesh) for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
      });
      node.label.remove();
    }
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.pointerDown);
    canvas.removeEventListener("pointermove", this.pointerMove);
    canvas.removeEventListener("pointerup", this.pointerUp);
    canvas.removeEventListener("pointercancel", this.pointerCancel);
  }
}
