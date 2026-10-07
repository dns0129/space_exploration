import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ShipDynamics, emptyInput } from "../src/ship-dynamics.ts";
import { world, validateFlightState } from "../shared/flight-state.mjs";
import { terrainHeightKm, surfaceProfile, LANDING_CLEARANCE_KM } from "../shared/surface.mjs";
import { mappedMountainNormal } from "./terrain-fixtures.mjs";

function place(ship, id, clearanceKm, normal = new THREE.Vector3(0, 0, -1)) {
  ship.jump(id);
  const body = world.bodies.find((candidate) => candidate.id === id);
  const height = terrainHeightKm(id, normal.toArray()) + LANDING_CLEARANCE_KM;
  ship.position.fromArray(body.position).addScaledVector(normal, body.radius + (height + clearanceKm) / world.unitsKm);
  return body;
}
test("Earth's 100 km entry uses the same kilometre shell as the sky, with thin aerodynamic density", () => {
  const ship = new ShipDynamics();
  const earth = world.bodies.find(body => body.id === "earth");
  ship.jump("earth");
  for (const altitude of [20, 100, 159.9, 160.1, 500]) {
    ship.position.fromArray(earth.position).add(new THREE.Vector3(0, 0, -earth.radius - altitude / world.unitsKm));
    assert(Math.abs(ship.environment.altitudeKm - altitude) < 0.000001);
    assert.equal(ship.environment.atmospheric, altitude < 160);
    if (altitude === 100) {
      assert(ship.environment.density > 0 && ship.environment.density < 0.001);
      ship.target = "mars";
      assert.equal(ship.startWarp(), null, "visual atmosphere entry must not impose a warp altitude restriction");
      ship.cancelWarp();
    }
  }
});
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
    assert.equal(saved.worldLayoutVersion, world.layoutVersion ?? 1);
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
    const takeoffSpeedKm = restored.velocity.length() * world.unitsKm;
    restored.step(0.05, emptyInput());
    assert(restored.environment.groundAltitudeKm - takeoffHeight <= takeoffSpeedKm * 0.05 + 1e-6,
      "takeoff must continue from its actual velocity instead of jumping to the old shield radius");
  }
});
test("automatic descent crosses the atmosphere at high speed, aligns and slows continuously before touching terrain", () => {
  const ship = new ShipDynamics();
  place(ship, "earth", 200);
  ship.setCruiseSpeed(250);
  ship.setEngineMode("interstellar");
  ship.orientation.setFromEuler(new THREE.Euler(0.7, -0.4, 0.9));
  assert(new THREE.Vector3(0, 1, 0).applyQuaternion(ship.orientation).dot(ship.environment.outward) < 0.99);
  assert.equal(ship.startLanding(), null);
  let previous = ship.position.clone(), enteredAtmosphere = false, fastAtmosphericSteps = 0, slowApproach = false;
  for (let i = 0; i < 1200 && ship.landingPhase !== "landed"; i++) {
    const before = ship.environment;
    ship.step(0.05, emptyInput());
    const after = ship.environment;
    const speedKm = ship.velocity.length() * world.unitsKm;
    const travelledKm = ship.position.distanceTo(previous) * world.unitsKm;
    assert(speedKm <= 250 + 1e-8);
    assert(travelledKm <= 250 * 0.05 + 1e-6);
    assert(Math.abs(travelledKm - (before.groundAltitudeKm - after.groundAltitudeKm)) < 1e-6);
    assert.equal(ship.engine.id, "interstellar");
    assert.equal(ship.cruiseSpeedKm, 250);
    assert(new THREE.Vector3(0, 1, 0).applyQuaternion(ship.orientation).dot(after.outward) > 0.999,
      "automatic landing must retain surface alignment");
    if (!before.atmospheric && after.atmospheric) {
      enteredAtmosphere = true;
      assert(travelledKm > 1, "entering the atmosphere must not apply the former 1 km/s cap");
    }
    if (after.atmospheric && speedKm > 100) fastAtmosphericSteps++;
    if (after.groundAltitudeKm < 1 && ship.landingPhase !== "landed") {
      slowApproach = true;
      assert(speedKm > 0 && speedKm < 1, "landing safety may decelerate below the selectable cruise minimum");
    }
    assert(after.groundAltitudeKm <= before.groundAltitudeKm + 1e-6);
    previous.copy(ship.position);
  }
  assert(enteredAtmosphere);
  assert(fastAtmosphericSteps > 1, "descent must sustain speeds above 100 km/s inside the atmosphere");
  assert(slowApproach);
  assert.equal(ship.landingPhase, "landed");
  assert.equal(ship.landedBody, "earth");
  assert.equal(ship.velocity.length(), 0);
  assert(ship.environment.groundAltitudeKm < 1e-6);
});

test("automatic descent obeys the user's cruise ceiling and preserves it in airless and atmospheric saves", () => {
  for (const id of ["earth", "moon"]) {
    for (const selectedKm of [100, 250, 1000, 100000]) {
      const ship = new ShipDynamics();
      place(ship, id, 4000);
      ship.setCruiseSpeed(selectedKm);
      ship.setEngineMode("atmospheric");
      assert.equal(ship.startLanding(), null);
      for (let i = 0; i < 3; i++) {
        const previous = ship.position.clone();
        ship.step(0.05, emptyInput());
        const speedKm = ship.velocity.length() * world.unitsKm;
        assert(speedKm <= selectedKm + 1e-8);
        assert(ship.position.distanceTo(previous) * world.unitsKm <= selectedKm * 0.05 + 1e-6);
        assert.equal(ship.engine.id, "atmospheric");
        if (selectedKm <= 1000) {
          assert(Math.abs(speedKm - selectedKm) < 1e-8,
            `${id}: a distant descent must actually reach the selected ${selectedKm} km/s ceiling`);
        } else {
          assert(speedKm > 1000, "the selected atmospheric engine must not impose its former speed limit");
          if (i === 0) assert(speedKm > 2500, "automatic descent must not retain the former 2500 km/s engineering ceiling");
        }
      }
      const saved = ship.snapshot();
      assert(validateFlightState(saved));
      assert.equal(saved.cruiseSpeedKm, selectedKm);
      const restored = new ShipDynamics();
      assert(restored.restore(saved));
      assert.deepEqual(restored.snapshot(), saved);
      assert.equal(restored.engine.id, "atmospheric");
    }
  }
});

test("automatic near-terrain descent and takeoff safely use speeds below the user's minimum selectable cruise ceiling", () => {
  for (const id of ["earth", "moon"]) {
    for (const selectedKm of [100, 1000]) {
      const ship = new ShipDynamics();
      place(ship, id, 0.5);
      ship.setCruiseSpeed(selectedKm);
      ship.setEngineMode("planetary");
      assert.equal(ship.startLanding(), null);
      let previousSpeedKm = 1, slowed = false;
      for (let i = 0; i < 1000 && ship.landingPhase !== "landed"; i++) {
        const before = ship.environment;
        const previous = ship.position.clone();
        ship.step(0.05, emptyInput());
        const speedKm = ship.velocity.length() * world.unitsKm;
        const after = ship.environment;
        assert(speedKm < 1);
        assert(speedKm <= previousSpeedKm + 1e-8);
        assert(ship.position.distanceTo(previous) * world.unitsKm <= previousSpeedKm * 0.05 + 1e-6);
        assert(after.groundAltitudeKm <= before.groundAltitudeKm + 1e-6);
        if (speedKm < 0.05 && speedKm > 0) slowed = true;
        previousSpeedKm = speedKm;
      }
      assert(slowed, `${id}: approach must slow before contact`);
      assert.equal(ship.landedBody, id);
      assert.equal(ship.velocity.length(), 0);
      assert(ship.environment.groundAltitudeKm < 1e-6);
      const saved = ship.snapshot();
      const restored = new ShipDynamics();
      assert(restored.restore(saved));
      assert.deepEqual(restored.snapshot(), saved);
      assert.equal(restored.takeOff(), null);
      let climbedAboveOldCap = false;
      for (let i = 0; i < 1000 && restored.landingPhase === "ascending"; i++) {
        const previous = restored.position.clone();
        const previousSpeedKm = restored.velocity.length() * world.unitsKm;
        restored.step(0.05, emptyInput());
        const speedKm = restored.velocity.length() * world.unitsKm;
        assert(speedKm > 0 && speedKm < 100);
        if (speedKm > 0.5) climbedAboveOldCap = true;
        assert(restored.position.distanceTo(previous) * world.unitsKm <= Math.max(previousSpeedKm, speedKm) * 0.05 + 1e-6);
        assert.equal(restored.engine.id, "planetary");
        assert.equal(restored.cruiseSpeedKm, selectedKm);
      }
      assert.equal(restored.landingPhase, "manual");
      assert(restored.environment.groundAltitudeKm >= 2);
      assert(climbedAboveOldCap, "automatic takeoff must not retain the former 0.5 km/s engineering ceiling");
    }
  }
});

test("automatic mountain descent crosses the former 10 km boundary without changing the user's engine or speed ceiling", () => {
  const normal = mappedMountainNormal();
  assert(terrainHeightKm("earth", normal.toArray()) > 4,
    "use a mountain where the old 10 km ground boundary lies above the radial shell");
  for (const engineId of ["atmospheric", "orbital", "planetary", "interstellar"]) {
    const ship = new ShipDynamics();
    place(ship, "earth", 11.125, normal);
    ship.setCruiseSpeed(100);
    assert.equal(ship.setEngineMode(engineId), null);
    assert.equal(ship.startLanding(), null);
    let crossed = false, lowSteps = 0;
    for (let i = 0; i < 30 && lowSteps < 10; i++) {
      const before = ship.environment;
      const previous = ship.position.clone();
      const previousSpeedKm = ship.velocity.length() * world.unitsKm;
      ship.step(0.05, emptyInput());
      const after = ship.environment;
      const travelledKm = ship.position.distanceTo(previous) * world.unitsKm;
      const speedKm = ship.velocity.length() * world.unitsKm;
      assert(before.atmospheric && after.atmospheric);
      assert(after.groundAltitudeKm <= before.groundAltitudeKm + 1e-6);
      assert(Math.abs(travelledKm - (before.groundAltitudeKm - after.groundAltitudeKm)) < 1e-6,
        "each position change must match the continuous altitude change");
      assert.equal(ship.engine.id, engineId);
      assert.equal(ship.cruiseSpeedKm, 100);
      assert(speedKm > 1 && speedKm <= 100);
      assert(travelledKm <= 100 * 0.05 + 1e-6);
      if (before.groundAltitudeKm > 10 && after.groundAltitudeKm <= 10) {
        crossed = true;
        assert(after.altitudeKm > 14,
          "the former ground boundary must be tested independently of radial altitude");
        assert(speedKm > previousSpeedKm * 0.9, "crossing 10 km must not introduce an artificial slowdown");
        assert(travelledKm > 0.05, "the former low-altitude cap must not limit the crossing frame");
      }
      if (after.groundAltitudeKm < 10) lowSteps++;
    }
    assert(crossed, "automatic descent must cross the former 10 km ground boundary");
    assert.equal(lowSteps, 10);
  }
});

test("restoring near-terrain vacuum flight preserves the user's selected engine and cruise ceiling", () => {
  for (const normal of [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)]) {
    const ship = new ShipDynamics();
    place(ship, "moon", 10, normal);
    assert.equal(ship.environment.atmospheric, false);
    assert(Math.abs(ship.environment.groundAltitudeKm - 10) < 1e-6);
    ship.orientation.setFromUnitVectors(new THREE.Vector3(0, 0, -1), normal);
    ship.setCruiseSpeed(2500);
    ship.setEngineMode("atmospheric");
    ship.velocity.copy(normal).multiplyScalar(50000 / world.unitsKm);
    const restored = new ShipDynamics();
    assert(restored.restore(ship.snapshot()));
    assert(Math.abs(restored.velocity.length() * world.unitsKm - 2500) < 1e-8);
    assert.equal(restored.engine.id, "atmospheric");
    assert.equal(restored.cruiseSpeedKm, 2500);
    const previous = restored.position.clone();
    restored.step(0.05, { ...emptyInput(), throttle: 1, boost: true });
    assert(restored.velocity.length() * world.unitsKm > 1000);
    assert(restored.velocity.length() * world.unitsKm <= 2500 + 1e-8);
    assert(restored.position.distanceTo(previous) * world.unitsKm <= 2500 * 0.05 + 1e-6);
    assert.equal(restored.engine.id, "atmospheric");
  }
});

test("landing rejects giant planets, the Sun, wrong targets and warp; manual input safely cancels descent", () => {
  const ship = new ShipDynamics();
  for (const id of ["sun", "jupiter", "saturn", "uranus", "neptune", "alpha-centauri-a", "alpha-centauri-b", "proxima-centauri", "betelgeuse"]) {
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
  ship.assist = false;
  ship.orientation.setFromEuler(new THREE.Euler(0.5, 0.2, 0.7));
  ship.velocity.set(0, 0, 0.01 / world.unitsKm);
  const previous = ship.position.clone();
  ship.step(0.05, emptyInput());
  assert.equal(ship.landedBody, "mars");
  assert(ship.environment.groundAltitudeKm < 1e-6);
  const normal = ship.environment.outward;
  assert(new THREE.Vector3(0, 1, 0).applyQuaternion(ship.orientation).dot(normal) > 0.999);
  assert(ship.position.distanceTo(previous) * world.unitsKm <= 0.0002 + 1e-6);
  assert.equal(ship.velocity.length(), 0);
  const saved = ship.snapshot();
  const restored = new ShipDynamics();
  assert(restored.restore(saved));
  assert.deepEqual(restored.snapshot(), saved);
  ship.step(0.05, { ...emptyInput(), lift: 1 });
  assert.equal(ship.landingPhase, "ascending");
  const fast = new ShipDynamics();
  place(fast, "mars", 0.02);
  fast.assist = false;
  fast.velocity.set(0, 0, 50 / world.unitsKm);
  const fastPrevious = fast.position.clone();
  fast.step(0.05, emptyInput());
  assert.equal(fast.collision, "mars");
  assert.equal(fast.velocity.length(), 0);
  assert(fast.environment.groundAltitudeKm >= 0 && fast.environment.groundAltitudeKm < 0.002);
  assert(fast.position.distanceTo(fastPrevious) * world.unitsKm <= 0.02 + 1e-6,
    "a fast contact must stop at the terrain instead of tunnelling or jumping to a shield shell");
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
  const landed = new ShipDynamics();
  place(landed, "proxima-b", 0.00001);
  landed.startLanding();
  landed.step(0.05, emptyInput());
  assert.equal(landed.landedBody, "proxima-b");
  assert.equal(validateFlightState({ ...landed.snapshot(), systemId: "solar" }), null);
});

test("Earth has continuous kilometre-scale mountain ranges and collision follows their peaks", () => {
  const region = mappedMountainNormal();
  const east = new THREE.Vector3(0, 1, 0).cross(region).normalize();
  const north = region.clone().cross(east).normalize();
  let low = Infinity, high = -Infinity, summit;
  for (let x = -100; x <= 100; x += 4) for (let y = -100; y <= 100; y += 4) {
    const normal = region.clone().multiplyScalar(6371).addScaledVector(east, x).addScaledVector(north, y).normalize();
    const height = terrainHeightKm("earth", normal.toArray());
    assert(height >= 0 && height < 10);
    low = Math.min(low, height);
    if (height > high) { high = height; summit = normal; }
    const next = normal.clone().addScaledVector(east, 0.001 / 6371).normalize();
    assert(Math.abs(height - terrainHeightKm("earth", next.toArray())) < 0.005,
      "a metre of lateral travel must not produce a height discontinuity");
  }
  assert(high - low > 3, "a 200 km region must show mountains rather than metre-scale bumps");
  const ship = new ShipDynamics();
  place(ship, "earth", 0.02, summit);
  assert(Math.abs(ship.environment.groundAltitudeKm - 0.02) < 0.00001);
  assert.equal(ship.startLanding(), null);
  for (let i = 0; i < 1600 && ship.landingPhase !== "landed"; i++) ship.step(0.05, emptyInput());
  assert.equal(ship.landingPhase, "landed");
  assert(Math.abs(ship.environment.groundAltitudeKm) < 0.00001);
});
