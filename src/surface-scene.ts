import * as THREE from "three";
import { surfaceProfile, terrainHeightKm } from "../shared/surface.mjs";
import type { ShipDynamics } from "./ship-dynamics";

/** A small curved terrain tile near the pilot, independent of AU-scale GPU coordinates. */
export class SurfaceScene {
  readonly group = new THREE.Group();
  readonly sky: THREE.Mesh;
  private terrain?: THREE.Mesh;
  private rocks?: THREE.InstancedMesh;
  private anchor = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private bodyId = "";
  private tileExtentKm = 10;
  private readonly groundDetail: THREE.DataTexture;
  private readonly light = new THREE.DirectionalLight(0xffead1, 2.2);
  private readonly ambient = new THREE.HemisphereLight(0xcbdce8, 0x3a3028, 0.8);
  private readonly skyMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    uniforms: { rotation: { value: new THREE.Matrix3() }, up: { value: new THREE.Vector3() },
      sun: { value: new THREE.Vector3() }, color: { value: new THREE.Color() },
      opacity: { value: 0 }, daylight: { value: 1 }, aspect: { value: 1 }, fov: { value: 1 } },
    vertexShader: `varying vec2 screen; void main() { screen = uv * 2.0 - 1.0; gl_Position = vec4(position.xy, 1.0, 1.0); }`,
    fragmentShader: `
      uniform mat3 rotation; uniform vec3 up, sun, color;
      uniform float opacity, daylight, aspect, fov; varying vec2 screen;
      void main() {
        vec3 ray = normalize(rotation * vec3(screen.x * aspect * fov, screen.y * fov, -1.0));
        float elevation = dot(ray, up);
        float haze = exp(-max(0.0, elevation) * 4.0);
        vec3 skyColor = mix(color * 0.58, mix(color, vec3(0.86, 0.79, 0.69), 0.35), haze);
        skyColor *= mix(0.025, 1.0, daylight);
        float glow = pow(max(0.0, dot(ray, sun)), 90.0);
        skyColor += vec3(1.0, 0.76, 0.44) * glow * daylight * 0.6;
        gl_FragColor = vec4(skyColor, opacity);
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
    this.sky.renderOrder = -100;
    this.sky.visible = false;
    this.group.add(this.light, this.light.target, this.ambient);
    this.group.visible = false;
  }
  update(ship: ShipDynamics, camera: THREE.PerspectiveCamera, sunlight: THREE.PointLight) {
    const env = ship.environment;
    const center = new THREE.Vector3().fromArray(env.body.position);
    const sun = sunlight.position.clone().normalize();
    const day = THREE.MathUtils.smoothstep(env.outward.dot(sun), -0.18, 0.12);
    const fraction = env.body.atmosphereKm ? Math.max(0, 1 - env.altitudeKm / env.body.atmosphereKm) : 0;
    this.sky.visible = env.atmospheric && !ship.warping;
    const uniforms = this.skyMaterial.uniforms;
    uniforms.rotation.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(camera.quaternion));
    uniforms.up.value.copy(env.outward);
    uniforms.sun.value.copy(sun);
    uniforms.color.value.set(env.profile.sky);
    uniforms.opacity.value = THREE.MathUtils.smoothstep(fraction, 0, 0.8);
    uniforms.daylight.value = day;
    uniforms.aspect.value = camera.aspect;
    uniforms.fov.value = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    this.group.visible = env.profile.solid && env.groundAltitudeKm < 20 && !ship.warping;
    if (!this.group.visible) return;
    const surfacePoint = center.clone().addScaledVector(env.outward, env.body.radius);
    if (!this.terrain || this.bodyId !== env.body.id || this.anchor.distanceTo(surfacePoint) * ship.config.unitsKm > Math.max(1.5, this.tileExtentKm * 0.35)
      || (env.groundAltitudeKm < 0.5 && this.tileExtentKm > 10)) {
      this.rebuild(ship, surfacePoint);
    }
    this.group.position.copy(this.anchor).sub(ship.position);
    this.light.position.copy(sun).multiplyScalar(10);
    this.light.color.copy(sunlight.color);
    this.light.intensity = 2.2 * day;
    this.ambient.intensity = 0.12 + day * 0.55;
    this.ambient.position.copy(env.outward);
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
    this.normal.copy(env.outward);
    const tangent = new THREE.Vector3(0, 1, 0).cross(this.normal).normalize();
    if (tangent.lengthSq() < 0.1) tangent.set(1, 0, 0);
    const bitangent = this.normal.clone().cross(tangent).normalize();
    const segments = env.groundAltitudeKm < 0.5 ? 128 : 64;
    const extentKm = this.tileExtentKm = Math.max(10, Math.min(80, env.groundAltitudeKm * 4));
    const positions: number[] = [], colors: number[] = [], indices: number[] = [], uvs: number[] = [];
    const ground = new THREE.Color(surfaceProfile(env.body.id).ground);
    for (let y = 0; y <= segments; y++) for (let x = 0; x <= segments; x++) {
      const dx = (x / segments * 2 - 1) * extentKm / ship.config.unitsKm;
      const dy = (y / segments * 2 - 1) * extentKm / ship.config.unitsKm;
      const radial = this.normal.clone().multiplyScalar(env.body.radius).addScaledVector(tangent, dx).addScaledVector(bitangent, dy).normalize();
      const height = terrainHeightKm(env.body.id, radial.toArray());
      const local = radial.clone().multiplyScalar(env.body.radius + height / ship.config.unitsKm)
        .addScaledVector(this.normal, -env.body.radius);
      positions.push(local.x, local.y, local.z);
      uvs.push(dx * ship.config.unitsKm * 1000 / 128, dy * ship.config.unitsKm * 1000 / 128);
      const shade = 0.65 + height * 4;
      colors.push(ground.r * shade, ground.g * shade, ground.b * shade);
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
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide,
      map: this.groundDetail, bumpMap: this.groundDetail, bumpScale: 0.018 / (ship.config.unitsKm * 1000) });
    // Metre-scale procedural grit adds detail without downloading additional textures.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 groundPosition;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\ngroundPosition = position * 6371000.0;");
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 groundPosition;")
        .replace("#include <color_fragment>", `#include <color_fragment>
          float grit = fract(sin(dot(floor(groundPosition * 2.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453) - 0.5;
          float fade = 1.0 - smoothstep(0.5, 4.0, length(fwidth(groundPosition)));
          diffuseColor.rgb *= 1.0 + grit * 0.14 * fade;`);
    };
    this.terrain = new THREE.Mesh(geometry, material);
    this.terrain.frustumCulled = false;
    this.group.add(this.terrain);
    this.rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: ground.clone().multiplyScalar(0.7), roughness: 1 }), 140);
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
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
    this.rocks?.geometry.dispose();
    (this.rocks?.material as THREE.Material | undefined)?.dispose();
  }
}
