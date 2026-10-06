/** Optical density is deliberately broader than aerodynamic density for a readable entry transition. */
export function atmosphereStrength(id: string) {
  return id === "mars" ? 0.55 : id === "venus" || id === "titan" ? 2.2 : 1.5;
}

/** Local weather art is separate from orbital texture maps and collision density. */
export function atmosphereCloudProfile(id: string, atmosphereKm: number) {
  if (id === "earth") return { scale: 1, opacity: 1, coverage: 0, tint: "#ffffff" };
  if (id === "venus") return { scale: 3, opacity: 1, coverage: 0.22, tint: "#eed0a0" };
  if (id === "titan") return { scale: 2.2, opacity: 0.7, coverage: 0.12, tint: "#dbc3a2" };
  if (id === "proxima-b") return { scale: 0.8, opacity: 0.75, coverage: 0.08, tint: "#e7cdbd" };
  if (id === "proxima-c") return { scale: 3, opacity: 0.85, coverage: 0.1, tint: "#d3e6ed" };
  if (["jupiter", "saturn", "uranus", "neptune"].includes(id))
    return { scale: Math.max(3, Math.min(16, atmosphereKm / 100)), opacity: 0.95, coverage: 0.24, tint: "#eee4d3" };
  return { scale: 1, opacity: 0, coverage: 0, tint: "#ffffff" };
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
    // A broad molecular layer stays readable from orbit; the much lower aerosol
    // layer gives the horizon depth instead of turning the whole sky one colour.
    float scaleHeight = height * 0.3;
    float aerosolHeight = height * 0.052;
    float optical = 0.0;
    vec3 scattered = vec3(0.0);
    float mu = dot(ray, sunDirection);
    float rayleigh = 0.68 * (1.0 + mu * mu);
    float mie = 0.055 / pow(max(1.0 + 0.72 * 0.72 - 1.44 * mu, 0.07), 1.5);
    // Blue worlds retain a deeper zenith above their pale aerosol horizon;
    // orange dusty atmospheres keep their own profile instead of turning blue.
    float blueSky = smoothstep(1.1, 1.5, tint.b / max(tint.r, 0.02));
    vec3 molecularTint = tint * mix(vec3(1.0), vec3(0.54, 0.77, 1.06),
      smoothstep(0.1, 0.8, dot(up, ray)) * blueSky * 0.32);
    for (int i = 0; i < 8; i++) {
      float t = entry + (float(i) + 0.5) * stepLength;
      vec3 point = up * radial + ray * t;
      // Rationalized height stays stable within metres of a large planet.
      float h = max(0.0, (groundC + 2.0 * b * t + t * t) / (length(point) + radius));
      float molecular = exp(-h / scaleHeight);
      float aerosol = exp(-h / aerosolHeight) * 0.26;
      float density = (molecular + aerosol) * stepLength / scaleHeight;
      density *= 1.0 - smoothstep(height * 0.72, height, h);
      float solarElevation = dot(normalize(point), sunDirection);
      float horizonDip = sqrt(max(h * (2.0 * radius + h), 0.0)) / (radius + h);
      float day = smoothstep(-0.16 - horizonDip, 0.14, solarElevation);
      float sunset = exp(-pow((solarElevation + 0.035) * 7.0, 2.0));
      float lowLayer = aerosol / max(molecular + aerosol, 0.00001);
      vec3 molecularColor = molecularTint * rayleigh * mix(0.004, 1.0, day);
      vec3 aerosolColor = mix(tint * 0.72, vec3(0.9, 0.84, 0.75), lowLayer * 0.8);
      vec3 color = mix(molecularColor, aerosolColor * day, lowLayer * 0.6);
      // Longer paths at the terminator remove blue light before it reaches us.
      color = mix(color, vec3(1.0, 0.29, 0.065) * (0.09 + day * 0.76), sunset * 0.66);
      color += mix(vec3(1.0, 0.94, 0.82), vec3(1.0, 0.46, 0.16), sunset) * mie * day;
      color += tint * 0.012 * (1.0 - day) * exp(-h / (height * 0.4));
      float weight = (1.0 - exp(-density * strength * 1.8)) * exp(-optical * strength * 1.8);
      scattered += color * weight;
      optical += density;
    }
    float opacity = 1.0 - exp(-optical * strength * 1.8);
    // Normalize weighted color, keeping the night side dark while occluding distant stars.
    vec3 color = scattered / max(opacity, 0.000001);
    // Retain terrain contrast beneath aerial haze, especially when looking straight down.
    float groundHaze = 0.22 + 0.58 * (1.0 - abs(dot(up, ray)));
    opacity = mix(opacity, min(opacity, groundHaze), groundRay);
    return vec4(color, opacity);
  }
`;
