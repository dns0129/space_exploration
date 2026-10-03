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
export function validateFlightState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    ![1, 2].includes(value.version) ||
    !vector(value.position, 3, value.version === 1 ? 1e6 : 1e12) ||
    !vector(value.velocity, 3, value.version === 1 ? 120 : world.boostSpeed * 2) ||
    !vector(value.orientation, 4, 1.01) ||
    !ids.has(value.target) ||
    (value.systemId !== undefined && !systemIds.has(value.systemId)) ||
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
    : [...value.position];
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
  return {
    version: 2,
    ...(value.landedBody ? { landedBody: value.landedBody } : {}),
    systemId: value.version === 1 ? "solar" : value.systemId ?? "solar",
    ...(value.version === 2 && ids.has(value.escapeBody) ? { escapeBody: value.escapeBody } : {}),
    position,
    velocity: value.version === 1 ? [0, 0, 0] : [...value.velocity],
    orientation: value.orientation.map((n) => n / (Math.abs(norm - 1) < 1e-10 ? 1 : norm)),
    target: value.target,
    camera: value.camera,
    assist: value.assist,
    elapsed: value.elapsed,
  };
}
