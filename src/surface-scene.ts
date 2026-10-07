import * as THREE from "three";
import { surfaceProfile, terrainHeightKm } from "../shared/surface.mjs";
import type { ShipDynamics } from "./ship-dynamics";
import type { WalkingDynamics } from "./walking-dynamics";
import { atmosphereCloudProfile, atmosphereScattering, atmosphereStrength } from "./atmosphere";
import { entryClouds } from "./entry-clouds";

/** A small curved terrain tile near the pilot, independent of AU-scale GPU coordinates. */
export class SurfaceScene {
  readonly group = new THREE.Group();
  readonly sky: THREE.Mesh;
  spaceVisibility = 1;
  private terrain?: THREE.Mesh;
  private rocks?: THREE.InstancedMesh;
  private horizon?: THREE.Mesh;
  private horizonBodyId = "";
  private horizonMapBodyId = "";
  private anchor = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private bodyId = "";
  private tileExtentKm = 10;
  private walkingDetail = false;
  private readonly terrainUniforms = {
    groundCamera: { value: new THREE.Vector3() },
    groundFog: { value: new THREE.Color() },
    groundSun: { value: new THREE.Vector3() },
    groundVisibility: { value: 1 },
    groundAtmosphere: { value: 0 },
    groundExtent: { value: 10000 },
    groundHorizonOffset: { value: new THREE.Vector3() },
    groundHorizonMap: { value: null as THREE.Texture | null },
    groundHorizonCloudMap: { value: null as THREE.Texture | null },
    groundMapRotation: { value: new THREE.Matrix3() },
    groundMapTint: { value: new THREE.Vector3(1, 1, 1) },
    groundCloudRotation: { value: new THREE.Matrix3() },
    groundMapReady: { value: 0 },
    groundCloudMapReady: { value: 0 },
    groundMapBlend: { value: 0 },
    groundCloudMapBlend: { value: 0 },
  };
  private readonly groundDetail: THREE.DataTexture;
  private readonly light = new THREE.DirectionalLight(0xffead1, 2.2);
  private readonly ambient = new THREE.HemisphereLight(0xcbdce8, 0x3a3028, 0.8);
  private readonly skyMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false,
    uniforms: { rotation: { value: new THREE.Matrix3() }, up: { value: new THREE.Vector3() },
      sun: { value: new THREE.Vector3() }, sunColor: { value: new THREE.Color() }, color: { value: new THREE.Color() },
      altitude: { value: 0 }, radius: { value: 6371 }, height: { value: 160 }, strength: { value: 1.5 },
      cloudVolume: { value: 0 }, cloudScale: { value: 1 }, cloudCoverage: { value: 0 }, cloudColor: { value: new THREE.Color() }, time: { value: 0 },
      aspect: { value: 1 }, fov: { value: 1 } },
    vertexShader: `varying vec2 screen; void main() { screen = uv * 2.0 - 1.0; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
    fragmentShader: `
      uniform mat3 rotation; uniform vec3 up, sun, sunColor, color, cloudColor;
      uniform float altitude, radius, height, strength, aspect, fov, cloudVolume, cloudScale, cloudCoverage, time; varying vec2 screen;
      ${atmosphereScattering}
      ${entryClouds}
      void main() {
        vec3 ray = normalize(rotation * vec3(screen.x * aspect * fov, screen.y * fov, -1.0));
        vec4 atmosphere = scatterAtmosphere(up, altitude, ray, radius, height, sun, color, strength);
        float solarTransmission = 1.0;
        if (cloudVolume > 0.0) {
          vec4 cirrus = scatterHighClouds(up, altitude, ray, radius, sun, time, cloudScale, cloudCoverage, cloudColor);
          vec4 cloud = scatterEntryClouds(up, altitude, ray, radius, sun, time, cloudScale, cloudCoverage, cloudColor);
          cloud.rgb = mix(cirrus.rgb, cloud.rgb, cloud.a / max(cloud.a + cirrus.a * (1.0 - cloud.a), 0.001));
          cloud.a += cirrus.a * (1.0 - cloud.a);
          cloud.a *= cloudVolume;
          solarTransmission = 1.0 - cloud.a * 0.96;
          float combined = atmosphere.a + cloud.a * (1.0 - atmosphere.a);
          // Clouds keep their shape even beneath a dense blue daytime sky.
          atmosphere.rgb = mix(atmosphere.rgb, cloud.rgb, cloud.a * 0.88 / max(combined, 0.001));
          atmosphere.a = max(combined, cloud.a);
        }
        // The local sky owns its sun, so it needs no solar-system sphere layer.
        float horizonDip = sqrt(max(altitude * (2.0 * radius + altitude), 0.0)) / (radius + altitude);
        float sunlight = smoothstep(-horizonDip - 0.01, -horizonDip + 0.01, dot(up, sun));
        float disk = smoothstep(0.999972, 0.999987, dot(ray, sun)) * sunlight * solarTransmission;
        float sunset = 1.0 - smoothstep(-0.02, 0.18, dot(up, sun));
        vec3 solarColor = mix(vec3(3.4, 3.15, 2.55), vec3(3.6, 1.35, 0.36), sunset * min(strength, 1.0)) * sunColor;
        atmosphere.rgb = mix(atmosphere.rgb, solarColor, disk);
        atmosphere.a = max(atmosphere.a, disk);
        gl_FragColor = atmosphere;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  constructor() {
    const pixels = new Uint8Array(128 * 128 * 4);
    let seed = 91;
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      seed = (seed * 16807) % 2147483647;
      const mottling = Math.sin(x * Math.PI / 16) * Math.cos(y * Math.PI / 32);
      const value = Math.round(196 + 34 * seed / 2147483647 + mottling * 14);
      const i = (y * 128 + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
      pixels[i + 3] = 255;
    }
    this.groundDetail = new THREE.DataTexture(pixels, 128, 128);
    this.groundDetail.wrapS = this.groundDetail.wrapT = THREE.RepeatWrapping;
    this.groundDetail.magFilter = THREE.LinearFilter;
    this.groundDetail.minFilter = THREE.LinearMipmapLinearFilter;
    this.groundDetail.generateMipmaps = true;
    this.groundDetail.anisotropy = 4;
    this.groundDetail.needsUpdate = true;
    this.sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.skyMaterial);
    this.sky.frustumCulled = false;
    // Composite the sky before local terrain so mountain silhouettes occlude it.
    this.sky.renderOrder = -20;
    this.sky.visible = false;
    this.group.add(this.light, this.light.target, this.ambient);
    this.group.visible = false;
  }
  usesAtmosphere(ship: ShipDynamics) {
    const env = ship.environment;
    return !!env.body.atmosphereKm && env.altitudeKm < env.body.atmosphereKm * 4 && !ship.warping;
  }
  /** Reuse a resident base image at entry without streaming or updating orbital models. */
  setHorizonMap(bodyId: string, texture: THREE.Texture | null, worldToSurfaceRotation: THREE.Matrix3,
      cloudMap: THREE.Texture | null = null, worldToCloudRotation = worldToSurfaceRotation,
      mapTint = new THREE.Vector3(1, 1, 1)) {
    this.horizonMapBodyId = bodyId;
    this.terrainUniforms.groundHorizonMap.value = texture;
    this.terrainUniforms.groundHorizonCloudMap.value = cloudMap;
    this.terrainUniforms.groundMapRotation.value.copy(worldToSurfaceRotation);
    this.terrainUniforms.groundCloudRotation.value.copy(worldToCloudRotation);
    this.terrainUniforms.groundMapTint.value.copy(mapTint);
  }
  /** Space transitions only update the inexpensive sky, never local geometry. */
  updateSky(ship: ShipDynamics, camera: THREE.PerspectiveCamera, sunlight: THREE.PointLight, local = false) {
    const env = ship.environment;
    const center = new THREE.Vector3().fromArray(env.body.position);
    const sun = sunlight.position.clone().normalize();
    const day = THREE.MathUtils.smoothstep(env.outward.dot(sun), -0.18, 0.12);
    this.sky.visible = (this.usesAtmosphere(ship) || local && env.profile.solid) && !ship.warping;
    const cameraRadial = ship.position.clone().sub(center).add(camera.position);
    const cameraAltitudeKm = Math.max(0, (cameraRadial.length() - env.body.radius) * ship.config.unitsKm);
    const depth = env.body.atmosphereKm ? 1 - cameraAltitudeKm / env.body.atmosphereKm : 0;
    this.spaceVisibility = this.sky.visible ? 1 - day * THREE.MathUtils.smoothstep(depth, 0, 0.65) * 0.98 : 1;
    const uniforms = this.skyMaterial.uniforms;
    uniforms.rotation.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(camera.quaternion));
    uniforms.up.value.copy(cameraRadial).normalize();
    uniforms.sun.value.copy(sun);
    uniforms.sunColor.value.copy(sunlight.color);
    uniforms.color.value.set(env.profile.sky);
    uniforms.altitude.value = cameraAltitudeKm;
    uniforms.radius.value = env.body.radius * ship.config.unitsKm;
    uniforms.height.value = env.body.atmosphereKm ?? 1;
    uniforms.strength.value = env.body.atmosphereKm ? atmosphereStrength(env.body.id) : 0;
    uniforms.aspect.value = camera.aspect;
    uniforms.fov.value = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const weather = atmosphereCloudProfile(env.body.id, env.body.atmosphereKm ?? 0);
    uniforms.cloudVolume.value = weather.opacity * (1 - THREE.MathUtils.smoothstep(cameraAltitudeKm, 18 * weather.scale, 36 * weather.scale));
    uniforms.cloudScale.value = weather.scale;
    uniforms.cloudCoverage.value = weather.coverage;
    uniforms.cloudColor.value.set(weather.tint);
    uniforms.time.value = ship.elapsed;
  }
  update(ship: ShipDynamics, camera: THREE.PerspectiveCamera, sunlight: THREE.PointLight, walker?: WalkingDynamics) {
    this.updateSky(ship, camera, sunlight, true);
    const env = ship.environment;
    const center = new THREE.Vector3().fromArray(env.body.position);
    const sun = sunlight.position.clone().normalize();
    const day = THREE.MathUtils.smoothstep(env.outward.dot(sun), -0.18, 0.12);
    this.group.visible = (env.profile.solid || !!env.body.atmosphereKm) && !ship.warping;
    if (!this.group.visible) return;
    const walking = !!walker?.active;
    const surfacePoint = center.clone().addScaledVector(walking ? walker!.outward : env.outward, env.body.radius);
    if (!this.horizon || this.horizonBodyId !== env.body.id) this.rebuildHorizon(ship);
    const detailVisible = env.profile.solid && env.groundAltitudeKm < 70;
    if (detailVisible && (!this.terrain || this.walkingDetail !== walking || this.bodyId !== env.body.id || this.anchor.distanceTo(surfacePoint) * ship.config.unitsKm > (walking ? 0.032 : env.body.id === "earth" && env.groundAltitudeKm < 10 ? 2 : Math.max(1.5, this.tileExtentKm * 0.35))
      || this.tileExtentKm > this.requiredExtentKm(ship) * 1.7
      || this.tileExtentKm < this.requiredExtentKm(ship) * 0.58)) {
      this.walkingDetail = walking;
      this.rebuild(ship, surfacePoint);
    }
    if (!detailVisible) this.anchor.copy(surfacePoint);
    this.group.position.copy(this.anchor).sub(ship.position);
    this.horizon!.position.copy(center).sub(this.anchor);
    this.terrainUniforms.groundHorizonOffset.value.copy(this.horizon!.position).multiplyScalar(ship.config.unitsKm * 1000);
    if (this.terrain) this.terrain.visible = detailVisible;
    if (this.rocks) this.rocks.visible = detailVisible && env.groundAltitudeKm < 2;
    this.terrainUniforms.groundCamera.value.copy(camera.position).sub(this.group.position).multiplyScalar(ship.config.unitsKm * 1000);
    this.terrainUniforms.groundSun.value.copy(sun);
    this.terrainUniforms.groundFog.value.set(env.profile.sky).multiplyScalar(0.035 + day * 0.7);
    this.terrainUniforms.groundVisibility.value = 1 - THREE.MathUtils.smoothstep(env.groundAltitudeKm, 38, 70);
    this.terrainUniforms.groundAtmosphere.value = env.body.atmosphereKm ? day : 0;
    this.terrainUniforms.groundMapReady.value = Number(this.horizonMapBodyId === env.body.id && !!this.terrainUniforms.groundHorizonMap.value);
    this.terrainUniforms.groundCloudMapReady.value = Number(this.horizonMapBodyId === env.body.id && !!this.terrainUniforms.groundHorizonCloudMap.value);
    this.terrainUniforms.groundMapBlend.value = THREE.MathUtils.smoothstep(env.groundAltitudeKm, 38, 80);
    this.terrainUniforms.groundCloudMapBlend.value = THREE.MathUtils.smoothstep(env.altitudeKm, 18, 36);
    this.light.position.copy(sun).multiplyScalar(10);
    this.light.color.copy(sunlight.color);
    this.light.intensity = 2.2 * day;
    this.ambient.intensity = 0.12 + day * 0.55;
    this.ambient.position.copy(env.outward);
  }
  private rebuildHorizon(ship: ShipDynamics) {
    if (this.horizon) {
      this.group.remove(this.horizon);
      this.horizon.geometry.dispose();
      (this.horizon.material as THREE.Material).dispose();
    }
    const env = ship.environment;
    this.horizonBodyId = env.body.id;
    // One small, texture-free curved shell fills everything beyond the detailed
    // tile. It is generated once per local body, including the 70–160 km band.
    const geometry = new THREE.SphereGeometry(env.body.radius, 96, 64);
    const position = geometry.getAttribute("position");
    const colors: number[] = [];
    const ground = new THREE.Color(env.profile.solid ? env.profile.ground : env.profile.sky);
    const normal = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      normal.fromBufferAttribute(position, i).normalize();
      const height = terrainHeightKm(env.body.id, normal.toArray());
      const point = normal.clone().multiplyScalar(env.body.radius + (height - 0.018) / ship.config.unitsKm);
      position.setXYZ(i, point.x, point.y, point.z);
      const gasBand = Math.sin(normal.y * 55 + Math.sin(normal.x * 10 + normal.z * 8) * 1.3);
      const shade = env.profile.solid ? 0.72 + height * 3 : 0.78 + gasBand * 0.12;
      const color = ground.clone().multiplyScalar(shade);
      if (env.body.id === "earth") color.lerp(new THREE.Color("#70834f"), 0.16);
      colors.push(color.r, color.g, color.b);
    }
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, transparent: true });
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.terrainUniforms);
      shader.vertexShader = shader.vertexShader.replace("#include <common>",
        "#include <common>\nvarying vec3 groundPosition, groundRadial; uniform vec3 groundHorizonOffset;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>\ngroundPosition = position * ${Number(ship.config.unitsKm * 1000).toFixed(1)} + groundHorizonOffset; groundRadial = normalize(position);`);
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
        varying vec3 groundPosition, groundRadial; uniform vec3 groundCamera, groundFog, groundSun, groundMapTint;
        uniform sampler2D groundHorizonMap, groundHorizonCloudMap;
        uniform mat3 groundMapRotation, groundCloudRotation;
        uniform float groundAtmosphere, groundMapReady, groundCloudMapReady, groundMapBlend, groundCloudMapBlend;
        vec2 groundSphereUv(vec3 p) {
          p = normalize(p);
          return vec2(fract(atan(p.z, -p.x) / 6.28318530718), 1.0 - acos(clamp(p.y, -1.0, 1.0)) / 3.14159265359);
        }`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          vec3 horizonPhoto = diffuseColor.rgb;
          float horizonCover = 0.0;
          if (groundMapReady * groundMapBlend > 0.0) {
            vec2 groundMapUv = groundSphereUv(groundMapRotation * groundRadial);
            horizonPhoto = texture2D(groundHorizonMap, groundMapUv).rgb * groundMapTint;
            diffuseColor.rgb = mix(diffuseColor.rgb, horizonPhoto, groundMapBlend);
          }
          if (groundCloudMapReady * groundCloudMapBlend > 0.0) {
            vec2 cloudMapUv = groundSphereUv(groundCloudRotation * groundRadial);
            horizonCover = texture2D(groundHorizonCloudMap, cloudMapUv).r * groundCloudMapBlend;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.96, 1.0), horizonCover * 0.82);
          }`)
        .replace("#include <opaque_fragment>", `
          // Base photography uses the same simple day response as the orbital
          // view; local PBR and extra ground haze emerge only during descent.
          float horizonDay = max(dot(normalize(groundRadial), groundSun), 0.0);
          vec3 photoLight = horizonPhoto * (0.015 + horizonDay * 1.08) * (1.0 - horizonCover * 0.26);
          photoLight = mix(photoLight, vec3(0.92, 0.96, 1.0) * (0.035 + horizonDay * 1.1), horizonCover * 0.82);
          outgoingLight = mix(outgoingLight, photoLight, groundMapReady * groundMapBlend);
          float groundDistance = length(groundPosition - groundCamera);
          float haze = (1.0 - exp(-groundDistance / 23000.0)) * groundAtmosphere * 0.6 * (1.0 - groundMapReady * groundMapBlend);
          outgoingLight = mix(outgoingLight, groundFog, haze);
          #include <opaque_fragment>`);
    };
    this.horizon = new THREE.Mesh(geometry, material);
    this.horizon.frustumCulled = false;
    this.horizon.renderOrder = -15;
    this.group.add(this.horizon);
  }
  private requiredExtentKm(ship: ShipDynamics) {
    // Cover the curved horizon while concentrating vertices around the pilot.
    const env = ship.environment;
    return Math.max(env.body.id === "earth" ? 100 : 28, Math.min(900, Math.sqrt(env.body.radius * ship.config.unitsKm * Math.max(0.02, env.groundAltitudeKm)) * 1.9));
  }
  private rebuild(ship: ShipDynamics, point: THREE.Vector3) {
    if (this.terrain) {
      this.group.remove(this.terrain);
      this.terrain.geometry.dispose();
      (this.terrain.material as THREE.Material).dispose();
    }
    if (this.rocks) {
      this.group.remove(this.rocks);
      this.rocks.geometry.dispose();
      (this.rocks.material as THREE.Material).dispose();
    }
    const env = ship.environment;
    this.bodyId = env.body.id;
    this.anchor.copy(point);
    this.normal.copy(point).sub(new THREE.Vector3().fromArray(env.body.position)).normalize();
    const tangent = new THREE.Vector3(0, 1, 0).cross(this.normal).normalize();
    if (tangent.lengthSq() < 0.1) tangent.set(1, 0, 0);
    const bitangent = this.normal.clone().cross(tangent).normalize();
    const segments = this.walkingDetail ? 192 : env.body.id === "earth" ? (env.groundAltitudeKm < 10 ? 192 : 160) : (env.groundAltitudeKm < 2 ? 144 : 96);
    const extentKm = this.tileExtentKm = this.requiredExtentKm(ship);
    this.terrainUniforms.groundExtent.value = extentKm * 1000;
    const positions: number[] = [], colors: number[] = [], indices: number[] = [], uvs: number[] = [];
    const ground = new THREE.Color(surfaceProfile(env.body.id).ground);
    const coordinate = (fraction: number) => {
      const t = fraction * 2 - 1;
      if (!this.walkingDetail) return Math.sinh(t * 4) / Math.sinh(4) * extentKm / ship.config.unitsKm;
      // Keep a dense 180 m patch around the explorer and retain the existing distant horizon.
      const a = Math.abs(t);
      const km = a <= 0.7 ? a / 0.7 * 0.09
        : 0.09 + (extentKm - 0.09) * ((a - 0.7) / 0.3) ** 3;
      return Math.sign(t) * km / ship.config.unitsKm;
    };
    for (let y = 0; y <= segments; y++) for (let x = 0; x <= segments; x++) {
      // Nonuniform spacing gives nearby hills fine geometry and a soft distant horizon.
      const dx = coordinate(x / segments);
      const dy = coordinate(y / segments);
      const radial = this.normal.clone().multiplyScalar(env.body.radius).addScaledVector(tangent, dx).addScaledVector(bitangent, dy).normalize();
      const height = terrainHeightKm(env.body.id, radial.toArray());
      const local = radial.clone().multiplyScalar(env.body.radius + height / ship.config.unitsKm)
        .addScaledVector(this.normal, -env.body.radius);
      positions.push(local.x, local.y, local.z);
      uvs.push(dx * ship.config.unitsKm * 1000 / 128, dy * ship.config.unitsKm * 1000 / 128);
      const shade = env.body.id === "earth" ? 0.88 + Math.min(height, 4) * 0.035 : 0.72 + height * 3;
      const color = ground.clone().multiplyScalar(shade);
      if (env.body.id === "earth") {
        const meadow = new THREE.Color("#70834f"), rock = new THREE.Color("#7d755b");
        color.lerp(meadow, 0.16 + 0.14 * Math.sin(radial.x * 2700 + radial.z * 1200));
        color.lerp(rock, THREE.MathUtils.smoothstep(height, 1.2, 3.2) * 0.75);
        color.lerp(new THREE.Color("#dce3e5"), THREE.MathUtils.smoothstep(height, 3.4, 4.7) * 0.85);
      }
      colors.push(color.r, color.g, color.b);
      if (x < segments && y < segments) {
        const a = y * (segments + 1) + x, b = a + 1, c = a + segments + 1, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, side: THREE.DoubleSide, transparent: true,
      map: this.groundDetail, bumpMap: this.groundDetail, bumpScale: 0.018 / (ship.config.unitsKm * 1000) });
    // Metre-scale procedural grit adds detail without downloading additional textures.
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.terrainUniforms);
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 groundPosition;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>\ngroundPosition = position * ${Number(ship.config.unitsKm * 1000).toFixed(1)};`);
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
        varying vec3 groundPosition;
        uniform vec3 groundCamera, groundFog, groundSun;
        uniform float groundVisibility, groundAtmosphere, groundExtent;`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          float grit = fract(sin(dot(floor(groundPosition * 2.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453) - 0.5;
          float fade = 1.0 - smoothstep(0.5, 4.0, length(fwidth(groundPosition)));
          diffuseColor.rgb *= 1.0 + grit * 0.07 * fade;`)
        .replace("#include <opaque_fragment>", `
          float groundDistance = length(groundPosition - groundCamera);
          float haze = (1.0 - exp(-groundDistance / 65000.0)) * groundAtmosphere * 0.48;
          vec3 groundView = normalize(groundPosition - groundCamera);
          float sunsetGlow = pow(max(dot(groundView, groundSun), 0.0), 12.0);
          outgoingLight = mix(outgoingLight, groundFog + vec3(0.06, 0.035, 0.012) * sunsetGlow * groundAtmosphere, haze);
          diffuseColor.a *= groundVisibility * (1.0 - smoothstep(groundExtent * 0.82, groundExtent, length(groundPosition)));
          #include <opaque_fragment>`);
    };
    this.terrain = new THREE.Mesh(geometry, material);
    this.terrain.frustumCulled = false;
    // The planetary cloud shell must composite over the fading local ground tile.
    this.terrain.renderOrder = -10;
    this.group.add(this.terrain);
    this.rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: ground.clone().multiplyScalar(0.7), roughness: 1, transparent: true }), 140);
    const pose = new THREE.Object3D();
    for (let i = 0; i < 140; i++) {
      const angle = i * 2.399963;
      const distanceM = 30 + Math.pow((i + 1) / 140, 1.6) * 1100;
      const dx = Math.cos(angle) * distanceM / (ship.config.unitsKm * 1000);
      const dy = Math.sin(angle) * distanceM / (ship.config.unitsKm * 1000);
      const radial = this.normal.clone().multiplyScalar(env.body.radius).addScaledVector(tangent, dx).addScaledVector(bitangent, dy).normalize();
      const height = terrainHeightKm(env.body.id, radial.toArray());
      const sizeM = 0.6 + (Math.sin(i * 78.23) * 0.5 + 0.5) * 2.5;
      pose.position.copy(radial).multiplyScalar(env.body.radius + (height + sizeM / 2000) / ship.config.unitsKm)
        .addScaledVector(this.normal, -env.body.radius);
      pose.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), radial);
      pose.rotateY(angle);
      pose.scale.set(sizeM, sizeM * 0.65, sizeM * 0.8).multiplyScalar(1 / (ship.config.unitsKm * 1000));
      pose.updateMatrix();
      this.rocks.setMatrixAt(i, pose.matrix);
    }
    this.rocks.instanceMatrix.needsUpdate = true;
    this.rocks.frustumCulled = false;
    this.group.add(this.rocks);
  }
  dispose() {
    this.groundDetail.dispose();
    this.terrain?.geometry.dispose();
    (this.terrain?.material as THREE.Material | undefined)?.dispose();
    this.horizon?.geometry.dispose();
    (this.horizon?.material as THREE.Material | undefined)?.dispose();
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
    this.rocks?.geometry.dispose();
    (this.rocks?.material as THREE.Material | undefined)?.dispose();
  }
}
