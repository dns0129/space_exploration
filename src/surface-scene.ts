import * as THREE from "three";
import { surfaceProfile, terrainHeightKm } from "../shared/surface.mjs";
import type { ShipDynamics } from "./ship-dynamics";
import type { WalkingDynamics } from "./walking-dynamics";
import { atmosphereCloudProfile, atmosphereScattering, atmosphereStrength } from "./atmosphere";
import { entryClouds } from "./entry-clouds";
import { mapSampling, noise } from "./planet-models";
import { createEnhancedSurfaceUniforms, enhancedSurfaceSampling } from "./enhanced-surface";
import { earthDetailSampling } from "./earth-detail";
import { canonicalTerrainFragmentSampling, createCanonicalTerrainUniforms } from "./canonical-terrain-material";
import { getBody } from "./solar-system";
import type { BodyId } from "./solar-system";

export interface SurfaceMaterialSnapshot {
  bodyId: string;
  texture: THREE.Texture | null;
  /** Includes the source map's longitude offset. */
  photoRotation: THREE.Matrix3;
  /** Body pose only: detail tiles already bake their source longitude offset. */
  detailRotation: THREE.Matrix3;
  cloudTexture?: THREE.Texture | null;
  cloudRotation?: THREE.Matrix3;
  tint?: THREE.Vector3;
  detailKind?: "native" | "enhanced";
  /** Uniform objects are shared with the orbital material, including tile fades. */
  detailUniforms?: Record<string, THREE.IUniform>;
}

function createLocalDetailUniforms(): Record<string, THREE.IUniform> {
  const result = createEnhancedSurfaceUniforms();
  result.detailBlend = { value: new THREE.Vector4() };
  for (let i = 0; i < 4; i++) {
    result[`detailTile${i}`] = { value: null };
    result[`detailRect${i}`] = { value: new THREE.Vector4(0, 0, 1 / 8, 1 / 4) };
  }
  return result;
}

const localSurfaceSampling = /* glsl */ `
  varying vec3 groundPosition, groundRadial;
  uniform vec3 groundCamera, groundFog, groundSun, groundMapTint;
  uniform sampler2D dayMap, groundHorizonCloudMap;
  uniform mat3 groundMapRotation, groundDetailRotation, groundCloudRotation;
  uniform vec2 mapSize;
  uniform float groundAtmosphere, groundMapReady, groundDetailKind, groundCloudMapReady, groundCloudMapBlend;
  uniform float groundCanonicalMaterial, groundEarth;
  ${noise}
  ${mapSampling}
  ${enhancedSurfaceSampling}
  ${earthDetailSampling}
  ${canonicalTerrainFragmentSampling}
  vec2 groundSphereUv(vec3 p) {
    p = normalize(p);
    return vec2(fract(atan(p.z, -p.x) / 6.28318530718), 1.0 - acos(clamp(p.y, -1.0, 1.0)) / 3.14159265359);
  }
  vec3 groundAlbedo(vec3 worldRadial, vec3 fallback) {
    if (groundCanonicalMaterial > 0.5) fallback = canonicalProceduralGround(worldRadial);
    vec2 photoUv = groundSphereUv(groundMapRotation * worldRadial);
    vec2 detailUv = groundSphereUv(groundDetailRotation * worldRadial);
    vec2 gx, gy;
    bool seam = seamGradients(photoUv, gx, gy);
    vec3 base = groundMapReady > 0.0 ? sampleMap(dayMap, photoUv, mapSize, gx, gy, seam).rgb : fallback;
    if (groundDetailKind > 0.5 && groundDetailKind < 1.5) {
      vec2 dx, dy;
      bool detailSeam = seamGradients(detailUv, dx, dy);
      base = earthDay(detailUv, dx, dy, detailSeam);
    } else if (groundDetailKind > 1.5) {
      vec2 dx, dy;
      seamGradients(detailUv, dx, dy);
      // Unimaged terrain retains its one canonical macro material; its 16K
      // texture is a multiplication around one, never a replacement landscape.
      base = groundMapReady > 0.0
        ? sampleEnhancedSurface(base, detailUv, dx, dy).rgb
        : base * sampleEnhancedSurface(vec3(1.0), detailUv, dx, dy).rgb;
    }
    // Map tint belongs to photography. The canonical procedural fallback has
    // already been coloured identically to the orbital material.
    return groundMapReady > 0.0 ? base * groundMapTint : base;
  }
`;

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
  private terrainUnitsKm = 6371;
  private terrainBodyRadius = 1;
  private readonly terrainBodyCenter = new THREE.Vector3();
  private walkingDetail = false;
  private readonly detailUniforms = createLocalDetailUniforms();
  private canonicalUniforms: Record<string, THREE.IUniform> = createCanonicalTerrainUniforms(getBody("earth"));
  private compiledHorizonUniforms?: Record<string, THREE.IUniform>;
  private compiledGroundUniforms?: Record<string, THREE.IUniform>;
  private compiledRockUniforms?: Record<string, THREE.IUniform>;
  private readonly terrainUniforms = {
    groundCamera: { value: new THREE.Vector3() },
    groundFog: { value: new THREE.Color() },
    groundSun: { value: new THREE.Vector3() },
    groundVisibility: { value: 1 },
    groundAtmosphere: { value: 0 },
    groundExtent: { value: 10000 },
    groundHorizonOffset: { value: new THREE.Vector3() },
    dayMap: { value: null as THREE.Texture | null },
    mapSize: { value: new THREE.Vector2(1, 1) },
    groundHorizonCloudMap: { value: null as THREE.Texture | null },
    groundMapRotation: { value: new THREE.Matrix3() },
    groundDetailRotation: { value: new THREE.Matrix3() },
    groundDetailKind: { value: 0 },
    groundCanonicalMaterial: { value: 0 },
    groundEarth: { value: 0 },
    groundMapTint: { value: new THREE.Vector3(1, 1, 1) },
    groundCloudRotation: { value: new THREE.Matrix3() },
    groundMapReady: { value: 0 },
    groundCloudMapReady: { value: 0 },
    groundCloudMapBlend: { value: 0 },
  };
  private readonly groundDetail: THREE.DataTexture;
  private readonly light = new THREE.DirectionalLight(0xffffff, 2.2);
  // Orbital albedo is illuminated without a colour multiplier. Keep the local
  // ground's fill light neutral too, so grey regolith stays grey on descent.
  private readonly ambient = new THREE.HemisphereLight(0xd9d9d9, 0x323232, 0.8);
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
          // Composite radiance, so opaque cloud banks retain their own light.
          atmosphere.rgb = (cloud.rgb * cloud.a + atmosphere.rgb * atmosphere.a * (1.0 - cloud.a))
            / max(combined, 0.00001);
          atmosphere.a = combined;
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
  /** Reuse the exact orbital colour layer and its resident detail tiles. */
  setSurfaceMap(snapshot: SurfaceMaterialSnapshot) {
    this.canonicalUniforms = createCanonicalTerrainUniforms(getBody(snapshot.bodyId as BodyId));
    this.horizonMapBodyId = snapshot.bodyId;
    this.terrainUniforms.dayMap.value = snapshot.texture;
    const image = snapshot.texture?.image as { width?: number; height?: number } | undefined;
    this.terrainUniforms.mapSize.value.set(image?.width ?? 1, image?.height ?? 1);
    this.terrainUniforms.groundHorizonCloudMap.value = snapshot.cloudTexture ?? null;
    this.terrainUniforms.groundMapRotation.value.copy(snapshot.photoRotation);
    this.terrainUniforms.groundDetailRotation.value.copy(snapshot.detailRotation);
    this.terrainUniforms.groundCloudRotation.value.copy(snapshot.cloudRotation ?? snapshot.photoRotation);
    this.terrainUniforms.groundMapTint.value.copy(snapshot.tint ?? new THREE.Vector3(1, 1, 1));
    this.terrainUniforms.groundDetailKind.value = snapshot.detailKind === "native" ? 1 : snapshot.detailKind === "enhanced" ? 2 : 0;
    this.terrainUniforms.groundCanonicalMaterial.value = Number(!snapshot.texture && surfaceProfile(snapshot.bodyId as BodyId).solid);
    this.terrainUniforms.groundEarth.value = Number(snapshot.bodyId === "earth");
    // Existing shaders hold uniform objects by reference. Rebind their tables
    // when entering a different body rather than copying the current values.
    Object.assign(this.detailUniforms, createLocalDetailUniforms(), snapshot.detailUniforms ?? {});
    if (this.compiledHorizonUniforms) Object.assign(this.compiledHorizonUniforms, this.terrainUniforms, this.detailUniforms, this.canonicalUniforms);
    if (this.compiledGroundUniforms) Object.assign(this.compiledGroundUniforms, this.terrainUniforms, this.detailUniforms, this.canonicalUniforms);
    if (this.compiledRockUniforms) Object.assign(this.compiledRockUniforms, this.terrainUniforms, this.detailUniforms, this.canonicalUniforms);
  }
  /** Compatibility wrapper for callers that have only a resident base map. */
  setHorizonMap(bodyId: string, texture: THREE.Texture | null, worldToSurfaceRotation: THREE.Matrix3,
      cloudMap: THREE.Texture | null = null, worldToCloudRotation = worldToSurfaceRotation,
      mapTint = new THREE.Vector3(1, 1, 1)) {
    this.setSurfaceMap({ bodyId, texture, photoRotation: worldToSurfaceRotation,
      detailRotation: worldToSurfaceRotation, cloudTexture: cloudMap,
      cloudRotation: worldToCloudRotation, tint: mapTint });
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
    this.terrainUniforms.groundMapReady.value = Number(this.horizonMapBodyId === env.body.id && !!this.terrainUniforms.dayMap.value);
    this.terrainUniforms.groundCloudMapReady.value = Number(this.horizonMapBodyId === env.body.id && !!this.terrainUniforms.groundHorizonCloudMap.value);
    this.terrainUniforms.groundCloudMapBlend.value = THREE.MathUtils.smoothstep(env.altitudeKm, 18, 36);
    this.light.position.copy(sun).multiplyScalar(10);
    // Sky and sun retain their stellar colours; terrain uses neutral irradiance
    // like the orbital material, preserving the source map's local hue.
    this.light.color.set(0xffffff);
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
    this.compiledHorizonUniforms = undefined;
    // The distant shell and detailed tile sample one radial colour/height field.
    // Only geometry density changes while approaching the ground.
    const geometry = new THREE.SphereGeometry(env.body.radius, 256, 128);
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
      this.compiledHorizonUniforms = shader.uniforms;
      Object.assign(shader.uniforms, this.terrainUniforms, this.detailUniforms, this.canonicalUniforms);
      shader.vertexShader = shader.vertexShader.replace("#include <common>",
        "#include <common>\nvarying vec3 groundPosition, groundRadial; uniform vec3 groundHorizonOffset;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>\ngroundPosition = position * ${Number(ship.config.unitsKm * 1000).toFixed(1)} + groundHorizonOffset; groundRadial = normalize(position);`);
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
        ${localSurfaceSampling}`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          vec3 horizonPhoto = groundAlbedo(groundRadial, diffuseColor.rgb);
          diffuseColor.rgb = horizonPhoto;
          float horizonCover = 0.0;
          if (groundCloudMapReady * groundCloudMapBlend > 0.0) {
            vec2 cloudMapUv = groundSphereUv(groundCloudRotation * groundRadial);
            horizonCover = texture2D(groundHorizonCloudMap, cloudMapUv).r * groundCloudMapBlend;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.96, 1.0), horizonCover * 0.82);
          }`)
        .replace("#include <opaque_fragment>", `
          // Photo albedo stays on the shell at every altitude. Lighting may gain
          // local terrain shading, but the visible geographical features stay.
          vec3 horizonNormal = canonicalTerrainWorldNormal(groundRadial);
          float horizonDay = max(dot(horizonNormal, groundSun), 0.0)
            * smoothstep(-0.12, 0.04, dot(normalize(groundRadial), groundSun));
          vec3 photoLight = horizonPhoto * (mix(0.009, 0.015, groundEarth) + horizonDay * mix(1.05, 1.08, groundEarth)) * (1.0 - horizonCover * 0.26);
          photoLight = mix(photoLight, vec3(0.92, 0.96, 1.0) * (0.035 + horizonDay * 1.1), horizonCover * 0.82);
          outgoingLight = mix(outgoingLight, photoLight, max(groundMapReady, groundCanonicalMaterial));
          float groundDistance = length(groundPosition - groundCamera);
          float haze = (1.0 - exp(-groundDistance / 23000.0)) * groundAtmosphere * 0.6 * (1.0 - groundMapReady);
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
    this.compiledGroundUniforms = undefined;
    this.compiledRockUniforms = undefined;
    this.terrainUnitsKm = ship.config.unitsKm;
    this.terrainBodyRadius = env.body.radius;
    this.terrainBodyCenter.fromArray(env.body.position);
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
    // Metre-scale grit changes reflectance around the shared surface albedo.
    // It never supplies a different large-scale ground colour or landscape.
    material.onBeforeCompile = shader => {
      this.compiledGroundUniforms = shader.uniforms;
      Object.assign(shader.uniforms, this.terrainUniforms, this.detailUniforms, this.canonicalUniforms);
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 groundPosition, groundRadial; uniform vec3 groundHorizonOffset;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>\ngroundPosition = position * ${Number(ship.config.unitsKm * 1000).toFixed(1)}; groundRadial = normalize(groundPosition - groundHorizonOffset);`);
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
        ${localSurfaceSampling}
        uniform float groundVisibility, groundExtent;`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          diffuseColor.rgb = groundAlbedo(groundRadial, diffuseColor.rgb);
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
    const rockMaterial = new THREE.MeshStandardMaterial({ roughness: 1, transparent: true });
    rockMaterial.onBeforeCompile = shader => {
      this.compiledRockUniforms = shader.uniforms;
      Object.assign(shader.uniforms, this.terrainUniforms, this.detailUniforms, this.canonicalUniforms);
      shader.vertexShader = shader.vertexShader.replace("#include <common>",
        `#include <common>
        varying vec3 groundPosition, groundRadial; uniform vec3 groundHorizonOffset;`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          // Instance translations are local to the same terrain anchor.
          groundPosition = (instanceMatrix * vec4(position, 1.0)).xyz * ${Number(ship.config.unitsKm * 1000).toFixed(1)};
          groundRadial = normalize(groundPosition - groundHorizonOffset);`);
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
        ${localSurfaceSampling}`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          diffuseColor.rgb = groundAlbedo(groundRadial, diffuseColor.rgb) * 0.7;`);
    };
    this.rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), rockMaterial, 140);
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
  /** The measured centre vertex, so verification observes the drawn terrain. */
  get terrainSample(): { bodyId: string; normal: number[]; heightKm: number } | undefined {
    if (!this.terrain || !this.terrain.visible || !this.bodyId) return undefined;
    const positions = this.terrain.geometry.getAttribute("position");
    const centre = Math.floor(positions.count / 2);
    const radial = new THREE.Vector3().fromBufferAttribute(positions, centre)
      .add(this.anchor).sub(this.terrainBodyCenter);
    const heightKm = (radial.length() - this.terrainBodyRadius) * this.terrainUnitsKm;
    return { bodyId: this.bodyId, normal: radial.normalize().toArray(), heightKm };
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
