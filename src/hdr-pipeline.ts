import * as THREE from "three";
import type { LightingQuality } from "./lighting-quality";

const vertex = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** Every astronomical/metre pass shares linear colour, with independent depth.
 * Tone mapping and the display transfer occur exactly once, after blending. */
export class HdrPipeline {
  readonly supported: boolean;
  readonly target: THREE.WebGLRenderTarget;
  private readonly bloomA: THREE.WebGLRenderTarget;
  private readonly bloomB: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  private readonly blur = new THREE.ShaderMaterial({ vertexShader: vertex, depthTest: false, depthWrite: false,
    uniforms: { source: { value: null as THREE.Texture | null }, stepUv: { value: new THREE.Vector2() }, threshold: { value: 0 } },
    fragmentShader: `varying vec2 vUv; uniform sampler2D source; uniform vec2 stepUv; uniform float threshold;
      vec3 radiance(vec2 uv) { vec3 c = texture2D(source, uv).rgb;
        float peak = max(c.r, max(c.g, c.b)); return c * max(peak - threshold, 0.0) / max(peak, 0.0001); }
      void main() { vec3 c = radiance(vUv) * 0.4;
        c += (radiance(vUv + stepUv) + radiance(vUv - stepUv)) * 0.24;
        c += (radiance(vUv + stepUv * 2.0) + radiance(vUv - stepUv * 2.0)) * 0.06;
        gl_FragColor = vec4(c, 1.0); }` });
  private readonly output = new THREE.ShaderMaterial({ vertexShader: vertex, depthTest: false, depthWrite: false,
    uniforms: { source: { value: null as THREE.Texture | null }, bloom: { value: null as THREE.Texture | null }, bloomStrength: { value: 0 } },
    fragmentShader: `varying vec2 vUv; uniform sampler2D source, bloom; uniform float bloomStrength;
      void main() { vec3 c = texture2D(source, vUv).rgb;
        if (bloomStrength > 0.0) c += texture2D(bloom, vUv).rgb * bloomStrength;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` });
  private quality?: LightingQuality;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.supported = renderer.extensions.has("EXT_color_buffer_float");
    const options = { type: this.supported ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    this.target = new THREE.WebGLRenderTarget(1, 1, options);
    this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.bloomA = new THREE.WebGLRenderTarget(1, 1, { ...options, depthBuffer: false });
    this.bloomB = new THREE.WebGLRenderTarget(1, 1, { ...options, depthBuffer: false });
    this.output.uniforms.source.value = this.target.texture;
    this.output.uniforms.bloom.value = this.bloomB.texture;
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    renderer.domElement.dataset.colorPipeline = this.supported ? "linear-hdr" : "linear-ldr";
  }
  configure(quality: LightingQuality, software: boolean) {
    this.quality = quality;
    // Multisampling stays on real GPUs. Software rasterizers need the cheaper target.
    this.target.samples = software ? 0 : 4;
    this.resize();
  }
  private resize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const width = Math.max(1, size.x), height = Math.max(1, size.y);
    this.target.setSize(width, height);
    const scale = this.quality?.bloomScale ?? 0.25;
    this.bloomA.setSize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    this.bloomB.setSize(this.bloomA.width, this.bloomA.height);
  }
  begin() {
    this.resize();
    this.renderer.setRenderTarget(this.target);
  }
  finish() {
    const renderer = this.renderer, autoClear = renderer.autoClear;
    const scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
    const strength = this.supported ? this.quality?.bloomStrength ?? 0 : 0;
    try {
      renderer.autoClear = true;
      renderer.setScissorTest(false);
      if (strength > 0) {
        this.quad.material = this.blur;
        this.blur.uniforms.source.value = this.target.texture;
        this.blur.uniforms.threshold.value = 1.2;
        this.blur.uniforms.stepUv.value.set(1 / this.bloomA.width, 0);
        renderer.setRenderTarget(this.bloomA);
        renderer.render(this.scene, this.camera);
        this.blur.uniforms.source.value = this.bloomA.texture;
        this.blur.uniforms.threshold.value = 0;
        this.blur.uniforms.stepUv.value.set(0, 1 / this.bloomA.height);
        renderer.setRenderTarget(this.bloomB);
        renderer.render(this.scene, this.camera);
      }
      this.quad.material = this.output;
      this.output.uniforms.bloomStrength.value = strength;
      renderer.setRenderTarget(null);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(null);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
      renderer.autoClear = autoClear;
    }
  }
  dispose() {
    this.target.dispose(); this.bloomA.dispose(); this.bloomB.dispose();
    this.quad.geometry.dispose(); this.blur.dispose(); this.output.dispose();
  }
}
