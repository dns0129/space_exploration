/** Optical density is deliberately broader than aerodynamic density for a readable entry transition. */
export function atmosphereStrength(id: string) {
  return id === "mars" ? 0.55 : id === "venus" || id === "titan" ? 2.2 : 1.5;
}

/** Shared by the orbital shell and the local sky; all lengths use the caller's same unit. */
export const atmosphereScattering = /* glsl */ `
  vec4 scatterAtmosphere(vec3 up, float altitude, vec3 ray, float radius,
      float height, vec3 sunDirection, vec3 tint, float strength) {
    float radial = radius + altitude;
    float b = radial * dot(up, ray);
    float c = (altitude - height) * (2.0 * radius + altitude + height);
    float discriminant = b * b - c;
    if (discriminant <= 0.0) return vec4(0.0);
    float root = sqrt(discriminant);
    float entry = max(0.0, -b - root);
    float exitPoint = -b + root;
    // Stop scattering at the ground instead of coloring the planet's far side.
    float groundC = altitude * (2.0 * radius + altitude);
    float groundD = b * b - groundC;
    float groundRay = 0.0;
    if (b < 0.0 && groundD > 0.0) {
      float hit = groundC / (-b + sqrt(groundD));
      exitPoint = min(exitPoint, max(0.0, hit));
      groundRay = 1.0;
    }
    if (exitPoint <= entry) return vec4(0.0);
    float stepLength = (exitPoint - entry) / 8.0;
    float scaleHeight = height * 0.3;
    float optical = 0.0;
    vec3 scattered = vec3(0.0);
    float mu = dot(ray, sunDirection);
    float rayleigh = 0.72 * (1.0 + mu * mu);
    float forward = pow(max(mu, 0.0), 18.0) * 0.55;
    for (int i = 0; i < 8; i++) {
      float t = entry + (float(i) + 0.5) * stepLength;
      vec3 point = up * radial + ray * t;
      // Rationalized height stays stable within metres of a large planet.
      float h = max(0.0, (groundC + 2.0 * b * t + t * t) / (length(point) + radius));
      float density = exp(-h / scaleHeight) * stepLength / scaleHeight;
      density *= 1.0 - smoothstep(height * 0.72, height, h);
      float solarElevation = dot(normalize(point), sunDirection);
      float day = smoothstep(-0.16, 0.14, solarElevation);
      float sunset = exp(-solarElevation * solarElevation * 100.0);
      vec3 color = tint * rayleigh * mix(0.008, 1.0, day);
      color = mix(color, vec3(0.95, 0.32, 0.09) * (0.15 + day * 0.7), sunset * 0.65);
      color += vec3(1.0, 0.87, 0.68) * forward * day;
      float weight = (1.0 - exp(-density * strength * 1.8)) * exp(-optical * strength * 1.8);
      scattered += color * weight;
      optical += density;
    }
    float opacity = 1.0 - exp(-optical * strength * 1.8);
    // Normalize weighted color, keeping the night side dark while occluding distant stars.
    vec3 color = scattered / max(opacity, 0.000001);
    // Retain terrain contrast beneath aerial haze, especially when looking straight down.
    float groundHaze = 0.28 + 0.57 * (1.0 - abs(dot(up, ray)));
    opacity = mix(opacity, min(opacity, groundHaze), groundRay);
    return vec4(color, opacity);
  }
`;
