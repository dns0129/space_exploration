import * as THREE from "three";

export type GalaxyTextureFile = "milky-way-8k.jpg" | "milky-way-4k.jpg";

/** Native source pixels, never a 4K image enlarged into an 8K/16K texture. */
export function selectGalaxyFile(maxTextureSize: number, compact = false, software = false): GalaxyTextureFile {
  return maxTextureSize >= 8192 && !compact && !software ? "milky-way-8k.jpg" : "milky-way-4k.jpg";
}

const skyVertex = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = position;
    // A sky direction has no world position. Ignore both camera translation
    // and the parent's metre conversion used by the walking render pass.
    vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
    gl_Position = vec4(clip.xy, clip.w * 0.999, clip.w);
  }
`;

const skyFragment = /* glsl */ `
  uniform sampler2D skyMap;
  uniform mat3 skyRotation;
  uniform float intensity;
  uniform float visibility;
  uniform float detail;
  uniform float hasMap;
  varying vec3 vDirection;

  float starHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }

  // Stars are evaluated at the display's pixel scale. Their tiny round cores
  // remain clean under zoom instead of magnifying square JPEG texels.
  // They are original visual detail, not an astrometric star catalogue.
  vec3 stars(vec2 uv, vec2 uvDx, vec2 uvDy, vec2 gridSize, float seed, float density, float gain) {
    vec2 grid = uv * gridSize;
    vec2 cell = floor(grid);
    float latitude = (uv.y - 0.5) * 3.14159265359;
    float latitudeScale = max(cos(latitude), 0.035);
    float selected = starHash(cell + seed);
    float present = step(selected, density * latitudeScale);
    vec2 center = vec2(starHash(cell + seed + 11.3), starHash(cell + seed + 53.7)) * 0.48 + 0.26;
    vec2 offset = fract(grid) - center;
    offset.x *= latitudeScale;
    // Differentiate the continuous angular field, never the hashed cell or
    // fract(grid): both are discontinuous and can create bright square patches.
    vec2 metric = vec2(latitudeScale, 1.0);
    float pixel = max(length(uvDx * gridSize * metric), length(uvDy * gridSize * metric));
    float magnitude = starHash(cell + seed + 137.0);
    float radius = max(mix(0.006, 0.027, pow(magnitude, 8.0)), pixel * 0.54);
    float distance2 = dot(offset, offset);
    float core = exp(-distance2 / (radius * radius));
    float halo = exp(-distance2 / (radius * radius * 7.0)) * 0.08 * pow(magnitude, 5.0);
    float temperature = starHash(cell + seed + 303.0);
    vec3 tint = mix(vec3(0.64, 0.79, 1.0), vec3(1.0, 0.83, 0.63), temperature);
    return tint * (core + halo) * present * gain * mix(0.28, 1.0, pow(magnitude, 3.0));
  }

  void main() {
    vec3 direction = normalize(skyRotation * normalize(vDirection));
    vec2 uv = vec2(atan(direction.z, direction.x) / 6.28318530718 + 0.5,
                   asin(clamp(direction.y, -1.0, 1.0)) / 3.14159265359 + 0.5);
    // Longitude wraps. Derivatives across the wrap must not select a blurry
    // mip level, especially when the sharp galactic plane crosses the seam.
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    dx.x -= floor(dx.x + 0.5);
    dy.x -= floor(dy.x + 0.5);
    vec3 photograph = textureGrad(skyMap, uv, dx, dy).rgb * hasMap;
    // A restrained photographic shadow lift reveals the native dust lanes;
    // it changes display exposure, without inventing higher-resolution clouds.
    vec3 radiance = photograph + sqrt(max(photograph, vec3(0.0))) * 0.024;
    vec3 pinpoints = stars(uv, dx, dy, vec2(420.0, 210.0), 19.3, 0.052, 0.62);
    if (detail > 0.5) {
      pinpoints += stars(uv, dx, dy, vec2(1440.0, 720.0), 71.8, 0.022, 0.13);
    }
    gl_FragColor = vec4((radiance * intensity + pinpoints) * visibility, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Direct panorama rendering avoids Three's equirectangular-to-cube downsample. */
export class GalaxySky {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly rotation = new THREE.Euler();
  private readonly rotationMatrix = new THREE.Matrix4();
  private readonly blackTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);

  constructor(compact = false) {
    this.blackTexture.needsUpdate = true;
    const material = new THREE.ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: {
        skyMap: { value: this.blackTexture },
        skyRotation: { value: new THREE.Matrix3() },
        intensity: { value: 2.5 },
        visibility: { value: 1 },
        detail: { value: compact ? 0 : 1 },
        hasMap: { value: 0 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 32), material);
    this.mesh.name = "native-panorama-galaxy";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  /** The caller owns panorama texture loading and disposal. */
  setTexture(texture: THREE.Texture | null) {
    this.mesh.material.uniforms.skyMap.value = texture ?? this.blackTexture;
    this.mesh.material.uniforms.hasMap.value = texture ? 1 : 0;
    if (texture) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
    }
  }

  /** Rotation uses the same convention as Scene.backgroundRotation. */
  setView(rotation: readonly number[], intensity: number, visibility = 1, enabled = true) {
    this.rotation.set(-rotation[0], -rotation[1], -rotation[2]);
    this.mesh.material.uniforms.skyRotation.value.setFromMatrix4(this.rotationMatrix.makeRotationFromEuler(this.rotation));
    this.mesh.material.uniforms.intensity.value = intensity;
    this.mesh.material.uniforms.visibility.value = THREE.MathUtils.clamp(visibility, 0, 1);
    this.mesh.visible = enabled && visibility > 0.001;
  }

  setDetailed(enabled: boolean) {
    this.mesh.material.uniforms.detail.value = enabled ? 1 : 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.blackTexture.dispose();
  }
}
