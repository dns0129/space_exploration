import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EARTH, getBody, STAR_SYSTEMS } from "./solar-system";
import type { BodyId, Layer, SystemId } from "./solar-system";
import { createPlanetModel } from "./planet-models";
import type { PlanetModel } from "./planet-models";
import { bodySystem, systemConfig } from "../shared/world-navigation.mjs";
import { ShipDynamics } from "./ship-dynamics";
import { FlightControls } from "./flight-controls";
import { createShip } from "./ship-model";
import { createWarpEffect } from "./warp-effect";
import { SurfaceScene } from "./surface-scene";
import { projectFlightTarget } from "./flight-target";
import type { FlightTargetStats } from "./flight-target";
import type { FlightState, WorldConfig } from "../shared/flight-state.mjs";

export type View = "overview" | "close" | "night";
export interface SceneStats {
  altitudeKm: number;
  fps: number;
}

export interface FlightStats {
  systemId: SystemId;
  engine: ShipDynamics["engine"];
  environment: ShipDynamics["environment"];
  warpBlockReason: string | null;
  warpPhase: ShipDynamics["warpPhase"];
  warpProgress: number;
  speedKm: number;
  speedLimitKm: number;
  altitudeKm: number;
  nearest: BodyId;
  distanceKm: number;
  target: BodyId;
  heading: number;
  elapsed: number;
  boosting: boolean;
  collision: BodyId | null;
  landingPhase: ShipDynamics["landingPhase"];
  landingBlockReason: string | null;
}
export interface FlightTrackingStats extends FlightTargetStats {
  target: BodyId;
  deceleration: number;
  aimX: number;
  aimY: number;
  steering: boolean;
  width: number;
  height: number;
}

const surfaceVertex = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
    #include <logdepthbuf_vertex>
  }
`;

const surfaceFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D heightMap;
  uniform sampler2D waterMap;
  uniform vec3 sunDirection;
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  void main() {
    vec3 normal = normalize(vNormal);
    // Derivative-based terrain shading keeps mountains subtle at planetary scale.
    float height = texture2D(heightMap, vUv).r;
    vec3 dpdx = dFdx(vWorldPosition);
    vec3 dpdy = dFdy(vWorldPosition);
    vec3 r1 = cross(dpdy, normal);
    vec3 r2 = cross(normal, dpdx);
    float determinant = dot(dpdx, r1);
    vec3 gradient = sign(determinant) * (dFdx(height) * r1 + dFdy(height) * r2);
    vec3 terrainNormal = normalize(abs(determinant) * normal - 0.0025 * gradient);
    float daylight = dot(normal, sunDirection);
    float diffuse = max(dot(terrainNormal, sunDirection), 0.0);
    vec3 day = texture2D(dayMap, vUv).rgb;
    vec3 night = texture2D(nightMap, vUv).rgb;
    float water = texture2D(waterMap, vUv).r;
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    vec3 halfwayDirection = normalize(sunDirection + viewDirection);
    float specular = pow(max(dot(terrainNormal, halfwayDirection), 0.0), 72.0);
    float nightWeight = 1.0 - smoothstep(-0.15, 0.12, daylight);
    vec3 color = day * (0.015 + diffuse * 1.08);
    // Isolate the warm city lights from the blue-tinted night-map terrain.
    float cityLight = max(night.r - night.b * 0.7, 0.0);
    color += vec3(1.0, 0.65, 0.32) * pow(cityLight, 0.7) * nightWeight * 5.0;
    color += vec3(0.9, 0.95, 1.0) * specular * water * smoothstep(0.0, 0.15, daylight) * 0.12;
    float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 4.0);
    color += vec3(0.035, 0.22, 0.55) * rim * smoothstep(-0.3, 0.6, daylight) * 0.35;
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const atmosphereFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform vec3 sunDirection;
  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float facing = abs(dot(normal, viewDirection));
    float glow = pow(1.0 - facing, 4.5);
    float sun = dot(normal, sunDirection);
    float daylight = smoothstep(-0.4, 0.8, sun);
    vec3 blue = mix(vec3(0.035, 0.15, 0.4), vec3(0.2, 0.55, 1.0), daylight);
    vec3 sunset = vec3(0.7, 0.23, 0.065) * exp(-pow(sun * 7.0, 2.0)) * 0.2;
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(blue + sunset, glow * (0.08 + daylight * 0.7));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Owns rendering and GPU resources; UI consumes its public controls and metrics. */
export class SolarScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
  private readonly controls: OrbitControls;
  private readonly planet = new THREE.Group();
  private readonly stars = new THREE.Group();
  private currentModel?: PlanetModel;
  private readonly flightRoot = new THREE.Group();
  private readonly flightSun = new THREE.PointLight(0xfff3e5, 2.5, 0, 0);
  private readonly observeSun = new THREE.DirectionalLight(0xfff3e5, 2.5);
  private readonly ship = createShip();
  private readonly shipScene = new THREE.Scene();
  private readonly shipCamera = new THREE.PerspectiveCamera(58, 1, 0.01, 200);
  private readonly shipSun = new THREE.DirectionalLight(0xfff3e5, 2.5);
  private readonly shipScale = 0.000015 * 0.16;
  private readonly warpEffect = createWarpEffect();
  private readonly surfaceScene = new SurfaceScene();
  private galaxy?: THREE.Texture;
  private readonly backgrounds = new Map<SystemId, THREE.Texture>();
  private backgroundSystem: SystemId = "solar";
  private starsEnabled = true;
  private spacePromise?: Promise<void>;
  private readonly planetMaps = new Map<BodyId, THREE.Texture>();
  private flightModels: PlanetModel[] = [];
  private readonly distantSphere = new THREE.SphereGeometry(1, 32, 24);
  private readonly flightGeometries = new Map<THREE.Mesh, THREE.BufferGeometry>();
  private dynamics?: ShipDynamics;
  private flightControls?: FlightControls;
  private flying = false;
  private flightPaused = false;
  private flightMetrics = 0;
  private flightHandler?: (stats: FlightStats) => void;
  private flightTargetHandler?: (stats: FlightTrackingStats) => void;
  private flightWidth = 1;
  private flightHeight = 1;
  private readonly flightRelative = new THREE.Vector3();
  private readonly flightForward = new THREE.Vector3();
  private flightBoost = 0;
  private readonly bankRotation = new THREE.Quaternion();
  private readonly flightAxis = new THREE.Vector3(0, 0, 1);
  private readonly models = new Map<BodyId, PlanetModel>();
  private readonly sunDirection = new THREE.Vector3(-3, 1.8, 4).normalize();
  private readonly textures = new Set<THREE.Texture>();
  private earthMaps?: THREE.Texture[];
  private earthPromise?: Promise<THREE.Texture[]>;
  private selectionVersion = 0;
  private readonly resizeObserver: ResizeObserver;
  private targetPosition: THREE.Vector3 | null = null;
  private paused = window.matchMedia("(prefers-reduced-motion: reduce)")
    .matches;
  private speed = 1;
  private lastTime = 0;
  private metricsStart = 0;
  private frames = 0;
  private frame = 0;
  private destroyed = false;
  private hidden = document.hidden;
  private readonly visibilityHandler = () => {
    this.hidden = document.hidden;
    this.lastTime = 0;
    this.metricsStart = 0;
    this.frames = 0;
  };

  constructor(
    private readonly container: HTMLElement,
    private readonly onStats: (stats: SceneStats) => void,
    private readonly onError: (message: string) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      logarithmicDepthBuffer: true,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.setAttribute(
      "aria-label",
      "交互式 3D 天体：拖动旋转视角，滚轮或双指缩放",
    );
    this.renderer.domElement.setAttribute("role", "img");
    this.container.append(this.renderer.domElement);
    this.renderer.domElement.addEventListener(
      "webglcontextlost",
      this.contextLost,
    );
    this.camera.position.set(0, 0.3, 3.9);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.25;
    this.controls.maxDistance = 7;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.65;
    this.controls.addEventListener("start", () => {
      this.targetPosition = null;
    });
    this.scene.add(this.planet);
    this.createStars();
    this.scene.add(this.stars);
    this.observeSun.position.set(-3, 1.8, 4);
    this.flightRoot.visible = false;
    this.scene.add(this.surfaceScene.group, this.surfaceScene.sky);
    this.flightSun.visible = false;
    this.shipScene.add(
      this.ship.group,
      this.shipSun,
      new THREE.HemisphereLight(0xc1e6ee, 0x233643, 1.2),
    );
    this.scene.add(
      this.observeSun,
      this.flightSun,
      this.flightRoot,
      this.warpEffect.mesh,
      new THREE.AmbientLight(0x9dbde8, 0.09),
    );
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.resize();
  }

  async selectBody(
    id: BodyId,
    onProgress: (percent: number) => void,
  ): Promise<boolean> {
    this.leaveFlight();
    const version = ++this.selectionVersion;
    await this.loadSpaceTextures();
    const maps =
      id === "earth" ? await this.loadEarthTextures(onProgress) : undefined;
    if (this.destroyed || version !== this.selectionVersion) return false;
    let model = this.models.get(id);
    if (!model) {
      model =
        id === "earth"
          ? this.createEarthModel(maps!)
          : createPlanetModel(getBody(id), this.sunDirection, undefined, this.planetMaps.get(id));
      this.models.set(id, model);
    }
    this.planet.clear();
    this.planet.add(model.group);
    this.currentModel = model;
    this.useSystemBackground(getBody(id).systemId ?? "solar");
    this.controls.maxDistance = id === "saturn" ? 12 : 7;
    this.targetPosition = null;
    this.controls.reset();
    this.camera.position.copy(this.viewPosition("overview"));
    this.controls.update();
    this.renderer.domElement.setAttribute(
      "aria-label",
      `交互式 3D ${model.body.name}：拖动旋转视角，滚轮或双指缩放`,
    );
    this.renderer.compile(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);
    onProgress(100);
    if (!this.frame) this.animate(0);
    return true;
  }

  private loadSpaceTextures(): Promise<void> {
    if (this.galaxy) return Promise.resolve();
    if (this.spacePromise) return this.spacePromise;
    const loader = new THREE.TextureLoader();
    const ids = ["mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune", "sun"] as const;
    const skyFiles = [...new Set(STAR_SYSTEMS.map(system => system.backgroundFile))];
    const files = [...skyFiles, ...ids.map((id) => `${id}-real.jpg`)];
    const batch: THREE.Texture[] = [];
    let failed = false;
    this.spacePromise = Promise.all(files.map(async (file) => {
      const texture = await loader.loadAsync(`${import.meta.env.BASE_URL}textures/${file}`);
      if (this.destroyed || failed) { texture.dispose(); throw new Error("场景已关闭或贴图加载失败"); }
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      batch.push(texture);
      return texture;
    })).then((maps) => {
      maps.forEach((map) => this.textures.add(map));
      for (const system of STAR_SYSTEMS) {
        const texture = maps[skyFiles.indexOf(system.backgroundFile)];
        texture.mapping = THREE.EquirectangularReflectionMapping;
        this.backgrounds.set(system.id as SystemId, texture);
      }
      this.galaxy = this.backgrounds.get("solar");
      this.useSystemBackground("solar");
      ids.forEach((id, i) => this.planetMaps.set(id, maps[i + skyFiles.length]));
    }).catch((error) => {
      failed = true;
      batch.forEach((texture) => texture.dispose());
      throw error;
    }).finally(() => { this.spacePromise = undefined; });
    return this.spacePromise;
  }

  private useSystemBackground(id: SystemId) {
    const system = STAR_SYSTEMS.find(item => item.id === id)!;
    const texture = this.backgrounds.get(id) ?? null;
    const background = this.starsEnabled ? texture : null;
    if (this.backgroundSystem !== id || this.scene.background !== background) {
      this.scene.background = background;
      this.scene.backgroundIntensity = system.backgroundIntensity;
      this.scene.backgroundRotation.fromArray(system.backgroundRotation as [number, number, number]);
    }
    this.backgroundSystem = id;
    this.stars.visible = this.starsEnabled && !texture;
    if (this.renderer.domElement.dataset.system !== id) this.renderer.domElement.dataset.system = id;
    if (this.renderer.domElement.dataset.background !== system.backgroundFile)
      this.renderer.domElement.dataset.background = system.backgroundFile;
  }

  private loadEarthTextures(
    onProgress: (percent: number) => void,
  ): Promise<THREE.Texture[]> {
    if (this.earthMaps) return Promise.resolve(this.earthMaps);
    if (this.earthPromise) return this.earthPromise;
    const loader = new THREE.TextureLoader();
    const files = [
      "earth-day.jpg",
      "earth-night.jpg",
      "earth-height.jpg",
      "earth-water.png",
      "earth-clouds.png",
    ];
    let loaded = 0;
    const batch: THREE.Texture[] = [];
    let failed = false;
    this.earthPromise = Promise.all(
      files.map(async (file) => {
        const texture = await loader.loadAsync(
          `${import.meta.env.BASE_URL}textures/${file}`,
        );
        if (this.destroyed || failed) {
          texture.dispose();
          throw new Error("场景已关闭");
        }
        texture.anisotropy = Math.min(
          this.renderer.capabilities.getMaxAnisotropy(),
          16,
        );
        this.textures.add(texture);
        batch.push(texture);
        onProgress(Math.round((++loaded / files.length) * 100));
        return texture;
      }),
    )
      .then((maps) => {
        maps[0].colorSpace = THREE.SRGBColorSpace;
        maps[1].colorSpace = THREE.SRGBColorSpace;
        maps[4].colorSpace = THREE.SRGBColorSpace;
        this.earthMaps = maps;
        return maps;
      })
      .catch((error) => {
        failed = true;
        batch.forEach((texture) => {
          this.textures.delete(texture);
          texture.dispose();
        });
        throw error;
      })
      .finally(() => {
        this.earthPromise = undefined;
      });
    return this.earthPromise;
  }

  private createEarthModel(
    maps: THREE.Texture[],
    sunDirection = this.sunDirection,
  ): PlanetModel {
    maps[0].colorSpace = THREE.SRGBColorSpace;
    maps[1].colorSpace = THREE.SRGBColorSpace;
    maps[4].colorSpace = THREE.SRGBColorSpace;
    const group = new THREE.Group();
    group.rotation.z = THREE.MathUtils.degToRad(EARTH.axialTiltDeg);
    const geometry = new THREE.SphereGeometry(1, 192, 128);
    const surface = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
        vertexShader: surfaceVertex,
        fragmentShader: surfaceFragment,
        uniforms: {
          dayMap: { value: maps[0] },
          nightMap: { value: maps[1] },
          heightMap: { value: maps[2] },
          waterMap: { value: maps[3] },
          sunDirection: { value: sunDirection },
        },
      }),
    );
    surface.rotation.y = -1.8;
    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(1.008, 128, 96),
      new THREE.MeshPhongMaterial({
        map: maps[4],
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
        shininess: 5,
      }),
    );
    clouds.rotation.y = surface.rotation.y;
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.014, 128, 96),
      new THREE.ShaderMaterial({
        vertexShader: surfaceVertex,
        fragmentShader: atmosphereFragment,
        uniforms: { sunDirection: { value: sunDirection } },
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    group.add(surface, clouds, atmosphere);
    return {
      body: EARTH,
      group,
      surface,
      layers: { clouds, atmosphere },
      spinning: [
        { object: surface, rate: 0.025 },
        { object: clouds, rate: 0.029 },
      ],
      timeUniforms: [],
    };
  }

  private createStars() {
    // Seeded positions make screenshots reproducible and keep the sky independent of assets.
    let seed = 83;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (const [count, size, opacity, band] of [
      [2200, 0.12, 0.7, false],
      [120, 0.21, 0.85, false],
      [1600, 0.07, 0.24, true],
    ] as const) {
      const positions: number[] = [];
      const colors: number[] = [];
      for (let i = 0; i < count; i++) {
        const azimuth = random() * Math.PI * 2;
        const y = band
          ? (random() + random() + random() - 1.5) * 0.17
          : random() * 2 - 1;
        const scale = Math.sqrt(1 - y * y);
        positions.push(
          70 * scale * Math.cos(azimuth),
          70 * y,
          70 * scale * Math.sin(azimuth),
        );
        const brightness = 0.4 + random() * 0.6;
        const warm = random() > 0.82;
        colors.push(
          brightness * (warm ? 1 : 0.76),
          brightness * 0.86,
          brightness * (warm ? 0.72 : 1),
        );
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      );
      geometry.setAttribute(
        "color",
        new THREE.Float32BufferAttribute(colors, 3),
      );
      const points = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          size,
          vertexColors: true,
          transparent: true,
          opacity,
          depthWrite: false,
        }),
      );
      if (band) points.rotation.z = 0.55;
      this.stars.add(points);
    }
  }

  private readonly resize = () => {
    if (this.destroyed) return;
    const { width, height } = this.container.getBoundingClientRect();
    this.flightWidth = width;
    this.flightHeight = height;
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private readonly animate = (time: number) => {
    if (this.destroyed) return;
    this.frame = requestAnimationFrame(this.animate);
    if (this.hidden) return;
    const delta = this.lastTime
      ? Math.min((time - this.lastTime) / 1000, 0.25)
      : 0;
    this.lastTime = time;
    if (this.flying) {
      this.animateFlight(delta, time);
      this.renderer.render(this.scene, this.camera);
      if (this.ship.group.visible) {
        // Meter-scale hull details need their own depth range in an AU-scale world.
        const camera = this.shipCamera;
        if (camera.aspect !== this.camera.aspect || camera.fov !== this.camera.fov) {
          camera.aspect = this.camera.aspect;
          camera.fov = this.camera.fov;
          camera.updateProjectionMatrix();
        }
        camera.position.copy(this.camera.position).multiplyScalar(1 / this.shipScale);
        camera.quaternion.copy(this.camera.quaternion);
        this.shipSun.position.copy(this.flightSun.position).normalize().multiplyScalar(10);
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(this.shipScene, camera);
        this.renderer.autoClear = true;
      }
      return;
    }
    if (!this.paused && this.currentModel) {
      for (const { object, rate } of this.currentModel.spinning)
        object.rotation.y += delta * rate * this.speed;
      for (const uniform of this.currentModel.timeUniforms)
        uniform.value += delta * this.speed;
    }
    if (this.targetPosition) {
      // Interpolate around the globe, keeping radius outside the surface even for opposite views.
      const step = 1 - Math.exp(-delta * 5);
      const direction = this.camera.position.clone().normalize();
      const targetDirection = this.targetPosition.clone().normalize();
      const rotation = new THREE.Quaternion().setFromUnitVectors(
        direction,
        targetDirection,
      );
      const partialRotation = new THREE.Quaternion().slerp(rotation, step);
      const radius = THREE.MathUtils.lerp(
        this.camera.position.length(),
        this.targetPosition.length(),
        step,
      );
      this.camera.position.copy(
        direction.applyQuaternion(partialRotation).multiplyScalar(radius),
      );
      if (this.camera.position.distanceTo(this.targetPosition) < 0.005)
        this.targetPosition = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frames++;
    if (!this.metricsStart) this.metricsStart = time;
    if (time - this.metricsStart > 750) {
      this.onStats({
        altitudeKm:
          (this.camera.position.length() - 1) *
          (this.currentModel?.body.radiusKm ?? EARTH.radiusKm),
        fps: Math.round((this.frames * 1000) / (time - this.metricsStart)),
      });
      this.metricsStart = time;
      this.frames = 0;
    }
  };

  async enterFlight(
    id: BodyId,
    config: WorldConfig,
    onProgress: (percent: number) => void,
  ): Promise<boolean> {
    const version = ++this.selectionVersion;
    await this.loadSpaceTextures();
    const maps = await this.loadEarthTextures(onProgress);
    if (this.destroyed || version !== this.selectionVersion) return false;
    if (!this.flightModels.length) {
      for (const body of config.bodies) {
        const center = new THREE.Vector3().fromArray(body.position);
        const hostId = body.hostStarId ?? systemConfig(config, bodySystem(body)).primaryStar;
        const host = config.bodies.find(candidate => candidate.id === hostId)!;
        const light = body.kind === "star" ? this.sunDirection
          : new THREE.Vector3().fromArray(host.position).sub(center).normalize();
        const model =
          body.id === "earth"
            ? this.createEarthModel(maps, light)
            : createPlanetModel(getBody(body.id), light, {
                center,
                radius: body.radius,
              }, this.planetMaps.get(body.id));
        model.group.traverse((object) => {
          if (object instanceof THREE.Mesh && object.material instanceof THREE.ShaderMaterial && object.material.uniforms.planetCenter)
            object.material.uniforms.planetCenter.value = model.group.position;
        });
        model.group.position.copy(center);
        model.group.scale.setScalar(body.radius);
        // Collision uses the mean-radius sphere. Match rocky flight surfaces to it.
        if (body.id !== "sun" && !["jupiter", "saturn", "uranus", "neptune"].includes(body.id)) model.surface.scale.y = 1;
        this.flightGeometries.set(model.surface, model.surface.geometry);
        this.flightRoot.add(model.group);
        this.flightModels.push(model);
      }
    }
    this.dynamics = new ShipDynamics(config);
    this.dynamics.jump(id);
    this.flightBoost = 0;
    this.flightMetrics = 0;
    this.flightPaused = false;
    this.flying = true;
    this.planet.visible = false;
    this.flightRoot.visible = true;
    this.observeSun.visible = false;
    this.flightSun.visible = true;
    this.controls.enabled = false;
    this.targetPosition = null;
    this.camera.fov = 58;
    this.camera.near = 1e-8;
    this.camera.far = 2e6;
    this.camera.updateProjectionMatrix();
    this.starsEnabled = true;
    this.useSystemBackground(this.dynamics!.systemId);
    this.flightControls?.dispose();
    this.flightControls = new FlightControls(this.renderer.domElement);
    this.renderer.domElement.setAttribute(
      "aria-label",
      "自由驾驶飞船：W/S 推力，方向键或触屏拖动转向，空格刹车",
    );
    this.updateFlightCamera(1);
    this.renderer.compile(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);
    onProgress(100);
    if (!this.frame) this.animate(0);
    return true;
  }
  leaveFlight() {
    if (!this.flying) return;
    this.flying = false;
    this.flightControls?.dispose();
    this.flightControls = undefined;
    this.planet.visible = true;
    this.flightRoot.visible = false;
    this.observeSun.visible = true;
    this.surfaceScene.group.visible = false;
    this.surfaceScene.sky.visible = false;
    this.flightSun.visible = false;
    this.controls.enabled = true;
    this.stars.position.set(0, 0, 0);
    this.warpEffect.mesh.visible = false;
    this.useSystemBackground(this.currentModel?.body.systemId ?? "solar");
    this.camera.near = 0.01;
    this.camera.up.set(0, 1, 0);
    this.camera.fov = 40;
    this.camera.far = 200;
    this.camera.updateProjectionMatrix();
  }
  setFlightHandler(handler: (stats: FlightStats) => void) {
    this.flightHandler = handler;
  }
  setFlightTargetHandler(handler: NonNullable<SolarScene["flightTargetHandler"]>) {
    this.flightTargetHandler = handler;
  }
  setFlightPaused(paused: boolean) {
    this.flightPaused = paused;
    this.flightControls?.clear();
  }
  flightState(): FlightState | null {
    return this.dynamics?.snapshot() ?? null;
  }
  restoreFlight(state: unknown) {
    const restored = this.dynamics?.restore(state) ?? false;
    if (restored) this.updateFlightCamera(1);
    return restored;
  }
  setDestination(id: BodyId) {
    if (this.dynamics && !this.dynamics.warping) this.dynamics.target = id;
  }
  alignFlight() {
    if (this.dynamics?.landingPhase !== "manual") return;
    this.dynamics?.align();
    this.flightControls?.clear();
  }
  jumpFlight(): string | null {
    if (!this.dynamics) return "飞船尚未就绪";
    const error = this.dynamics.startWarp();
    this.flightControls?.clear();
    return error;
  }
  cancelWarp() { this.dynamics?.cancelWarp(); }
  landFlight(): string | null {
    if (!this.dynamics) return "飞船尚未就绪";
    this.flightControls?.clear();
    if (this.dynamics.landingPhase === "landed") return this.dynamics.takeOff();
    if (this.dynamics.landingPhase !== "manual") { this.dynamics.cancelLanding(); return null; }
    return this.dynamics.startLanding();
  }
  setFlightCamera(view: "cockpit" | "chase") {
    if (this.dynamics) {
      this.dynamics.camera = view;
      this.updateFlightCamera(1);
    }
  }
  setFlightAssist(assist: boolean) {
    if (this.dynamics) this.dynamics.assist = assist;
  }
  private updateFlightCamera(blend: number) {
    const ship = this.dynamics!;
    const environment = ship.environment;
    // CPU positions remain in double precision. GPU objects are relative to the ship.
    for (const model of this.flightModels) {
      const body = ship.config.bodies.find((b) => b.id === model.body.id)!;
      if (bodySystem(body) !== ship.systemId) { model.group.visible = false; continue; }
      model.group.position.fromArray(body.position).sub(ship.position);
      const angularRadius = body.radius / Math.max(model.group.position.length(), 1e-9);
      model.group.visible = angularRadius > 0.00001;
      model.surface.geometry = angularRadius < 0.005 ? this.distantSphere : this.flightGeometries.get(model.surface)!;
      // The local curved tile adds detail above the coarse globe; clouds stay overhead.
      if (model.layers.atmosphere) model.layers.atmosphere.visible = model.body.id !== environment.body.id || !environment.atmospheric;
    }
    const stars = ship.activeBodies.filter(body => body.kind === "star");
    const light = stars.reduce((closest, body) =>
      this.flightRelative.fromArray(body.position).distanceToSquared(ship.position)
        < this.flightForward.fromArray(closest.position).distanceToSquared(ship.position) ? body : closest);
    this.flightSun.position.fromArray(light.position).sub(ship.position);
    this.flightSun.color.set(getBody(light.id).color);
    this.shipSun.color.copy(this.flightSun.color);
    this.useSystemBackground(ship.systemId);
    const scale = 0.000015; // Approximately 25 m hull with a close chase camera.
    this.ship.group.position.set(0, 0, 0);
    this.ship.group.scale.setScalar(1);
    const attitude = ship.orientation.clone().multiply(this.bankRotation.setFromAxisAngle(this.flightAxis, ship.bank));
    this.ship.group.quaternion.copy(attitude);
    this.ship.group.visible = ship.camera === "chase" && !ship.warping;
    const offset = new THREE.Vector3(0, ship.camera === "chase" ? 0.19 : 0, ship.camera === "chase" ? 0.72 + this.flightBoost * 0.1 : 0).multiplyScalar(scale).applyQuaternion(ship.orientation);
    if (ship.camera === "chase") {
      this.camera.position.lerp(offset, blend);
      this.camera.up.set(0, 1, 0).applyQuaternion(attitude);
      this.camera.lookAt(new THREE.Vector3(0, 0, -5 * scale).applyQuaternion(ship.orientation));
    } else {
      this.camera.position.copy(offset);
      this.camera.quaternion.slerp(attitude, blend);
    }
    const strength = ship.warpPhase === "transit" ? Math.sin(ship.warpProgress * Math.PI) * 0.65 + 0.35 : ship.warpPhase === "charging" ? ship.warpProgress * 0.15 : ship.warpPhase === "arrival" ? (1 - ship.warpProgress) * 0.35 : 0;
    this.warpEffect.mesh.visible = strength > 0;
    this.warpEffect.material.uniforms.strength.value = strength;
    this.warpEffect.material.uniforms.time.value = ship.elapsed;
    this.warpEffect.material.uniforms.aspect.value = this.camera.aspect;
    const fov = 58 + strength * 25 + this.flightBoost * 9;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.surfaceScene.update(ship, this.camera, this.flightSun);
    this.ship.gear.visible = ship.landingPhase !== "manual" || (environment.profile.solid && environment.groundAltitudeKm < 1);
  }
  private animateFlight(delta: number, time: number) {
    const ship = this.dynamics!;
    const input = this.flightControls!.read();
    if (!this.flightPaused) {
      ship.step(delta, input);
      if (!this.paused)
        for (const model of this.flightModels) {
          // Keep surface features fixed in the collision frame while flying; clouds still drift.
          for (const { object, rate } of model.spinning)
            if (object !== model.surface) object.rotation.y += rate * delta;
          for (const uniform of model.timeUniforms) uniform.value += delta;
        }
    }
    if (!this.flightPaused) this.flightBoost = THREE.MathUtils.lerp(this.flightBoost,
      input.boost && ship.velocity.length() > 0 && !ship.warping ? 1 : 0, 1 - Math.exp(-delta * 4));
    const exhaust = this.flightPaused || ship.warping ? 0.1 : input.boost && input.throttle > 0 ? 2.4 : input.throttle > 0 ? 1 : 0.22;
    this.ship.exhaust.scale.z = THREE.MathUtils.lerp(this.ship.exhaust.scale.z, exhaust, 1 - Math.exp(-delta * 10));
    this.updateFlightCamera(1 - Math.exp(-delta * 9));
    const target = ship.config.bodies.find((b) => b.id === ship.target)!;
    this.flightRelative.copy(ship.targetRelative);
    const tracking = projectFlightTarget(this.flightRelative, this.camera);
    const aim = this.flightControls!.aim;
    this.flightTargetHandler?.({ ...tracking, target: ship.target, deceleration: ship.deceleration,
      aimX: aim.x, aimY: aim.y, steering: aim.active && !this.flightPaused,
      width: this.flightWidth, height: this.flightHeight });
    if (time - this.flightMetrics < 150) return;
    this.flightMetrics = time;
    const environment = ship.environment;
    const forward = this.flightForward.set(0, 0, -1).applyQuaternion(
      this.camera.quaternion,
    );
    this.flightHandler?.({
      systemId: ship.systemId,
      engine: ship.engine,
      environment,
      warpBlockReason: ship.warpBlockReason,
      warpPhase: ship.warpPhase,
      warpProgress: ship.warpProgress,
      speedKm: ship.warping ? ship.warpSpeedKm : ship.velocity.length() * ship.config.unitsKm,
      speedLimitKm: ship.speedLimit * ship.config.unitsKm,
      altitudeKm: environment.altitudeKm,
      nearest: environment.body.id,
      distanceKm:
        Math.max(0, this.flightRelative.length() - target.radius) *
        ship.config.unitsKm,
      target: ship.target,
      heading:
        (THREE.MathUtils.radToDeg(Math.atan2(forward.x, -forward.z)) + 360) %
        360,
      elapsed: ship.elapsed,
      boosting: input.boost,
      collision: ship.collision,
      landingPhase: ship.landingPhase,
      landingBlockReason: ship.landingBlockReason,
    });
  }

  private viewPosition(view: View): THREE.Vector3 {
    if (this.currentModel?.body.id === "saturn") {
      return {
        // Narrow displays need more distance to show the full ring system.
        overview: new THREE.Vector3(0, 2.6, 5.2).multiplyScalar(
          Math.max(1, 1.07 / Math.max(this.camera.aspect, 0.55)),
        ),
        close: new THREE.Vector3(0, 1.3, 2.6),
        night: new THREE.Vector3(4, 2, -4),
      }[view];
    }
    if (this.currentModel?.body.id === "mars" && view === "overview")
      return new THREE.Vector3(0, 1.2, 3.72);
    const vectors: Record<View, THREE.Vector3> = {
      overview: new THREE.Vector3(0, 0.3, 3.9),
      close: new THREE.Vector3(0, 0.14, 1.85),
      night: new THREE.Vector3(3.6, 0.45, -1.2),
    };
    return vectors[view];
  }

  setView(view: View) {
    this.targetPosition = this.viewPosition(view);
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }
  setSpeed(speed: number) {
    this.speed = speed;
  }
  setLayer(layer: Layer, visible: boolean) {
    const object =
      layer === "stars" ? this.stars : this.currentModel?.layers[layer];
    if (object) object.visible = visible;
    if (layer === "stars") {
      this.starsEnabled = visible;
      this.useSystemBackground(this.backgroundSystem);
    }
    if (layer === "rings" && this.currentModel?.ringsEnabled)
      this.currentModel.ringsEnabled.value = Number(visible);
  }
  setQuality(high: boolean) {
    this.renderer.setPixelRatio(
      high ? Math.min(window.devicePixelRatio, 2) : 1,
    );
    this.resize();
  }
  zoom(factor: number) {
    this.targetPosition = null;
    const distance = THREE.MathUtils.clamp(
      this.camera.position.length() * factor,
      this.controls.minDistance,
      this.controls.maxDistance,
    );
    this.camera.position.setLength(distance);
  }
  rotate(horizontal: number, vertical: number) {
    this.targetPosition = null;
    this.camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), horizontal);
    const right = new THREE.Vector3()
      .crossVectors(this.camera.up, this.camera.position)
      .normalize();
    this.camera.position.applyAxisAngle(right, vertical);
  }

  private readonly contextLost = (event: Event) => {
    event.preventDefault();
    this.onError(
      "图形上下文已中断，请重新加载场景。也可以关闭其他占用显卡的页面后重试。",
    );
  };

  dispose() {
    this.surfaceScene.dispose();
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    this.renderer.domElement.removeEventListener(
      "webglcontextlost",
      this.contextLost,
    );
    this.flightControls?.dispose();
    this.controls.dispose();
    const geometries = new Set<THREE.BufferGeometry>();
    geometries.add(this.distantSphere);
    this.flightGeometries.forEach((geometry) => geometries.add(geometry));
    const materials = new Set<THREE.Material>();
    const collect = (object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
        geometries.add(object.geometry);
        const objectMaterials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        objectMaterials.forEach((material) => materials.add(material));
      }
    };
    this.scene.traverse(collect);
    this.shipScene.traverse(collect);
    this.models.forEach((model) => model.group.traverse(collect));
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.textures.forEach((texture) => texture.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
