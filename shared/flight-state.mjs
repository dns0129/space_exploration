import world from "./world.json" with { type: "json" };
export { world };
const ids = new Set(world.bodies.map((body) => body.id));
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
    value.version !== 1 ||
    !vector(value.position, 3, 1e6) ||
    !vector(value.velocity, 3, world.boostSpeed * 2) ||
    !vector(value.orientation, 4, 1.01) ||
    !ids.has(value.target) ||
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
    Math.hypot(...value.velocity) > world.boostSpeed * 2
  )
    return null;
  return {
    version: 1,
    position: [...value.position],
    velocity: [...value.velocity],
    orientation: value.orientation.map((n) => n / norm),
    target: value.target,
    camera: value.camera,
    assist: value.assist,
    elapsed: value.elapsed,
  };
}
