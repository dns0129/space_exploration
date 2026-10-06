import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EARTH, getBody, STAR_SYSTEMS } from "./solar-system";
import type { BodyId, Layer, SystemId } from "./solar-system";
import { createPlanetModel, atmosphereFragment, mapSampling, noise, setSurfaceMap } from "./planet-models";
import { SURFACE_MAPS } from "./body-textures";
import type { PlanetModel } from "./planet-models";
import { bodySystem, systemConfig } from "../shared/world-navigation.mjs";
import { ShipDynamics } from "./ship-dynamics";
import { FlightControls } from "./flight-controls";
import { createShip, SHIP_LENGTH_KM } from "./ship-model";
import { createWarpEffect } from "./warp-effect";
import { FlightLight } from "./flight-light";
import { GalaxySky, selectGalaxyFile } from "./galaxy-sky";
import type { GalaxyTextureFile } from "./galaxy-sky";
import { SurfaceScene } from "./surface-scene";
import { atmosphereStrength } from "./atmosphere";
import { surfaceProfile } from "../shared/surface.mjs";
import { projectFlightTarget } from "./flight-target";
import type { FlightTargetStats } from "./flight-target";
import type { FlightState, WorldConfig } from "../shared/flight-state.mjs";
import { RenderBudget } from "./render-budget";
import { EarthDetail, earthDetailSampling } from "./earth-detail";
import type { RenderQuality } from "./earth-detail";
import { FlightRenderPolicy } from "./render-mode";
import type { FlightRenderMode } from "./render-mode";
import { surfaceMapRotation } from "./surface-map-pose";

export type View = "overview" | "close" | "night";
export interface SceneStats {
  altitudeKm: number;
  fps: number;
}

export interface FlightStats {
  systemId: SystemId;
  renderMode: FlightRenderMode;
  engine: ShipDynamics["engine"];
  atmosphericSpeedMps: number;
  engineMode: ShipDynamics["engineMode"];
  orbitalEngineActive: boolean;
  orbitalBlockReason: string | null;
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
  varying vec3 vLocalPosition;
  varying vec3 vAxisX;
  varying vec3 vAxisY;
  varying vec3 vAxisZ;
  void main() {
    vUv = uv;
    vLocalPosition = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vAxisX = normalize(mat3(modelMatrix)[0]);
    vAxisY = normalize(mat3(modelMatrix)[1]);
    vAxisZ = normalize(mat3(modelMatrix)[2]);
    gl_Position = projectionMatrix * viewMatrix * world;
    #include <logdepthbuf_vertex>
  }
`;

const earthSurfaceVertex = surfaceVertex
  .replace("void main()", "uniform sampler2D terrainMap; uniform float terrainDetail; uniform float elevationStrength; void main()")
  .replace("vec4 world = modelMatrix * vec4(position, 1.0);", /* glsl */ `
    float elevation = max(textureLod(terrainMap, uv, 0.0).r - 40.0 / 255.0, 0.0) * (255.0 / 215.0);
    vec3 displaced = position * (1.0 + elevation * 0.00142 * terrainDetail * elevationStrength);
    vec4 world = modelMatrix * vec4(displaced, 1.0);
  `);

const surfaceFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D terrainMap;
  uniform sampler2D cloudMap;
  uniform vec2 mapSize;
  uniform vec2 terrainSize;
  uniform vec2 cloudSize;
  uniform vec2 nightSize;
  uniform float cloudsEnabled;
  uniform float cloudOffset;
  uniform float flatClouds;
  uniform float terrainDetail;
  uniform vec3 sunDirection;
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying vec3 vLocalPosition;
  varying vec3 vAxisX;
  varying vec3 vAxisY;
  varying vec3 vAxisZ;
  ${noise}
  ${mapSampling}
  ${earthDetailSampling}
  float elevation(float value) { return max(value - 40.0 / 255.0, 0.0) * (255.0 / 215.0); }
  void main() {
    vec3 normal = normalize(vNormal);
    vec3 p = normalize(vLocalPosition);
    vec2 gx, gy;
    bool seam = seamGradients(vUv, gx, gy);
    float texels = max(length(gx * mapSize), length(gy * mapSize));
    float footprint = max(length(dFdx(p)), length(dFdy(p)));
    float magnify = 1.0 - smoothstep(0.6, 1.4, texels);
    vec3 terrainNormal = normal;
    float terrain = sampleMap(terrainMap, vUv, terrainSize, gx, gy, seam).r;
    float water = 1.0 - smoothstep(0.015, 40.0 / 255.0, terrain), landGrain = 0.0;
    float ring = length(p.xz);
    vec3 eastward = vec3(p.z, 0.0, -p.x) / max(ring, 0.0001);
    vec3 northward = cross(p, eastward);
    if(terrainDetail>0.5) {
      // Relief differenced in texture space keeps mountains smooth at any zoom, without texel facets.
      float stepTexels = max(1.0, max(length(gx * terrainSize), length(gy * terrainSize)));
      vec2 du = vec2(stepTexels / terrainSize.x, 0.0), dv = vec2(0.0, stepTexels / terrainSize.y);
      float reliefLod = log2(stepTexels);
      float east = elevation(textureLod(terrainMap, vUv + du, reliefLod).r) - elevation(textureLod(terrainMap, vUv - du, reliefLod).r);
      float north = elevation(textureLod(terrainMap, vUv + dv, reliefLod).r) - elevation(textureLod(terrainMap, vUv - dv, reliefLod).r);
      vec3 slope = 0.00142 * (east * terrainSize.x / (12.566 * max(ring, 0.15) * stepTexels) * eastward
        + north * terrainSize.y / (6.2832 * stepTexels) * northward);
      vec4 grain = surfaceGrain(p, 2600.0, footprint, magnify, vec3(1.0), 3.7);
      float land = 1.0 - water;
      slope += grain.yzw * 0.035 * land;
      landGrain = grain.x * land;
      slope -= p * dot(slope, p);
      terrainNormal = normalize(normal - mat3(vAxisX, vAxisY, vAxisZ) * slope);
    }
    float daylight = dot(normal, sunDirection);
    float diffuse = max(dot(terrainNormal, sunDirection), 0.0) * smoothstep(-0.12, 0.04, daylight);
    // The deep-blue day map stays the colour layer at every distance; land grain only adds texture.
    vec3 day = earthDay(vUv, gx, gy, seam);
    // Open ocean holds faint 8x8 JPEG blocks; when magnified, read it from the block-averaged mip.
    float smoothOcean = water * (1.0 - smoothstep(0.25, 0.6, texels));
    if(smoothOcean > 0.0) day = mix(day, sampleMapLod(dayMap, vUv, mapSize, 3.0).rgb, smoothOcean);
    day *= 1.0 + landGrain * 0.12;
    // Satellite mosaics have nearly black open water; retain its natural deep-blue scattering.
    day += vec3(0.002, 0.012, 0.035) * water;
    float cityLight = daylight<0.12 ? sampleMap(nightMap, vUv, nightSize, gx, gy, seam).r : 0.0;
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    vec3 halfwayDirection = normalize(sunDirection + viewDirection);
    float specular = pow(max(dot(terrainNormal, halfwayDirection), 0.0), 72.0);
    float nightWeight = 1.0 - smoothstep(-0.15, 0.12, daylight);
    vec3 localSun = transpose(mat3(vAxisX, vAxisY, vAxisZ)) * sunDirection;
    vec2 shadowShift = vec2(dot(localSun,eastward)/(6.2832*max(ring,0.15)), dot(localSun,northward)/3.1416)
      * (0.0018 / max(daylight, 0.15));
    vec2 cloudUv = vec2(vUv.x + cloudOffset, vUv.y);
    float cloudCover = sampleMap(cloudMap, cloudUv + shadowShift, cloudSize, gx, gy, seam).r * cloudsEnabled;
    vec3 color = day * (0.015 + diffuse * 1.08 * (1.0-cloudCover*0.26));
    // Isolate the warm city lights from the blue-tinted night-map terrain.
    color += vec3(1.0, 0.65, 0.32) * pow(cityLight, 1.15) * nightWeight * 2.4 * (1.0-cloudCover*0.6);
    float fresnel = 0.02 + 0.98 * pow(1.0-max(dot(terrainNormal,viewDirection),0.0),5.0);
    color += vec3(0.75, 0.87, 1.0) * specular * water * smoothstep(0.0, 0.15, daylight) * (0.12+fresnel*0.35);
    float visibleCloud = sampleMap(cloudMap, cloudUv, cloudSize, gx, gy, seam).r * cloudsEnabled;
    color = mix(color,vec3(0.92,0.96,1.0)*(0.035+max(daylight,0.0)*1.1),visibleCloud*flatClouds*0.82);
    float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 4.0);
    color += vec3(0.035, 0.22, 0.55) * rim * smoothstep(-0.3, 0.6, daylight) * 0.35;
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Separate cloud shell, shaded exactly like the merged distant clouds so Earth's colours never shift. */
const earthCloudFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D cloudMap;
  uniform vec2 mapSize;
  uniform vec3 sunDirection;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vLocalPosition;
  varying vec3 vWorldPosition;
  ${noise}
  ${mapSampling}
  void main() {
    vec3 p = normalize(vLocalPosition);
    vec2 gx, gy;
    bool seam = seamGradients(vUv, gx, gy);
    float texels = max(length(gx * mapSize), length(gy * mapSize));
    float footprint = max(length(dFdx(p)), length(dFdy(p)));
    float magnify = 1.0 - smoothstep(0.6, 1.4, texels);
    vec4 cloud = sampleMap(cloudMap, vUv, mapSize, gx, gy, seam);
    float cover = cloud.r;
    if(magnify > 0.0) {
      // Sub-texel wisps sharpen partly covered texels instead of showing soft magnified blobs.
      vec4 grain = surfaceGrain(p, mapSize.x / 6.2832, footprint, magnify, vec3(1.0, 1.6, 1.0), 9.1);
      cover = clamp(cover + grain.x * 2.0 * cover * (1.0 - cover), 0.0, 1.0);
    }
    float daylight = max(dot(normalize(vNormal), sunDirection), 0.0);
    #include <logdepthbuf_fragment>
    float silver = pow(max(dot(normalize(cameraPosition-vWorldPosition), sunDirection),0.0),12.0) * (1.0-cover) * 0.2;
    gl_FragColor = vec4(vec3(0.92,0.96,1.0) * (0.035 + daylight * 1.1 + silver), cover * 0.82);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Owns rendering and GPU resources; UI consumes its public controls and metrics. */
export class SolarScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly spaceScene = new THREE.Scene();
  private readonly surfaceWorldScene = new THREE.Scene();
  private readonly renderPolicy = new FlightRenderPolicy();
  private readonly spaceWorkWaiters = new Set<() => void>();
  private readonly pendingSurfaceMaps = new Set<string>();
  private spaceUpdates = 0;
  private flightFrameDirty = true;
  private worldRenderCount = 0;
  private readonly drawnCameraPosition = new THREE.Vector3();
  private readonly drawnCameraQuaternion = new THREE.Quaternion();
  private drawnCameraFov = 0;
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
  private readonly controls: OrbitControls;
  private readonly planet = new THREE.Group();
  private readonly galaxySky: GalaxySky;
  private readonly surfaceGalaxySky: GalaxySky;
  private readonly galaxyFile: GalaxyTextureFile;
  private currentModel?: PlanetModel;
  private readonly flightRoot = new THREE.Group();
  private readonly flightSun = new THREE.PointLight(0xfff3e5, 2.5, 0, 0);
  private readonly observeSun = new THREE.DirectionalLight(0xfff3e5, 2.5);
  private readonly ship = createShip();
  private readonly shipScene = new THREE.Scene();
  private readonly shipCamera = new THREE.PerspectiveCamera(58, 1, 0.01, 200);
  private readonly shipSun = new THREE.DirectionalLight(0xfff3e5, 2.5);
  private readonly shipAmbient = new THREE.HemisphereLight(0xc1e6ee, 0x233643, 0.85);
  private readonly shipRim = new THREE.DirectionalLight(0x77bfff, 0.45);
  private shipScale = SHIP_LENGTH_KM / (6371 * this.ship.hullLength);
  private readonly warpEffect = createWarpEffect();
  private readonly flightLight = new FlightLight();
  private readonly surfaceScene = new SurfaceScene();
  private surfaceMapBody: BodyId | null = null;
  private galaxy?: THREE.Texture;
  private readonly backgrounds = new Map<SystemId, THREE.Texture>();
  private backgroundSystem: SystemId = "solar";
  private starsEnabled = true;
  private spacePromise?: Promise<void>;
  private readonly planetMaps = new Map<BodyId, THREE.Texture>();
  /** Moon, star and exoplanet maps load on approach and are released when unused, keyed by file. */
  private readonly lazyMaps = new Map<string, { texture?: THREE.Texture; loading?: Promise<void>; failedAt?: number; used: number }>();
  private readonly mapFades = new Set<PlanetModel>();
  private mapCheck = 0;
  private stillSeconds = 0;
  private readonly lastCameraPosition = new THREE.Vector3();
  private readonly lastCameraQuaternion = new THREE.Quaternion();
  private readonly compactTextures = window.matchMedia("(pointer: coarse)").matches
    || ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4;
  private flightModels: PlanetModel[] = [];
  private readonly flightModelById = new Map<BodyId, PlanetModel>();
  private readonly distantSphere = new THREE.SphereGeometry(1, 32, 24);
  private readonly mediumSphere = new THREE.SphereGeometry(1, 64, 48);
  private readonly tinySphere = new THREE.SphereGeometry(1, 16, 12);
  private readonly largeSphere = new THREE.SphereGeometry(1, 128, 80);
  private readonly renderBudget = new RenderBudget();
  private quality: RenderQuality = this.compactTextures ? "high" : "ultra";
  private minimumRenderRatio = 0.5;
  /** Sharp oblique detail on GPUs; software rasterizers keep the cheaper 4x filtering. */
  private surfaceAnisotropy = 4;
  private readonly flightGeometries = new Map<THREE.Mesh, THREE.BufferGeometry>();
  private readonly flightSpheres = new Map<PlanetModel, THREE.Mesh[]>();
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
  private readonly earthDetails = new Map<PlanetModel, EarthDetail>();
  private earthHighMaps?: THREE.Texture[];
  private earthUpgrade?: Promise<void>;
  private earthUpgraded = false;
  private earthUpgradeAt = 0;
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
    this.flightFrameDirty = true;
    this.lastTime = 0;
    this.metricsStart = 0;
    this.frames = 0;
  };

  constructor(
    private readonly container: HTMLElement,
    private readonly onStats: (stats: SceneStats) => void,
    private readonly onError: (message: string) => void,
  ) {
    // MSAA smooths planet limbs and atmosphere edges; software rasterizers skip it to stay responsive.
    this.renderer = new THREE.WebGLRenderer({
      logarithmicDepthBuffer: true,
      antialias: !SolarScene.softwareRendering(),
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const gl = this.renderer.getContext();
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const graphicsRenderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "unavailable";
    const software = /swiftshader|llvmpipe|software/i.test(graphicsRenderer);
    this.renderer.domElement.dataset.graphicsRenderer = graphicsRenderer;
    if (software) { this.minimumRenderRatio = 0.125; this.quality = "high"; }
    else this.surfaceAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.renderer.domElement.dataset.softwareRenderer = String(software);
    this.galaxySky = new GalaxySky(this.compactTextures || software);
    this.surfaceGalaxySky = new GalaxySky(true);
    this.galaxyFile = selectGalaxyFile(this.renderer.capabilities.maxTextureSize, this.compactTextures, software);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.domElement.setAttribute(
      "aria-label",
      "交互式 3D 天体：拖动旋转视角，滚轮或双指缩放",
    );
    this.renderer.domElement.setAttribute("role", "img");
    this.renderer.domElement.dataset.renderMode = "observation";
    this.spaceScene.name = "space-world";
    this.surfaceWorldScene.name = "planet-environment";
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
    this.spaceScene.add(this.planet);
    this.spaceScene.add(this.galaxySky.mesh);
    this.surfaceWorldScene.add(this.surfaceGalaxySky.mesh, this.surfaceScene.group, this.surfaceScene.sky);
    this.observeSun.position.set(-3, 1.8, 4);
    this.flightRoot.visible = false;
    this.flightSun.visible = false;
    this.shipScene.add(
      this.ship.group,
      this.shipSun,
      this.shipAmbient,
      this.shipRim,
    );
    this.spaceScene.add(
      this.observeSun,
      this.flightSun,
      this.flightRoot,
      this.warpEffect.mesh,
      this.flightLight.mesh,
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
    if (id !== "earth" && this.isLazyMap(id)) onProgress(40);
    const lazyMap = id !== "earth" ? await this.loadSurfaceMap(id) : null;
    if (this.destroyed || version !== this.selectionVersion) return false;
    let model = this.models.get(id);
    if (!model) {
      model =
        id === "earth"
          ? this.createEarthModel(maps!)
          : createPlanetModel(getBody(id), this.sunDirection, undefined, this.planetMaps.get(id) ?? lazyMap ?? undefined);
      this.models.set(id, model);
    } else if (lazyMap && model.mapUniforms?.detailMap.value !== lazyMap) setSurfaceMap(model, lazyMap, 1);
    this.mapFades.delete(model);
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
    this.renderer.compile(this.spaceScene, this.camera);
    this.renderer.render(this.spaceScene, this.camera);
    onProgress(100);
    if (!this.frame) this.animate(0);
    return true;
  }

  private loadSpaceTextures(): Promise<void> {
    if (this.galaxy) return Promise.resolve();
    if (this.spacePromise) return this.spacePromise;
    const ids = (Object.keys(SURFACE_MAPS) as BodyId[]).filter(id => SURFACE_MAPS[id]!.core);
    const skyFiles = [this.galaxyFile];
    const files = [...skyFiles, ...ids.map((id) => SURFACE_MAPS[id]!.file)];
    const batch: THREE.Texture[] = [];
    let failed = false;
    this.spacePromise = Promise.all(files.map(async (file, index) => {
      const texture = await this.loadTexture(file, index >= skyFiles.length);
      if (this.destroyed || failed) { texture.dispose(); throw new Error("场景已关闭或贴图加载失败"); }
      batch.push(texture);
      return texture;
    })).then((maps) => {
      maps.forEach((map) => this.textures.add(map));
      for (const system of STAR_SYSTEMS) {
        const texture = maps[0];
        this.backgrounds.set(system.id as SystemId, texture);
      }
      this.galaxy = this.backgrounds.get("solar");
      this.useSystemBackground("solar");
      // Both render modes reuse the resident panorama; entering a planet never requests or rebuilds it.
      this.surfaceGalaxySky.setTexture(this.galaxy ?? null);
      ids.forEach((id, i) => this.planetMaps.set(id, maps[i + skyFiles.length]));
    }).catch((error) => {
      failed = true;
      batch.forEach((texture) => texture.dispose());
      throw error;
    }).finally(() => { this.spacePromise = undefined; });
    return this.spacePromise;
  }

  private static softwareRendering() {
    try {
      const gl = document.createElement("canvas").getContext("webgl2");
      if (!gl) return false;
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      const name = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "";
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return /swiftshader|llvmpipe|software/i.test(name);
    } catch {
      return false;
    }
  }

  /** Decoded before upload so large maps don't stall a frame; surface maps wrap in longitude. */
  private async loadTexture(file: string, surface: boolean) {
    const surfaceMap = surface ? Object.values(SURFACE_MAPS).find(map => map?.file === file) : undefined;
    if (surfaceMap?.compactFile && (this.compactTextures || this.renderer.capabilities.maxTextureSize < surfaceMap.width)) {
      file = surfaceMap.compactFile;
    }
    const texture = await new THREE.TextureLoader().loadAsync(`${import.meta.env.BASE_URL}textures/${file}`);
    await this.waitForSpaceWork();
    if (this.destroyed) { texture.dispose(); throw new Error("场景已关闭"); }
    const image = texture.image as HTMLImageElement;
    await image.decode?.().catch(() => undefined);
    await this.waitForSpaceWork();
    if (this.destroyed) { texture.dispose(); throw new Error("场景已关闭"); }
    if (surface && this.compactTextures && !surfaceMap?.compactFile && image.width > 2048) {
      // Low-memory devices keep 2K copies: a quarter of the GPU memory of a 4K map.
      const canvas = document.createElement("canvas");
      canvas.width = 2048;
      canvas.height = Math.round(2048 * image.height / image.width);
      const context = canvas.getContext("2d")!;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      texture.image = canvas;
    }
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = surface ? this.surfaceAnisotropy : Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    if (surface) texture.wrapS = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    return texture;
  }

  /** Network requests already in flight may finish, but their decoding/upload waits outside the local renderer. */
  private async waitForSpaceWork() {
    while (!this.destroyed && this.flying && this.renderPolicy.mode === "surface")
      await new Promise<void>(resolve => this.spaceWorkWaiters.add(resolve));
  }

  private resumeSpaceWork() {
    this.spaceWorkWaiters.forEach(resolve => resolve());
    this.spaceWorkWaiters.clear();
  }

  private isLazyMap(id: BodyId) {
    const surfaceMap = SURFACE_MAPS[id];
    return !!surfaceMap && !surfaceMap.core;
  }

  /** Marks a body's map as in use and starts loading it if it isn't resident. */
  private touchSurfaceMap(id: BodyId) {
    if (this.flying && this.renderPolicy.mode === "surface") return;
    const surfaceMap = SURFACE_MAPS[id];
    if (!surfaceMap || surfaceMap.core) return;
    const now = performance.now();
    const file = surfaceMap.file;
    let entry = this.lazyMaps.get(file);
    if (!entry) this.lazyMaps.set(file, entry = { used: now });
    entry.used = now;
    if (entry.texture || entry.loading || (entry.failedAt && now - entry.failedAt < 20000)) return;
    const loading = entry;
    loading.loading = this.loadTexture(file, true).then((texture) => {
      if (this.destroyed || this.lazyMaps.get(file) !== loading) { texture.dispose(); return; }
      loading.texture = texture;
      this.textures.add(texture);
      this.pendingSurfaceMaps.add(file);
      if (!this.flying || this.renderPolicy.mode === "space") this.applyPendingSurfaceMaps();
    }).catch((error) => {
      loading.failedAt = performance.now();
      console.warn(`Surface map ${file} unavailable; keeping the procedural surface.`, error);
    }).finally(() => { loading.loading = undefined; });
  }

  private applyPendingSurfaceMaps() {
    for (const file of this.pendingSurfaceMaps) {
      const texture = this.lazyMaps.get(file)?.texture;
      if (!texture) continue;
      this.renderer.initTexture(texture);
      this.renderBudget.hold(0.75);
      for (const model of this.allModels())
        if (model.surfaceMap?.file === file && model.mapUniforms?.detailMap.value !== texture) {
          const immediate = !this.flying && model === this.currentModel;
          setSurfaceMap(model, texture, immediate ? 1 : 0);
          if (!immediate) this.mapFades.add(model);
        }
    }
    this.pendingSurfaceMaps.clear();
    this.releaseSurfaceMaps();
  }

  private async loadSurfaceMap(id: BodyId): Promise<THREE.Texture | null> {
    if (!this.isLazyMap(id)) return null;
    this.touchSurfaceMap(id);
    const entry = this.lazyMaps.get(SURFACE_MAPS[id]!.file);
    await entry?.loading;
    return entry?.texture ?? null;
  }

  private allModels() {
    return [...this.flightModels, ...this.models.values()];
  }

  /** Keeps GPU memory bounded: the least recently seen maps return to their procedural fallback. */
  private releaseSurfaceMaps() {
    const limit = this.compactTextures ? 3 : 6;
    const now = performance.now();
    const resident = [...this.lazyMaps].filter(([, entry]) => entry.texture).sort((a, b) => a[1].used - b[1].used);
    for (const [file, entry] of resident) {
      if (resident.filter(([, item]) => item.texture).length <= limit || now - entry.used < 8000) break;
      for (const model of this.allModels())
        if (model.surfaceMap?.file === file) { setSurfaceMap(model, null, 0); this.mapFades.delete(model); }
      this.textures.delete(entry.texture!);
      entry.texture!.dispose();
      entry.texture = undefined;
      this.lazyMaps.delete(file);
    }
  }

  private updateSurfaceMaps(delta: number, time: number) {
    if (this.pendingSurfaceMaps.size) this.applyPendingSurfaceMaps();
    for (const model of this.mapFades) {
      const ready = model.mapUniforms!.mapReady;
      ready.value = Math.min(1, ready.value + delta / 0.7);
      if (ready.value >= 1) this.mapFades.delete(model);
    }
    if (!this.flying && this.currentModel) this.touchSurfaceMap(this.currentModel.body.id);
    if (time - this.mapCheck > 3000) {
      this.mapCheck = time;
      this.releaseSurfaceMaps();
    }
  }

  private useSystemBackground(id: SystemId) {
    const system = STAR_SYSTEMS.find(item => item.id === id)!;
    const texture = this.backgrounds.get(id) ?? null;
    const sky = this.flying && this.renderPolicy.mode === "surface" ? this.surfaceGalaxySky : this.galaxySky;
    if (sky.mesh.material.uniforms.skyMap.value !== texture) {
      sky.setTexture(texture);
    }
    sky.setView(system.backgroundRotation, system.backgroundIntensity,
      this.flying ? this.surfaceScene.spaceVisibility : 1, this.starsEnabled);
    this.backgroundSystem = id;
    if (this.renderer.domElement.dataset.system !== id) this.renderer.domElement.dataset.system = id;
    if (this.renderer.domElement.dataset.background !== this.galaxyFile) {
      this.renderer.domElement.dataset.background = this.galaxyFile;
      this.renderer.domElement.dataset.backgroundResolution = this.galaxyFile.includes("8k") ? "8192x4096" : "4096x2048";
      this.renderer.domElement.dataset.backgroundSampling = "direct-equirectangular";
    }
  }

  private loadEarthTextures(
    onProgress: (percent: number) => void,
  ): Promise<THREE.Texture[]> {
    if (this.earthMaps) return Promise.resolve(this.earthMaps);
    if (this.earthPromise) return this.earthPromise;
    const files = ["earth-day.jpg", "earth-night.jpg", "earth-terrain-4k.png", "earth-clouds-4k.jpg"];
    let loaded = 0;
    const batch: THREE.Texture[] = [];
    let failed = false;
    this.earthPromise = Promise.all(
      files.map(async (file) => {
        const texture = await this.loadEarthMap(file, file !== "earth-day.jpg");
        if (this.destroyed || failed) {
          this.releaseEarthMap(texture);
          throw new Error("场景已关闭");
        }
        this.textures.add(texture);
        batch.push(texture);
        onProgress(Math.round((++loaded / files.length) * 100));
        return texture;
      }),
    )
      .then((maps) => {
        maps[0].colorSpace = THREE.SRGBColorSpace;
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

  private releaseEarthMap(texture: THREE.Texture) {
    this.textures.delete(texture);
    texture.dispose();
  }

  private async loadEarthMap(file: string, monochrome = false): Promise<THREE.Texture> {
    let texture = await new THREE.TextureLoader().loadAsync(`${import.meta.env.BASE_URL}textures/${file}`);
    await this.waitForSpaceWork();
    if (this.destroyed) { texture.dispose(); throw new Error("场景已关闭"); }
    const image = texture.image as HTMLImageElement;
    await image.decode?.().catch(() => undefined);
    await this.waitForSpaceWork();
    if (this.destroyed) { texture.dispose(); throw new Error("场景已关闭"); }
    if (monochrome) {
      // One-byte density/elevation/radiance maps use one quarter of RGBA texture memory.
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      const rgba = context.getImageData(0, 0, image.width, image.height).data;
      const data = new Uint8Array(image.width * image.height);
      // Typed-array uploads are bottom-up, unlike the source image's north-to-south rows.
      for (let y = 0; y < image.height; y++) {
        const source = (image.height - 1 - y) * image.width * 4;
        for (let x = 0; x < image.width; x++) data[y * image.width + x] = rgba[source + x * 4];
      }
      texture.dispose();
      canvas.width = canvas.height = 1;
      texture = new THREE.DataTexture(data, image.width, image.height, THREE.RedFormat);
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
    } else texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = this.surfaceAnisotropy;
    texture.needsUpdate = true;
    this.textures.add(texture);
    return texture;
  }

  private updateEarthDetail(delta: number, time: number) {
    const model = this.flying ? this.flightModels.find(model => model.body.id === "earth") : this.models.get("earth");
    const active = !!model && (this.flying ? model.group.visible && this.dynamics?.systemId === "solar" : this.currentModel === model);
    const capable = !this.compactTextures && this.renderer.capabilities.maxTextureSize >= 8192
      && (this.renderer.domElement.dataset.softwareRenderer !== "true" || this.quality === "ultra");
    for (const [earth, detail] of this.earthDetails) if (earth !== model) detail.update(undefined, this.camera, false, delta, time);
    if (model) this.earthDetails.get(model)?.update(active ? model.surface : undefined,
      this.camera, active && capable && this.earthUpgraded && this.quality === "ultra", delta, time);
    if (!active || !capable || this.quality === "standard" || this.earthUpgraded || this.earthUpgrade || time < this.earthUpgradeAt) return;
    const batch: THREE.Texture[] = [];
    this.earthUpgrade = (async () => {
      // Stagger decoding and uploads; one large map at a time avoids a burst of frame stalls.
      for (const file of ["earth-day-8k.jpg", "earth-night-8k.jpg", "earth-terrain-8k.png", "earth-clouds-8k.jpg"]) {
        await this.waitForSpaceWork();
        if (this.destroyed) throw new Error("场景已关闭");
        const texture = await this.loadEarthMap(file, file !== "earth-day-8k.jpg");
        batch.push(texture);
        await this.waitForSpaceWork();
        if (this.destroyed) throw new Error("场景已关闭");
        this.renderBudget.hold(1.5);
        this.renderer.initTexture(texture);
      }
      if (this.destroyed) throw new Error("场景已关闭");
      this.earthHighMaps = batch;
      for (const earth of this.earthDetails.keys()) this.applyEarthMaps(earth, batch);
      this.earthUpgraded = true;
      this.renderer.domElement.dataset.earthMaps = "8k";
    })().catch(() => {
      batch.forEach(texture => this.releaseEarthMap(texture));
      this.earthUpgradeAt = performance.now() + 30_000;
    }).finally(() => { this.earthUpgrade = undefined; });
  }

  private applyEarthMaps(model: PlanetModel, maps: THREE.Texture[]) {
    const uniforms = (model.surface.material as THREE.ShaderMaterial).uniforms;
    for (const [i, name, size] of [[0, "dayMap", "mapSize"], [1, "nightMap", "nightSize"],
      [2, "terrainMap", "terrainSize"], [3, "cloudMap", "cloudSize"]] as const) {
      uniforms[name].value = maps[i];
      uniforms[size].value.set(maps[i].image.width, maps[i].image.height);
    }
    const cloudUniforms = ((model.layers.clouds as THREE.Mesh).material as THREE.ShaderMaterial).uniforms;
    cloudUniforms.cloudMap.value = maps[3];
    cloudUniforms.mapSize.value.set(maps[3].image.width, maps[3].image.height);
  }

  private createEarthModel(
    maps: THREE.Texture[],
    sunDirection = this.sunDirection,
  ): PlanetModel {
    maps = this.earthHighMaps ?? maps;
    maps[0].colorSpace = THREE.SRGBColorSpace;
    const group = new THREE.Group();
    group.rotation.z = THREE.MathUtils.degToRad(EARTH.axialTiltDeg);
    const compactMesh = this.compactTextures || this.renderer.domElement.dataset.softwareRenderer === "true";
    const geometry = new THREE.SphereGeometry(1, compactMesh ? 256 : 512, compactMesh ? 128 : 256);
    const detail = new EarthDetail(maps[0], file => this.loadEarthMap(file),
      texture => this.releaseEarthMap(texture), texture => {
        this.renderBudget.hold(1.5);
        this.renderer.initTexture(texture);
      }, this.renderer.domElement);
    const surface = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
        vertexShader: earthSurfaceVertex,
        fragmentShader: surfaceFragment,
        uniforms: {
          dayMap: { value: maps[0] },
          nightMap: { value: maps[1] },
          terrainMap: { value: maps[2] },
          cloudMap: { value: maps[3] },
          ...detail.uniforms,
          terrainSize: { value: new THREE.Vector2(maps[2].image.width, maps[2].image.height) },
          nightSize: { value: new THREE.Vector2(maps[1].image.width, maps[1].image.height) },
          cloudSize: { value: new THREE.Vector2(maps[3].image.width, maps[3].image.height) },
          mapSize: { value: new THREE.Vector2(maps[0].image.width, maps[0].image.height) },
          cloudsEnabled: { value: 1 },
          cloudOffset: { value: 0 },
          flatClouds: { value: 0 },
          terrainDetail: { value: 1 },
          elevationStrength: { value: 1 },
          sunDirection: { value: sunDirection },
        },
      }),
    );
    surface.rotation.y = -1.8;
    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(1.0018, 256, 128),
      new THREE.ShaderMaterial({
        vertexShader: surfaceVertex,
        fragmentShader: earthCloudFragment,
        uniforms: {
          cloudMap: { value: maps[3] },
          mapSize: { value: new THREE.Vector2(maps[3].image.width, maps[3].image.height) },
          sunDirection: { value: sunDirection },
        },
        transparent: true,
        depthWrite: false,
      }),
    );
    clouds.rotation.y = surface.rotation.y;
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1 + EARTH.atmosphereKm! / EARTH.radiusKm, 128, 96),
      new THREE.ShaderMaterial({
        vertexShader: surfaceVertex,
        fragmentShader: atmosphereFragment,
        uniforms: { sunDirection: { value: sunDirection },
          planetCenter: { value: group.position }, bodyRadius: { value: 1 },
          atmosphereColor: { value: new THREE.Color(surfaceProfile("earth").sky) },
          atmosphereHeight: { value: EARTH.atmosphereKm! / EARTH.radiusKm }, strength: { value: atmosphereStrength("earth") }, uTime: { value: 0 } },
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    group.add(surface, clouds, atmosphere);
    this.renderer.domElement.dataset.earthMaps = this.earthHighMaps ? "8k" : "4k";
    this.renderer.domElement.dataset.earthMesh = `${geometry.parameters.widthSegments}x${geometry.parameters.heightSegments}`;
    const model: PlanetModel = {
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
    this.earthDetails.set(model, detail);
    return model;
  }

  private updateCloudShadow(model: PlanetModel) {
    if (model.body.id !== "earth") return;
    const uniforms = (model.surface.material as THREE.ShaderMaterial).uniforms;
    const clouds = model.layers.clouds!;
    const turns = (model.surface.rotation.y-clouds.rotation.y)/(Math.PI*2);
    uniforms.cloudOffset.value = turns - Math.floor(turns);
    uniforms.cloudsEnabled.value = Number(clouds.visible || uniforms.flatClouds.value>0);
  }
  private readonly resize = () => {
    if (this.destroyed) return;
    const { width, height } = this.container.getBoundingClientRect();
    this.flightWidth = width;
    this.flightHeight = height;
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.configureRenderBudget();
  };

  private configureRenderBudget() {
    this.renderBudget.configure(this.quality, window.devicePixelRatio, this.flightWidth, this.flightHeight, this.minimumRenderRatio);
    this.applyRenderBudget();
  }
  private applyRenderBudget() {
    this.renderer.setPixelRatio(this.renderBudget.ratio);
    this.flightFrameDirty = true;
    this.renderer.domElement.dataset.renderScale = this.renderBudget.ratio.toFixed(2);
  }

  /** Chase smoothing can approach its final pose indefinitely; subpixel changes need no new paused frame. */
  private flightCameraQuiet() {
    const positionTolerance = Math.max(1e-14, this.camera.position.lengthSq() * 1e-8);
    return this.camera.position.distanceToSquared(this.drawnCameraPosition) <= positionTolerance
      && 1 - Math.abs(this.camera.quaternion.dot(this.drawnCameraQuaternion)) <= 1e-9
      && Math.abs(this.camera.fov - this.drawnCameraFov) <= 0.001;
  }

  private recordFlightRender() {
    this.flightFrameDirty = false;
    this.drawnCameraPosition.copy(this.camera.position);
    this.drawnCameraQuaternion.copy(this.camera.quaternion);
    this.drawnCameraFov = this.camera.fov;
    this.renderer.domElement.dataset.worldRenderCount = String(++this.worldRenderCount);
  }

  private readonly animate = (time: number) => {
    if (this.destroyed) return;
    this.frame = requestAnimationFrame(this.animate);
    if (this.hidden) return;
    const delta = this.lastTime
      ? Math.min((time - this.lastTime) / 1000, 0.25)
      : 0;
    this.lastTime = time;
    // Adapt resolution only while the picture moves; a paused, still view is restored to full sharpness.
    const moved = !this.camera.position.equals(this.lastCameraPosition) || !this.camera.quaternion.equals(this.lastCameraQuaternion);
    this.lastCameraPosition.copy(this.camera.position);
    this.lastCameraQuaternion.copy(this.camera.quaternion);
    const animating = this.flying ? !this.flightPaused : !this.paused || moved || !!this.targetPosition;
    this.stillSeconds = animating ? 0 : this.stillSeconds + delta;
    if (animating ? this.renderBudget.sample(delta) : this.stillSeconds > 0.4 && this.renderBudget.rest()) this.applyRenderBudget();
    if (this.flying) {
      this.animateFlight(delta, time);
      if (this.renderPolicy.mode === "space") {
        this.updateSurfaceMaps(delta, time);
        this.updateEarthDetail(delta, time);
      }
      const reuseFrame = this.flightPaused && this.renderPolicy.mode === "surface"
        && this.stillSeconds > 0.4 && !this.flightFrameDirty && this.flightCameraQuiet();
      this.renderer.domElement.dataset.surfaceFrameIdle = String(reuseFrame);
      // RAF, controls, tracking and HUD continue above; retain the last canvas frame instead of repeating GPU work.
      if (reuseFrame) return;
      this.renderer.render(this.renderPolicy.mode === "surface" ? this.surfaceWorldScene : this.spaceScene, this.camera);
      this.recordFlightRender();
      if (this.ship.group.visible) {
        // The hull pass uses the same physical scale as the world camera.
        const camera = this.shipCamera;
        if (camera.aspect !== this.camera.aspect || camera.fov !== this.camera.fov) {
          camera.aspect = this.camera.aspect;
          camera.fov = this.camera.fov;
          camera.updateProjectionMatrix();
        }
        camera.position.copy(this.camera.position).multiplyScalar(1 / this.shipScale);
        camera.quaternion.copy(this.camera.quaternion);
        this.shipSun.position.copy(this.flightSun.position).normalize().multiplyScalar(10);
        this.shipSun.intensity = 2.8 * this.flightLight.illumination;
        this.shipRim.position.copy(camera.position).normalize().multiplyScalar(-10);
        this.shipAmbient.intensity = 0.28 + this.flightLight.illumination * 0.57;
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(this.shipScene, camera);
        this.renderer.autoClear = true;
      }
      return;
    }
    this.updateSurfaceMaps(delta, time);
    if (!this.paused && this.currentModel) {
      for (const { object, rate } of this.currentModel.spinning)
        object.rotation.y += delta * rate * this.speed;
      this.updateCloudShadow(this.currentModel);
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
    this.updateEarthDetail(delta, time);
    this.renderer.render(this.spaceScene, this.camera);
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
    await this.loadEarthTextures(onProgress);
    if (this.destroyed || version !== this.selectionVersion) return false;
    this.dynamics = new ShipDynamics(config);
    this.shipScale = SHIP_LENGTH_KM / (config.unitsKm * this.ship.hullLength);
    this.renderer.domElement.dataset.shipLengthKm = String(SHIP_LENGTH_KM);
    this.dynamics.jump(id);
    this.flightBoost = 0;
    this.flightMetrics = 0;
    this.flightPaused = false;
    this.flying = true;
    this.flightFrameDirty = true;
    this.renderPolicy.reset();
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
    const scene = this.renderPolicy.mode === "surface" ? this.surfaceWorldScene : this.spaceScene;
    this.renderer.compile(scene, this.camera);
    this.renderer.render(scene, this.camera);
    this.recordFlightRender();
    onProgress(100);
    if (!this.frame) this.animate(0);
    return true;
  }
  /** Bodies acquire GPU meshes only after growing large enough to be visible in the space renderer. */
  private createFlightModel(body: WorldConfig["bodies"][number]): PlanetModel {
    const config = this.dynamics!.config;
    const center = new THREE.Vector3().fromArray(body.position);
    const hostId = body.hostStarId ?? systemConfig(config, bodySystem(body)).primaryStar;
    const host = config.bodies.find(candidate => candidate.id === hostId)!;
    const light = body.kind === "star" ? this.sunDirection
      : new THREE.Vector3().fromArray(host.position).sub(center).normalize();
    const model =
      body.id === "earth"
        ? this.createEarthModel(this.earthMaps!, light)
        : createPlanetModel(getBody(body.id), light, {
            center,
            radius: body.radius,
          }, this.planetMaps.get(body.id) ?? this.lazyMaps.get(SURFACE_MAPS[body.id]?.file ?? "")?.texture);
    const spheres: THREE.Mesh[] = [];
    model.group.traverse((object) => {
      if (object instanceof THREE.Mesh && object.geometry instanceof THREE.SphereGeometry) {
        const radius = object.geometry.parameters.radius;
        object.geometry.scale(1/radius,1/radius,1/radius);
        object.scale.multiplyScalar(radius);
        this.flightGeometries.set(object,object.geometry);
        spheres.push(object);
      }
      if (object instanceof THREE.Mesh && object.material instanceof THREE.ShaderMaterial && object.material.uniforms.planetCenter)
        object.material.uniforms.planetCenter.value = model.group.position;
    });
    model.group.position.copy(center);
    model.group.scale.setScalar(body.radius);
    // Collision uses the mean-radius sphere. Match rocky flight surfaces to it.
    if (body.id !== "sun" && !["jupiter", "saturn", "uranus", "neptune"].includes(body.id)) {
      model.surface.scale.y = 1;
      model.layers.atmosphere?.traverse(object => { if (object instanceof THREE.Mesh) object.scale.y = object.scale.x; });
    }
    this.flightSpheres.set(model,spheres);
    this.flightRoot.add(model.group);
    this.flightModels.push(model);
    this.flightModelById.set(body.id, model);
    this.renderer.domElement.dataset.spaceModels = String(this.flightModels.length);
    return model;
  }

  leaveFlight() {
    if (!this.flying) return;
    this.flying = false;
    this.flightFrameDirty = true;
    this.renderPolicy.reset();
    this.resumeSpaceWork();
    this.renderer.domElement.dataset.renderMode = "observation";
    this.renderer.domElement.dataset.spaceWorkActive = "true";
    this.renderer.domElement.dataset.surfaceFrameIdle = "false";
    this.flightControls?.dispose();
    this.flightControls = undefined;
    this.planet.visible = true;
    this.flightRoot.visible = false;
    this.observeSun.visible = true;
    this.surfaceScene.group.visible = false;
    this.surfaceScene.sky.visible = false;
    this.flightSun.visible = false;
    this.controls.enabled = true;
    this.warpEffect.mesh.visible = false;
    this.flightLight.mesh.visible = false;
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
    if (this.flightPaused !== paused) this.flightFrameDirty = true;
    this.flightPaused = paused;
    this.flightControls?.clear();
  }
  flightState(): FlightState | null {
    return this.dynamics?.snapshot() ?? null;
  }
  restoreFlight(state: unknown) {
    const restored = this.dynamics?.restore(state) ?? false;
    if (restored) { this.flightFrameDirty = true; this.updateFlightCamera(1); }
    return restored;
  }
  setDestination(id: BodyId) {
    if (this.dynamics && !this.dynamics.warping) this.dynamics.target = id;
    // Prefetch so the destination is already high resolution on arrival.
    this.touchSurfaceMap(id);
  }
  alignFlight() {
    if (this.dynamics?.landingPhase !== "manual") return;
    this.flightFrameDirty = true;
    this.dynamics?.align();
    if (this.flying && this.dynamics) this.updateFlightCamera(1);
    this.flightControls?.clear();
  }
  jumpFlight(): string | null {
    if (!this.dynamics) return "飞船尚未就绪";
    const error = this.dynamics.startWarp();
    if (!error) this.flightFrameDirty = true;
    this.flightControls?.clear();
    return error;
  }
  cancelWarp() {
    if (this.dynamics?.warping) this.flightFrameDirty = true;
    this.dynamics?.cancelWarp();
  }
  setAtmosphericFlightSpeed(mps: number) { this.dynamics?.setAtmosphericSpeed(mps); }
  setFlightEngineMode(mode: ShipDynamics["engineMode"]): string | null {
    return this.dynamics?.setEngineMode(mode) ?? (this.dynamics ? null : "飞船尚未就绪");
  }
  startOrbitalFlight(): string | null {
    if (!this.dynamics) return "飞船尚未就绪";
    const error = this.dynamics.startOrbitalEngine();
    this.flightControls?.clear();
    return error;
  }
  landFlight(): string | null {
    if (!this.dynamics) return "飞船尚未就绪";
    this.flightControls?.clear();
    if (this.dynamics.landingPhase !== "manual" && this.dynamics.landingPhase !== "landed") {
      this.flightFrameDirty = true;
      this.dynamics.cancelLanding(); return null;
    }
    const error = this.dynamics.landingPhase === "landed" ? this.dynamics.takeOff() : this.dynamics.startLanding();
    if (!error) this.flightFrameDirty = true;
    return error;
  }
  setFlightCamera(view: "cockpit" | "chase") {
    if (this.dynamics) {
      this.flightFrameDirty = true;
      this.dynamics.camera = view;
      this.updateFlightCamera(1);
    }
  }
  setFlightAssist(assist: boolean) {
    if (this.dynamics) this.dynamics.assist = assist;
  }
  private updateSpaceWorld() {
    const ship = this.dynamics!;
    const environment = ship.environment;
    this.renderer.domElement.dataset.spaceUpdates = String(++this.spaceUpdates);
    const pixelsPerRadian = this.flightHeight * this.renderer.getPixelRatio()
      / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    // CPU positions remain in double precision. GPU objects are relative to the ship.
    for (const model of this.flightModels) model.group.visible = false;
    for (const body of ship.activeBodies) {
      this.flightRelative.fromArray(body.position).sub(ship.position);
      const angularRadius = body.radius / Math.max(this.flightRelative.length(), 1e-9);
      const pixelRadius = angularRadius * pixelsPerRadian;
      if (pixelRadius <= 0.65) continue;
      const model = this.flightModelById.get(body.id) ?? this.createFlightModel(body);
      model.group.position.copy(this.flightRelative);
      model.group.visible = true;
      // Maps stream in as bodies grow beyond a few pixels; far ones keep the procedural fallback.
      if (pixelRadius > 4) this.touchSurfaceMap(model.body.id);
      const lod = pixelRadius < 8 ? this.tinySphere : pixelRadius < 100 ? this.distantSphere : pixelRadius < 280 ? this.mediumSphere : pixelRadius < 700 ? this.largeSphere : undefined;
      for (const sphere of this.flightSpheres.get(model)!) sphere.geometry = lod ?? this.flightGeometries.get(sphere)!;
      // The local curved tile adds detail above the coarse globe; clouds stay overhead.
      if (model.layers.atmosphere) model.layers.atmosphere.visible = pixelRadius > 12 && (model.body.id !== environment.body.id || !this.surfaceScene.usesAtmosphere(ship));
      if (model.layers.clouds) model.layers.clouds.visible = pixelRadius > 12;
      if (body.id === "earth") {
        const uniforms = (model.surface.material as THREE.ShaderMaterial).uniforms;
        uniforms.flatClouds.value = Number(pixelRadius < 280);
        uniforms.terrainDetail.value = Number(pixelRadius >= 280);
        // Let the collision-matched local terrain take over before the camera reaches it.
        uniforms.elevationStrength.value = environment.body.id === "earth"
          ? THREE.MathUtils.smoothstep(environment.groundAltitudeKm, 50, 80) : 1;
        model.layers.clouds!.visible = pixelRadius >= 280;
        this.updateCloudShadow(model);
      }
    }
  }

  /** Take resident asset references once at entry; the local world never traverses or updates space models. */
  private snapshotSurfaceMaps(bodyId: BodyId) {
    const model = this.flightModelById.get(bodyId);
    const axialTilt = getBody(bodyId).axialTiltDeg;
    const map = SURFACE_MAPS[bodyId];
    const pose = { group: model?.group.quaternion, surface: model?.surface.quaternion,
      clouds: model?.layers.clouds?.quaternion };
    const rotation = surfaceMapRotation(bodyId, axialTilt, pose, map?.offset);
    const cloudRotation = bodyId === "earth" ? surfaceMapRotation(bodyId, axialTilt,
      { group: pose.group, surface: pose.clouds }) : rotation;
    const earth = this.earthHighMaps ?? this.earthMaps;
    const texture = bodyId === "earth" ? earth?.[0]
      : this.planetMaps.get(bodyId) ?? this.lazyMaps.get(SURFACE_MAPS[bodyId]?.file ?? "")?.texture;
    this.surfaceScene.setHorizonMap(bodyId, texture ?? null, rotation,
      bodyId === "earth" ? earth?.[3] ?? null : null, cloudRotation,
      new THREE.Vector3(...(map?.tint ?? [1, 1, 1])));
    this.surfaceMapBody = bodyId;
  }

  private updateFlightCamera(blend: number) {
    const ship = this.dynamics!;
    const environment = ship.environment;
    const previousMode = this.renderPolicy.mode;
    const mode = this.renderPolicy.update({ bodyId: environment.body.id,
      atmosphereKm: environment.body.atmosphereKm, altitudeKm: environment.altitudeKm,
      groundAltitudeKm: environment.groundAltitudeKm, solid: environment.profile.solid, warping: ship.warping });
    if (mode !== previousMode) this.flightFrameDirty = true;
    if (mode !== previousMode || this.surfaceScene.sky.parent !== (mode === "surface" ? this.surfaceWorldScene : this.spaceScene)) {
      const scene = mode === "surface" ? this.surfaceWorldScene : this.spaceScene;
      scene.add(this.surfaceScene.sky, this.flightLight.mesh);
      if (mode === "space") this.resumeSpaceWork();
    }
    this.renderer.domElement.dataset.renderMode = mode;
    this.renderer.domElement.dataset.spaceWorkActive = String(mode === "space");
    if (mode === "surface" && (previousMode !== "surface" || this.surfaceMapBody !== environment.body.id))
      this.snapshotSurfaceMaps(environment.body.id);
    if (mode === "space") this.updateSpaceWorld();
    const stars = ship.activeBodies.filter(body => body.kind === "star");
    const light = stars.reduce((closest, body) =>
      this.flightRelative.fromArray(body.position).distanceToSquared(ship.position)
        < this.flightForward.fromArray(closest.position).distanceToSquared(ship.position) ? body : closest);
    this.flightSun.position.fromArray(light.position).sub(ship.position);
    this.flightSun.color.set(getBody(light.id).color);
    this.shipSun.color.copy(this.flightSun.color);
    this.useSystemBackground(ship.systemId);
    const scale = this.shipScale;
    const surfaceView = environment.profile.solid ? 1-THREE.MathUtils.smoothstep(environment.groundAltitudeKm,20,50) : 0;
    this.ship.group.position.set(0,this.ship.landingFootOffset*surfaceView,0).applyQuaternion(ship.orientation);
    this.ship.group.scale.setScalar(1);
    const attitude = ship.orientation.clone().multiply(this.bankRotation.setFromAxisAngle(this.flightAxis, ship.bank));
    this.ship.group.quaternion.copy(attitude);
    this.ship.group.visible = ship.camera === "chase" && !ship.warping;
    const cameraScale = THREE.MathUtils.lerp(scale,0.000015,surfaceView);
    const chaseY = THREE.MathUtils.lerp(1.2,0.19,surfaceView);
    const chaseZ = THREE.MathUtils.lerp(9+this.flightBoost*0.6,0.72,surfaceView);
    const offset = new THREE.Vector3(0,ship.camera === "chase" ? chaseY : 0,ship.camera === "chase" ? chaseZ : 0).multiplyScalar(cameraScale).applyQuaternion(ship.orientation);
    if (ship.camera === "chase") {
      this.camera.position.lerp(offset, blend);
      // Keep the chase camera in the pilot's altitude band, including a steep descent.
      // A several-hundred-km hull framing offset must not move the sky back into space.
      if (environment.body.atmosphereKm && environment.altitudeKm < environment.body.atmosphereKm * 4) {
        const relative = ship.position.clone().sub(new THREE.Vector3().fromArray(environment.body.position));
        const near = 1 - THREE.MathUtils.smoothstep(environment.altitudeKm, environment.body.atmosphereKm, environment.body.atmosphereKm * 4);
        const maxOffsetKm = THREE.MathUtils.lerp(1200, Math.max(0.02, environment.altitudeKm * 0.15), near);
        const limit = maxOffsetKm / ship.config.unitsKm;
        const radialOffset = this.camera.position.dot(environment.outward);
        if (Math.abs(radialOffset) > limit) {
          const distance = this.camera.position.length();
          const tangent = this.camera.position.clone().addScaledVector(environment.outward, -radialOffset);
          if (tangent.lengthSq() < 1e-12) tangent.set(1, 0, 0).applyQuaternion(attitude).projectOnPlane(environment.outward);
          const radial = THREE.MathUtils.clamp(radialOffset, -limit, limit);
          this.camera.position.copy(tangent.normalize().multiplyScalar(Math.sqrt(Math.max(0, distance * distance - radial * radial))))
            .addScaledVector(environment.outward, radial);
        }
        const cameraRadial = relative.clone().add(this.camera.position);
        const minRadius = environment.body.radius + Math.max(environment.groundHeightKm + 0.002, environment.altitudeKm - maxOffsetKm) / ship.config.unitsKm;
        const maxRadius = environment.body.radius + (environment.altitudeKm + maxOffsetKm) / ship.config.unitsKm;
        cameraRadial.clampLength(minRadius, Math.max(minRadius, maxRadius));
        this.camera.position.copy(cameraRadial.sub(relative));
      }
      this.camera.up.set(0, 1, 0).applyQuaternion(attitude);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.orientation);
      const nearAtmosphere = environment.body.atmosphereKm
        ? 1 - THREE.MathUtils.smoothstep(environment.altitudeKm, environment.body.atmosphereKm, environment.body.atmosphereKm * 4) : 0;
      this.camera.up.lerp(environment.outward, nearAtmosphere * Math.pow(forward.dot(environment.outward), 2)).normalize();
      const lookAhead = 5 * cameraScale * (1 - nearAtmosphere * Math.abs(forward.dot(environment.outward)) * 0.92);
      this.camera.lookAt(forward.multiplyScalar(lookAhead));
    } else {
      this.camera.position.copy(offset);
      this.camera.quaternion.slerp(attitude, blend);
    }
    const strength = ship.warpPhase === "transit" ? Math.sin(ship.warpProgress * Math.PI) * 0.65 + 0.35 : ship.warpPhase === "charging" ? ship.warpProgress * 0.15 : ship.warpPhase === "arrival" ? (1 - ship.warpProgress) ** 2 * 0.35 : 0;
    this.warpEffect.mesh.visible = strength > 0;
    this.warpEffect.material.uniforms.strength.value = strength;
    this.warpEffect.material.uniforms.time.value = ship.elapsed;
    this.warpEffect.material.uniforms.aspect.value = this.camera.aspect;
    const fov = 58 + strength * 25 + this.flightBoost * 9;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    if (mode === "surface") this.surfaceScene.update(ship, this.camera, this.flightSun);
    else this.surfaceScene.updateSky(ship, this.camera, this.flightSun);
    this.flightLight.update(ship, this.camera, this.flightSun);
    this.useSystemBackground(ship.systemId);
    this.ship.gear.visible = ship.landingPhase !== "manual" || (environment.profile.solid && environment.groundAltitudeKm < 1);
  }
  private animateFlight(delta: number, time: number) {
    const ship = this.dynamics!;
    const input = this.flightControls!.read();
    if (!this.flightPaused) {
      ship.step(delta, input);
    }
    if (!this.flightPaused) this.flightBoost = THREE.MathUtils.lerp(this.flightBoost,
      input.boost && ship.velocity.length() > 0 && !ship.warping ? 1 : 0, 1 - Math.exp(-delta * 4));
    const exhaust = this.flightPaused || ship.warping ? 0.1 : input.boost && input.throttle > 0 ? 2.4 : input.throttle > 0 ? 1 : 0.22;
    this.ship.exhaust.scale.z = THREE.MathUtils.lerp(this.ship.exhaust.scale.z, exhaust, 1 - Math.exp(-delta * 10));
    this.updateFlightCamera(1 - Math.exp(-delta * 9));
    if (!this.flightPaused && !this.paused && this.renderPolicy.mode === "space")
      for (const model of this.flightModels) {
        if (!model.group.visible) continue;
        // Keep surface features fixed in the collision frame while flying; clouds still drift.
        for (const { object, rate } of model.spinning)
          if (object !== model.surface) object.rotation.y += rate * delta;
        this.updateCloudShadow(model);
        for (const uniform of model.timeUniforms) uniform.value += delta;
      }
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
      renderMode: this.renderPolicy.mode,
      engine: ship.engine,
      atmosphericSpeedMps: ship.atmosphericSpeedMps,
      engineMode: ship.engineMode,
      orbitalEngineActive: ship.orbitalEngineActive,
      orbitalBlockReason: ship.orbitalBlockReason,
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
      layer === "stars" ? this.galaxySky.mesh : this.currentModel?.layers[layer];
    if (object) object.visible = visible;
    if (layer === "clouds" && this.currentModel) this.updateCloudShadow(this.currentModel);
    if (layer === "stars") {
      this.starsEnabled = visible;
      this.useSystemBackground(this.backgroundSystem);
    }
    if (layer === "rings" && this.currentModel?.ringsEnabled)
      this.currentModel.ringsEnabled.value = Number(visible);
  }
  setQuality(quality: RenderQuality) {
    if (quality === this.quality) return;
    this.quality = quality;
    this.galaxySky.setDetailed(quality !== "standard" && !this.compactTextures
      && this.renderer.domElement.dataset.softwareRenderer !== "true");
    this.configureRenderBudget();
  }
  getQuality(): RenderQuality { return this.quality; }
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
    this.destroyed = true;
    this.resumeSpaceWork();
    this.galaxySky.dispose();
    this.surfaceGalaxySky.dispose();
    this.surfaceScene.dispose();
    this.earthDetails.forEach(detail => detail.dispose());
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
    geometries.add(this.mediumSphere);
    geometries.add(this.tinySphere);
    geometries.add(this.largeSphere);
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
    this.spaceScene.traverse(collect);
    this.surfaceWorldScene.traverse(collect);
    this.shipScene.traverse(collect);
    this.models.forEach((model) => model.group.traverse(collect));
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.textures.forEach((texture) => texture.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
