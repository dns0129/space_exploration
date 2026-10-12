import * as THREE from "three";
import { terrainHeightKm } from "../shared/surface.mjs";
import type { ShipDynamics } from "./ship-dynamics";
import type { WalkingDynamics } from "./walking-dynamics";
import { atmosphereCloudProfile, atmosphereScattering, atmosphereStrength } from "./atmosphere";
import { entryClouds } from "./entry-clouds";
import { SpatialScale, sampleSurface, METRES_PER_KILOMETRE } from "../shared/spatial-frame.mjs";
import { echoSurfaceColor, echoTerrainTexture } from "./echo-surface";
import { sampleStellarLighting, stellarShader, stellarUniforms } from "./stellar-light";
import type { LightingQuality } from "./lighting-quality";

/** Metre-space ground: a closed distant globe and the exact nearby Rapier triangles. */
export class SurfaceScene {
  readonly group = new THREE.Group();
  readonly sky: THREE.Mesh;
  spaceVisibility = 1;
  private horizon?: THREE.Mesh;
  private collisionGround?: THREE.Mesh;
  private collisionRevision = -1;
  private collisionPatch?: WalkingDynamics["terrainPatch"];
  private readonly patchVertexOffset = { value: new THREE.Vector3() };
  private readonly patchFlag = { value: 1 };
  private echoTerrain?: THREE.DataTexture;
  private horizonBodyId = "";
  private horizonMapBodyId = "";
  private anchor = new THREE.Vector3();
  private readonly terrainUniforms = {
    groundVertexOffset: { value: new THREE.Vector3() },
    groundIsPatch: { value: 0 },
    groundPatchCenter: { value: new THREE.Vector3() },
    groundPatchRight: { value: new THREE.Vector3() },
    groundPatchForward: { value: new THREE.Vector3() },
    groundPatchExtent: { value: 0 },
    groundCamera: { value: new THREE.Vector3() },
    groundFog: { value: new THREE.Color() },
    groundSun: { value: new THREE.Vector3() },
    groundLightTint: { value: new THREE.Color(0xffffff) },
    groundNightFloor: { value: 0.015 },
    groundAtmosphere: { value: 0 },
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
  private readonly secondaryLight = new THREE.DirectionalLight(0xffffff, 0);
  private readonly ambient = new THREE.HemisphereLight(0xd9d9d9, 0x323232, 0.8);
  private readonly skyMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false,
    uniforms: { rotation: { value: new THREE.Matrix3() }, up: { value: new THREE.Vector3() },
      ...stellarUniforms(),
      sun: { value: new THREE.Vector3() }, sunColor: { value: new THREE.Color() }, color: { value: new THREE.Color() },
      altitude: { value: 0 }, radius: { value: 6371 }, height: { value: 160 }, strength: { value: 1.5 },
      cloudVolume: { value: 0 }, cloudScale: { value: 1 }, cloudCoverage: { value: 0 }, cloudColor: { value: new THREE.Color() }, time: { value: 0 },
      aspect: { value: 1 }, fov: { value: 1 }, stellarDiskRadius: { value: 0 } },
    vertexShader: `varying vec2 screen; void main() { screen = uv * 2.0 - 1.0; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
    fragmentShader: `
      ${stellarShader}
      uniform mat3 rotation; uniform vec3 up, sun, sunColor, color, cloudColor;
      uniform float altitude, radius, height, strength, aspect, fov, cloudVolume, cloudScale, cloudCoverage, time, stellarDiskRadius; varying vec2 screen;
      ${atmosphereScattering}
      ${entryClouds}
      void main() {
        vec3 ray = normalize(rotation * vec3(screen.x * aspect * fov, screen.y * fov, -1.0));
        vec4 atmosphere = scatterAtmosphere(up, altitude, ray, radius, height, sun, color, strength);
        atmosphere.rgb *= lightTint * stellarEnergy * stellarVisibility;
        if (dot(secondaryIrradiance, secondaryIrradiance) > 0.00001)
          atmosphere.rgb += scatterAtmosphere(up, altitude, ray, radius, height,
            secondarySunDirection, color, strength).rgb * secondaryIrradiance;
        float solarTransmission = 1.0;
        if (cloudVolume > 0.0) {
          vec4 cirrus = scatterHighClouds(up, altitude, ray, radius, sun, time, cloudScale, cloudCoverage, cloudColor);
          vec4 cloud = scatterEntryClouds(up, altitude, ray, radius, sun, time, cloudScale, cloudCoverage, cloudColor);
          cirrus.rgb *= lightTint * stellarEnergy * stellarVisibility;
          cloud.rgb *= lightTint * stellarEnergy * stellarVisibility;
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
        float disk = (stellarDiskRadius > 0.0
          ? smoothstep(cos(stellarDiskRadius * 1.025), cos(stellarDiskRadius * 0.975), dot(ray, sun))
          : smoothstep(0.999972, 0.999987, dot(ray, sun))) * sunlight * solarTransmission;
        float sunset = 1.0 - smoothstep(-0.02, 0.18, dot(up, sun));
        vec3 solarColor = mix(vec3(3.4, 3.15, 2.55), vec3(3.6, 1.35, 0.36), sunset * min(strength, 1.0))
          * lightTint * stellarEnergy * stellarVisibility;
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
    this.light.castShadow = true;
    this.light.shadow.bias = -0.00015;
    this.light.shadow.normalBias = 0.04;
    Object.assign(this.light.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 0.1, far: 400 });
    this.group.add(this.light, this.light.target, this.secondaryLight, this.secondaryLight.target, this.ambient);
    this.group.visible = false;
  }
  usesAtmosphere(ship: ShipDynamics) {
    const env = ship.environment;
    return !!env.body.atmosphereKm && env.altitudeKm < env.body.atmosphereKm * 4 && !ship.warping;
  }
  configureLighting(quality: LightingQuality) {
    if (this.light.shadow.mapSize.x !== quality.shadowSize) {
      this.light.shadow.map?.dispose(); this.light.shadow.map = null;
      this.light.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
    }
    const defines = this.skyMaterial.defines;
    if (defines.ATMOSPHERE_STEPS !== quality.atmosphereSteps || defines.CLOUD_STEPS !== quality.cloudSteps) {
      defines.ATMOSPHERE_STEPS = quality.atmosphereSteps; defines.CLOUD_STEPS = quality.cloudSteps;
      this.skyMaterial.needsUpdate = true;
    }
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
  updateSky(ship: ShipDynamics, camera: THREE.PerspectiveCamera, sunlight: THREE.PointLight, local = false, walker?: WalkingDynamics) {
    const env = ship.environment;
    const center = new THREE.Vector3().fromArray(env.body.position);
    const sun = sunlight.position.clone().normalize();
    const day = THREE.MathUtils.smoothstep(env.outward.dot(sun), -0.18, 0.12);
    this.sky.visible = (this.usesAtmosphere(ship) || local && env.profile.solid) && !ship.warping;
    const scale = new SpatialScale(ship.config.unitsKm);
    const cameraRadial = ship.localFrame.bodyId === env.body.id ? ship.bodyRadialM
      : new THREE.Vector3().fromArray(scale.universeDeltaToMetres(ship.position.toArray(), center.toArray()));
    if (local) cameraRadial.add(camera.position).sub(walker?.active ? walker.localShipPositionM : ship.localPositionM);
    else cameraRadial.addScaledVector(camera.position, scale.metresPerUnit);
    const cameraAltitudeKm = Math.max(0, (cameraRadial.length() - env.body.radius * scale.metresPerUnit) / METRES_PER_KILOMETRE);
    const depth = env.body.atmosphereKm ? 1 - cameraAltitudeKm / env.body.atmosphereKm : 0;
    this.spaceVisibility = this.sky.visible ? 1 - day * THREE.MathUtils.smoothstep(depth, 0, 0.65) * 0.98 : 1;
    const uniforms = this.skyMaterial.uniforms;
    uniforms.rotation.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(camera.quaternion));
    uniforms.up.value.copy(cameraRadial).normalize();
    uniforms.sun.value.copy(sun);
    uniforms.sunColor.value.copy(sunlight.color);
    const samples = sampleStellarLighting(ship.activeBodies, ship.position, ship.config.unitsKm);
    const primary = samples[0];
    uniforms.lightTint.value.copy(primary?.color ?? new THREE.Color(0xffffff));
    uniforms.stellarEnergy.value = primary?.energy ?? 0;
    uniforms.stellarVisibility.value = primary?.visibility ?? 0;
    uniforms.secondarySunDirection.value.copy(samples[1]?.direction ?? new THREE.Vector3());
    uniforms.secondaryIrradiance.value.copy(samples[1]?.color ?? new THREE.Color(0, 0, 0))
      .multiplyScalar((samples[1]?.energy ?? 0) * (samples[1]?.visibility ?? 0));
    const source = env.body.systemId === "barnard"
      ? ship.activeBodies.find(body => body.id === "barnard-star") : undefined;
    uniforms.stellarDiskRadius.value = source
      ? Math.asin(Math.min(1, source.radius / Math.max(sunlight.position.length(), source.radius))) : 0;
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
    this.updateSky(ship, camera, sunlight, true, walker);
    const env = ship.environment;
    const center = new THREE.Vector3().fromArray(env.body.position);
    const sun = sunlight.position.clone().normalize();
    const day = THREE.MathUtils.smoothstep(env.outward.dot(sun), -0.18, 0.12);
    this.group.visible = (env.profile.solid || !!env.body.atmosphereKm) && !ship.warping;
    if (!this.group.visible) return;
    const walking = !!walker?.active;
    const scale = new SpatialScale(ship.config.unitsKm);
    const shipLocal = walking ? walker!.localShipPositionM : ship.localPositionM;
    const shipRadialM = ship.localFrame.bodyId === env.body.id ? ship.bodyRadialM
      : new THREE.Vector3().fromArray(scale.universeDeltaToMetres(ship.position.toArray(), center.toArray()));
    const surfacePoint = (walking ? walker!.outward : env.outward).clone().multiplyScalar(env.body.radius * scale.metresPerUnit);
    // Subtract the radial anchor in double precision BEFORE uploading Float32 vertices.
    if (!this.horizon || this.horizonBodyId !== env.body.id
      || this.anchor.distanceTo(surfacePoint) > (walking ? 32 : 2000)) {
      this.anchor.copy(surfacePoint);
      this.rebuildHorizon(ship, walking ? walker!.outward : env.outward);
      this.collisionRevision = -1;
    }
    this.group.position.copy(shipLocal).add(this.anchor).sub(shipRadialM);
    this.horizon!.position.set(0, 0, 0);
    this.terrainUniforms.groundCamera.value.copy(camera.position).sub(this.group.position);
    this.updateCollisionGround(ship, walker);
    this.terrainUniforms.groundSun.value.copy(sun);
    const barnard = env.body.systemId === "barnard";
    this.terrainUniforms.groundLightTint.value.set(0xffffff);
    if (barnard) this.terrainUniforms.groundLightTint.value.copy(sunlight.color);
    this.terrainUniforms.groundNightFloor.value = barnard ? 0.0035 : 0.015;
    this.terrainUniforms.groundFog.value.set(env.profile.sky).multiplyScalar(0.035 + day * 0.7);
    this.terrainUniforms.groundAtmosphere.value = env.body.atmosphereKm ? day : 0;
    this.terrainUniforms.groundMapReady.value = Number(this.horizonMapBodyId === env.body.id && !!this.terrainUniforms.groundHorizonMap.value);
    this.terrainUniforms.groundCloudMapReady.value = Number(this.horizonMapBodyId === env.body.id && !!this.terrainUniforms.groundHorizonCloudMap.value);
    this.terrainUniforms.groundMapBlend.value = 1;
    this.terrainUniforms.groundCloudMapBlend.value = THREE.MathUtils.smoothstep(env.altitudeKm, 18, 36);
    const samples = sampleStellarLighting(ship.activeBodies, ship.position, ship.config.unitsKm);
    const focus = (walker?.active ? walker.localPositionM : shipLocal).clone().sub(this.group.position);
    this.light.target.position.copy(focus);
    this.light.position.copy(focus).addScaledVector(sun, 150);
    this.light.color.copy(samples[0]?.color ?? this.terrainUniforms.groundLightTint.value);
    this.light.intensity = 3.4 * day * (samples[0]?.energy ?? 0) * (samples[0]?.visibility ?? 0);
    this.light.castShadow = !!walker?.active;
    this.secondaryLight.target.position.copy(focus);
    this.secondaryLight.position.copy(focus).addScaledVector(samples[1]?.direction ?? sun, 150);
    this.secondaryLight.color.copy(samples[1]?.color ?? this.light.color);
    const secondaryDay = samples[1] ? THREE.MathUtils.smoothstep(env.outward.dot(samples[1].direction), -0.18, 0.12) : 0;
    this.secondaryLight.intensity = 3.4 * secondaryDay * (samples[1]?.energy ?? 0) * (samples[1]?.visibility ?? 0);
    this.ambient.intensity = (barnard ? 0.01 : 0.015) + day * (env.body.atmosphereKm ? 0.12 : 0.025);
    this.ambient.position.copy(env.outward);
  }
  private rebuildHorizon(ship: ShipDynamics, outward: THREE.Vector3) {
    this.echoTerrain?.dispose();
    this.echoTerrain = undefined;
    if (this.horizon) {
      this.group.remove(this.horizon);
      this.horizon.geometry.dispose();
      (this.horizon.material as THREE.Material).dispose();
    }
    const env = ship.environment;
    this.horizonBodyId = env.body.id;
    // Closed globe with dense rings near the pilot and coarser rings on the
    // far hemisphere. This changes geometry density, never surface material.
    const geometry = new THREE.SphereGeometry(1, 192, 160);
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
      radial.applyQuaternion(pose);
      vertices.setXYZ(i, radial.x, radial.y, radial.z);
    }
    const position = geometry.getAttribute("position");
    const colors = new Float32Array(position.count * 3);
    const radialDirections = new Float32Array(position.count * 3);
    const ground = new THREE.Color(env.profile.solid ? env.profile.ground : env.profile.sky);
    const earthTint = new THREE.Color("#70834f");
    const color = new THREE.Color();
    const normal = new THREE.Vector3();
    const point = new THREE.Vector3();
    const radialM: [number, number, number] = [0, 0, 0];
    const radiusM = new SpatialScale(ship.config.unitsKm).universeDistanceToMeters(env.body.radius);
    for (let i = 0; i < position.count; i++) {
      normal.fromBufferAttribute(position, i).normalize();
      normal.toArray(radialDirections, i * 3);
      point.copy(normal).multiplyScalar(radiusM).toArray(radialM);
      const sample = sampleSurface(ship.config, env.body, radialM);
      const height = sample.heightM / METRES_PER_KILOMETRE;
      point.fromArray(sample.surfaceRadialM).sub(this.anchor);
      position.setXYZ(i, point.x, point.y, point.z);
      const gasBand = Math.sin(normal.y * 55 + Math.sin(normal.x * 10 + normal.z * 8) * 1.3);
      const shade = env.profile.solid ? 0.72 + height * 3 : 0.78 + gasBand * 0.12;
      color.copy(ground).multiplyScalar(shade);
      if (env.body.id === "earth") color.lerp(earthTint, 0.16);
      color.toArray(colors, i * 3);
    }
    geometry.setAttribute("surfaceRadial", new THREE.BufferAttribute(radialDirections, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, transparent: true });
    const echoMoon = env.body.id === "echo-thalassa" || env.body.id === "cinder";
    if (echoMoon) this.echoTerrain = echoTerrainTexture(env.body.id);
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.terrainUniforms);
      if (echoMoon) {
        shader.uniforms.echoTerrain = { value: this.echoTerrain };
        shader.uniforms.oceanMoon = { value: env.body.id === "echo-thalassa" ? 1 : 0 };
      }
      shader.vertexShader = shader.vertexShader.replace("#include <common>",
        "#include <common>\nvarying vec3 groundPosition, groundRadial; attribute vec3 surfaceRadial; uniform vec3 groundVertexOffset;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>\ngroundPosition = position + groundVertexOffset; groundRadial = surfaceRadial;`);
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
        varying vec3 groundPosition, groundRadial; uniform vec3 groundCamera, groundFog, groundSun, groundMapTint, groundLightTint;
        uniform float groundNightFloor;
        uniform sampler2D groundHorizonMap, groundHorizonCloudMap;
        uniform mat3 groundMapRotation, groundCloudRotation;
        uniform vec3 groundPatchCenter, groundPatchRight, groundPatchForward;
        uniform float groundPatchExtent, groundIsPatch;
        uniform float groundAtmosphere, groundMapReady, groundCloudMapReady, groundMapBlend, groundCloudMapBlend;
        ${echoMoon ? `uniform sampler2D echoTerrain; uniform float oceanMoon; ${echoSurfaceColor}` : ""}
        vec2 groundSphereUv(vec3 p) {
          p = normalize(p);
          return vec2(fract(atan(p.z, -p.x) / 6.28318530718), 1.0 - acos(clamp(p.y, -1.0, 1.0)) / 3.14159265359);
        }`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          vec3 patchDelta = groundPosition - groundPatchCenter;
          if (groundIsPatch < 0.5 && groundPatchExtent > 0.0
            && abs(dot(patchDelta, groundPatchRight)) < groundPatchExtent
            && abs(dot(patchDelta, groundPatchForward)) < groundPatchExtent) discard;
          vec3 horizonPhoto = diffuseColor.rgb;
          float horizonCover = 0.0;
          ${echoMoon ? `
            vec3 echoRadial = normalize(groundMapRotation * groundRadial);
            vec2 echoField = texture2D(echoTerrain, groundSphereUv(echoRadial)).rg;
            diffuseColor.rgb = echoLandColor(echoRadial, echoField.r, echoField.g, oceanMoon);
            horizonPhoto = diffuseColor.rgb;` : ""}
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
        .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
          // Keep photographic albedo inside the BRDF: real slope normals and
          // shadow maps survive map loading, including the Rapier ground mesh.
          reflectedLight.directDiffuse *= (1.0 - horizonCover * 0.26);
          reflectedLight.directSpecular *= (1.0 - horizonCover * 0.26);
        `)
        .replace("#include <opaque_fragment>", `
          outgoingLight += diffuseColor.rgb * groundNightFloor;
          float groundDistance = length(groundPosition - groundCamera);
          float haze = (1.0 - exp(-groundDistance / 23000.0)) * groundAtmosphere * 0.6 * (1.0 - groundMapReady * groundMapBlend);
          outgoingLight = mix(outgoingLight, groundFog, haze);
          #include <opaque_fragment>`);
    };
    this.horizon = new THREE.Mesh(geometry, material);
    this.horizon.name = "complete-surface-globe";
    this.horizon.frustumCulled = false;
    this.horizon.receiveShadow = true;
    this.horizon.renderOrder = -15;
    this.group.add(this.horizon);
  }
  private updateCollisionGround(ship: ShipDynamics, walker?: WalkingDynamics) {
    const patch = walker?.active ? walker.terrainPatch : undefined;
    this.terrainUniforms.groundPatchExtent.value = patch?.halfExtentM ?? 0;
    if (!patch) {
      if (this.collisionGround) this.collisionGround.visible = false;
      this.collisionRevision = -1;
      this.collisionPatch = undefined;
      return;
    }
    this.terrainUniforms.groundPatchCenter.value.copy(patch.centerLocalM).sub(this.group.position);
    this.terrainUniforms.groundPatchRight.value.copy(patch.right);
    this.terrainUniforms.groundPatchForward.value.copy(patch.forward);
    if (this.collisionPatch !== patch || this.collisionRevision !== patch.revision) {
      this.collisionGround?.geometry.dispose();
      if (!this.collisionGround) {
        const source = this.horizon!.material as THREE.MeshStandardMaterial;
        const material = source.clone();
        material.onBeforeCompile = (shader, renderer) => {
          source.onBeforeCompile(shader, renderer);
          shader.uniforms.groundVertexOffset = this.patchVertexOffset;
          shader.uniforms.groundIsPatch = this.patchFlag;
        };
        material.customProgramCacheKey = () => `rapier-ground-${this.horizonBodyId}`;
        this.collisionGround = new THREE.Mesh(new THREE.BufferGeometry(), material);
        this.collisionGround.name = "rapier-collision-ground";
        this.collisionGround.frustumCulled = false;
        this.collisionGround.receiveShadow = true;
        this.collisionGround.renderOrder = -14;
        this.group.add(this.collisionGround);
      } else {
        // Reuse the current globe's material hook when crossing to a different body.
        const source = this.horizon!.material as THREE.MeshStandardMaterial;
        (this.collisionGround.material as THREE.Material).onBeforeCompile = (shader, renderer) => {
          source.onBeforeCompile(shader, renderer);
          shader.uniforms.groundVertexOffset = this.patchVertexOffset;
          shader.uniforms.groundIsPatch = this.patchFlag;
        };
        (this.collisionGround.material as THREE.Material).needsUpdate = true;
      }
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(patch.vertices.length);
      const radials = new Float32Array(patch.vertices.length);
      const colors = new Float32Array(patch.vertices.length);
      const environment = ship.environment;
      const ground = new THREE.Color(environment.profile.ground);
      const earthTint = new THREE.Color("#70834f");
      const color = new THREE.Color();
      const radial = new THREE.Vector3();
      const normal: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < positions.length; i += 3) {
        radial.fromArray(patch.vertices, i).sub(patch.centerLocalM);
        radial.toArray(positions, i);
        radial.add(patch.centerRadialM).normalize();
        radial.toArray(radials, i);
        const height = terrainHeightKm(environment.body.id, radial.toArray(normal));
        color.copy(ground).multiplyScalar(0.72 + height * 3);
        if (environment.body.id === "earth") color.lerp(earthTint, 0.16);
        color.toArray(colors, i);
      }
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("surfaceRadial", new THREE.BufferAttribute(radials, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geometry.setIndex(new THREE.BufferAttribute(patch.indices, 1));
      geometry.computeVertexNormals();
      this.collisionGround.geometry = geometry;
      this.collisionRevision = patch.revision;
      this.collisionPatch = patch;
    }
    this.collisionGround!.visible = true;
    this.collisionGround!.position.copy(patch.centerLocalM).sub(this.group.position);
    this.patchVertexOffset.value.copy(this.collisionGround!.position);
  }
  dispose() {
    this.light.shadow.dispose();
    this.collisionGround?.geometry.dispose();
    (this.collisionGround?.material as THREE.Material | undefined)?.dispose();
    this.echoTerrain?.dispose();
    this.horizon?.geometry.dispose();
    (this.horizon?.material as THREE.Material | undefined)?.dispose();
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
  }
}
