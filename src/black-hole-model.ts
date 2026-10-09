import * as THREE from "three";
import type { PlanetModel } from "./planet-models";
import type { CelestialBody } from "./solar-system";

/**
 * Camera rays intersect a fixed 3D annular disk. The secondary disk image is an
 * inclination-dependent analytic lens approximation, NOT a GR geodesic solver.
 * Units are the apparent shadow radius; they do not represent a measured horizon.
 * The quad is only a ray viewport, never a texture or a camera-independent image.
 */
export function createBlackHoleModel(body: CelestialBody): PlanetModel {
  const group = new THREE.Group();
  const time = { value: 0 };
  const uniforms = {
    uTime: time,
    eye: { value: new THREE.Vector3() },
    right: { value: new THREE.Vector3() },
    up: { value: new THREE.Vector3() },
    forward: { value: new THREE.Vector3() },
  };
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform vec3 right, up;
      varying vec3 rayPoint;
      void main() {
        rayPoint = right * position.x + up * position.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(rayPoint, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime;
      uniform vec3 eye, right, up, forward;
      varying vec3 rayPoint;
      // Disk temperature gradient, many advecting radial filaments and azimuthal
      // turbulence. Derivative filtering keeps the fine bands stable at distance.
      vec3 diskLight(float r, float angle) {
        float heat = 1.0 - smoothstep(1.35, 4.35, r);
        float flow = angle + uTime * (0.22 + 0.55 / max(r, 1.0));
        // The lens compresses several source radii into a small image arc.
        // Include resolved broad filaments as well as finer strata, otherwise
        // derivative filtering correctly removes every band in that arc.
        float wave = sin(flow * 13.0 + r * 5.0) * 0.8 + sin(flow * 7.0) * 0.5;
        float coarsePhase = r * 22.0 + wave;
        float bandPhase = r * 58.0 + wave * 1.6 + flow * 3.0;
        float finePhase = r * 137.0 + wave * 2.3 + flow * 11.0;
        float coarse = sin(coarsePhase) * exp(-pow(fwidth(coarsePhase) * 0.28, 2.0));
        float bands = sin(bandPhase) * exp(-pow(fwidth(bandPhase) * 0.28, 2.0));
        float fine = sin(finePhase) * exp(-pow(fwidth(finePhase) * 0.28, 2.0));
        float structure = clamp(0.61 + 0.29 * coarse + 0.17 * bands + 0.06 * fine
          + 0.10 * sin(flow * 9.0 + r * 7.0), 0.12, 1.15);
        vec3 color = mix(vec3(1.0, 0.24, 0.025), vec3(1.0, 0.88, 0.63), heat);
        float doppler = 0.85 + 0.25 * cos(angle);
        // Keep disk radiance below the photon ring. ACES must retain filament
        // contrast and the warm temperature gradient instead of flattening a
        // large bright arch into an almost uniform white band.
        return color * structure * doppler * (0.45 + 1.35 * heat);
      }
      float diskMask(float r) {
        return smoothstep(1.28, 1.43, r) * (1.0 - smoothstep(3.6, 4.4, r));
      }
      void main() {
        vec3 ray = normalize(rayPoint - eye);
        float closest = max(0.0, -dot(eye, ray));
        vec3 impact = eye + closest * ray;
        float b = length(impact);
        float aa = max(fwidth(b), 0.002);
        float shadow = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, b);
        vec3 color = vec3(0.0);
        float alpha = shadow;
        // Screen-space ring is derived from the ray's impact parameter, so it
        // stays circular from every direction and has the correct angular size.
        float photon = exp(-pow((b - 1.035) / max(0.012, aa), 2.0));
        float ringGlow = exp(-abs(b - 1.05) * 17.0) * 0.22;
        color += vec3(1.0, 0.83, 0.56) * (photon * 3.4 + ringGlow);
        alpha = max(alpha, clamp(photon + ringGlow, 0.0, 1.0));

        vec3 normal = vec3(0.0, 1.0, 0.0);
        float inclination = abs(dot(normalize(eye), normal));
        // Project the fixed disk normal into the observer's image, avoiding
        // singular camera-up assumptions when rolling or looking down a pole.
        vec3 projected = normal - forward * dot(normal, forward);
        vec3 imageUp = length(projected) > 0.001 ? normalize(projected) : up;
        vec3 imageRight = normalize(cross(imageUp, forward));
        float vertical = dot(impact, imageUp);
        float horizontal = dot(impact, imageRight);
        // The far disk appears outside the shadow as a broad upper arch and a
        // compressed lower image. Smoothly becomes a concentric image pole-on.
        float lowerScale = mix(0.77, 1.0, inclination);
        float lensR = length(vec2(horizontal, vertical / (vertical < 0.0 ? lowerScale : 1.0)));
        float sourceR = 1.35 + (lensR - 1.09) * 4.3;
        float lensMask = diskMask(sourceR) * smoothstep(1.02, 1.08, lensR);
        float arch = mix(pow(abs(vertical) / max(lensR, 0.001), 0.45), 1.0, inclination);
        lensMask *= arch * (1.0 - shadow) * mix(1.0, 0.25, inclination);
        float angle = atan(vertical, horizontal);
        color += diskLight(sourceR, angle) * lensMask * (vertical < 0.0 ? 0.68 : 1.15);
        alpha = max(alpha, lensMask);
        float lensGlow = exp(-pow((lensR - 1.36) / 0.32, 2.0)) * arch * (1.0 - shadow) * 0.11;
        color += vec3(1.0, 0.44, 0.11) * lensGlow;
        alpha = max(alpha, lensGlow);

        // Integrate a fixed 3D annular volume, not a few discrete horizontal
        // sheets: sheets miss the disk entirely for some exactly edge-on pixel
        // rays. Clip the ray to its outer cylinder and thin vertical slab, then
        // accumulate emission front-to-back with a stylized optical depth.
        const float halfHeight = 0.10;
        float radialA = max(dot(ray.xz, ray.xz), 0.000001);
        float radialB = dot(eye.xz, ray.xz);
        float radialC = dot(eye.xz, eye.xz) - 4.4 * 4.4;
        float discriminant = radialB * radialB - radialA * radialC;
        float root = sqrt(max(discriminant, 0.0));
        float nearT = max(0.0, (-radialB - root) / radialA);
        float farT = (-radialB + root) / radialA;
        float volumeVisible = step(0.0, discriminant);
        if (abs(ray.y) > 0.00001) {
          float bottomT = (-halfHeight - eye.y) / ray.y;
          float topT = (halfHeight - eye.y) / ray.y;
          nearT = max(nearT, min(bottomT, topT));
          farT = min(farT, max(bottomT, topT));
        } else {
          volumeVisible *= step(abs(eye.y), halfHeight);
        }
        float segment = max(0.0, farT - nearT);
        float stepLength = segment / 8.0;
        vec3 emission = vec3(0.0);
        float transmission = 1.0;
        for (int i = 0; i < 8; i++) {
          float t = nearT + (float(i) + 0.5) * stepLength;
          vec3 hit = eye + ray * t;
          float r = length(hit.xz);
          float density = diskMask(r) * exp(-pow(hit.y / 0.052, 2.0)) * volumeVisible;
          // Only emission in front of the shadow may cross its black center.
          float front = step(t, closest);
          density *= mix(1.0 - shadow, 1.0, front);
          float opacity = 1.0 - exp(-density * stepLength * 18.0);
          emission += diskLight(r, atan(hit.z, hit.x)) * opacity * transmission;
          transmission *= 1.0 - opacity;
        }
        color += emission;
        alpha = max(alpha, 1.0 - transmission);
        if (alpha < 0.001) discard;
        #include <logdepthbuf_fragment>
        // Normal alpha blending needs unpremultiplied radiance. Shadow pixels
        // remain pure black except where actual foreground disk emission occurs.
        gl_FragColor = vec4(color / max(alpha, 0.001), alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  }));
  surface.frustumCulled = false;
  const inverse = new THREE.Matrix4();
  const cameraWorld = new THREE.Vector3();
  surface.onBeforeRender = (_renderer, _scene, camera) => {
    inverse.copy(group.matrixWorld).invert();
    camera.getWorldPosition(cameraWorld);
    uniforms.eye.value.copy(cameraWorld).applyMatrix4(inverse);
    uniforms.right.value.setFromMatrixColumn(camera.matrixWorld, 0).transformDirection(inverse);
    uniforms.up.value.setFromMatrixColumn(camera.matrixWorld, 1).transformDirection(inverse);
    uniforms.forward.value.copy(uniforms.eye.value).normalize();
  };
  group.add(surface);
  return { body, group, surface, layers: {}, spinning: [], timeUniforms: [time] };
}
