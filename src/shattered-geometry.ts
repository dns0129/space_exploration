import * as THREE from "three";

/** Both the real openings and the material's finer fracture damage use this map. */
export const SHATTERED_FRACTURE_GLSL = /* glsl */ `
  vec3 shatteredCoordinates(vec3 p, float small) {
    vec3 q = normalize(p);
    q.x *= 1.0 - small * 2.0;
    q.y = mix(q.y, -q.y, small);
    return q;
  }
  float shatteredMainPath(vec3 q) {
    return 0.14 + 0.18 * q.y + 0.056 * sin(q.y * 8.0 + q.z * 2.0)
      + 0.021 * sin(q.y * 23.0 - q.z * 7.0);
  }
  float shatteredFault(vec3 p, float small) {
    vec3 q = shatteredCoordinates(p, small);
    float path = shatteredMainPath(q);
    float width = 0.012 + 0.007 * (0.5 + 0.5 * sin(q.y * 13.0 + q.z * 7.0))
      + 0.043 * exp(-pow((q.y + 0.12) / 0.32, 2.0));
    float d = abs(q.x - path) - width;
    if (q.x > path + 0.012 && q.z > -0.48) {
      float branchA = q.y - (0.39 - 0.43 * q.x + 0.025 * sin(q.x * 16.0 + q.z * 4.0));
      float branchB = q.y - (-0.25 + 0.32 * q.x + 0.030 * sin(q.x * 17.0 - q.z * 3.0));
      d = min(d, abs(branchA) - 0.010);
      d = min(d, abs(branchB) - 0.012);
      if (q.x > 0.40) d = min(d, abs(q.x - (0.58 + 0.075 * sin(q.y * 7.0 + q.z * 3.0))) - 0.006);
    }
    return d;
  }
  float shatteredDamage(vec3 p, float small) {
    vec3 q = shatteredCoordinates(p, small);
    float side = smoothstep(-0.11, 0.38, q.x - shatteredMainPath(q));
    float seam = 1.0 - smoothstep(0.0, 0.13, shatteredFault(p, small));
    return max(side * (0.72 + 0.28 * smoothstep(-0.5, 0.6, q.z)), seam * 0.92);
  }
`;

type Sample = { q: THREE.Vector3; path: number; a: number; b: number; side: number; fault: number };
function sampleFracture(p: THREE.Vector3, small: boolean): Sample {
  const q = p.clone().normalize();
  if (small) { q.x *= -1; q.y *= -1; }
  const path = 0.14 + 0.18 * q.y + 0.056 * Math.sin(q.y * 8 + q.z * 2)
    + 0.021 * Math.sin(q.y * 23 - q.z * 7);
  const width = 0.012 + 0.007 * (0.5 + 0.5 * Math.sin(q.y * 13 + q.z * 7))
    + 0.043 * Math.exp(-Math.pow((q.y + 0.12) / 0.32, 2));
  const a = q.y - (0.39 - 0.43 * q.x + 0.025 * Math.sin(q.x * 16 + q.z * 4));
  const b = q.y - (-0.25 + 0.32 * q.x + 0.030 * Math.sin(q.x * 17 - q.z * 3));
  const side = q.x - (0.58 + 0.075 * Math.sin(q.y * 7 + q.z * 3));
  let fault = Math.abs(q.x - path) - width;
  if (q.x > path + 0.012 && q.z > -0.48) {
    fault = Math.min(fault, Math.abs(a) - 0.010, Math.abs(b) - 0.012);
    if (q.x > 0.40) fault = Math.min(fault, Math.abs(side) - 0.006);
  }
  return { q, path, a, b, side, fault };
}

type Data = { positions: number[]; sources: number[]; normals: number[]; shells: number[]; uvs: number[] };
type Vertex = { position: THREE.Vector3; source: THREE.Vector3; normal?: THREE.Vector3 };
function data(): Data { return { positions: [], sources: [], normals: [], shells: [], uvs: [] }; }
function face(target: Data, a: Vertex, b: Vertex, c: Vertex, shell: number) {
  const normal = b.position.clone().sub(a.position).cross(c.position.clone().sub(a.position)).normalize();
  const uvs = [a, b, c].map(v => {
    const p = v.source.clone().normalize();
    return [0.5 + Math.atan2(p.z, p.x) / (Math.PI * 2), 0.5 + Math.asin(p.y) / Math.PI];
  });
  const seam = Math.max(...uvs.map(uv => uv[0])) - Math.min(...uvs.map(uv => uv[0])) > 0.5;
  [a, b, c].forEach((v, i) => {
    target.positions.push(v.position.x, v.position.y, v.position.z);
    target.sources.push(v.source.x, v.source.y, v.source.z);
    const n = v.normal ?? normal;
    target.normals.push(n.x, n.y, n.z);
    target.shells.push(shell);
    target.uvs.push(uvs[i][0] + (seam && uvs[i][0] < 0.5 ? 1 : 0), uvs[i][1]);
  });
}
function finish(target: Data) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(target.positions, 3));
  geometry.setAttribute("aSourcePosition", new THREE.Float32BufferAttribute(target.sources, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(target.normals, 3));
  geometry.setAttribute("aShell", new THREE.Float32BufferAttribute(target.shells, 1));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(target.uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

const key = (p: THREE.Vector3) => `${Math.round(p.x * 1000000)},${Math.round(p.y * 1000000)},${Math.round(p.z * 1000000)}`;
function radius(p: THREE.Vector3, small: boolean) {
  const seed = small ? 8.3 : 3.1;
  return 0.976 + 0.0013 * Math.sin(p.x * 32 + p.y * 14 + seed) * Math.sin(p.z * 27 - p.y * 19)
    + 0.0008 * Math.sin(p.y * 63 - p.z * 31 + seed) * Math.sin(p.x * 47 + p.z * 53);
}
function vertex(p: THREE.Vector3, offset: THREE.Vector3, small: boolean, inner = false): Vertex {
  const radial = p.clone().normalize();
  const r = inner ? 0.925 + 0.0015 * Math.sin(radial.x * 37 + radial.y * 23) * Math.sin(radial.z * 29) : radius(radial, small);
  const source = radial.clone().multiplyScalar(r);
  return { position: source.clone().add(offset), source, normal: radial };
}

type Edge = { a: THREE.Vector3; b: THREE.Vector3; count: number; offset: THREE.Vector3 };
function walls(target: Data, edges: Map<string, Edge>, small: boolean, fragmentThickness?: number) {
  let count = 0;
  for (const edge of edges.values()) {
    if (edge.count !== 1) continue;
    let a = vertex(edge.a, edge.offset, small), b = vertex(edge.b, edge.offset, small);
    for (let level = 1; level <= 3; level++) {
      const t = level / 3;
      const inner = (p: THREE.Vector3): Vertex => {
        const outerR = radius(p, small);
        const innerRadius = fragmentThickness === undefined ? 0.924 : outerR - fragmentThickness;
        const rough = Math.sin(p.x * 83 + p.y * 97 + p.z * 71 + level) * 0.0015 * Math.sin(t * Math.PI);
        const r = THREE.MathUtils.lerp(outerR, innerRadius, t) + rough;
        const source = p.clone().multiplyScalar(r);
        return { source, position: source.clone().add(edge.offset) };
      };
      const nextA = inner(edge.a), nextB = inner(edge.b);
      face(target, a, nextA, b, 0.2);
      face(target, b, nextA, nextB, 0.2);
      a = nextA; b = nextB; count += 2;
    }
  }
  return count;
}

function plateOffset(sample: Sample, small: boolean) {
  let id = 0;
  if (sample.q.x > sample.path) id = (sample.a > 0 ? 1 : sample.b > 0 ? 2 : 3) + (sample.side > 0 ? 3 : 0);
  const offsets = [new THREE.Vector3(-0.003, 0, 0), new THREE.Vector3(0.010, 0.006, 0.009),
    new THREE.Vector3(0.014, -0.001, 0.012), new THREE.Vector3(0.008, -0.009, 0.007),
    new THREE.Vector3(0.014, 0.007, 0.002), new THREE.Vector3(0.017, -0.002, 0.004),
    new THREE.Vector3(0.012, -0.008, 0.001)];
  const offset = offsets[id];
  if (small) { offset.x *= -1; offset.y *= -1; }
  return { id, offset };
}

type Chip = { center: THREE.Vector3; extent: number; thickness: number; drift: THREE.Vector3; rotation: THREE.Quaternion };
function chips(small: boolean): Chip[] {
  const random = (n: number) => { const v = Math.sin(n * 78.233 + (small ? 97.4 : 13.1)) * 43758.5453; return v - Math.floor(v); };
  return Array.from({ length: small ? 11 : 14 }, (_, i) => {
    const theta = 1.00 + random(i * 8 + 1) * 0.42;
    const phi = -1.03 + random(i * 8 + 2) * 1.90;
    const center = new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta));
    if (small) { center.x *= -1; center.y *= -1; }
    const extent = i < 3 ? 0.045 + random(i * 8 + 3) * 0.024 : 0.012 + random(i * 8 + 3) * 0.022;
    const drift = center.clone().multiplyScalar(0.055 + random(i * 8 + 4) * 0.11);
    // The source locations stay on the real crust, while tangential drift
    // gathers fragments into unequal groups instead of an evenly spaced ring.
    const targetY = (i % 3 === 0 ? 0.61 : i % 3 === 1 ? -0.53 : 0.06) * (small ? -1 : 1);
    drift.y += (targetY - center.y * 0.976) * (i < 3 ? 0.38 : 0.61);
    drift.x += (small ? -1 : 1) * random(i * 8 + 5) * (i < 3 ? 0.085 : 0.045);
    const tiltAxis = center.clone().cross(new THREE.Vector3(0, 0, 1)).normalize();
    const tilt = i < 3 ? 0.40 + random(i * 8 + 6) * 0.25 : 0.17 + random(i * 8 + 6) * 0.44;
    const rotation = new THREE.Quaternion().setFromAxisAngle(tiltAxis, tilt);
    rotation.multiply(new THREE.Quaternion().setFromAxisAngle(center, (random(i * 8 + 7) - 0.5) * 2.6));
    return { center, extent, thickness: 0.006 + extent * 0.35, drift, rotation };
  });
}
function inChip(p: THREE.Vector3, chip: Chip) {
  if (p.dot(chip.center) < Math.cos(chip.extent * 1.55)) return false;
  const tangent = new THREE.Vector3(-chip.center.y, chip.center.x, 0).normalize();
  const bitangent = chip.center.clone().cross(tangent);
  const u = p.dot(tangent), v = p.dot(bitangent), angle = Math.atan2(v, u);
  const phase = chip.center.x * 31 + chip.center.y * 17;
  const contour = 1 + 0.20 * Math.sin(angle * 3 + phase) + 0.11 * Math.sin(angle * 5 - phase * 0.7)
    + 0.065 * Math.sin(angle * 9 + phase * 1.3);
  return Math.hypot(u / 1.12, v / 0.91) < chip.extent * contour;
}

/** Original spherical crust shards; all surfaces retain their original material coordinates. */
export function createShatteredGeometries(small: boolean) {
  const sourceGeometry = new THREE.IcosahedronGeometry(1, 70);
  const positions = sourceGeometry.getAttribute("position");
  const crustData = data(), mantleData = data(), debrisData = data();
  const edges = new Map<string, Edge>();
  const pieces = chips(small);
  const debrisEdges = pieces.map(() => new Map<string, Edge>());
  const centers = pieces.map(piece => piece.center.clone().multiplyScalar(radius(piece.center, small)));
  const register = (map: Map<string, Edge>, a: THREE.Vector3, b: THREE.Vector3, offset: THREE.Vector3, region = 0) => {
    const ka = key(a), kb = key(b), id = `${region}/${ka < kb ? `${ka}/${kb}` : `${kb}/${ka}`}`;
    const previous = map.get(id);
    if (previous) previous.count++;
    else map.set(id, { a, b, count: 1, offset });
  };
  const driftVertex = (v: Vertex, index: number) => {
    const piece = pieces[index], center = centers[index];
    v.position.sub(center).applyQuaternion(piece.rotation).add(center).add(piece.drift);
    v.normal?.applyQuaternion(piece.rotation);
    return v;
  };
  const fragmentVertex = (p: THREE.Vector3, index: number, inner = false) => {
    const v = vertex(p, new THREE.Vector3(), small);
    if (inner) {
      const radial = p.clone().normalize();
      v.source = radial.multiplyScalar(radius(radial, small) - pieces[index].thickness);
      v.position.copy(v.source);
      v.normal?.negate();
    }
    return driftVertex(v, index);
  };
  const faultCache = new Map<string, number>();
  const fault = (p: THREE.Vector3) => {
    const id = key(p), previous = faultCache.get(id);
    if (previous !== undefined) return previous;
    const value = sampleFracture(p, small).fault;
    faultCache.set(id, value);
    return value;
  };
  const intersections = new Map<string, THREE.Vector3>();
  const intersection = (a: THREE.Vector3, b: THREE.Vector3) => {
    const ka = key(a), kb = key(b), id = ka < kb ? `${ka}/${kb}` : `${kb}/${ka}`;
    const previous = intersections.get(id);
    if (previous) return previous;
    // The same canonical edge and root are shared by adjacent triangles, so
    // clipped shells and their walls meet without cracks or doubled slivers.
    const start = ka < kb ? a : b, end = ka < kb ? b : a;
    let low = 0, high = 1, lowFault = fault(start), highFault = fault(end);
    for (let step = 0; step < 6; step++) {
      const middle = (low + high) * 0.5;
      const value = fault(start.clone().lerp(end, middle).normalize());
      if ((value >= 0) === (lowFault >= 0)) { low = middle; lowFault = value; }
      else { high = middle; highFault = value; }
    }
    const weight = THREE.MathUtils.clamp(lowFault / (lowFault - highFault), 0, 1);
    const point = start.clone().lerp(end, THREE.MathUtils.lerp(low, high, weight)).normalize();
    intersections.set(id, point);
    return point;
  };
  const clipShell = (polygon: THREE.Vector3[]) => {
    const result: THREE.Vector3[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const insideA = fault(a) >= 0, insideB = fault(b) >= 0;
      if (insideA) result.push(a);
      if (insideA !== insideB) result.push(intersection(a, b));
    }
    return result.filter((p, i) => p.distanceToSquared(result[(i + result.length - 1) % result.length]) > 1e-14);
  };
  const hiddenGaps = new Map<string, THREE.Vector3 | null>();
  const hiddenGap = (a: THREE.Vector3, b: THREE.Vector3) => {
    const fa = fault(a), fb = fault(b);
    if (fa <= 0 || fb <= 0 || Math.min(fa, fb) > a.distanceTo(b) * 1.8) return null;
    const ka = key(a), kb = key(b), id = ka < kb ? `${ka}/${kb}` : `${kb}/${ka}`;
    if (hiddenGaps.has(id)) return hiddenGaps.get(id)!;
    const start = ka < kb ? a : b, end = ka < kb ? b : a;
    let point: THREE.Vector3 | null = null, lowest = 0;
    for (const weight of [0.125, 0.25, 0.5, 0.75, 0.875]) {
      const candidate = start.clone().lerp(end, weight).normalize(), value = fault(candidate);
      if (value < lowest) { lowest = value; point = candidate; }
    }
    hiddenGaps.set(id, point);
    return point;
  };
  let surviving = 0, removed = 0, fragmentFaces = 0;
  const appendShell = (polygon: THREE.Vector3[]) => {
    if (polygon.length < 3) return;
    const center = polygon.reduce((sum, p) => sum.add(p), new THREE.Vector3()).normalize();
    const { id, offset } = plateOffset(sampleFracture(center, small), small);
    for (let i = 1; i < polygon.length - 1; i++) {
      face(crustData, vertex(polygon[0], offset, small), vertex(polygon[i], offset, small), vertex(polygon[i + 1], offset, small), 1);
      surviving++;
    }
    for (let i = 0; i < polygon.length; i++) register(edges, polygon[i], polygon[(i + 1) % polygon.length], offset, id);
  };
  for (let i = 0; i < positions.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(positions, i).normalize();
    const b = new THREE.Vector3().fromBufferAttribute(positions, i + 1).normalize();
    const c = new THREE.Vector3().fromBufferAttribute(positions, i + 2).normalize();
    const p = a.clone().add(b).add(c).normalize();
    const chip = pieces.findIndex(piece => inChip(p, piece));
    if (chip >= 0) {
      const zero = new THREE.Vector3();
      face(debrisData, fragmentVertex(a, chip), fragmentVertex(b, chip), fragmentVertex(c, chip), 1);
      face(debrisData, fragmentVertex(a, chip, true), fragmentVertex(c, chip, true), fragmentVertex(b, chip, true), 0.2);
      register(debrisEdges[chip], a, b, zero); register(debrisEdges[chip], b, c, zero); register(debrisEdges[chip], c, a, zero);
      removed++; fragmentFaces += 2;
      continue;
    }
    const original = [a, b, c], boundary: THREE.Vector3[] = [];
    for (let edge = 0; edge < 3; edge++) {
      boundary.push(original[edge]);
      const gap = hiddenGap(original[edge], original[(edge + 1) % 3]);
      if (gap) boundary.push(gap);
    }
    const before = surviving;
    // Only a thin crack that crosses a triangle's interior needs a local fan.
    // All other faces keep their original resolution and are linearly clipped
    // at the exact fracture function rather than removed as whole grid teeth.
    if (boundary.length > 3 || original.every(v => fault(v) > 0) && fault(p) < 0) {
      for (let edge = 0; edge < boundary.length; edge++) appendShell(clipShell([p, boundary[edge], boundary[(edge + 1) % boundary.length]]));
    } else appendShell(clipShell(original));
    if (surviving === before) removed++;
  }
  const wallFaces = walls(crustData, edges, small);
  debrisEdges.forEach((map, index) => {
    const raw = data();
    fragmentFaces += walls(raw, map, small, pieces[index].thickness);
    for (let i = 0; i < raw.shells.length; i += 3) {
      const vertices = [0, 1, 2].map(j => {
        const o = (i + j) * 3;
        return driftVertex({ position: new THREE.Vector3(...raw.positions.slice(o, o + 3) as [number, number, number]),
          source: new THREE.Vector3(...raw.sources.slice(o, o + 3) as [number, number, number]),
          normal: new THREE.Vector3(...raw.normals.slice(o, o + 3) as [number, number, number]) }, index);
      });
      face(debrisData, vertices[0], vertices[1], vertices[2], 0.2);
    }
  });
  sourceGeometry.dispose();
  const mantleSource = new THREE.IcosahedronGeometry(1, 49);
  const source = mantleSource.getAttribute("position"), zero = new THREE.Vector3();
  for (let i = 0; i < source.count; i += 3) {
    const points = [0, 1, 2].map(j => vertex(new THREE.Vector3().fromBufferAttribute(source, i + j), zero, small, true));
    face(mantleData, points[0], points[1], points[2], 0);
  }
  mantleSource.dispose();
  const crust = finish(crustData), mantle = finish(mantleData), debris = finish(debrisData);
  crust.userData = { survivingFaces: surviving, removedFaces: removed, wallFaces,
    plateCount: 7, circularRadius: 0.976, innerRadius: 0.925 };
  debris.userData = { curvedShellFragments: pieces.length, fragmentFaces };
  return { crust, mantle, debris };
}
