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
      assert(ship.startWarp(), "entering the visual atmosphere must preserve the near-surface warp restriction");
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
test("automatic descent crosses the atmosphere continuously at no more than 1000 m/s", () => {
  const ship = new ShipDynamics();
  place(ship, "earth", 200);
  assert.equal(ship.startLanding(), null);
  let previous = ship.position.clone(), enteredAtmosphere = false;
  for (let i = 0; i < 5200 && ship.landingPhase !== "landed"; i++) {
    const before = ship.environment;
    ship.step(0.05, emptyInput());
    const after = ship.environment;
    if (before.atmospheric || after.atmospheric) {
      enteredAtmosphere = true;
      assert(ship.velocity.length() * world.unitsKm <= 1 + 1e-8);
      if (before.atmospheric)
        assert(ship.position.distanceTo(previous) * world.unitsKm <= 0.05 + 1e-6);
      else
        assert(after.altitudeKm >= 160 - 0.05 - 1e-6,
          "the atmospheric part of the entry step must obey the cap");
    }
    assert(after.groundAltitudeKm <= before.groundAltitudeKm + 1e-6);
    previous.copy(ship.position);
  }
  assert(enteredAtmosphere);
  assert.equal(ship.landingPhase, "landed");
  assert.equal(ship.landedBody, "earth");
});

test("automatic low-altitude descent and takeoff obey the selected 1 and 133 m/s speeds in air and vacuum", () => {
  for (const id of ["earth", "moon"]) {
    for (const selectedMps of [1, 133]) {
      const ship = new ShipDynamics();
      place(ship, id, 0.5);
      ship.setAtmosphericSpeed(selectedMps);
      const startAltitude = ship.environment.groundAltitudeKm;
      assert.equal(ship.startLanding(), null);
      for (let i = 0; i < 20; i++) {
        const previous = ship.position.clone();
        ship.step(0.05, emptyInput());
        assert(ship.velocity.length() * world.unitsKm * 1000 <= selectedMps + 1e-6);
        assert(ship.position.distanceTo(previous) * world.unitsKm * 1000 <= selectedMps * 0.05 + 1e-5);
      }
      const descentMetres = (startAltitude - ship.environment.groundAltitudeKm) * 1000;
      assert(Math.abs(descentMetres - selectedMps) < 0.001, `${id}: descent must actually use ${selectedMps} m/s`);
      ship.cancelLanding();
      place(ship, id, 0.00001);
      assert.equal(ship.startLanding(), null);
      ship.step(0.05, emptyInput());
      assert.equal(ship.landedBody, id);
      assert.equal(ship.takeOff(), null);
      const takeoffAltitude = ship.environment.groundAltitudeKm;
      for (let i = 0; i < 400 && ship.landingPhase === "ascending"; i++) {
        const previous = ship.position.clone();
        ship.step(0.05, emptyInput());
        assert(ship.velocity.length() * world.unitsKm * 1000 <= selectedMps + 1e-6);
        assert(ship.position.distanceTo(previous) * world.unitsKm * 1000 <= selectedMps * 0.05 + 1e-5);
        if (i === 19 && selectedMps === 1) {
          const climbMetres = (ship.environment.groundAltitudeKm - takeoffAltitude) * 1000;
          assert(Math.abs(climbMetres - 1) < 0.001, `${id}: minimum-speed takeoff must actually climb 1 m in 1 s`);
        }
      }
      assert(ship.environment.groundAltitudeKm > takeoffAltitude);
    }
  }
});

test("automatic atmospheric entry preserves a selected 133 m/s limit on the entry frame and subsequent descent", () => {
  const ship = new ShipDynamics();
  place(ship, "earth", 200);
  ship.setAtmosphericSpeed(133);
  assert.equal(ship.startLanding(), null);
  let entry = false, atmosphericSteps = 0;
  for (let i = 0; i < 120; i++) {
    const before = ship.environment;
    const previous = ship.position.clone();
    ship.step(0.05, emptyInput());
    const after = ship.environment;
    if (after.atmospheric) {
      if (!before.atmospheric) entry = true;
      assert(ship.velocity.length() * world.unitsKm * 1000 <= 133 + 1e-6);
      if (before.atmospheric) {
        atmosphericSteps++;
        assert(ship.position.distanceTo(previous) * world.unitsKm * 1000 <= 133 * 0.05 + 1e-5);
      } else {
        assert(after.altitudeKm >= 160 - 133 * 0.05 / 1000 - 1e-6);
      }
    }
  }
  assert(entry, "the simulation must reach the atmospheric boundary");
  assert(atmosphericSteps > 20, "validate sustained descent after the entry boundary");
});

test("airless worlds still obey the 10 km limit above their actual generated terrain", () => {
  for (const normal of [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)]) {
    const ship = new ShipDynamics();
    place(ship, "moon", 10, normal);
    assert.equal(ship.environment.atmospheric, false);
    assert(Math.abs(ship.environment.groundAltitudeKm - 10) < 1e-6);
    ship.orientation.setFromUnitVectors(new THREE.Vector3(0, 0, -1), normal);
    assert(ship.startOrbitalEngine(), "surface height, not the reference sphere, controls launch eligibility");
    ship.setAtmosphericSpeed(80);
    ship.velocity.set(50000 / world.unitsKm, 50000 / world.unitsKm, 50000 / world.unitsKm);
    const restored = new ShipDynamics();
    assert(restored.restore(ship.snapshot()));
    assert(restored.velocity.length() * world.unitsKm <= 0.08 + 1e-8);
    restored.step(0.05, { ...emptyInput(), throttle: 1, strafe: 1, lift: 1, boost: true });
    assert(restored.velocity.length() * world.unitsKm <= 0.08 + 1e-8);
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
  const landed = new ShipDynamics();
  place(landed, "proxima-b", 0.00001);
  landed.startLanding();
  landed.step(0.05, emptyInput());
  assert.equal(landed.landedBody, "proxima-b");
  assert.equal(validateFlightState({ ...landed.snapshot(), systemId: "solar" }), null);
});

test("Earth has continuous kilometre-scale mountain ranges and collision follows their peaks", () => {
  let low = Infinity, high = -Infinity, summit;
  for (let x = -100; x <= 100; x += 4) for (let y = -100; y <= 100; y += 4) {
    const normal = new THREE.Vector3(x / 6371, y / 6371, -1).normalize();
    const height = terrainHeightKm("earth", normal.toArray());
    assert(height >= 0 && height < 5.3);
    low = Math.min(low, height);
    if (height > high) { high = height; summit = normal; }
    const next = normal.clone().add(new THREE.Vector3(0.001 / 6371, 0, 0)).normalize();
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
