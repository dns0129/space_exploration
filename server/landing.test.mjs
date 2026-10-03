import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ShipDynamics, emptyInput } from "../src/ship-dynamics.ts";
import { world, validateFlightState } from "../shared/flight-state.mjs";
import { terrainHeightKm, surfaceProfile, LANDING_CLEARANCE_KM } from "../shared/surface.mjs";

function place(ship, id, clearanceKm, normal = new THREE.Vector3(0, 0, -1)) {
  ship.jump(id);
  const body = world.bodies.find((candidate) => candidate.id === id);
  const height = terrainHeightKm(id, normal.toArray()) + LANDING_CLEARANCE_KM;
  ship.position.fromArray(body.position).addScaledVector(normal, body.radius + (height + clearanceKm) / world.unitsKm);
  return body;
}
test("all solid worlds descend continuously, touch terrain, stay landed and restore a valid surface save", () => {
  for (const body of world.bodies.filter((candidate) => surfaceProfile(candidate.id).solid)) {
    const ship = new ShipDynamics();
    place(ship, body.id, 1);
    assert.equal(ship.startLanding(), null, body.id);
    let previous = ship.position.clone();
    let altitude = ship.environment.groundAltitudeKm;
    for (let i = 0; i < 1600 && ship.landingPhase !== "landed"; i++) {
      ship.step(0.05, emptyInput());
      const env = ship.environment;
      assert(env.groundAltitudeKm <= altitude + 1e-6);
      assert(ship.position.distanceTo(previous) * world.unitsKm <= 0.04);
      altitude = env.groundAltitudeKm;
      previous.copy(ship.position);
    }
    assert.equal(ship.landedBody, body.id);
    assert(ship.environment.groundAltitudeKm < 1e-6);
    assert.equal(ship.velocity.length(), 0);
    const saved = ship.snapshot();
    assert(validateFlightState(saved));
    ship.step(0.25, { ...emptyInput(), throttle: 1, roll: 1 });
    assert.deepEqual(ship.position.toArray(), saved.position);
    const restored = new ShipDynamics();
    assert(restored.restore(saved));
    assert.equal(restored.landingPhase, "landed");
    assert.deepEqual(restored.snapshot(), saved);
    assert.equal(restored.takeOff(), null);
    for (let i = 0; i < 1000 && restored.landingPhase === "ascending"; i++) restored.step(0.05, emptyInput());
    assert.equal(restored.landingPhase, "manual");
    assert(restored.environment.groundAltitudeKm >= 2);
    assert.equal(restored.landedBody, null);
    const takeoffHeight = restored.environment.groundAltitudeKm;
    restored.step(0.05, emptyInput());
    assert(restored.environment.groundAltitudeKm - takeoffHeight < 0.03, "takeoff must not jump to the old shield radius");
  }
});
test("landing rejects giant planets, the Sun, wrong targets and warp; manual input safely cancels descent", () => {
  const ship = new ShipDynamics();
  for (const id of ["sun", "jupiter", "saturn", "uranus", "neptune"]) {
    ship.jump(id);
    const before = ship.snapshot();
    assert(ship.startLanding());
    assert.deepEqual(ship.snapshot(), before);
  }
  place(ship, "earth", 1);
  ship.target = "mars";
  assert(ship.startLanding());
  ship.target = "earth";
  assert.equal(ship.startLanding(), null);
  assert(ship.startWarp());
  ship.step(0.05, { ...emptyInput(), brake: true });
  assert.equal(ship.landingPhase, "manual");
  assert.equal(ship.landedBody, null);
  assert(ship.environment.groundAltitudeKm > 0.9);
});
test("slow manual contact lands while fast contact still brakes without tunnelling", () => {
  const ship = new ShipDynamics();
  place(ship, "mars", 0.0002);
  ship.velocity.set(0, 0, 0.01 / world.unitsKm);
  ship.step(0.05, emptyInput());
  assert.equal(ship.landedBody, "mars");
  assert(ship.environment.groundAltitudeKm < 1e-6);
  const normal = ship.environment.outward;
  assert(new THREE.Vector3(0, 1, 0).applyQuaternion(ship.orientation).dot(normal) > 0.999);
  ship.step(0.05, { ...emptyInput(), lift: 1 });
  assert.equal(ship.landingPhase, "ascending");
});
test("density changes drag; unassisted near-surface flight feels gravity; malformed landed saves fail", () => {
  const air = new ShipDynamics(), vacuum = new ShipDynamics();
  place(air, "earth", 1);
  place(vacuum, "moon", 1);
  for (const ship of [air, vacuum]) {
    ship.assist = false;
    ship.velocity.set(0.1 / world.unitsKm, 0, 0);
  }
  air.step(0.25, emptyInput()); vacuum.step(0.25, emptyInput());
  assert(air.velocity.x < vacuum.velocity.x);
  assert(air.velocity.z > 0, "gravity points down toward Earth");
  assert(air.environment.density > 0);
  assert.equal(vacuum.environment.density, 0);
  const base = new ShipDynamics().snapshot();
  assert.equal(validateFlightState({ ...base, landedBody: "earth" }), null);
  assert.equal(validateFlightState({ ...base, landedBody: "jupiter" }), null);
  assert.equal(validateFlightState({ ...base, landedBody: "unknown" }), null);
  const earth = world.bodies.find(body => body.id === "earth");
  assert.equal(validateFlightState({ ...base, position: earth.position, landedBody: "earth" }), null);
});
