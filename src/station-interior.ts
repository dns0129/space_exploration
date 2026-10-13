import * as THREE from "three";
import type { StationVisitState } from "../shared/flight-state.mjs";
import { STATION_HELM, STATION_SPAWN, STATION_ROOMS, stationWalkable, stationZone, stationHeadroom } from "../shared/station-layout.mjs";
import type { FlightInput, ShipDynamics } from "./ship-dynamics";
import { buildStarshipDeck } from "./starship-deck";
import type { StarshipInstruments } from "./starship-instruments";
import type { LightingQuality } from "./lighting-quality";
import type { StellarSample } from "./stellar-light";
import type { PlanetBounce } from "./bridge-lighting";

const EYE_HEIGHT_M = 1.65;
const MAX_FOOT_HEIGHT_M = 2.4;
type Point = [number, number, number];

/** Separate metre-scale scene: the astronomical station never becomes a walkable planet. */
export class StationInterior {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(68, 1, 0.06, 2600);
  readonly positionM = new THREE.Vector3().fromArray(STATION_SPAWN);
  yaw = 0;
  pitch = 0;
  cameraView: "first" | "third" = "first";
  active = false;
  grounded = true;
  piloting = false;
  private readonly velocity = new THREE.Vector3();
  private readonly astronaut = new THREE.Group();
  private readonly limbs: THREE.Group[] = [];
  private readonly holograms: THREE.Object3D[] = [];
  private readonly textures = new Set<THREE.Texture>();
  private clock = 0;
  private gait = 0;
  private jumpHeld = false;
  private built = false;
  private readonly probes = new Map<string, THREE.WebGLRenderTarget>();
  private readonly sunlight = new THREE.DirectionalLight(0xffffff, 0);
  private readonly secondarySunlight = new THREE.DirectionalLight(0xffffff, 0);
  private readonly lampShadow = new THREE.SpotLight(0xe4edf2, 20, 70, 1.25, 0.85, 2);
  private readonly windowBounce = new THREE.RectAreaLight(0xb6cde3, 0, 23, 2.1);
  private readonly consoleFill = new THREE.RectAreaLight(0x8fc3cf, 18, 4.2, 0.55);
  private finishDetail = { value: 1 };
  private effectLevel = 1;
  private reflectionLevel = 2;
  private roomLights: { id: string; light: THREE.RectAreaLight }[] = [];
  private lightingRoom = "";
  private instruments?: StarshipInstruments;
  private surfaces: THREE.Mesh[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly corner = new THREE.Vector3();
  private readonly viewCorner = new THREE.Vector3();

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  get speedMps() { return Math.hypot(this.velocity.x, this.velocity.z); }
  get distanceToShipM() { return this.positionM.distanceTo(new THREE.Vector3().fromArray(STATION_SPAWN)); }
  get distanceToHelmM() { return this.positionM.distanceTo(new THREE.Vector3().fromArray(STATION_HELM)); }
  get zone() { return stationZone(this.positionM); }

  enter(state?: StationVisitState) {
    if (!this.built) this.build();
    const position = state?.positionM;
    if (position && stationWalkable(position) && position[1] >= 0 && position[1] <= MAX_FOOT_HEIGHT_M)
      this.positionM.fromArray(position);
    else this.positionM.fromArray(STATION_SPAWN);
    this.positionM.y = Math.min(this.positionM.y, this.maximumFootHeight);
    this.yaw = Number.isFinite(state?.yaw) ? state!.yaw : 0;
    this.pitch = THREE.MathUtils.clamp(Number.isFinite(state?.pitch) ? state!.pitch : 0, -1.25, 1.25);
    this.cameraView = state?.camera === "third" ? "third" : "first";
    this.velocity.set(0, 0, 0);
    this.grounded = this.positionM.y <= 0.001;
    this.jumpHeld = false;
    this.active = true;
    this.piloting = state?.piloting ?? false;
    this.updateCamera();
  }

  leave() {
    this.active = false;
    this.piloting = false;
    this.velocity.set(0, 0, 0);
    this.jumpHeld = false;
  }

  snapshot(): StationVisitState | undefined {
    return this.active ? { bodyId: "earth-station", positionM: this.positionM.toArray(),
      yaw: this.yaw, pitch: this.pitch, camera: this.cameraView, vessel: true, piloting: this.piloting } : undefined;
  }

  takeHelm() {
    this.piloting = true;
    this.velocity.set(0, 0, 0);
    this.updateCamera();
  }
  releaseHelm() {
    this.piloting = false;
    this.positionM.fromArray(STATION_HELM);
    this.yaw = 0;
    this.pitch = 0;
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.jumpHeld = false;
    this.updateCamera();
  }

  setCamera(view: "first" | "third") {
    this.cameraView = view;
    this.updateCamera();
  }

  resize(width: number, height: number) {
    this.camera.aspect = Math.max(1, width) / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  updateInstruments(ship: ShipDynamics, input: FlightInput, time: number) {
    if (!this.instruments?.inView(this.camera)) return false;
    return this.instruments?.update(ship, input, time) ?? false;
  }
  configureLighting(quality: LightingQuality) {
    this.effectLevel = quality.level;
    if (this.reflectionLevel !== quality.reflectionLevel) {
      this.scene.environment = null;
      this.probes.forEach(probe => probe.dispose()); this.probes.clear();
      this.lightingRoom = ""; this.reflectionLevel = quality.reflectionLevel;
    }
    this.finishDetail.value = Number(quality.level > 0);
    for (const light of [this.sunlight, this.lampShadow]) {
      if (!quality.shadowsEnabled) { light.shadow.map?.dispose(); light.shadow.map = null; }
      if (light.shadow.mapSize.x === quality.shadowSize) continue;
      light.shadow.map?.dispose(); light.shadow.map = null;
      light.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
    }
  }
  updateLighting(samples: StellarSample[], rotation: THREE.Quaternion, bounce?: PlanetBounce) {
    if (!this.built) return;
    const inverse = rotation.clone().invert();
    for (const [index, light] of [this.sunlight, this.secondarySunlight].entries()) {
      const sample = samples[index];
      light.target.position.copy(this.positionM).setY(1.5);
      const direction = sample?.direction.clone().applyQuaternion(inverse) ?? new THREE.Vector3(0, 1, 0);
      light.position.copy(light.target.position).addScaledVector(direction, 130);
      light.color.copy(sample?.color ?? new THREE.Color(0xffffff));
      light.intensity = 2.8 * (sample?.energy ?? 0) * (sample?.visibility ?? 0);
    }
    const room = STATION_ROOMS.find(room => this.positionM.x >= room.minX && this.positionM.x <= room.maxX
      && this.positionM.z >= room.minZ && this.positionM.z <= room.maxZ) ?? STATION_ROOMS[0];
    const bridge = room.id === "control";
    const incoming = bounce?.direction.clone().applyQuaternion(inverse);
    // A broad window source is a bounded diffuse-bounce approximation. Only
    // Earth's illuminated disc in front of the bridge can supply this light.
    const windowFacing = incoming ? THREE.MathUtils.smoothstep(-incoming.z, 0.12, 0.65) : 0;
    this.windowBounce.intensity = bounce ? Math.min(1.8, Math.sqrt(Math.max(0, bounce.irradiance)) * 6) * windowFacing : 0;
    this.windowBounce.visible = bridge && this.windowBounce.intensity > 0.001;
    if (bounce) this.windowBounce.color.copy(bounce.color);
    this.consoleFill.visible = bridge && this.effectLevel > 0;
    this.lampShadow.color.set(bridge ? 0xffe0bb : 0xe4edf2);
    this.lampShadow.intensity = 20;
    this.renderer.domElement.dataset.earthshine = this.windowBounce.visible ? this.windowBounce.intensity.toFixed(3) : "0";
    this.lampShadow.position.set((room.minX + room.maxX) / 2, room.height - 0.25, (room.minZ + room.maxZ) / 2);
    this.lampShadow.target.position.set(this.lampShadow.position.x, 0, this.lampShadow.position.z);
    this.lampShadow.shadow.needsUpdate = this.lampShadow.shadow.map === null
      || room.id !== this.lightingRoom || this.cameraView === "third";
    if (this.reflectionLevel > 0 && room.id !== this.lightingRoom) {
      // Capture actual architecture and lamps once per visited room; never bake
      // moving celestial sunlight or recursively reflect an existing probe.
      let probe = this.probes.get(room.id);
      if (!probe) {
        const generator = new THREE.PMREMGenerator(this.renderer);
        const enabled = this.renderer.shadowMap.enabled, env = this.scene.environment;
        const visible = this.surfaces.map(mesh => mesh.visible);
        const celestial = [this.sunlight.visible, this.secondarySunlight.visible, this.lampShadow.visible, this.windowBounce.visible];
        const consoleVisible = this.consoleFill.visible;
        const detail = this.finishDetail.value;
        const lamps = this.roomLights.map(({ light }) => light.visible);
        try {
          this.renderer.shadowMap.enabled = false; this.scene.environment = null;
          this.surfaces.forEach(mesh => { mesh.visible = true; });
          this.sunlight.visible = this.secondarySunlight.visible = this.lampShadow.visible = false;
          this.windowBounce.visible = false;
          this.consoleFill.visible = room.id === "control";
          this.finishDetail.value = 0;
          this.roomLights.forEach(({ light }) => { light.visible = true; });
          probe = generator.fromScene(this.scene, 0.04, 0.05, 150, { size: this.reflectionLevel === 3 ? 128 : this.reflectionLevel === 2 ? 64 : 32,
            position: new THREE.Vector3(this.lampShadow.position.x, 1.8, this.lampShadow.position.z) });
          this.probes.set(room.id, probe);
        } finally {
          generator.dispose(); this.renderer.shadowMap.enabled = enabled; this.scene.environment = env;
          this.surfaces.forEach((mesh, index) => { mesh.visible = visible[index]; });
          [this.sunlight.visible, this.secondarySunlight.visible, this.lampShadow.visible, this.windowBounce.visible] = celestial;
          this.consoleFill.visible = consoleVisible;
          this.finishDetail.value = detail;
          this.roomLights.forEach(({ light }, index) => { light.visible = lamps[index]; });
        }
      }
      this.scene.environment = probe.texture;
      this.lightingRoom = room.id;
      this.renderer.domElement.dataset.interiorProbe = room.id;
    }
    if (this.reflectionLevel === 0) {
      this.scene.environment = null; this.renderer.domElement.dataset.interiorProbe = "off";
    }
    // Only the current room and its connecting corridor contribute local lamps.
    for (const { id, light } of this.roomLights) light.visible = id === room.id || id === "corridor";
  }

  private get maximumFootHeight() {
    return Math.min(MAX_FOOT_HEIGHT_M, stationHeadroom(this.positionM) - EYE_HEIGHT_M - 0.16);
  }

  step(delta: number, input: FlightInput) {
    if (!this.active || this.piloting || !Number.isFinite(delta)) return;
    const duration = THREE.MathUtils.clamp(delta, 0, 0.25);
    if (!duration) return;
    if (input.brake && !this.jumpHeld && this.grounded) {
      this.velocity.y = 4.5;
      this.grounded = false;
    }
    this.jumpHeld = input.brake;
    for (let remaining = duration; remaining > 1e-9; remaining -= 1 / 120) {
      const dt = Math.min(remaining, 1 / 120);
      this.yaw += THREE.MathUtils.clamp(input.yaw - input.mouseX, -1, 1) * 1.8 * dt;
      this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
      this.pitch = THREE.MathUtils.clamp(this.pitch + (input.pitch - input.mouseY) * 1.3 * dt, -1.25, 1.25);
      const forward = THREE.MathUtils.clamp(input.throttle, -1, 1);
      const strafe = THREE.MathUtils.clamp(input.strafe, -1, 1);
      const wish = new THREE.Vector3(strafe, 0, -forward).clampLength(0, 1)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).multiplyScalar(input.boost ? 5.5 : 2.8);
      const response = 1 - Math.exp(-dt * (this.grounded ? 9 : 3));
      this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, wish.x, response);
      this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, wish.z, response);
      // Fixed small substeps and axis sliding prevent tunnelling at doors and furniture.
      const next = this.positionM.clone();
      next.x += this.velocity.x * dt;
      if (stationWalkable(next)) this.positionM.x = next.x;
      else this.velocity.x = 0;
      next.copy(this.positionM);
      next.z += this.velocity.z * dt;
      if (stationWalkable(next)) this.positionM.z = next.z;
      else this.velocity.z = 0;
      this.velocity.y -= 9.81 * dt;
      const ceiling = this.maximumFootHeight;
      this.positionM.y = Math.min(ceiling, this.positionM.y + this.velocity.y * dt);
      if (this.positionM.y >= ceiling && this.velocity.y > 0) this.velocity.y = 0;
      this.grounded = this.positionM.y <= 0;
      if (this.grounded) {
        this.positionM.y = 0;
        this.velocity.y = 0;
      }
      this.clock += dt;
      this.gait += this.speedMps * dt * 2.2;
    }
    this.updateCamera();
  }

  updateCamera() {
    if (this.piloting) {
      this.camera.position.set(0, 1.8, -36.8);
      this.camera.quaternion.identity();
      this.astronaut.visible = false;
      this.camera.updateMatrixWorld();
      this.orderSurfaces();
      return;
    }
    const head = this.positionM.clone().add(new THREE.Vector3(0, EYE_HEIGHT_M, 0));
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
    this.camera.quaternion.copy(rotation);
    if (this.cameraView === "first") {
      this.camera.position.copy(head);
      // A subtle stride keeps the horizon steady and never changes the collision capsule.
      if (this.grounded) this.camera.position.y += Math.sin(this.gait * 2) * 0.018 * Math.min(1, this.speedMps);
    } else {
      const backward = new THREE.Vector3(0, 0.45, 4.2).applyQuaternion(rotation);
      const desired = head.clone().add(backward);
      // Sweep the complete camera segment, including walls and furniture corners.
      let fraction = 1;
      const samples = Math.ceil(backward.length() / 0.12);
      for (let sample = 1; sample <= samples; sample++) {
        const test = head.clone().lerp(desired, sample / samples);
        if (!stationWalkable(test, 0.2) || test.y < 0.25 || test.y > stationHeadroom(test) - 0.22) {
          fraction = Math.max(0, (sample - 1) / samples);
          break;
        }
      }
      this.camera.position.copy(head).lerp(desired, fraction);
      this.camera.lookAt(head.clone().add(new THREE.Vector3(0, -0.2, -5).applyQuaternion(rotation)));
    }
    this.astronaut.visible = this.active && this.cameraView === "third";
    this.astronaut.position.copy(this.positionM);
    this.astronaut.rotation.y = this.yaw;
    for (let index = 0; index < this.limbs.length; index++) {
      this.limbs[index].rotation.x = Math.sin(this.gait + (index % 2) * Math.PI)
        * Math.min(0.55, this.speedMps * 0.12) * (this.grounded ? 1 : 0.25) * (index < 2 ? 1 : -0.7);
    }
    for (let index = 0; index < this.holograms.length; index++)
      this.holograms[index].rotation.y = this.clock * (index % 2 ? -0.12 : 0.08);
    this.camera.updateMatrixWorld();
    this.orderSurfaces();
  }

  private orderSurfaces() {
    // Draw nearby opaque architecture first so hidden fragments fail the depth
    // test before running the metal finish and area-light shaders. Transparent
    // glazing keeps the renderer's normal back-to-front ordering.
    this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection);
    for (const mesh of this.surfaces) {
      // Off-camera walls still occlude lights. WebGL's own per-camera frustum
      // culling applies independently to the colour and shadow passes.
      mesh.visible = mesh.castShadow || this.frustum.intersectsBox(mesh.geometry.boundingBox!);
      if (!(mesh.material as THREE.Material).transparent)
        mesh.renderOrder = mesh.geometry.boundingSphere!.center.distanceToSquared(this.camera.position);
    }
  }

  /** Conservative screen rectangle enclosing every visible pressure window. */
  windowScissor(width: number, height: number) {
    let minX = 1, minY = 1, maxX = -1, maxY = -1;
    for (const mesh of this.surfaces) {
      if (!mesh.visible || (mesh.material as THREE.Material).name !== "Starship pressure glazing") continue;
      const bounds = mesh.geometry.boundingBox!;
      for (let i = 0; i < 8; i++) {
        this.corner.set(i & 1 ? bounds.max.x : bounds.min.x,
          i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z);
        this.viewCorner.copy(this.corner).applyMatrix4(this.camera.matrixWorldInverse);
        // A window crossing the near plane can cover the whole view. Keep the
        // complete orbital pass rather than clipping a close or third-person view.
        if (this.viewCorner.z >= -this.camera.near) return { x: 0, y: 0, width, height };
        this.corner.applyMatrix4(this.viewProjection);
        minX = Math.min(minX, this.corner.x); minY = Math.min(minY, this.corner.y);
        maxX = Math.max(maxX, this.corner.x); maxY = Math.max(maxY, this.corner.y);
      }
    }
    if (maxX < minX || maxY < minY) return null;
    const x = Math.max(0, Math.floor((minX + 1) * width / 2) - 2);
    const y = Math.max(0, Math.floor((minY + 1) * height / 2) - 2);
    const right = Math.min(width, Math.ceil((maxX + 1) * width / 2) + 2);
    const top = Math.min(height, Math.ceil((maxY + 1) * height / 2) + 2);
    return { x, y, width: right - x, height: top - y };
  }

  /** The control-room projection is decorative; window views use the orbital scene. */
  private hologramMaterial() {
    const material = new THREE.ShaderMaterial({
      vertexShader: `varying vec3 vSphere; varying vec3 vNormal; varying vec3 vView; varying vec2 vUv;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main(){ vUv=uv; vSphere=normalize(position); vNormal=normalize(normalMatrix*normal);
          vec4 p=modelViewMatrix*vec4(position,1.0); vView=-p.xyz; gl_Position=projectionMatrix*p;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        varying vec3 vSphere,vNormal,vView; varying vec2 vUv;
        #include <logdepthbuf_pars_fragment>
        float hash(vec3 p){p=fract(p*0.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
        float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
          return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
            mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1)),f.x),f.y),f.z);}
        float fbm(vec3 p){return noise(p)*0.5+noise(p*2.03)*0.25+noise(p*4.01)*0.125+noise(p*8.07)*0.0625;}
        void main(){
          #include <logdepthbuf_fragment>
          vec3 n=normalize(vSphere); vec3 color;
          float land=fbm(n*3.6+vec3(3.0,7.1,2.0));
          float continents=smoothstep(0.48,0.51,land); float desert=smoothstep(0.55,0.69,fbm(n*6.0+7.0));
          vec3 terrain=mix(vec3(0.085,0.25,0.15),vec3(0.53,0.42,0.24),desert);
          color=mix(vec3(0.015,0.11,0.3),terrain,continents);
          float ice=smoothstep(0.8,0.94,abs(n.y)+noise(n*18.0)*0.06);color=mix(color,vec3(0.84,0.91,0.92),ice);
          float cloud=smoothstep(0.54,0.66,fbm(n*9.0+vec3(8.0,2.0,11.0)));
          color=mix(color,vec3(0.86,0.92,0.95),cloud*0.85);
          float sunlight=smoothstep(-0.2,0.45,dot(n,normalize(vec3(-0.8,0.5,-0.25))));
          color*=0.1+sunlight*1.15;
          float rim=pow(1.0-max(0.0,dot(normalize(vNormal),normalize(vView))),3.5);
          color+=vec3(0.09,0.42,0.8)*rim*0.8;
          float grid=pow(abs(sin(atan(n.z,n.x)*18.0)),180.0)+pow(abs(sin(asin(clamp(n.y,-1.0,1.0))*18.0)),180.0);
          color=color*0.4+vec3(0.07,0.7,0.95)*(0.45+grid*0.5);
          gl_FragColor=vec4(color,1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    return material;
  }

  private build() {
    this.built = true;
    // Keep the actual astronomical background behind the local pressure glazing.
    this.scene.background = null;
    const deck = buildStarshipDeck(this.scene, this.renderer, this.textures, this.hologramMaterial());
    this.roomLights = deck.roomLights;
    this.finishDetail = deck.finishDetail;
    this.instruments = deck.instruments;
    this.surfaces = deck.surfaces;
    this.holograms.push(deck.projection);
    this.buildExterior();
    this.buildAstronaut();
    this.sunlight.castShadow = this.lampShadow.castShadow = true;
    this.lampShadow.shadow.autoUpdate = false;
    this.sunlight.shadow.bias = -0.00015; this.sunlight.shadow.normalBias = 0.03;
    Object.assign(this.sunlight.shadow.camera, { left: -42, right: 42, top: 42, bottom: -42, near: 0.1, far: 260 });
    this.lampShadow.shadow.bias = -0.00015; this.lampShadow.shadow.normalBias = 0.02;
    this.windowBounce.position.set(0, 2.05, -39.88);
    this.windowBounce.lookAt(0, 1.05, -30);
    this.consoleFill.position.set(0, 1.19, -38.48);
    this.consoleFill.lookAt(0, 1.7, -35.2);
    this.scene.add(this.sunlight, this.sunlight.target, this.secondarySunlight, this.secondarySunlight.target,
      this.lampShadow, this.lampShadow.target, this.windowBounce, this.consoleFill);
    // This pass clears the astronomical depth buffer and draws only metre-scale
    // geometry. Fragment-written logarithmic depth disables early depth rejection
    // on some GPUs, shading entire rooms hidden behind the pressure walls.
    // Use ordinary depth consistently for every local surface, including glass,
    // instruments and the shuttle; keep logarithmic depth in the orbital pass.
    const materials = new Set<THREE.Material>();
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh) {
        const list = Array.isArray(object.material) ? object.material : [object.material];
        object.castShadow = list.some(material => !material.transparent && !(material instanceof THREE.MeshBasicMaterial));
        object.receiveShadow = list.some(material => !material.transparent);
        for (const material of Array.isArray(object.material) ? object.material : [object.material])
          materials.add(material);
      }
    });
    for (const material of materials) {
      const compile = material.onBeforeCompile;
      const key = material.customProgramCacheKey();
      material.onBeforeCompile = (shader, renderer) => {
        compile.call(material, shader, renderer);
        const chunks = /#include <logdepthbuf_(?:pars_)?(?:vertex|fragment)>/g;
        shader.vertexShader = shader.vertexShader.replace(chunks, "");
        shader.fragmentShader = shader.fragmentShader.replace(chunks, "");
      };
      material.customProgramCacheKey = () => `${key}/station-linear-depth`;
    }
  }

  private buildExterior() {
    // The ring and aft tanks are visible through the real space-scene windows.
    const hardware = new THREE.MeshStandardMaterial({ color: 0x616d75, metalness: 0.65, roughness: 0.4 });
    const frame = new THREE.MeshStandardMaterial({ color: 0x263139, metalness: 0.45, roughness: 0.5 });
    const ring = new THREE.Shape(); ring.absarc(0, 0, 42, 0, Math.PI * 2, false);
    const hole = new THREE.Path(); hole.absarc(0, 0, 34, 0, Math.PI * 2, true); ring.holes.push(hole);
    const ringMesh = new THREE.Mesh(new THREE.ExtrudeGeometry(ring, { depth: 5.8,
      bevelEnabled: true, bevelSize: 0.15, bevelThickness: 0.15, bevelSegments: 2, curveSegments: 96 }), frame);
    ringMesh.position.z = -11.9; this.scene.add(ringMesh);
    for (const z of [-12.2, -5.8]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(41.8, 0.17, 6, 128), hardware);
      rim.position.z = z; this.scene.add(rim);
    }
    for (const side of [-1, 1]) {
      const tank = new THREE.Mesh(new THREE.SphereGeometry(8, 48, 32), hardware);
      tank.position.set(side * 10, 19, 55); this.scene.add(tank);
      const radiator = new THREE.Mesh(new THREE.BoxGeometry(15, 0.35, 25), frame);
      radiator.position.set(side * 37, -5, 21); this.scene.add(radiator);
      const spar = new THREE.Mesh(new THREE.BoxGeometry(20, 0.7, 1), hardware);
      spar.position.set(side * 26, -5, 21);
      this.scene.add(spar);
    }
  }

  private buildAstronaut() {
    const suit = new THREE.MeshStandardMaterial({ color: 0xd5dfdf, metalness: 0.2, roughness: 0.62 });
    const joint = new THREE.MeshStandardMaterial({ color: 0x172b40, metalness: 0.15, roughness: 0.72 });
    const trim = new THREE.MeshStandardMaterial({ color: 0xc9914e, metalness: 0.25, roughness: 0.5 });
    const visor = new THREE.MeshStandardMaterial({ color: 0x08283b, metalness: 0.85, roughness: 0.14, emissive: 0x082335 });
    const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, position: Point, parent: THREE.Group = this.astronaut) => {
      const item = new THREE.Mesh(geometry, material); item.position.fromArray(position); parent.add(item); return item;
    };
    mesh(new THREE.CapsuleGeometry(0.235, 0.36, 5, 12), suit, [0, 1.13, 0]);
    mesh(new THREE.BoxGeometry(0.4, 0.31, 0.14), trim, [0, 1.25, -0.225]);
    mesh(new THREE.BoxGeometry(0.36, 0.44, 0.24), joint, [0, 1.15, 0.235]);
    mesh(new THREE.SphereGeometry(0.245, 24, 16), suit, [0, 1.63, 0]);
    const glass = mesh(new THREE.SphereGeometry(0.215, 24, 16), visor, [0, 1.65, -0.115]);
    glass.scale.set(0.98, 0.69, 0.52);
    mesh(new THREE.TorusGeometry(0.18, 0.04, 6, 24), joint, [0, 1.43, 0]).rotation.x = Math.PI / 2;
    for (const side of [-1, 1]) {
      const leg = new THREE.Group(); leg.position.set(side * 0.135, 0.77, 0); this.astronaut.add(leg); this.limbs.push(leg);
      mesh(new THREE.CapsuleGeometry(0.1, 0.42, 4, 10), suit, [0, -0.3, 0], leg);
      mesh(new THREE.BoxGeometry(0.21, 0.15, 0.3), joint, [0, -0.69, -0.035], leg);
      mesh(new THREE.CylinderGeometry(0.112, 0.112, 0.12, 10), trim, [0, -0.37, 0], leg);
    }
    for (const side of [-1, 1]) {
      const arm = new THREE.Group(); arm.position.set(side * 0.31, 1.32, 0); this.astronaut.add(arm); this.limbs.push(arm);
      mesh(new THREE.CapsuleGeometry(0.082, 0.34, 4, 10), suit, [0, -0.21, 0], arm);
      mesh(new THREE.SphereGeometry(0.085, 12, 8), joint, [0, -0.47, 0], arm);
    }
    this.astronaut.name = "Walking station astronaut";
    this.scene.add(this.astronaut);
  }

  dispose() {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        geometries.add(object.geometry);
        const list = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of list) materials.add(material);
      }
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    this.textures.forEach(texture => texture.dispose());
    this.textures.clear();
    this.scene.environment = null;
    this.probes.forEach(probe => probe.dispose()); this.probes.clear();
    this.sunlight.shadow.dispose(); this.lampShadow.shadow.dispose();
    this.lightingRoom = ""; this.roomLights = [];
    this.instruments = undefined;
    this.surfaces = [];
    this.scene.clear();
    this.limbs.length = 0;
    this.holograms.length = 0;
    this.astronaut.clear();
    this.built = false;
    this.active = false;
    this.piloting = false;
  }
}
