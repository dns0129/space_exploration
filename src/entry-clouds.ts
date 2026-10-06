/** Kilometre-scale local cloud volume. Coordinates stay in the planet's collision frame. */
export const entryClouds = /* glsl */ `
  float entryHash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  // The eight corner hashes produce both value and analytic gradient; normals
  // therefore reuse the existing billow sample instead of adding noise calls.
  vec4 entryNoiseGradient(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 derivative = 6.0 * f * (1.0 - f);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = entryHash(i), n100 = entryHash(i + vec3(1, 0, 0));
    float n010 = entryHash(i + vec3(0, 1, 0)), n110 = entryHash(i + vec3(1, 1, 0));
    float n001 = entryHash(i + vec3(0, 0, 1)), n101 = entryHash(i + vec3(1, 0, 1));
    float n011 = entryHash(i + vec3(0, 1, 1)), n111 = entryHash(i + vec3(1, 1, 1));
    float x00 = mix(n000, n100, f.x), x10 = mix(n010, n110, f.x);
    float x01 = mix(n001, n101, f.x), x11 = mix(n011, n111, f.x);
    float low = mix(x00, x10, f.y), high = mix(x01, x11, f.y);
    float dx = mix(mix(n100 - n000, n110 - n010, f.y),
      mix(n101 - n001, n111 - n011, f.y), f.z);
    float dy = mix(x10 - x00, x11 - x01, f.z);
    return vec4(mix(low, high, f.z), vec3(dx, dy, high - low) * derivative);
  }
  float entryNoise(vec3 p) { return entryNoiseGradient(p).x; }
  vec4 scatterEntryClouds(vec3 up, float altitude, vec3 ray, float radius,
      vec3 sunDirection, float time) {
    // This is only the bounding shell. The cloud tops themselves billow between
    // 10.5 and 15.5 km, and all density fades smoothly above the 7.8 km base.
    float top = 16.0, base = 7.8;
    float radial = radius + altitude;
    float b = radial * dot(up, ray);
    float c = (altitude - top) * (2.0 * radius + altitude + top);
    float d = b * b - c;
    if (d <= 0.0) return vec4(0.0);
    float entry = max(0.0, -b - sqrt(d));
    float exitPoint = -b + sqrt(d);
    float groundC = altitude * (2.0 * radius + altitude);
    float groundD = b * b - groundC;
    if (b < 0.0 && groundD > 0.0) {
      exitPoint = min(exitPoint, groundC / (-b + sqrt(groundD)));
    }
    // Beyond this range the global cloud shell supplies the distant cloud deck.
    exitPoint = min(exitPoint, entry + 420.0);
    if (exitPoint <= entry) return vec4(0.0);
    float stepLength = (exitPoint - entry) / 6.0;
    float transmission = 1.0;
    vec3 light = vec3(0.0);
    float forward = pow(max(dot(ray, sunDirection), 0.0), 14.0);
    for (int i = 0; i < 6; i++) {
      // At most 2.5% of the remaining light can contribute beyond a dense bank.
      if (transmission < 0.025) break;
      float t = entry + (float(i) + 0.5) * stepLength;
      vec3 point = up * radial + ray * t;
      float h = (groundC + 2.0 * b * t + t * t) / (length(point) + radius);
      if (h > base && h < top) {
        vec3 p = point * 0.023 + vec3(time * 0.0007, 0.0, time * 0.0003);
        float weather = entryNoise(p);
        vec4 billowSample = entryNoiseGradient(p * 3.9 + vec3(17.2, 4.1, 11.8));
        float billow = billowSample.x;
        float wisp = entryNoise(p * 10.7 + vec3(3.8, 7.4, 1.3));
        float localTop = 10.5 + weather * 4.0 + billow;
        float shape = smoothstep(base, base + 1.1, h)
          * (1.0 - smoothstep(localTop - 1.2, localTop, h));
        float density = smoothstep(0.5, 0.76, weather * 0.60 + billow * 0.31 + wisp * 0.09) * shape;
        float alpha = 1.0 - exp(-density * stepLength * 0.42);
        vec3 radialUp = normalize(point);
        float solarElevation = dot(radialUp, sunDirection);
        float day = smoothstep(-0.13, 0.16, solarElevation);
        float sunset = exp(-pow((solarElevation + 0.02) * 8.0, 2.0));
        float topLight = smoothstep(base, localTop, h);
        // Rounded density gradients face the star differently on each billow.
        // This optical normal is artistic; no extra shadow ray or texture is used.
        vec3 cloudNormal = normalize(radialUp * 0.82 - billowSample.yzw * 0.65);
        float diffuse = max(dot(cloudNormal, sunDirection), 0.0);
        float sculpted = (0.53 + diffuse * 0.47) * (0.73 + topLight * 0.27);
        vec3 color = mix(vec3(0.009, 0.014, 0.026), vec3(0.87, 0.93, 1.0), day);
        color *= sculpted + (1.0 - density) * forward * 0.62;
        color = mix(color, vec3(1.0, 0.48, 0.2) * (0.15 + day * 0.65), sunset * 0.64);
        light += color * alpha * transmission;
        transmission *= 1.0 - alpha;
      }
    }
    float opacity = 1.0 - transmission;
    return vec4(light / max(opacity, 0.00001), opacity);
  }
`;
