import * as THREE from "three";
import type { PlanetModel } from "./planet-models";
import type { CelestialBody } from "./solar-system";
import { echoSurfaceColor, echoTerrainTexture } from "./echo-surface";
import { terrainHeightField } from "../shared/surface.mjs";

type Placement = { center: THREE.Vector3; radius: number };
type ShaderSources = { vertex: string; noise: string; atmosphere: string };

/** Original fictional bodies, kept in the existing kilometre-based renderer. */
export function createEchoModel(body: CelestialBody, sun: THREE.Vector3,
  placement: Placement, sources: ShaderSources): PlanetModel {
  const group = new THREE.Group();
  group.rotation.z = THREE.MathUtils.degToRad(body.axialTiltDeg);
  const time = { value: 0 };
  const uniforms: Record<string, THREE.IUniform> = {
    uTime: time, sunDirection: { value: sun }, planetCenter: { value: placement.center },
    bodyRadius: { value: placement.radius },
  };
  const common = `#include <logdepthbuf_pars_fragment>
    uniform float uTime; uniform vec3 sunDirection, planetCenter; uniform float bodyRadius;
    varying vec2 vUv; varying vec3 vLocalPosition, vWorldPosition, vNormal;
    ${sources.noise}`;
  const ending = `#include <logdepthbuf_fragment>
    gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>`;
  const material = new THREE.ShaderMaterial({ vertexShader: sources.vertex, uniforms,
    fragmentShader: `${common} void main() { vec3 color = vec3(0.5); ${ending} }` });
  const surface = new THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>(new THREE.SphereGeometry(1, 160, 112), material);
  surface.rotation.y = -0.4;
  surface.scale.y = body.flattening;
  group.add(surface);
  const model: PlanetModel = { body, group, surface, layers: {},
    spinning: [{ object: surface, rate: body.rotationSpeed }], timeUniforms: [time] };
  if (body.id === "echo-pulsar") {
    material.fragmentShader = `${common} void main() {
      vec3 p = normalize(vLocalPosition);
      float plasma = fbm(p * 13.0 + vec3(0.0, uTime * 0.04, 8.0));
      float magnetic = pow(0.5 + 0.5 * sin(p.y * 42.0 + plasma * 8.0), 6.0);
      float limb = pow(max(dot(normalize(vNormal), normalize(cameraPosition-vWorldPosition)), 0.0), 0.35);
      vec3 color = mix(vec3(0.15, 0.65, 1.9), vec3(2.6, 3.6, 4.2), plasma * 0.7 + magnetic * 0.3);
      color *= (0.65 + limb * 0.55) * (0.94 + 0.06 * sin(uTime * 2.1));
      ${ending} }`;
    const magnetosphere = new THREE.Group();
    magnetosphere.rotation.z = 0.42;
    for (const sign of [-1, 1]) {
      const beamMaterial = new THREE.ShaderMaterial({
        vertexShader: sources.vertex,
        fragmentShader: `${common} void main() {
          float along = vUv.y;
          float azimuth = pow(0.5 + 0.5 * cos(vUv.x * 6.2831853), 2.0);
          float envelope = sin(along * 3.14159265) * (0.5 + azimuth * 0.5);
          float thread = 0.78 + 0.22 * sin(along * 38.0 - uTime * 2.1);
          float pulse = 0.80 + 0.20 * sin(uTime * 1.8 + along * 3.0);
          vec3 color = mix(vec3(0.08, 0.32, 0.95), vec3(0.55, 1.55, 2.5), along);
          #include <logdepthbuf_fragment>
          float softEdge = pow(abs(dot(normalize(vNormal), normalize(cameraPosition-vWorldPosition))), 0.85);
          gl_FragColor = vec4(color, envelope * thread * pulse * softEdge * 0.30);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`, uniforms, side: THREE.DoubleSide, forceSinglePass: true,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.035, 2.45, 48, 16, true), beamMaterial);
      beam.position.y = sign * 1.85;
      if (sign < 0) beam.rotation.z = Math.PI;
      magnetosphere.add(beam);
    }
    const halo = new THREE.Mesh(new THREE.SphereGeometry(1.19, 64, 48),
      new THREE.ShaderMaterial({ vertexShader: sources.vertex, fragmentShader: sources.atmosphere,
        defines: { SOLAR_CORONA: 1 }, uniforms: { ...uniforms,
          atmosphereColor: { value: new THREE.Color("#78d4ff") }, atmosphereHeight: { value: 0.19 }, strength: { value: 0.70 } },
        side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    magnetosphere.add(halo);
    group.add(magnetosphere);
    model.layers.atmosphere = magnetosphere;
    model.spinning.push({ object: magnetosphere, rate: 0.09 });
  } else if (body.id === "veyl") {
    material.fragmentShader = `${common} void main() {
      vec3 p = normalize(vLocalPosition);
      float turbulence = fbm(p * vec3(8.0, 19.0, 8.0) + vec3(23.0, 1.0, 4.0));
      float latitude = p.y + (turbulence - 0.48) * 0.115;
      float bands = 0.5 + 0.5 * sin(latitude * 56.0 + fbm(p * 23.0) * 3.0);
      vec3 color = mix(vec3(0.024, 0.12, 0.17), vec3(0.30, 0.54, 0.53), smoothstep(0.10, 0.90, bands));
      color = mix(color, vec3(0.76, 0.58, 0.31), smoothstep(0.77, 0.94, sin(latitude*24.0 + turbulence*3.0) * 0.5 + 0.5) * 0.78);
      vec2 storm = vec2(fract(vUv.x - 0.67 + 0.5) - 0.5, vUv.y - 0.43) / vec2(0.085, 0.048);
      float d = length(storm);
      float spiral = sin(d * 19.0 - atan(storm.y, storm.x) * 3.0 + turbulence * 8.0);
      color = mix(color, mix(vec3(0.10, 0.27, 0.29), vec3(0.86, 0.74, 0.49), spiral * 0.5 + 0.5), (1.0-smoothstep(0.72, 1.24, d)) * 0.85);
      color *= 0.87 + noise3(p * 340.0) * 0.17;
      float day = max(dot(normalize(vNormal), sunDirection), 0.0);
      color *= 0.022 + day * 1.18;
      ${ending} }`;
  } else if (body.id === "echo-thalassa" || body.id === "cinder") {
    const texture = echoTerrainTexture(body.id);
    model.ownedTextures = [texture];
    uniforms.echoTerrain = { value: texture };
    uniforms.oceanMoon = { value: body.id === "echo-thalassa" ? 1 : 0 };
    uniforms.echoRelief = { value: terrainHeightField(body.id)!.heightScaleKm / body.radiusKm };
    // Orbit and the local globe displace from precisely the same fixed field.
    material.vertexShader = sources.vertex
      .replace("void main()", "uniform sampler2D echoTerrain; uniform float echoRelief; void main()")
      .replace("vec4 world = modelMatrix * vec4(position, 1.0);",
        "vec3 displaced = position * (1.0 + texture2D(echoTerrain, uv).r * echoRelief); vec4 world = modelMatrix * vec4(displaced, 1.0);");
    material.fragmentShader = `${common}
      uniform sampler2D echoTerrain; uniform float oceanMoon;
      ${echoSurfaceColor}
      void main() {
        vec3 p = normalize(vLocalPosition);
        vec2 field = texture2D(echoTerrain, vUv).rg;
        vec3 color = echoLandColor(p, field.r, field.g, oceanMoon);
        float day = max(dot(normalize(vNormal), sunDirection), 0.0);
        color *= 0.018 + day * 1.15;
        vec3 view = normalize(cameraPosition - vWorldPosition);
        float glint = pow(max(dot(reflect(-sunDirection, normalize(vNormal)), view), 0.0), 110.0);
        color += vec3(0.35, 0.55, 0.62) * glint * field.g * oceanMoon * day;
        ${ending} }`;
  } else {
    surface.geometry.dispose();
    surface.geometry = shatteredGeometry(body.id === "shard");
    material.fragmentShader = `${common} varying float shell;
      void main() {
        vec3 p = vLocalPosition;
        float texture = fbm(p * 12.0 + ${body.id === "shard" ? "vec3(41.0, 21.0, 87.0)" : "vec3(11.0)"});
        float strata = 0.5 + 0.5 * sin(length(p) * 180.0 + texture * 8.0);
        vec3 crust = mix(${body.id === "shard" ? "vec3(0.10, 0.17, 0.22), vec3(0.50, 0.67, 0.75)" : "vec3(0.095, 0.08, 0.075), vec3(0.43, 0.32, 0.23)"}, texture);
        crust *= (0.8 + strata * 0.25) * (0.025 + max(dot(normalize(vNormal), sunDirection), 0.0) * 1.1);
        vec3 inner = mix(vec3(0.22, 0.025, 0.008), vec3(2.1, 0.45, 0.035), pow(texture, 2.5));
        inner *= 0.76 + 0.24 * strata;
        vec3 color = mix(inner, crust, shell);
        ${ending} }`;
    material.vertexShader = sources.vertex.replace("void main()", "attribute float aShell; varying float shell; void main()")
      .replace("vUv = uv;", "vUv = uv; shell = aShell;");
    const rubble = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: body.id === "shard" ? "#7f6d67" : "#96765c", roughness: 0.95 }), 96);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < rubble.count; i++) {
      const angle = i * 2.399963;
      const r = 0.77 + (Math.sin(i * 13.41) * 0.5 + 0.5) * 0.17;
      dummy.position.set(Math.cos(angle) * r, Math.sin(i * 4.17) * 0.24, Math.sin(angle) * r);
      dummy.rotation.set(i * 1.7, i * 0.9, i * 2.1);
      dummy.scale.setScalar(0.006 + (Math.sin(i * 12.79) * 0.5 + 0.5) * 0.032);
      dummy.updateMatrix(); rubble.setMatrixAt(i, dummy.matrix);
    }
    rubble.rotation.set(0.38, 0.0, -0.26);
    group.add(rubble);
    model.spinning.push({ object: rubble, rate: 0.008 });
  }
  if (body.id === "veyl" || body.id === "echo-thalassa") {
    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.025, 80, 56),
      new THREE.ShaderMaterial({ vertexShader: sources.vertex, fragmentShader: sources.atmosphere,
        uniforms: { ...uniforms, atmosphereColor: { value: new THREE.Color(body.atmosphereColor ?? "#70bcca") },
          atmosphereHeight: { value: (body.atmosphereKm ?? 100) / body.radiusKm }, strength: { value: 1.2 } },
        transparent: true, depthWrite: false }));
    atmosphere.scale.y = body.flattening;
    group.add(atmosphere); model.layers.atmosphere = atmosphere;
  }
  return model;
}

/** Closed radial wedges separate physically; glowing cut faces are actual geometry. */
function shatteredGeometry(small: boolean): THREE.BufferGeometry {
  const sphere = new THREE.IcosahedronGeometry(small ? 0.65 : 0.70, 4);
  const source = sphere.getAttribute("position");
  const sectors = small ? 9 : 11;
  const directions = Array.from({ length: sectors }, (_, i) => {
    const y = 1 - (i + 0.5) * 2 / sectors, r = Math.sqrt(1 - y * y), angle = i * (small ? 2.72 : 2.399963) + (small ? 0.73 : 0);
    return new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r);
  });
  const positions: number[] = [], normals: number[] = [], shell: number[] = [], uv: number[] = [];
  function face(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, outer: boolean, offset: THREE.Vector3) {
    const flat = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    for (const v of [a, b, c]) {
      positions.push(...v.clone().add(offset).toArray());
      normals.push(...(outer ? v.clone().normalize() : flat).toArray());
      shell.push(outer ? 1 : 0); uv.push(0, 0);
    }
  }
  for (let i = 0; i < source.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(source, i);
    const b = new THREE.Vector3().fromBufferAttribute(source, i + 1);
    const c = new THREE.Vector3().fromBufferAttribute(source, i + 2);
    const center = a.clone().add(b).add(c).normalize();
    let region = 0, score = -Infinity;
    directions.forEach((direction, index) => { const dot = direction.dot(center); if (dot > score) { score = dot; region = index; } });
    // A missing sector reveals the interior instead of an intact sphere with painted cracks.
    if (region === (small ? 6 : 2) || small && region === 0) continue;
    const offset = directions[region].clone().multiplyScalar((small ? 0.20 : 0.12) + (region % 3) * (small ? 0.02 : 0.035));
    const inner = directions[region].clone().multiplyScalar(0.11);
    face(a, b, c, true, offset);
    face(a, inner, b, false, offset); face(b, inner, c, false, offset); face(c, inner, a, false, offset);
  }
  sphere.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute("aShell", new THREE.Float32BufferAttribute(shell, 1));
  geometry.computeBoundingSphere();
  return geometry;
}
