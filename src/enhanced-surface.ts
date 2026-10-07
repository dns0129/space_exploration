import * as THREE from "three";

export const ENHANCED_SURFACE_WIDTH = 16384;
export const ENHANCED_SURFACE_HEIGHT = 8192;
export const ENHANCED_TILE_INTERIOR = 2048;
export const ENHANCED_TILE_GUTTER = 8;
export const ENHANCED_TILE_SIZE = ENHANCED_TILE_INTERIOR + ENHANCED_TILE_GUTTER * 2;

export type EnhancedSurfaceFamily = "rock" | "ice" | "gas" | "star";
export interface EnhancedSurfaceProfile {
  bodyId: string;
  family: EnhancedSurfaceFamily;
  seed: readonly [number, number, number];
  /** Source-map tint; the ordinary material can instead apply its own tint after sampling. */
  tint?: readonly [number, number, number];
  /** Source longitude offset in turns. Generated structure stays in the body's own coordinates. */
  offset?: number;
  strength?: number;
}

export interface EnhancedSurfaceState {
  bodyId: string;
  kind: "enhanced";
  native: false;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  residentTiles: number;
  status: "global" | "pending" | "ready";
}

/** Inactive defaults let every material compile before a detail controller is attached. */
export function createEnhancedSurfaceUniforms(): Record<string, THREE.IUniform> {
  const uniforms: Record<string, THREE.IUniform> = {
    enhancedBlend: { value: new THREE.Vector4() },
    enhancedModulation: { value: 0 },
    enhancedAtlas: { value: null }, enhancedAtlasSize: { value: new THREE.Vector2(1, 1) },
    enhancedAtlasQuadrant: { value: new THREE.Vector2() }, enhancedMaterialSeed: { value: new THREE.Vector3() },
    enhancedMaterialStretch: { value: new THREE.Vector3(1, 1, 1) }, enhancedMaterialMean: { value: 0.5 },
    enhancedMaterialDeviation: { value: 0.15 }, enhancedDetailStrength: { value: 0 },
    enhancedMaterialReady: { value: 0 }, enhancedAtlasSrgb: { value: 0 },
  };
  for (let i = 0; i < 4; i++) {
    uniforms[`enhancedTile${i}`] = { value: null };
    uniforms[`enhancedRect${i}`] = { value: new THREE.Vector4(0, 0, 1 / 8, 1 / 4) };
  }
  return uniforms;
}

/** The same body-fixed artistic material is evaluated by cached tiles and their filtered fallback. */
const enhancedMaterialSampling = /* glsl */ `
  uniform sampler2D enhancedAtlas;
  uniform vec2 enhancedAtlasSize, enhancedAtlasQuadrant;
  uniform vec3 enhancedMaterialSeed, enhancedMaterialStretch;
  uniform float enhancedMaterialMean, enhancedMaterialDeviation, enhancedDetailStrength;
  uniform float enhancedMaterialReady, enhancedAtlasSrgb;
  vec3 enhancedAtlasValue(vec2 uv, float lod) {
    vec2 mirrored = 1.0 - abs(fract(uv * 0.5) * 2.0 - 1.0);
    vec2 inset = vec2(2.0) / enhancedAtlasSize;
    vec2 coord = enhancedAtlasQuadrant * 0.5 + inset + mirrored * (0.5 - 2.0 * inset);
    vec3 value = textureLod(enhancedAtlas, coord, lod).rgb;
    if (enhancedAtlasSrgb > 0.5) value = mix(value * 12.92,
      1.055 * pow(value, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), value));
    return value;
  }
  vec3 enhancedSphereDirection(vec2 uv) {
    float longitude = uv.x * 6.28318530718, latitude = (1.0 - uv.y) * 3.14159265359;
    return vec3(-cos(longitude) * sin(latitude), cos(latitude), sin(longitude) * sin(latitude));
  }
  float enhancedStructure(vec3 p, float lod) {
    float frequency = 16384.0 / (6.28318530718 * (enhancedAtlasSize.x * 0.5));
    vec3 q = p * enhancedMaterialStretch * frequency + enhancedMaterialSeed * 0.1137;
    vec3 weight = pow(abs(p), vec3(4.0));
    weight /= max(dot(weight, vec3(1.0)), 0.0001);
    vec3 material = enhancedAtlasValue(q.yz, lod) * weight.x
      + enhancedAtlasValue(q.zx, lod) * weight.y + enhancedAtlasValue(q.xy, lod) * weight.z;
    return clamp((dot(material, vec3(0.2126, 0.7152, 0.0722)) - enhancedMaterialMean)
      / max(enhancedMaterialDeviation, 0.05), -2.0, 2.0);
  }
`;

/** Uses mapSampling's filtered lookup; uv is the unoffset, body-local sphere UV. */
export const enhancedSurfaceSampling = /* glsl */ `
  ${enhancedMaterialSampling}
  uniform sampler2D enhancedTile0, enhancedTile1, enhancedTile2, enhancedTile3;
  uniform vec4 enhancedRect0, enhancedRect1, enhancedRect2, enhancedRect3;
  uniform vec4 enhancedBlend;
  uniform float enhancedModulation;
  float enhancedTileWeight(vec2 uv, vec4 rect, float blend) {
    if (blend <= 0.0) return 0.0;
    vec2 local = vec2(fract(uv.x-rect.x),uv.y-rect.y)/rect.zw;
    if (local.x>1.0 || local.y<0.0 || local.y>1.0) return 0.0;
    vec2 edge = min(local,1.0-local);
    return blend*smoothstep(0.0,0.006,min(edge.x,edge.y));
  }
  float enhancedSurfaceCoverage(vec2 uv) {
    return clamp(enhancedTileWeight(uv,enhancedRect0,enhancedBlend.x)
      + enhancedTileWeight(uv,enhancedRect1,enhancedBlend.y)
      + enhancedTileWeight(uv,enhancedRect2,enhancedBlend.z)
      + enhancedTileWeight(uv,enhancedRect3,enhancedBlend.w),0.0,1.0);
  }
  vec4 enhancedSurfaceTile(sampler2D tile,vec4 rect,float blend,vec4 base,
    vec2 uv,vec2 gx,vec2 gy) {
    float weight = enhancedTileWeight(uv,rect,blend);
    if (weight<=0.0) return base;
    vec2 local = vec2(fract(uv.x-rect.x),uv.y-rect.y)/rect.zw;
    vec2 tileUv = (local*2048.0+8.0)/2064.0;
    vec2 dx = gx/rect.zw*(2048.0/2064.0),dy = gy/rect.zw*(2048.0/2064.0);
    vec4 detail = sampleMap(tile,tileUv,vec2(2064.0),dx,dy,true);
    // Unsourced procedural bodies store modulation at half amplitude so RGBA8
    // can represent both darker and brighter detail around a neutral value of 1.
    detail.rgb *= mix(1.0,2.0,enhancedModulation);
    return mix(base,detail,weight);
  }
  vec4 sampleEnhancedSurface(vec3 base,vec2 uv,vec2 gx,vec2 gy) {
    vec4 result = vec4(base, 0.5);
    if (enhancedMaterialReady > 0.5 && enhancedSurfaceCoverage(uv) < 0.999) {
      float texels = max(length(gx * vec2(16384.0, 8192.0)), length(gy * vec2(16384.0, 8192.0)));
      // A minified view reads the same field's mips; no separate distant geology.
      float field = enhancedStructure(enhancedSphereDirection(uv), log2(max(texels, 1.0)));
      field *= 1.0 - smoothstep(16.0, 128.0, texels);
      result = vec4(base * (1.0 + clamp(field * enhancedDetailStrength, -0.26, 0.26)),
        clamp(0.5 + field * 0.14, 0.12, 0.88));
    }
    result = enhancedSurfaceTile(enhancedTile0,enhancedRect0,enhancedBlend.x,result,uv,gx,gy);
    result = enhancedSurfaceTile(enhancedTile1,enhancedRect1,enhancedBlend.y,result,uv,gx,gy);
    result = enhancedSurfaceTile(enhancedTile2,enhancedRect2,enhancedBlend.z,result,uv,gx,gy);
    return enhancedSurfaceTile(enhancedTile3,enhancedRect3,enhancedBlend.w,result,uv,gx,gy);
  }
`;

const bakeVertex = /* glsl */ `
  varying vec2 bakeUv;
  void main() {
    bakeUv = uv;
    gl_Position = vec4(position.xy,0.0,1.0);
  }
`;

const bakeFragment = /* glsl */ `
  uniform sampler2D baseMap,materialAtlas;
  uniform vec2 sourceSize,atlasSize,atlasQuadrant;
  uniform vec4 tileRect;
  uniform vec3 bodySeed,sourceTint,materialStretch;
  uniform float sourceReady,sourceOffset,materialMean,materialDeviation,detailStrength,atlasSrgb;
  varying vec2 bakeUv;
  ${enhancedMaterialSampling}
  void main() {
    // Interior pixels address an actual 16384x8192 composite. Gutters evaluate
    // exactly the same global function as the adjacent tile's interior.
    vec2 uv = tileRect.xy+(bakeUv*2064.0-8.0)/2048.0*tileRect.zw;
    uv = vec2(fract(uv.x),clamp(uv.y,0.0,1.0));
    float longitude = uv.x*6.28318530718;
    float latitude = (1.0-uv.y)*3.14159265359;
    vec3 p = vec3(-cos(longitude)*sin(latitude),cos(latitude),sin(longitude)*sin(latitude));
    float field = enhancedStructure(p, 0.0);
    float albedoDetail = clamp(field*detailStrength,-0.26,0.26);
    vec3 composite = vec3((1.0+albedoDetail)*0.5);
    if (sourceReady>0.5) {
      vec2 sourceUv = vec2(fract(uv.x+sourceOffset),uv.y);
      // A cache samples the same source and material as the direct path.
      vec3 source = textureLod(baseMap, sourceUv, 0.0).rgb;
      composite = max(source*sourceTint*(1.0+albedoDetail),vec3(0.0));
    }
    gl_FragColor = vec4(composite,clamp(0.5+field*0.14,0.12,0.88));
  }
`;

type Slot = { key: string; target: THREE.WebGLRenderTarget; fade: number };
const familyData: Record<EnhancedSurfaceFamily, {
  quadrant: readonly [number, number]; mean: number; deviation: number; stretch: readonly [number, number, number];
}> = {
  rock: { quadrant: [0, 1], mean: 0.408853, deviation: 0.170026, stretch: [1, 1, 1] },
  ice: { quadrant: [1, 1], mean: 0.632920, deviation: 0.134339, stretch: [1.3, 0.8, 1.1] },
  gas: { quadrant: [0, 0], mean: 0.493814, deviation: 0.102324, stretch: [0.5, 1.5, 0.5] },
  star: { quadrant: [1, 0], mean: 0.535934, deviation: 0.176546, stretch: [1, 1, 1] },
};

/**
 * Four real GPU tiles form a generated 16K virtual surface. Existing source
 * imagery supplies geography; a separately authored atlas supplies fine
 * structure. This is enhanced artwork, never additional measured imagery.
 */
export class EnhancedSurface {
  readonly uniforms = createEnhancedSurfaceUniforms();
  private readonly slots: (Slot | undefined)[] = Array(4);
  private readonly fallback: THREE.DataTexture;
  private readonly bakeMaterial: THREE.ShaderMaterial;
  private readonly bakeMesh: THREE.Mesh;
  private readonly bakeScene = new THREE.Scene();
  private readonly bakeCamera = new THREE.Camera();
  private readonly eye = new THREE.Vector3();
  private desired: string[] = [];
  private identity = "";
  private bodyId = "";
  private checkAt = 0;
  private failedUntil = 0;
  private disposed = false;
  private publication = "";

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly atlas: () => THREE.Texture | undefined,
    private readonly onChange?: (state: EnhancedSurfaceState) => void,
  ) {
    this.fallback = new THREE.DataTexture(new Uint8Array([255,255,255,128]),1,1,THREE.RGBAFormat);
    this.fallback.needsUpdate = true;
    for (let i = 0; i < 4; i++) this.uniforms[`enhancedTile${i}`].value = this.fallback;
    this.bakeMaterial = new THREE.ShaderMaterial({
      vertexShader: bakeVertex, fragmentShader: bakeFragment,
      depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: {
        ...this.uniforms,
        baseMap: { value: this.fallback }, materialAtlas: { value: this.fallback },
        sourceSize: { value: new THREE.Vector2(1,1) }, atlasSize: { value: new THREE.Vector2(1,1) },
        atlasQuadrant: { value: new THREE.Vector2() }, tileRect: { value: new THREE.Vector4() },
        bodySeed: { value: new THREE.Vector3() }, sourceTint: { value: new THREE.Vector3(1,1,1) },
        materialStretch: { value: new THREE.Vector3(1,1,1) }, sourceReady: { value: 0 },
        sourceOffset: { value: 0 }, materialMean: { value: 0.5 }, materialDeviation: { value: 0.15 },
        detailStrength: { value: 0.12 }, atlasSrgb: { value: 0 },
      },
    });
    this.bakeMesh = new THREE.Mesh(new THREE.PlaneGeometry(2,2),this.bakeMaterial);
    this.bakeMesh.frustumCulled = false;
    this.bakeScene.add(this.bakeMesh);
  }

  update(
    surface: THREE.Mesh | undefined, camera: THREE.Camera, enabled: boolean,
    delta: number, now: number, sourceTexture: THREE.Texture | null | undefined,
    profile: EnhancedSurfaceProfile,
  ) {
    if (this.disposed) return;
    this.bodyId = profile.bodyId;
    this.configureMaterial(profile);
    this.uniforms.enhancedModulation.value = sourceTexture ? 0 : 1;
    if (!enabled || !surface || this.renderer.capabilities.maxTextureSize<ENHANCED_TILE_SIZE) {
      this.clear(); this.publish("global"); return;
    }
    surface.updateWorldMatrix(true,false);
    surface.worldToLocal(this.eye.copy(camera.position));
    if (this.eye.length()>3.0 || this.eye.length()<1e-8) {
      this.clear(); this.publish("global"); return;
    }
    const atlas = this.atlas();
    const image = atlas?.image as { width?: number; height?: number } | undefined;
    if (!atlas || !image?.width || !image.height) {
      this.clear(); this.publish("pending"); return;
    }
    const identity = [profile.bodyId,profile.family,...profile.seed,...(profile.tint??[1,1,1]),
      profile.offset??0,profile.strength??0.12,sourceTexture?.uuid??"procedural",sourceTexture?.version??0,
      atlas.uuid,atlas.version,atlas.colorSpace,image.width,image.height].join(":");
    if (identity!==this.identity) {
      this.clear(); this.identity = identity; this.checkAt = 0; this.failedUntil = 0;
    }
    const blend = this.uniforms.enhancedBlend.value as THREE.Vector4;
    this.slots.forEach((slot,i) => {
      if (slot) { slot.fade = Math.min(1,slot.fade+Math.max(0,delta)*2.5); blend.setComponent(i,slot.fade); }
    });
    if (now<this.checkAt) { this.publish(this.slots.some(Boolean)?"ready":"pending"); return; }
    this.checkAt = now+150;
    this.eye.normalize();
    const u = THREE.MathUtils.euclideanModulo(Math.atan2(this.eye.z,-this.eye.x)/(2*Math.PI),1);
    const northV = Math.acos(THREE.MathUtils.clamp(this.eye.y,-1,1))/Math.PI;
    const col = Math.floor(u*8-0.5),row = THREE.MathUtils.clamp(Math.floor(northV*4-0.5),0,2);
    this.desired = [0,1].flatMap(dy => [0,1].map(dx => `${THREE.MathUtils.euclideanModulo(col+dx,8)}-${row+dy}`));
    for (let i = 0; i < 4; i++) if (this.slots[i] && !this.desired.includes(this.slots[i]!.key)) this.remove(i);
    const key = this.desired.find(key => !this.slots.some(slot => slot?.key===key));
    if (key && now>=this.failedUntil) {
      const index = this.slots.findIndex(slot => !slot);
      if (index>=0) {
        try { this.bake(index,key,atlas,sourceTexture,profile); }
        catch { this.failedUntil = now+30_000; }
      }
    }
    this.publish(this.slots.some(Boolean)?"ready":"pending");
  }

  get tileIds() { return this.slots.flatMap(slot => slot ? [slot.target.texture.uuid] : []); }
  get isSettled() { return this.slots.every(slot => !slot || slot.fade >= 1); }

  private configureMaterial(profile: EnhancedSurfaceProfile) {
    const atlas = this.atlas(), image = atlas?.image as { width?: number; height?: number } | undefined;
    const family = familyData[profile.family], u = this.uniforms;
    u.enhancedMaterialReady.value = Number(!!atlas && !!image?.width && !!image.height);
    u.enhancedAtlas.value = atlas ?? this.fallback;
    u.enhancedAtlasSize.value.set(image?.width ?? 1, image?.height ?? 1);
    u.enhancedAtlasQuadrant.value.set(...family.quadrant);
    u.enhancedMaterialSeed.value.set(...profile.seed);
    u.enhancedMaterialStretch.value.set(...family.stretch);
    u.enhancedMaterialMean.value = family.mean;
    u.enhancedMaterialDeviation.value = family.deviation;
    u.enhancedDetailStrength.value = profile.strength ?? 0.12;
    u.enhancedAtlasSrgb.value = Number(atlas?.colorSpace === THREE.SRGBColorSpace);
  }

  private bake(index: number,key: string,atlas: THREE.Texture,source: THREE.Texture | null | undefined,profile: EnhancedSurfaceProfile) {
    const [col,row] = key.split("-").map(Number);
    const family = familyData[profile.family];
    const uniforms = this.bakeMaterial.uniforms;
    const atlasImage = atlas.image as { width: number; height: number };
    const sourceImage = source?.image as { width?: number; height?: number } | undefined;
    uniforms.materialAtlas.value = atlas;
    uniforms.baseMap.value = source??this.fallback;
    uniforms.sourceReady.value = source ? 1 : 0;
    uniforms.sourceSize.value.set(sourceImage?.width||1,sourceImage?.height||1);
    uniforms.atlasSize.value.set(atlasImage.width,atlasImage.height);
    uniforms.atlasQuadrant.value.set(...family.quadrant);
    uniforms.tileRect.value.set(col/8,(3-row)/4,1/8,1/4);
    uniforms.bodySeed.value.set(...profile.seed);
    uniforms.sourceTint.value.set(...(profile.tint??[1,1,1]));
    uniforms.materialStretch.value.set(...family.stretch);
    uniforms.sourceOffset.value = profile.offset??0;
    uniforms.materialMean.value = family.mean;
    uniforms.materialDeviation.value = family.deviation;
    uniforms.detailStrength.value = profile.strength??0.12;
    uniforms.atlasSrgb.value = atlas.colorSpace===THREE.SRGBColorSpace ? 1 : 0;

    const target = new THREE.WebGLRenderTarget(ENHANCED_TILE_SIZE,ENHANCED_TILE_SIZE,{
      depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      generateMipmaps: true,
    });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
    target.texture.name = `enhanced-${profile.bodyId}-16k-${key}`;
    target.texture.anisotropy = Math.min(4,this.renderer.capabilities.getMaxAnisotropy());
    const previousTarget = this.renderer.getRenderTarget();
    const previousFace = this.renderer.getActiveCubeFace(),previousMip = this.renderer.getActiveMipmapLevel();
    const viewport = this.renderer.getViewport(new THREE.Vector4());
    const scissor = this.renderer.getScissor(new THREE.Vector4());
    const scissorTest = this.renderer.getScissorTest();
    const clearColor = this.renderer.getClearColor(new THREE.Color()),clearAlpha = this.renderer.getClearAlpha();
    const autoClear = this.renderer.autoClear,xr = this.renderer.xr.enabled;
    let succeeded = false;
    try {
      this.renderer.xr.enabled = false;
      this.renderer.autoClear = true;
      this.renderer.setRenderTarget(target);
      this.renderer.setViewport(0,0,ENHANCED_TILE_SIZE,ENHANCED_TILE_SIZE);
      this.renderer.setScissor(0,0,ENHANCED_TILE_SIZE,ENHANCED_TILE_SIZE);
      this.renderer.setScissorTest(false);
      this.renderer.setClearColor(0x000000,0.5);
      this.renderer.render(this.bakeScene,this.bakeCamera);
      const gl = this.renderer.getContext();
      if (gl.isContextLost() || gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)
        throw new Error("Enhanced surface framebuffer unavailable");
      succeeded = true;
    } finally {
      this.renderer.setRenderTarget(previousTarget,previousFace,previousMip);
      this.renderer.setViewport(viewport);
      this.renderer.setScissor(scissor);
      this.renderer.setScissorTest(scissorTest);
      this.renderer.setClearColor(clearColor,clearAlpha);
      this.renderer.autoClear = autoClear;
      this.renderer.xr.enabled = xr;
      if (!succeeded) target.dispose();
    }
    this.slots[index] = { key,target,fade: 0 };
    this.uniforms[`enhancedTile${index}`].value = target.texture;
    this.uniforms[`enhancedRect${index}`].value.copy(uniforms.tileRect.value);
  }

  private remove(index: number) {
    this.slots[index]?.target.dispose();
    this.slots[index] = undefined;
    this.uniforms[`enhancedTile${index}`].value = this.fallback;
    (this.uniforms.enhancedBlend.value as THREE.Vector4).setComponent(index,0);
  }
  private clear() {
    this.desired = [];
    for (let i = 0; i < 4; i++) this.remove(i);
  }
  private publish(status: EnhancedSurfaceState["status"]) {
    const residentTiles = this.slots.filter(Boolean).length;
    if (status === "ready" && residentTiles < this.slots.length) status = "pending";
    const target = this.slots.find(slot => !!slot)?.target;
    const tileWidth = target?.width ?? 0,tileHeight = target?.height ?? 0;
    const publication = `${this.bodyId}:${status}:${residentTiles}`;
    if (publication===this.publication) return;
    this.publication = publication;
    this.onChange?.({
      bodyId: this.bodyId,kind: "enhanced",native: false,
      width: ENHANCED_SURFACE_WIDTH,height: ENHANCED_SURFACE_HEIGHT,
      tileWidth,tileHeight,residentTiles,status,
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.bakeMesh.geometry.dispose();
    this.bakeMaterial.dispose();
    this.fallback.dispose();
    this.bakeScene.clear();
  }
}
