import world from "./world.json" with { type: "json" };
import { surfaceProfile, terrainHeightKm, LANDING_CLEARANCE_KM } from "./surface.mjs";
export { world };
const systemIds = new Set(world.systems.map(system => system.id));
const ids = new Set(world.bodies.map((body) => body.id));
// Stage 03 used a compressed world. Re-anchor old saves relative to their destination.
const legacy = {
  sun: [8, [0, 0, 0]], mercury: [0.4, [14, 0, 13]], venus: [0.95, [-28, 1, 4]],
  earth: [1, [0, 0, 42]], mars: [0.58, [41, 1, -38]], jupiter: [5.4, [-79, -3, -47]],
  saturn: [4.6, [78, 4, 96]], uranus: [2.5, [-147, 5, 65]], neptune: [2.45, [80, -4, -180]],
};
const vector = (value, count, bound) =>
  Array.isArray(value) &&
  value.length === count &&
  value.every(
    (n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= bound,
  );
// Layout 1 placed every planet in the ecliptic. Preserve local ship/terrain
// offsets near moved bodies, including landed and walking saves. Deep-space
// positions retain their absolute coordinates. Current saves carry the layout
// version so a normalized save can never be translated twice.
function migrateLayoutPosition(value, position) {
  if (value.version !== 2 || (value.worldLayoutVersion ?? 1) >= (world.layoutVersion ?? 1)) return position;
  const bodies = world.bodies.filter(body => (body.systemId ?? "solar") === (value.systemId ?? "solar"));
  const distanceTo = (body, previous) => Math.hypot(...position.map((n, i) => n - (previous ? body.previousPosition ?? body.position : body.position)[i]));
  const anchor = value.landedBody ? bodies.find(body => body.id === value.landedBody)
    : bodies.reduce((nearest, body) => !nearest || distanceTo(body, true) - body.radius < distanceTo(nearest, true) - nearest.radius ? body : nearest, undefined);
  if (!anchor?.previousPosition) return position;
  const oldDistance = distanceTo(anchor, true);
  const currentDistance = Math.min(...bodies.map(body => distanceTo(body, false) - body.radius));
  if (oldDistance - anchor.radius >= currentDistance
    || (!value.landedBody && oldDistance - anchor.radius > Math.max(1e6 / world.unitsKm, anchor.radius * 20))) return position;
  return position.map((n, i) => anchor.position[i] + (n - anchor.previousPosition[i]));
}
// Keep walking saves in the ship's metre-scale frame; never subtract two AU-scale character positions.
export function validateWalkingState(value, flight, config = world) {
  if (!value || typeof value !== "object" || !flight || value.bodyId !== flight.landedBody
    || !vector(value.offsetM, 3, 1e6) || Math.hypot(...value.offsetM) > 1e6
    || !vector(value.velocityMps, 3, 60) || Math.hypot(...value.velocityMps) > 60
    || !vector(value.orientation, 4, 1.01)
    || typeof value.pitch !== "number" || !Number.isFinite(value.pitch) || Math.abs(value.pitch) > 1.35
    || typeof value.grounded !== "boolean"
    || (value.camera !== undefined && !["first", "third"].includes(value.camera))
    || !vector(flight.position, 3, 1e12) || !vector(flight.velocity, 3, 1e12)
    || Math.hypot(...flight.velocity) > 1e-9) return null;
  const body = config.bodies.find(candidate => candidate.id === value.bodyId);
  if (!body || !surfaceProfile(body.id).solid || body.kind === "star" || body.kind === "station"
    || (body.systemId ?? "solar") !== (flight.systemId ?? "solar")) return null;
  const norm = Math.hypot(...value.orientation);
  if (norm < 0.95 || norm > 1.05) return null;
  const meters = config.unitsKm * 1000;
  const anchorRadial = flight.position.map((n, i) => (n - body.position[i]) * meters);
  const anchorDistance = Math.hypot(...anchorRadial);
  if (!anchorDistance) return null;
  const landingRadius = body.radius * meters
    + (terrainHeightKm(body.id, anchorRadial.map(n => n / anchorDistance)) + LANDING_CLEARANCE_KM) * 1000;
  if (Math.abs(anchorDistance - landingRadius) > 0.1) return null;
  const radial = anchorRadial.map((n, i) => n + value.offsetM[i]);
  const distance = Math.hypot(...radial);
  if (!distance) return null;
  const normal = radial.map(n => n / distance);
  const clearance = distance - body.radius * meters - terrainHeightKm(body.id, normal) * 1000;
  // 1.5 cm allows the landing anchor's floating-point round-off even at Neptune.
  if (clearance < -0.015 || clearance > 2000
    || (value.grounded && (Math.abs(clearance) > 0.015
      || Math.abs(value.velocityMps.reduce((sum, n, i) => sum + n * normal[i], 0)) > 0.1))) return null;
  return {
    bodyId: value.bodyId,
    offsetM: [...value.offsetM],
    velocityMps: [...value.velocityMps],
    orientation: value.orientation.map(n => n / norm),
    pitch: value.pitch,
    grounded: value.grounded,
    ...(value.camera !== undefined ? { camera: value.camera } : {}),
  };
}
export function validateFlightState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    ![1, 2].includes(value.version) ||
    (value.worldLayoutVersion !== undefined && ![1, world.layoutVersion ?? 1].includes(value.worldLayoutVersion)) ||
    !vector(value.position, 3, value.version === 1 ? 1e6 : 1e12) ||
    !vector(value.velocity, 3, value.version === 1 ? 120 : world.boostSpeed * 2) ||
    !vector(value.orientation, 4, 1.01) ||
    !ids.has(value.target) ||
    (value.systemId !== undefined && !systemIds.has(value.systemId)) ||
    (value.escapeBody !== undefined && !ids.has(value.escapeBody)) ||
    (value.engineMode !== undefined && !["standard", "interstellar"].includes(value.engineMode)) ||
    (value.atmosphericSpeedMps !== undefined && (typeof value.atmosphericSpeedMps !== "number"
      || !Number.isFinite(value.atmosphericSpeedMps) || value.atmosphericSpeedMps < 1 || value.atmosphericSpeedMps > 1000)) ||
    !["cockpit", "chase"].includes(value.camera) ||
    typeof value.assist !== "boolean" ||
    typeof value.elapsed !== "number" ||
    !Number.isFinite(value.elapsed) ||
    value.elapsed < 0 ||
    value.elapsed > 1e12
  )
    return null;
  const norm = Math.hypot(...value.orientation);
  if (
    norm < 0.95 ||
    norm > 1.05 ||
    Math.hypot(...value.velocity) > (value.version === 1 ? 120 : world.boostSpeed * 2)
  )
    return null;
  const body = world.bodies.find((b) => b.id === value.target);
  const old = legacy[value.target];
  if (value.version === 1 && (!old || (value.systemId && value.systemId !== "solar"))) return null;
  const position = value.version === 1
    ? value.position.map((n, i) => body.position[i] + (n - old[1][i]) / old[0] * body.radius)
    : migrateLayoutPosition(value, [...value.position]);
  if (!vector(position, 3, 1e12)) return null;
  if (value.landedBody !== undefined) {
    const ground = world.bodies.find((b) => b.id === value.landedBody);
    if (value.version !== 2 || !ground || ground.kind === "star" || !surfaceProfile(ground.id).solid
      || (ground.systemId ?? "solar") !== (value.systemId ?? "solar") || Math.hypot(...value.velocity) > 1e-9) return null;
    const offset = position.map((n, i) => n - ground.position[i]);
    const distance = Math.hypot(...offset);
    if (distance === 0) return null;
    const altitude = (distance - ground.radius) * world.unitsKm;
    const height = terrainHeightKm(ground.id, offset.map((n) => n / distance)) + LANDING_CLEARANCE_KM;
    if (Math.abs(altitude - height) > 0.0001) return null;
  }
  const walking = value.walking === undefined ? undefined : validateWalkingState(value.walking, {
    position, velocity: value.velocity, landedBody: value.landedBody, systemId: value.systemId ?? "solar",
  });
  if (value.walking !== undefined && (value.version !== 2 || !walking)) return null;
  return {
    version: 2,
    worldLayoutVersion: world.layoutVersion ?? 1,
    ...(value.landedBody ? { landedBody: value.landedBody } : {}),
    ...(walking ? { walking } : {}),
    systemId: value.version === 1 ? "solar" : value.systemId ?? "solar",
    ...(value.version === 2 && ids.has(value.escapeBody) ? { escapeBody: value.escapeBody } : {}),
    engineMode: value.version === 2 ? value.engineMode ?? "standard" : "standard",
    atmosphericSpeedMps: value.version === 2 ? value.atmosphericSpeedMps ?? 1000 : 1000,
    position,
    velocity: value.version === 1 ? [0, 0, 0] : [...value.velocity],
    orientation: value.orientation.map((n) => n / (Math.abs(norm - 1) < 1e-10 ? 1 : norm)),
    target: value.target,
    camera: value.camera,
    assist: value.assist,
    elapsed: value.elapsed,
  };
}
