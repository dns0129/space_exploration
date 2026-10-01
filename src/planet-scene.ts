import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EARTH, getBody } from "./solar-system";
import type { BodyId, Layer } from "./solar-system";
import { createPlanetModel } from "./planet-models";
import type { PlanetModel } from "./planet-models";

export type View = "overview" | "close" | "night";
export interface SceneStats {
  altitudeKm: number;
  fps: number;
}

const surfaceVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const surfaceFragment = /* glsl */ `
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
    vec3 color = day * (0.025 + diffuse * 1.4);
    // Isolate the warm city lights from the blue-tinted night-map terrain.
    float cityLight = max(night.r - night.b * 0.7, 0.0);
    color += vec3(1.0, 0.65, 0.32) * pow(cityLight, 0.7) * nightWeight * 5.0;
    color += vec3(0.9, 0.95, 1.0) * specular * water * smoothstep(0.0, 0.15, daylight) * 0.5;
    float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 4.0);
    color += vec3(0.035, 0.22, 0.55) * rim * smoothstep(-0.3, 0.6, daylight) * 0.35;
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const atmosphereFragment = /* glsl */ `
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
    const sun = new THREE.DirectionalLight(0xfff3e5, 2.5);
    sun.position.set(-3, 1.8, 4);
    this.scene.add(sun, new THREE.AmbientLight(0x9dbde8, 0.09));
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(container);
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.resize();
  }

  async selectBody(
    id: BodyId,
    onProgress: (percent: number) => void,
  ): Promise<boolean> {
    const version = ++this.selectionVersion;
    const maps =
      id === "earth" ? await this.loadEarthTextures(onProgress) : undefined;
    if (this.destroyed || version !== this.selectionVersion) return false;
    let model = this.models.get(id);
    if (!model) {
      model =
        id === "earth"
          ? this.createEarthModel(maps!)
          : createPlanetModel(getBody(id), this.sunDirection);
      this.models.set(id, model);
    }
    this.planet.clear();
    this.planet.add(model.group);
    this.currentModel = model;
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

  private createEarthModel(maps: THREE.Texture[]): PlanetModel {
    maps[0].colorSpace = THREE.SRGBColorSpace;
    maps[1].colorSpace = THREE.SRGBColorSpace;
    maps[4].colorSpace = THREE.SRGBColorSpace;
    const sunDirection = this.sunDirection;
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
      new THREE.SphereGeometry(1.035, 128, 96),
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
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private readonly animate = (time: number) => {
    if (this.destroyed) return;
    this.frame = requestAnimationFrame(this.animate);
    if (this.hidden) return;
    const delta = this.lastTime
      ? Math.min((time - this.lastTime) / 1000, 0.05)
      : 0;
    this.lastTime = time;
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
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    this.renderer.domElement.removeEventListener(
      "webglcontextlost",
      this.contextLost,
    );
    this.controls.dispose();
    const geometries = new Set<THREE.BufferGeometry>();
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
    this.models.forEach((model) => model.group.traverse(collect));
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.textures.forEach((texture) => texture.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
