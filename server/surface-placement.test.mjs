import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ShipDynamics, emptyInput } from "../src/ship-dynamics.ts";
import { WalkingDynamics } from "../src/walking-dynamics.ts";
import { world, validateFlightState } from "../shared/flight-state.mjs";
import { surfaceProfile, terrainMapNormal, terrainHeightKm, LANDING_CLEARANCE_KM } from "../shared/surface.mjs";

test("direct placement on every solid body uses the chosen terrain and creates restorable ship and walking saves", () => {
  const bodies = world.bodies.filter(body => surfaceProfile(body.id).solid);
  assert.equal(bodies.length, 36);
  for (const body of bodies) {
    for (const uv of [[0.17, 0.61], [0.995, 0.32], [0.4, 1]]) {
      const normal = new THREE.Vector3().fromArray(terrainMapNormal(body.id, uv));
      const ship = new ShipDynamics();
      ship.velocity.set(1, 2, 3);
      ship.angularVelocity.set(0.2, 0.3, 0.4);
      ship.bank = 0.8;
      assert.equal(ship.placeOnSurface(body.id, normal.clone().multiplyScalar(3).toArray()), null, body.id);
      assert.equal(ship.landingPhase, "landed", body.id);
      assert.equal(ship.warpPhase, "ready", body.id);
      assert.equal(ship.landedBody, body.id);
      assert.equal(ship.target, body.id);
      assert.equal(ship.systemId, body.systemId ?? "solar");
      assert.equal(ship.camera, "chase");
      assert.equal(ship.velocity.length(), 0);
      assert.equal(ship.angularVelocity.length(), 0);
      assert.equal(ship.bank, 0);
      const radial = ship.position.clone().sub(new THREE.Vector3().fromArray(body.position));
      const radialErrorM = radial.clone().normalize().distanceTo(normal) * body.radius * world.unitsKm * 1000;
      assert(radialErrorM < 0.01, `${body.id} keeps the chosen radial within AU-coordinate precision`);
      const expectedHeight = terrainHeightKm(body.id, radial.clone().normalize().toArray()) + LANDING_CLEARANCE_KM;
      const actualHeight = (radial.length() - body.radius) * world.unitsKm;
      assert(Math.abs(actualHeight - expectedHeight) < 1e-5, `${body.id} sits on collision terrain`);
      assert(new THREE.Vector3(0, 1, 0).applyQuaternion(ship.orientation).dot(normal) > 1 - 1e-8);
      const saved = ship.snapshot();
      assert(validateFlightState(saved), `${body.id} ship save is valid`);
      ship.step(0.25, { ...emptyInput(), throttle: 1, yaw: 1, roll: 1 });
      assert.deepEqual(ship.position.toArray(), saved.position, `${body.id} stays parked`);
      const walker = new WalkingDynamics();
      assert.equal(walker.disembark(ship), null, body.id);
      assert(walker.active && walker.grounded, `${body.id} starts grounded`);
      assert.equal(walker.bodyId, body.id);
      assert(Math.abs(walker.groundClearanceM) < 0.01, `${body.id} astronaut feet match terrain`);
      const walking = { ...walker.snapshot(), camera: "third" };
      assert(validateFlightState({ ...saved, walking }), `${body.id} walking save is valid`);
      const restoredShip = new ShipDynamics();
      assert(restoredShip.restore(saved));
      assert.equal(restoredShip.landedBody, body.id);
      const restoredWalker = new WalkingDynamics();
      restoredWalker.restore(walking, restoredShip);
      assert(restoredWalker.active && restoredWalker.grounded, `${body.id} restores grounded exploration`);
      assert.equal(restoredWalker.bodyId, body.id);
      assert(Math.abs(restoredWalker.groundClearanceM) < 0.01);
      restoredWalker.reset();
      assert.equal(restoredShip.takeOff(), null, body.id);
      restoredShip.step(0.25, emptyInput());
      assert.equal(restoredShip.landingPhase, "ascending", body.id);
      assert.equal(restoredShip.landedBody, null);
      assert(restoredShip.environment.groundAltitudeKm > 0, `${body.id} takes off without an orbital jump`);
    }
  }
});

test("unsupported bodies and malformed surface locations do not mutate the flight", () => {
  const ship = new ShipDynamics();
  ship.velocity.set(0.1, 0.2, 0.3);
  ship.angularVelocity.set(0.2, 0.3, 0.4);
  ship.bank = 0.6;
  const unchanged = (id, radial) => {
    const state = ship.snapshot();
    const angularVelocity = ship.angularVelocity.toArray();
    const bank = ship.bank;
    assert(ship.placeOnSurface(id, radial), `${id} rejects invalid placement`);
    assert.deepEqual(ship.snapshot(), state);
    assert.deepEqual(ship.angularVelocity.toArray(), angularVelocity);
    assert.equal(ship.bank, bank);
  };
  for (const body of world.bodies.filter(body => !surfaceProfile(body.id).solid)) unchanged(body.id, [0, 1, 0]);
  unchanged("missing-body", [0, 1, 0]);
  for (const radial of [null, undefined, [], [1, 2], [1, 2, 3, 4], [0, 0, 0],
    [NaN, 1, 0], [Infinity, 0, 0], [1, "2", 3], [Number.MAX_VALUE, Number.MAX_VALUE, 0]])
    unchanged("earth", radial);
});
