import * as THREE from "three";
import type { CelestialBody, Layer } from "./solar-system";

export interface PlanetModel {
  body: CelestialBody;
  group: THREE.Group;
  surface: THREE.Mesh;
  layers: Partial<Record<Layer, THREE.Object3D>>;
  spinning: { object: THREE.Object3D; rate: number }[];
  timeUniforms: THREE.IUniform<number>[];
  ringsEnabled?: THREE.IUniform<number>;
}

export const modelVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vLocalPosition;
  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vLocalPosition = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    vec3 n = normalMatrix * normal;
    vNormal = normalize(vec3(dot(viewMatrix[0].xyz,n),dot(viewMatrix[1].xyz,n),dot(viewMatrix[2].xyz,n)));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const noise = /* glsl */ `
  float hash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float noise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
  float fbm(vec3 p) {
    float value = 0.0, amplitude = 0.5;
    for (int i=0; i<4; i++) {
      value += noise3(p) * amplitude;
      p = p * 2.03 + vec3(7.1,13.7,3.2);
      amplitude *= 0.5;
    }
    return value;
  }
  float crater(vec2 uv, float density) {
    vec2 grid = vec2(density,density*0.5);
    vec2 cell = floor(uv*grid), f = fract(uv*grid);
    float result = 0.0;
    for (int y=-1; y<=1; y++) for (int x=-1; x<=1; x++) {
      vec2 offset = vec2(float(x),float(y));
      vec2 wrapped = mod(cell+offset,grid);
      vec2 center = vec2(hash(vec3(wrapped,8.0)),hash(vec3(wrapped,27.0)));
      float radius = 0.12+hash(vec3(wrapped,3.0))*0.28;
      float d = length(f-offset-center)/radius;
      result += -0.22*(1.0-smoothstep(0.0,0.94,d))+0.1*exp(-pow((d-1.0)*12.0,2.0));
    }
    return result;
  }
  float ringDensity(float r, float footprint) {
    // Average lines smaller than a pixel to keep distant rings from shimmering.
    float fine = 0.68+0.12*sin(r*330.0)*exp(-0.5*pow(footprint*330.0,2.0))+0.1*sin(r*790.0)*exp(-0.5*pow(footprint*790.0,2.0));
    float broad = 0.6+0.22*sin(r*34.0)+0.13*sin(r*83.0);
    float cassini = smoothstep(1.93,1.945,r)*(1.0-smoothstep(2.005,2.02,r));
    return clamp(fine*broad*smoothstep(1.12,1.25,r)*(1.0-smoothstep(2.25,2.3,r))*(1.0-cassini*0.99),0.0,0.95);
  }
`;

const planetFragment = /* glsl */ `
  uniform vec3 sunDirection;
  uniform vec3 planetAxis;
  uniform vec3 planetCenter;
  uniform float bodyRadius;
  uniform float uTime;
  uniform float ringsEnabled;
  varying vec2 vUv;
  varying vec3 vLocalPosition;
  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  ${noise}
  void main() {
    vec3 p = normalize(vLocalPosition);
    float terrain = fbm(p*5.0);
    float detail = noise3(p*180.0);
    float height = terrain*0.03;
    vec3 color = vec3(0.5);
    #if BODY_KIND == 0
      height += crater(vUv,18.0)+crater(vUv,56.0)*0.55;
      color = mix(vec3(0.19,0.17,0.16),vec3(0.55,0.52,0.47),smoothstep(0.3,0.7,terrain));
      color *= 0.85+detail*0.3+height*0.25;
    #elif BODY_KIND == 1
      height += crater(vUv,24.0)*0.25;
      color = mix(vec3(0.21,0.105,0.035),vec3(0.65,0.35,0.12),terrain);
      color *= 0.86+detail*0.18;
    #elif BODY_KIND == 2
      height += crater(vUv,35.0)*0.18;
      float dark = smoothstep(0.36,0.59,fbm(p*vec3(6.0,3.0,7.0)));
      color = mix(vec3(0.60,0.22,0.09),vec3(0.23,0.095,0.048),dark)+vec3(0.2,0.12,0.06)*terrain;
      float cap = smoothstep(0.945,0.98,abs(p.y)+noise3(p*35.0)*0.02);
      color = mix(color,vec3(0.83,0.82,0.76),cap)*(0.9+detail*0.15);
    #elif BODY_KIND == 3
      float lat = p.y+fbm(p*vec3(5.0,9.0,5.0))*0.06;
      float bands = 0.5+0.5*sin(lat*30.0+noise3(p*12.0)*0.65);
      color = mix(vec3(0.87,0.78,0.63),vec3(0.46,0.26,0.14),smoothstep(0.2,0.85,bands));
      color += (fbm(p*vec3(28.0,70.0,28.0))-0.5)*0.16;
      vec2 spot = vec2(mod(vUv.x-0.19+0.5,1.0)-0.5,vUv.y-0.39)/vec2(0.068,0.038);
      float oval = length(spot);
      float vortex = sin(oval*19.0+atan(spot.y,spot.x)*3.0+terrain*4.0);
      vec3 red = mix(vec3(0.62,0.20,0.075),vec3(0.83,0.43,0.20),vortex*0.5+0.5);
      color = mix(color,red,(1.0-smoothstep(0.82,1.16,oval))*0.88);
      height = detail*0.002;
    #elif BODY_KIND == 4
      float bands = 0.5+0.5*sin(p.y*32.0+terrain*0.5);
      color = mix(vec3(0.88,0.78,0.56),vec3(0.65,0.52,0.33),bands*0.45);
      color += (fbm(p*vec3(16.0,60.0,16.0))-0.45)*0.065;
      height = detail*0.001;
    #elif BODY_KIND == 5
      color = mix(vec3(0.32,0.66,0.69),vec3(0.54,0.81,0.79),terrain*0.5+0.2);
      color += sin(p.y*22.0+terrain)*0.015;
      height = 0.0;
    #elif BODY_KIND == 6
      float bands = 0.5+0.5*sin(p.y*24.0+terrain*1.5);
      color = mix(vec3(0.055,0.20,0.52),vec3(0.12,0.38,0.77),bands*0.65+terrain*0.2);
      vec2 spot = vec2(mod(vUv.x-0.22+0.5,1.0)-0.5,vUv.y-0.44)/vec2(0.045,0.035);
      color *= 1.0-(1.0-smoothstep(0.6,1.2,length(spot)))*0.4;
      height = detail*0.001;
    #elif BODY_KIND == 7
      vec3 plasma = p*20.0+vec3(0.0,uTime*0.008,0.0);
      float granules = fbm(plasma+(terrain-0.5)*1.4);
      float fine = noise3(p*170.0+uTime*0.006);
      color = mix(vec3(1.5,0.25,0.007),vec3(3.0,1.6,0.22),smoothstep(0.24,0.70,granules))*(0.84+fine*0.23);
      float sunspots = smoothstep(0.69,0.78,fbm(p*8.0+vec3(17.0)));
      color *= 1.0-sunspots*0.85;
      vec3 viewDirection = normalize(cameraPosition-vWorldPosition);
      color *= 0.55+0.45*pow(max(dot(normalize(vNormal),viewDirection),0.0),0.3);
      gl_FragColor = vec4(color,1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    #endif
    vec3 normal = normalize(vNormal);
    vec3 dpdx = dFdx(vWorldPosition), dpdy = dFdy(vWorldPosition);
    vec3 r1 = cross(dpdy,normal), r2 = cross(normal,dpdx);
    float determinant = dot(dpdx,r1);
    vec3 gradient = sign(determinant)*(dFdx(height)*r1+dFdy(height)*r2);
    normal = normalize(max(abs(determinant),0.0000001)*normal-0.012*gradient);
    float diffuse = max(dot(normal,sunDirection),0.0);
    #if BODY_KIND == 4
      float planeAngle = dot(sunDirection,planetAxis);
      if(abs(planeAngle)>0.001) {
        vec3 relative = (vWorldPosition-planetCenter)/bodyRadius;
        float t = -dot(relative,planetAxis)/planeAngle;
        float r = length(relative+sunDirection*t);
        if(t>0.0 && r>1.12 && r<2.3) diffuse *= 1.0-ringDensity(r,0.0)*ringsEnabled*0.88;
      }
    #endif
    gl_FragColor = vec4(max(color*(0.045+diffuse*1.2),vec3(0.0)),1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const atmosphereFragment = /* glsl */ `
  uniform vec3 sunDirection;
  uniform vec3 atmosphereColor;
  uniform vec3 planetCenter;
  uniform float bodyRadius;
  uniform float strength;
  uniform float uTime;
  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  varying vec3 vLocalPosition;
  ${noise}
  void main() {
    vec3 normal = normalize(vNormal), view = normalize(cameraPosition-vWorldPosition);
    float rim = pow(1.0-abs(dot(normal,view)),4.0);
    float sun = smoothstep(-0.35,0.8,dot(normal,sunDirection));
    #ifdef SOLAR_CORONA
      float streamers = 0.65+noise3(normal*14.0+uTime*0.006)*0.6;
      float impact = length(cross(cameraPosition-planetCenter,normalize(vWorldPosition-cameraPosition)))/bodyRadius;
      float envelope = exp(-max(impact-1.0,0.0)*18.0)*(1.0-smoothstep(1.08,1.2,impact));
      gl_FragColor = vec4(atmosphereColor*1.6,envelope*strength*streamers*0.68);
    #else
      gl_FragColor = vec4(atmosphereColor,rim*strength*(0.12+sun*0.75));
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const cloudsFragment = /* glsl */ `
  uniform vec3 sunDirection;
  uniform float uTime;
  varying vec3 vLocalPosition;
  varying vec3 vWorldPosition;
  varying vec3 vNormal;
  ${noise}
  void main() {
    vec3 p = normalize(vLocalPosition);
    float clouds = fbm(p*vec3(6.0,12.0,6.0)+vec3(0.0,0.0,uTime*0.004));
    float diffuse = max(dot(normalize(vNormal),sunDirection),0.0);
    #ifdef VENUS_CLOUDS
      float swirl = fbm(p*8.0+(clouds-0.5)*1.8);
      vec3 color = mix(vec3(0.67,0.45,0.21),vec3(0.96,0.85,0.62),swirl*0.75+0.15);
      gl_FragColor = vec4(color*(0.06+diffuse*1.15),0.995);
    #else
      float streaks = fbm(p*vec3(15.0,90.0,15.0));
      gl_FragColor = vec4(vec3(0.72,0.83,0.92)*(0.035+diffuse*1.15),smoothstep(0.52,0.72,streaks)*0.45);
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const ringFragment = /* glsl */ `
  uniform vec3 sunDirection;
  uniform vec3 planetAxis;
  uniform vec3 planetCenter;
  uniform float bodyRadius;
  varying vec3 vWorldPosition;
  varying vec3 vLocalPosition;
  ${noise}
  void main() {
    float radius = length(vLocalPosition);
    float density = ringDensity(radius,fwidth(radius));
    if(density<0.015) discard;
    vec3 color = mix(vec3(0.38,0.33,0.26),vec3(0.89,0.81,0.66),density);
    float light = 0.35+abs(dot(sunDirection,planetAxis))*0.8;
    // Analytic ellipsoid intersection casts Saturn's shadow onto the rings.
    float scale = 1.0/(0.902*0.902)-1.0;
    vec3 relative = (vWorldPosition-planetCenter)/bodyRadius;
    float py = dot(relative,planetAxis), dy = dot(sunDirection,planetAxis);
    float a = 1.0+scale*dy*dy;
    float b = 2.0*(dot(relative,sunDirection)+scale*py*dy);
    float c = dot(relative,relative)+scale*py*py-1.0;
    float discriminant = b*b-4.0*a*c;
    if(discriminant>0.0 && (-b-sqrt(discriminant))/(2.0*a)>0.0) light *= 0.16;
    gl_FragColor = vec4(color*light,density*0.95);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createPlanetModel(
  body: CelestialBody,
  sunDirection: THREE.Vector3,
  placement = { center: new THREE.Vector3(), radius: 1 },
): PlanetModel {
  const kinds = {
    mercury: 0,
    venus: 1,
    mars: 2,
    jupiter: 3,
    saturn: 4,
    uranus: 5,
    neptune: 6,
    sun: 7,
  };
  if (body.id === "earth")
    throw new Error("Earth requires its photographic texture model.");
  const group = new THREE.Group();
  group.rotation.z = THREE.MathUtils.degToRad(body.axialTiltDeg);
  const axis = new THREE.Vector3(0, 1, 0).applyAxisAngle(
    new THREE.Vector3(0, 0, 1),
    group.rotation.z,
  );
  const uTime = { value: 0 },
    ringsEnabled = { value: 1 };
  const surface = new THREE.Mesh(
    new THREE.SphereGeometry(1, 192, 128),
    new THREE.ShaderMaterial({
      vertexShader: modelVertex,
      fragmentShader: planetFragment,
      defines: { BODY_KIND: kinds[body.id] },
      uniforms: {
        sunDirection: { value: sunDirection },
        planetAxis: { value: axis },
        planetCenter: { value: placement.center },
        bodyRadius: { value: placement.radius },
        uTime,
        ringsEnabled,
      },
    }),
  );
  surface.scale.y = body.flattening;
  surface.rotation.y = -0.4;
  group.add(surface);
  const model: PlanetModel = {
    body,
    group,
    surface,
    layers: {},
    spinning: [{ object: surface, rate: body.rotationSpeed }],
    timeUniforms: [uTime],
    ringsEnabled,
  };
  if (body.layers.includes("atmosphere")) {
    const solar = body.id === "sun";
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(solar ? 1.23 : 1.028, 96, 64),
      new THREE.ShaderMaterial({
        vertexShader: modelVertex,
        fragmentShader: atmosphereFragment,
        defines: solar ? { SOLAR_CORONA: 1 } : {},
        uniforms: {
          sunDirection: { value: sunDirection },
          planetCenter: { value: placement.center },
          bodyRadius: { value: placement.radius },
          atmosphereColor: {
            value: new THREE.Color(solar ? "#ff8f2c" : body.atmosphereColor!),
          },
          strength: { value: solar ? 0.95 : body.id === "mars" ? 0.4 : 0.5 },
          uTime,
        },
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    halo.scale.y = body.flattening;
    const atmosphere = new THREE.Group();
    atmosphere.add(halo);
    group.add(atmosphere);
    model.layers.atmosphere = atmosphere;
  }
  if (body.id === "venus" || body.id === "neptune") {
    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(1.007, 128, 96),
      new THREE.ShaderMaterial({
        vertexShader: modelVertex,
        fragmentShader: cloudsFragment,
        defines: body.id === "venus" ? { VENUS_CLOUDS: 1 } : {},
        uniforms: { sunDirection: { value: sunDirection }, uTime },
        transparent: true,
        depthWrite: false,
      }),
    );
    clouds.scale.y = body.flattening;
    group.add(clouds);
    model.layers.clouds = clouds;
    model.spinning.push({ object: clouds, rate: body.rotationSpeed * 1.1 });
  }
  if (body.id === "saturn") {
    const rings = new THREE.Mesh(
      new THREE.RingGeometry(1.12, 2.3, 320),
      new THREE.ShaderMaterial({
        vertexShader: modelVertex,
        fragmentShader: ringFragment,
        uniforms: {
          sunDirection: { value: sunDirection },
          planetAxis: { value: axis },
          planetCenter: { value: placement.center },
          bodyRadius: { value: placement.radius },
        },
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
      }),
    );
    rings.rotation.x = -Math.PI / 2;
    group.add(rings);
    model.layers.rings = rings;
  }
  if (body.id === "sun") {
    const flares = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.5, 0.45, 0.04),
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    for (let i = 0; i < 12; i++) {
      const angle = i * 2.399;
      const normal = new THREE.Vector3(
        Math.cos(angle),
        Math.sin(angle),
        Math.sin(i * 1.71) * 0.4,
      ).normalize();
      const tangent = new THREE.Vector3()
        .crossVectors(normal, new THREE.Vector3(0, 0, 1))
        .normalize();
      const a = normal.clone().addScaledVector(tangent, -0.055).normalize();
      const b = normal.clone().multiplyScalar(1.11 + Math.sin(i * 2.1) * 0.035);
      const c = normal.clone().addScaledVector(tangent, 0.055).normalize();
      flares.add(
        new THREE.Mesh(
          new THREE.TubeGeometry(
            new THREE.QuadraticBezierCurve3(a, b, c),
            32,
            0.0025,
            6,
            false,
          ),
          material,
        ),
      );
    }
    model.layers.atmosphere!.add(flares);
    model.spinning.push({ object: flares, rate: body.rotationSpeed });
  }
  return model;
}
