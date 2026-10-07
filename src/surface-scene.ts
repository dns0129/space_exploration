import * as THREE from "three";
import { surfaceProfile, terrainHeightKm } from "../shared/surface.mjs";
import type { ShipDynamics } from "./ship-dynamics";
import type { WalkingDynamics } from "./walking-dynamics";
import { atmosphereCloudProfile, atmosphereScattering, atmosphereStrength } from "./atmosphere";
import { entryClouds } from "./entry-clouds";

/** A closed surface globe with concentrated subdivision near the pilot. */
export class SurfaceScene {
  readonly group = new THREE.Group();
  readonly sky: THREE.Mesh;
  spaceVisibility = 1;
  private horizon?: THREE.Mesh;
  private horizonBodyId = "";
  private horizonMapBodyId = "";
  private anchor = new THREE.Vector3();
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
  private readonly light = new THREE.DirectionalLight(0xffffff, 2.2);
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
    // A single closed sphere owns the ground at every altitude. Recenter only
    // its subdivision density; never overlay a separate terrain patch.
    if (!this.horizon || this.horizonBodyId !== env.body.id
      || this.anchor.distanceTo(surfacePoint) * ship.config.unitsKm > (walking ? 0.032 : 2)) {
      this.anchor.copy(surfacePoint);
      this.rebuildHorizon(ship, walking ? walker!.outward : env.outward);
    }
    this.group.position.copy(this.anchor).sub(ship.position);
    this.horizon!.position.copy(center).sub(this.anchor);
    this.terrainUniforms.groundHorizonOffset.value.copy(this.horizon!.position).multiplyScalar(ship.config.unitsKm * 1000);
    this.terrainUniforms.groundCamera.value.copy(camera.position).sub(this.group.position).multiplyScalar(ship.config.unitsKm * 1000);
    this.terrainUniforms.groundSun.value.copy(sun);
    this.terrainUniforms.groundFog.value.set(env.profile.sky).multiplyScalar(0.035 + day * 0.7);
    this.terrainUniforms.groundVisibility.value = 1 - THREE.MathUtils.smoothstep(env.groundAltitudeKm, 38, 70);
    this.terrainUniforms.groundAtmosphere.value = env.body.atmosphereKm ? day : 0;
    this.terrainUniforms.groundMapReady.value = Number(this.horizonMapBodyId === env.body.id && !!this.terrainUniforms.groundHorizonMap.value);
    this.terrainUniforms.groundCloudMapReady.value = Number(this.horizonMapBodyId === env.body.id && !!this.terrainUniforms.groundHorizonCloudMap.value);
    this.terrainUniforms.groundMapBlend.value = 1;
    this.terrainUniforms.groundCloudMapBlend.value = THREE.MathUtils.smoothstep(env.altitudeKm, 18, 36);
    this.light.position.copy(sun).multiplyScalar(10);
    this.light.color.set(0xffffff);
    this.light.intensity = 2.2 * day;
    this.ambient.intensity = 0.12 + day * 0.55;
    this.ambient.position.copy(env.outward);
  }
  private rebuildHorizon(ship: ShipDynamics, outward: THREE.Vector3) {
    if (this.horizon) {
      this.group.remove(this.horizon);
      this.horizon.geometry.dispose();
      (this.horizon.material as THREE.Material).dispose();
    }
    const env = ship.environment;
    this.horizonBodyId = env.body.id;
    // Closed globe with dense rings near the pilot and coarser rings on the
    // far hemisphere. This changes geometry density, never surface material.
    const geometry = new THREE.SphereGeometry(env.body.radius, 192, 160);
    const up = outward.clone().normalize();
    const pose = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    const vertices = geometry.getAttribute("position");
    const radial = new THREE.Vector3();
    for (let i = 0; i < vertices.count; i++) {
      radial.fromBufferAttribute(vertices, i).normalize();
      const fraction = Math.acos(THREE.MathUtils.clamp(radial.y, -1, 1)) / Math.PI;
      const angle = Math.PI * Math.sinh(fraction * 12) / Math.sinh(12);
      const longitude = Math.atan2(radial.z, radial.x);
      radial.set(Math.sin(angle) * Math.cos(longitude), Math.cos(angle), Math.sin(angle) * Math.sin(longitude));
      radial.applyQuaternion(pose).multiplyScalar(env.body.radius);
      vertices.setXYZ(i, radial.x, radial.y, radial.z);
    }
    const position = geometry.getAttribute("position");
    const colors: number[] = [];
    const ground = new THREE.Color(env.profile.solid ? env.profile.ground : env.profile.sky);
    const normal = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      normal.fromBufferAttribute(position, i).normalize();
      const height = terrainHeightKm(env.body.id, normal.toArray());
      const point = normal.clone().multiplyScalar(env.body.radius + height / ship.config.unitsKm);
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
    this.horizon.name = "complete-surface-globe";
    this.horizon.frustumCulled = false;
    this.horizon.renderOrder = -15;
    this.group.add(this.horizon);
  }
  dispose() {
    this.horizon?.geometry.dispose();
    (this.horizon?.material as THREE.Material | undefined)?.dispose();
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
  }
}
