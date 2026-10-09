/** Shared, fixed celestial directions for the sky and its locally lensed image. */
export const blackHoleSky = /* glsl */ `
  float bhStarHash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }

  vec3 bhStars(vec2 uv, vec2 dx, vec2 dy, vec2 gridSize, float seed, float density, float gain) {
    vec2 grid = uv * gridSize;
    vec2 cell = floor(grid);
    float latitudeScale = max(cos((uv.y - 0.5) * 3.14159265359), 0.035);
    float present = step(bhStarHash(cell + seed), density * latitudeScale);
    vec2 center = vec2(bhStarHash(cell + seed + 11.3), bhStarHash(cell + seed + 53.7)) * 0.48 + 0.26;
    vec2 offset = (fract(grid) - center) * vec2(latitudeScale, 1.0);
    float pixel = max(length(dx * gridSize * vec2(latitudeScale, 1.0)),
                      length(dy * gridSize * vec2(latitudeScale, 1.0)));
    float magnitude = bhStarHash(cell + seed + 137.0);
    float intrinsic = mix(0.008, 0.019, pow(magnitude, 7.0));
    float radius = max(intrinsic, pixel * 0.5);
    // Filter unresolved pinpoints by their angular footprint, conserving energy
    // instead of turning small stars into bright, coarse squares at a lens edge.
    float energy = min(1.0, intrinsic * intrinsic / max(radius * radius, 0.000001));
    float core = exp(-dot(offset, offset) / (radius * radius));
    float temperature = bhStarHash(cell + seed + 303.0);
    vec3 tint = mix(vec3(0.78, 0.85, 1.0), vec3(1.0, 0.86, 0.70), temperature);
    return tint * core * energy * present * gain * mix(0.3, 1.0, pow(magnitude, 3.0));
  }

  vec3 blackHoleStarField(vec3 direction) {
    direction = normalize(direction);
    vec2 uv = vec2(atan(direction.z, direction.x) / 6.28318530718 + 0.5,
                   asin(clamp(direction.y, -1.0, 1.0)) / 3.14159265359 + 0.5);
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    dx.x -= floor(dx.x + 0.5);
    dy.x -= floor(dy.x + 0.5);
    // No dust glow or animated twinkle. This is a sparse artistic star field,
    // not an astrometric catalogue or a simulated gravitational source plane.
    return bhStars(uv, dx, dy, vec2(420.0, 210.0), 291.7, 0.018, 1.2)
      + bhStars(uv, dx, dy, vec2(1120.0, 560.0), 513.1, 0.0035, 0.30);
  }
`;
