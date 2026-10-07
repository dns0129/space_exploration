import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVoyagerServer } from "./server.mjs";
import { world, validateFlightState } from "../shared/flight-state.mjs";
import { bodySystem } from "../shared/world-navigation.mjs";
import { terrainHeightKm, surfaceProfile, LANDING_CLEARANCE_KM } from "../shared/surface.mjs";
import { ShipDynamics, emptyInput } from "../src/ship-dynamics.ts";
import * as THREE from "three";
import { RenderBudget } from "../src/render-budget.ts";
import { createShip, SHIP_LENGTH_KM } from "../src/ship-model.ts";
import { projectFlightTarget } from "../src/flight-target.ts";
const state = () => new ShipDynamics().snapshot();
const speedKm = ship => ship.velocity.length() * world.unitsKm;
function placeAtAltitude(ship, id, altitudeKm, normal = new THREE.Vector3(0, 0, 1)) {
  const body = world.bodies.find(candidate => candidate.id === id);
  ship.systemId = bodySystem(body);
  ship.target = id;
  ship.position.fromArray(body.position).addScaledVector(normal, body.radius + altitudeKm / world.unitsKm);
  ship.velocity.set(0, 0, 0);
  return body;
}
function placeAboveGround(ship, id, groundAltitudeKm, normal = new THREE.Vector3(0, 0, 1)) {
  return placeAtAltitude(ship, id, terrainHeightKm(id, normal.toArray()) + LANDING_CLEARANCE_KM + groundAltitudeKm, normal);
}
function faceOutward(ship) {
  ship.orientation.setFromUnitVectors(new THREE.Vector3(0, 0, -1), ship.environment.outward);
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "voyager-server-"));
  const staticRoot = join(root, "game"),
    dataDir = join(root, "saves");
  await mkdir(staticRoot);
  await writeFile(join(staticRoot, "index.html"), "<h1>Voyager flight</h1>");
  const server = createVoyagerServer({ staticRoot, dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    server,
    staticRoot,
    dataDir,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}
test("backend serves the game and full solar world; blocks invalid files and methods", async (t) => {
  const { url } = await fixture(t);
  assert.equal(await (await fetch(url)).text(), "<h1>Voyager flight</h1>");
  assert.deepEqual(await (await fetch(url + "/api/world")).json(), world);
  assert.equal((await fetch(url + "/missing.jpg")).status, 404);
  assert.equal((await fetch(url + "/%2f..%2fsecret")).status, 403);
  assert.equal(
    (await fetch(url + "/api/flight/save", { method: "DELETE" })).status,
    405,
  );
});
test("flight saves persist across server restart and remain private to the pilot cookie", async (t) => {
  const f = await fixture(t);
  const initial = await fetch(f.url + "/api/flight/save");
  const cookie = initial.headers.get("set-cookie").split(";")[0];
  assert.equal((await initial.json()).state, null);
  const saved = state();
  saved.position[0] += 10;
  saved.elapsed = 42;
  const result = await fetch(f.url + "/api/flight/save", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(saved),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(
    (
      await (
        await fetch(f.url + "/api/flight/save", { headers: { cookie } })
      ).json()
    ).state,
    saved,
  );
  assert.equal(
    (await (await fetch(f.url + "/api/flight/save")).json()).state,
    null,
  );
  await new Promise((resolve) => f.server.close(resolve));
  await new Promise((resolve) => f.server.listen(0, "127.0.0.1", resolve));
  assert.deepEqual(
    (
      await (
        await fetch(
          `http://127.0.0.1:${f.server.address().port}/api/flight/save`,
          { headers: { cookie } },
        )
      ).json()
    ).state,
    saved,
  );
});
test("backend preserves a Proxima coordinate frame and rejects unknown systems", async (t) => {
  const { url } = await fixture(t);
  const cookie = (await fetch(url + "/api/flight/save")).headers.get("set-cookie").split(";")[0];
  const headers = { cookie, "content-type": "application/json" };
  const ship = new ShipDynamics();
  ship.jump("proxima-b");
  const saved = ship.snapshot();
  const post = value => fetch(url + "/api/flight/save", { method: "POST", headers, body: JSON.stringify(value) });
  assert.equal((await post(saved)).status, 200);
  assert.equal((await post({ ...saved, systemId: "unknown" })).status, 400);
  const stored = (await (await fetch(url + "/api/flight/save", { headers: { cookie } })).json()).state;
  assert.deepEqual(stored, saved);
  const restored = new ShipDynamics();
  assert.equal(restored.restore(stored), true);
  assert.equal(restored.systemId, "proxima-centauri");
  assert.equal(restored.environment.body.id, "proxima-b");
});
test("malformed, oversized and cross-origin saves are rejected without replacing a valid save", async (t) => {
  const { url } = await fixture(t);
  const cookie = (await fetch(url + "/api/flight/save")).headers
    .get("set-cookie")
    .split(";")[0];
  const headers = { cookie, "content-type": "application/json" };
  const saved = state();
  assert.equal(
    (
      await fetch(url + "/api/flight/save", {
        method: "POST",
        headers,
        body: JSON.stringify(saved),
      })
    ).status,
    200,
  );
  for (const body of [
    "{bad",
    JSON.stringify({ ...saved, orientation: [0, 0, 0, 0] }),
    JSON.stringify({ ...saved, position: [null, 0, 0] }),
    JSON.stringify({ ...saved, target: "pluto" }),
  ])
    assert.equal(
      (await fetch(url + "/api/flight/save", { method: "POST", headers, body }))
        .status,
      400,
    );
  assert.equal(validateFlightState({ ...saved, position: [Infinity, 0, 0] }), null);
  assert.equal(
    (
      await fetch(url + "/api/flight/save", {
        method: "POST",
        headers,
        body: "x".repeat(9000),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await fetch(url + "/api/flight/save", {
        method: "POST",
        headers: { ...headers, origin: "https://elsewhere.example" },
        body: JSON.stringify(saved),
      })
    ).status,
    403,
  );
  assert.deepEqual(
    (
      await (
        await fetch(url + "/api/flight/save", { headers: { cookie } })
      ).json()
    ).state,
    saved,
  );
});
test("standalone server serves only the game document and API, never save files", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.staticRoot, "private.json"), "secret");
  await new Promise((resolve) => f.server.close(resolve));
  const server = createVoyagerServer({
    staticRoot: f.staticRoot,
    dataDir: f.dataDir,
    serveOnlyIndex: true,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url + "/private.json")).status, 404);
});
test("thrust, six-axis orientation, inertia and braking change the actual ship state", () => {
  const ship = new ShipDynamics();
  const start = ship.position.clone();
  const input = {
    ...emptyInput(),
    throttle: 1,
    strafe: 1,
    lift: 1,
    yaw: 0.5,
    roll: 0.5,
  };
  for (let i = 0; i < 30; i++) ship.step(0.05, input);
  assert(ship.position.distanceTo(start) > 0.001);
  assert(Math.abs(speedKm(ship) - ship.cruiseSpeedKm) < 1e-8);
  assert(ship.orientation.angleTo(new ShipDynamics().orientation) > 0.2);
  const speed = ship.velocity.length();
  for (let i = 0; i < 15; i++)
    ship.step(0.05, { ...emptyInput(), brake: true });
  assert(ship.velocity.length() < speed * 0.01);
  assert(validateFlightState(ship.snapshot()));
});
test("continuous entity collision stops a fast ship at terrain rather than an altitude protection bubble", () => {
  const ship = new ShipDynamics();
  placeAtAltitude(ship, "earth", 12742, new THREE.Vector3(0, 0, -1));
  ship.setCruiseSpeed(600000);
  ship.velocity.set(0, 0, 600000 / world.unitsKm);
  ship.assist = false;
  ship.step(0.05, emptyInput());
  assert.equal(ship.collision, "earth");
  assert.equal(ship.velocity.length(), 0, "entity collision remains the exception to powered cruising");
  assert(ship.environment.groundAltitudeKm < 0.01, "collision must happen at actual terrain, not the old 1000 km or radius-based shell");
  const saved = ship.snapshot();
  const restored = new ShipDynamics();
  assert(restored.restore(saved));
  assert.deepEqual(restored.snapshot(), saved);
  assert.equal(restored.restore({ ...saved, position: [Infinity, 0, 0] }), false);
});

function mountainTraverse(heightKm) {
  const normal = new THREE.Vector3(-180, -141, -6371).normalize();
  const tangent = new THREE.Vector3(1, 0, 0).projectOnPlane(normal).normalize();
  const direction = tangent.clone().add(new THREE.Vector3().crossVectors(normal, tangent).normalize()).normalize();
  const fromKm = normal.multiplyScalar(6371 + heightKm).addScaledVector(direction, -2.5);
  const terrain = [], clearance = [];
  for (let i = 0; i <= 500; i++) {
    const point = fromKm.clone().addScaledVector(direction, i / 100);
    const height = terrainHeightKm("earth", point.clone().normalize().toArray());
    terrain.push(height);
    clearance.push(point.length() - 6371 - height - LANDING_CLEARANCE_KM);
  }
  return { fromKm, direction, terrain, clearance };
}
function placeOnTraverse(ship, fixture) {
  const earth = world.bodies.find(body => body.id === "earth");
  ship.position.fromArray(earth.position).addScaledVector(fixture.fromKm, 1 / world.unitsKm);
  ship.orientation.setFromUnitVectors(new THREE.Vector3(0, 0, -1), fixture.direction);
  ship.setCruiseSpeed(100);
  ship.velocity.copy(fixture.direction).multiplyScalar(100 / world.unitsKm);
}

test("a five-kilometre valley-to-valley flight stops at the first real ridge contact even when both endpoints are clear", () => {
  const fixture = mountainTraverse(3.600752135459824);
  assert(fixture.clearance[0] > 0.2 && fixture.clearance.at(-1) > 0.2);
  assert(Math.max(...fixture.terrain) - Math.max(fixture.terrain[0], fixture.terrain.at(-1)) > 0.2,
    "the interior ridge must be significantly higher than either valley endpoint");
  assert(Math.min(...fixture.clearance) < -0.2, "the planned straight flight must really intersect the ridge");
  const ship = new ShipDynamics();
  placeOnTraverse(ship, fixture);
  const start = ship.position.clone();
  ship.step(0.05, { ...emptyInput(), throttle: 1 });
  assert.equal(ship.collision, "earth");
  assert.equal(ship.velocity.length(), 0);
  const travelledKm = ship.position.distanceTo(start) * world.unitsKm;
  assert(travelledKm > 2 && travelledKm < 3, "the ship must stop at the first intermediate ridge, not at a valley endpoint");
  const earth = world.bodies.find(body => body.id === "earth");
  const radial = ship.position.clone().sub(new THREE.Vector3().fromArray(earth.position));
  const clearance = radial.length() * world.unitsKm - 6371
    - terrainHeightKm("earth", radial.clone().normalize().toArray()) - LANDING_CLEARANCE_KM;
  assert(clearance >= -0.00001 && clearance < 0.005, "collision must stop on the sampled terrain without penetrating it");
});

test("the same five-kilometre route above the highest ridge remains at user speed and does not collide with a terrain envelope", () => {
  const low = mountainTraverse(3.600752135459824);
  const fixture = mountainTraverse(Math.max(...low.terrain) + 0.1 + LANDING_CLEARANCE_KM);
  assert(Math.min(...fixture.clearance) > 0.099, "the control path must stay about 100 m above the entire ridge");
  const ship = new ShipDynamics();
  placeOnTraverse(ship, fixture);
  const start = ship.position.clone();
  ship.step(0.05, { ...emptyInput(), throttle: 1 });
  assert.equal(ship.collision, null);
  assert(Math.abs(speedKm(ship) - 100) < 1e-8);
  assert(Math.abs(ship.position.distanceTo(start) * world.unitsKm - 5) < 1e-6,
    "the conservative terrain envelope must not shorten a physically clear path");
});

test("maximum finite cruise speed produces finite consecutive powered frames and valid far-space saves", () => {
  const ship = new ShipDynamics();
  ship.setEngineMode("atmospheric");
  ship.position.set(1e6, 0, 0);
  ship.orientation.identity();
  ship.setCruiseSpeed(Number.MAX_VALUE);
  const internalLimit = Number.MAX_VALUE / world.unitsKm;
  for (let i = 0; i < 3; i++) {
    ship.step(0.01, { ...emptyInput(), throttle: 1 });
    assert(ship.position.toArray().every(Number.isFinite), "real powered displacement must remain finite");
    assert(ship.velocity.toArray().every(Number.isFinite), "normalizing to MAX_VALUE must not create Infinity or NaN");
    const speed = Math.hypot(...ship.velocity.toArray());
    assert(Number.isFinite(speed));
    assert(Math.abs(speed / internalLimit - 1) < 1e-12);
    assert(validateFlightState(ship.snapshot()), "maximum-speed displacement must remain a restorable flight state");
  }
});

test("extreme finite swept velocities still stop at the Sun and an intermediate physical mountain ridge", () => {
  const sunShip = new ShipDynamics();
  const sun = placeAtAltitude(sunShip, "sun", 100000, new THREE.Vector3(0, 0, -1));
  sunShip.assist = false;
  sunShip.setCruiseSpeed(1e160);
  sunShip.velocity.set(0, 0, 1e160 / world.unitsKm);
  sunShip.step(0.05, emptyInput());
  assert.equal(sunShip.collision, "sun");
  assert.equal(sunShip.velocity.length(), 0);
  const sunClearanceKm = (sunShip.position.distanceTo(new THREE.Vector3().fromArray(sun.position)) - sun.radius) * world.unitsKm;
  assert(sunClearanceKm >= -0.00001 && sunClearanceKm < 0.005,
    "overflowing squared velocities must not skip the Sun's physical surface");
  const ridgeShip = new ShipDynamics();
  placeOnTraverse(ridgeShip, mountainTraverse(3.600752135459824));
  ridgeShip.assist = false;
  ridgeShip.setCruiseSpeed(1e160);
  ridgeShip.velocity.multiplyScalar(1e158);
  const start = ridgeShip.position.clone();
  ridgeShip.step(0.05, emptyInput());
  assert.equal(ridgeShip.collision, "earth");
  assert.equal(ridgeShip.velocity.length(), 0);
  assert(ridgeShip.position.toArray().every(Number.isFinite));
  const travelledKm = ridgeShip.position.distanceTo(start) * world.unitsKm;
  assert(travelledKm > 2 && travelledKm < 3,
    "a stable extreme-speed sweep must stop at the first ridge rather than tunnelling through the entire terrain envelope");
  assert(validateFlightState(ridgeShip.snapshot()));
});

test("all four engines stay manually selected independently of speed, atmosphere and ground clearance", () => {
  const ship = new ShipDynamics();
  assert.equal(ship.engineMode, "planetary");
  assert.equal(ship.cruiseSpeedKm, 100);
  assert.equal(ship.engine.id, "planetary");
  assert(world.engines.every(engine => !("minSpeedKm" in engine) && !("maxSpeedKm" in engine)),
    "manual engine metadata must not retain obsolete speed gates");
  for (const mode of ["atmospheric", "orbital", "planetary", "interstellar"]) {
    ship.position.set(1e6, 0, 0);
    ship.setCruiseSpeed(600000);
    assert.equal(ship.setEngineMode(mode), null);
    for (const speed of [0, 0.001, 100, 10000, 500000]) {
      ship.velocity.set(speed / world.unitsKm, 0, 0);
      assert.equal(ship.engine.id, mode, `${mode} at ${speed} km/s`);
      const restored = new ShipDynamics();
      assert(restored.restore(ship.snapshot()));
      assert.equal(restored.engineMode, mode);
      assert.equal(restored.engine.id, mode);
      assert(Math.abs(speedKm(restored) - speed) < 1e-7);
    }
    for (const [id, groundAltitude] of [["earth", 1], ["earth", 50], ["moon", 1], ["jupiter", 1500]]) {
      placeAboveGround(ship, id, groundAltitude);
      assert.equal(ship.setEngineMode(mode), null, "engine selection must be available in air and near the surface");
      assert.equal(ship.engine.id, mode);
      assert(Math.abs(ship.speedLimit * world.unitsKm - 600000) < 1e-7);
    }
  }
});

test("powered six-axis flight reaches the user cruise speed immediately in every gear and preserves space inertia", () => {
  for (const mode of ["atmospheric", "orbital", "planetary", "interstellar"]) {
    for (const cruise of [100, 250, 1000000]) for (const boost of [false, true]) {
      const ship = new ShipDynamics();
      ship.position.set(1e6, 0, 0);
      ship.setEngineMode(mode);
      ship.setCruiseSpeed(cruise);
      ship.step(0.01, { ...emptyInput(), throttle: 1, strafe: 1, lift: 1, boost });
      assert(Math.abs(speedKm(ship) - cruise) < 1e-7, "the first powered frame must already use the selected total-vector speed");
      assert(ship.velocity.x && ship.velocity.y && ship.velocity.z, "test a genuinely diagonal velocity");
      assert.equal(ship.engine.id, mode);
      assert(validateFlightState(ship.snapshot()));
      ship.assist = false;
      const velocity = ship.velocity.clone(), position = ship.position.clone();
      ship.step(0.05, emptyInput());
      assert(ship.velocity.distanceTo(velocity) < 1e-12);
      assert(ship.position.distanceTo(position.addScaledVector(velocity, 0.05)) < 1e-8);
    }
  }
});

test("Space brakes continuously and S brakes before reversing; idle may remain below the cruise minimum", () => {
  for (const brake of [true, false]) {
    const ship = new ShipDynamics();
    ship.position.set(1e6, 0, 0);
    ship.setCruiseSpeed(400);
    ship.step(0.05, { ...emptyInput(), throttle: 1 });
    assert(Math.abs(speedKm(ship) - 400) < 1e-8);
    const slowing = { ...emptyInput(), throttle: brake ? 1 : -1, strafe: 1, lift: 1, boost: true, brake };
    let previous = speedKm(ship);
    for (let i = 0; i < 200; i++) {
      ship.step(0.05, slowing);
      assert(speedKm(ship) <= previous + 1e-8, "combined controls must not reset braking to the cruise value");
      previous = speedKm(ship);
      // S becomes reverse thrust after stopping; release it as soon as the ship reaches rest.
      if (!brake && ship.velocity.length() === 0) break;
    }
    assert.equal(ship.velocity.length(), 0);
    assert.equal(ship.engine.id, "planetary");
    ship.step(0.05, emptyInput());
    assert.equal(ship.velocity.length(), 0, "idle flight must not force a stationary ship to the 100 km/s minimum");
    if (!brake) {
      ship.step(0.05, { ...emptyInput(), throttle: -1 });
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.orientation);
      assert(ship.velocity.dot(forward) < 0, "S remains reverse thrust when used from rest");
      assert(Math.abs(speedKm(ship) - 400) < 1e-8);
    }
  }
});

test("backend persists arbitrary finite cruise speeds and all engine choices while normalizing obsolete settings", async (t) => {
  const { url } = await fixture(t);
  const cookie = (await fetch(url + "/api/flight/save")).headers.get("set-cookie").split(";")[0];
  const ship = new ShipDynamics();
  ship.position.set(1e6, 0, 0);
  ship.setEngineMode("atmospheric");
  ship.setCruiseSpeed(900000);
  ship.velocity.set(900000 / world.unitsKm, 0, 0);
  const saved = ship.snapshot();
  assert.equal(saved.cruiseSpeedKm, 900000);
  assert(!("atmosphericSpeedMps" in saved));
  assert(!("escapeBody" in saved));
  const headers = { cookie, "content-type": "application/json" };
  const post = value => fetch(url + "/api/flight/save", { method: "POST", headers, body: JSON.stringify(value) });
  assert.equal((await post(saved)).status, 200);
  for (const patch of [{ engineMode: "automatic" }, { cruiseSpeedKm: 99 },
    { cruiseSpeedKm: 0 }, { cruiseSpeedKm: "100" }, { cruiseSpeedKm: null }])
    assert.equal((await post({ ...saved, ...patch })).status, 400);
  for (const cruiseSpeedKm of [NaN, Infinity, -Infinity])
    assert.equal(validateFlightState({ ...saved, cruiseSpeedKm }), null);
  assert.equal(validateFlightState({ ...saved, velocity: [Number.MAX_VALUE, Number.MAX_VALUE, 0] }), null,
    "finite components must still have a finite total speed");
  const stored = (await (await fetch(url + "/api/flight/save", { headers: { cookie } })).json()).state;
  assert.deepEqual(stored, saved);
  const restored = new ShipDynamics();
  assert(restored.restore(stored));
  assert.equal(restored.engineMode, "atmospheric");
  assert.equal(restored.cruiseSpeedKm, 900000);
  assert(Math.abs(speedKm(restored) - 900000) < 1e-7, "restoring an obsolete low engine must not apply its nominal cap");
  const legacy = { ...saved, engineMode: "standard", atmosphericSpeedMps: 0, escapeBody: "unknown" };
  delete legacy.cruiseSpeedKm;
  assert.equal((await post(legacy)).status, 200);
  const migrated = (await (await fetch(url + "/api/flight/save", { headers: { cookie } })).json()).state;
  assert.equal(migrated.engineMode, "planetary");
  assert.equal(migrated.cruiseSpeedKm, 100);
  assert(!("atmosphericSpeedMps" in migrated));
  assert(!("escapeBody" in migrated));
  const unselected = { ...legacy }; delete unselected.engineMode;
  assert.equal(validateFlightState(unselected).engineMode, "planetary");
  assert(restored.restore(migrated));
  assert(Math.abs(speedKm(restored) - 100) < 1e-8);
});

test("finite far-space coordinates and 1e18 km/s cruise speeds survive API persistence and restoration", async (t) => {
  const { url } = await fixture(t);
  const cookie = (await fetch(url + "/api/flight/save")).headers.get("set-cookie").split(";")[0];
  const ship = new ShipDynamics();
  ship.position.set(1e18, -2e18, 3e18);
  ship.setCruiseSpeed(1e18);
  ship.velocity.set(1e18 / world.unitsKm, 0, 0);
  const saved = ship.snapshot();
  assert(validateFlightState(saved), "finite coordinates must not retain the former 1e12 bound");
  const headers = { cookie, "content-type": "application/json" };
  const response = await fetch(url + "/api/flight/save", { method: "POST", headers, body: JSON.stringify(saved) });
  assert.equal(response.status, 200);
  const stored = (await (await fetch(url + "/api/flight/save", { headers: { cookie } })).json()).state;
  assert.deepEqual(stored, saved);
  const restored = new ShipDynamics();
  assert(restored.restore(stored));
  assert.deepEqual(restored.snapshot(), saved);
});

test("world uses real solar radii and astronomical distances; compressed saves migrate safely", () => {
  const earth = world.bodies.find((b) => b.id === "earth");
  const sun = world.bodies.find((b) => b.id === "sun");
  const neptune = world.bodies.find((b) => b.id === "neptune");
  assert.equal(earth.radius * world.unitsKm, 6371);
  assert.equal(sun.radius * world.unitsKm, 695700);
  assert(Math.abs(Math.hypot(...earth.position) * world.unitsKm - world.auKm) < 1);
  assert(Math.abs(Math.hypot(...neptune.position) * world.unitsKm - 4495.1e6) < 1);
  const legacy = { ...state(), version: 1, position: [0, 0, 38.2], velocity: [0, 0, -30] };
  const migrated = validateFlightState(legacy);
  assert.equal(migrated.version, 2);
  assert(Math.abs(migrated.position[2] - earth.position[2] + 3.8) < 1e-8);
  assert.deepEqual(migrated.velocity, [0, 0, 0]);
});

test("warp charges, moves continuously, arrives safely and cools down at all nine bodies", () => {
  const ship = new ShipDynamics();
  for (const target of ["mercury", "venus", "mars", "jupiter", "saturn", "uranus", "neptune", "sun", "earth"]) {
    ship.target = target;
    const departure = ship.position.clone();
    const departureSide = ship.targetRelative.negate().normalize();
    assert.equal(ship.startWarp(), null);
    assert.equal(ship.warpPhase, "charging");
    assert.equal(ship.startWarp(), "跃迁引擎正在工作或冷却");
    ship.step(0.05, emptyInput());
    assert(ship.position.equals(departure));
    let sawTransit = false, sawArrival = false, movedInTransit = false;
    for (let i = 0; i < 300 && ship.warpPhase !== "ready"; i++) {
      ship.step(0.05, emptyInput());
      if (ship.warpPhase === "transit") {
        sawTransit = true;
        if (ship.position.distanceTo(departure) > 1) movedInTransit = true;
      }
      if (ship.warpPhase === "arrival") sawArrival = true;
      for (const body of ship.activeBodies) {
        const distance = Math.hypot(...ship.position.toArray().map((n, axis) => n - body.position[axis]));
        assert(distance > body.radius, `route intersects ${body.id}`);
      }
      assert(validateFlightState(ship.snapshot()));
    }
    assert(sawTransit && movedInTransit && sawArrival);
    assert.equal(ship.warpPhase, "ready");
    assertNearbyArrival(ship, departureSide);
    assert.equal(ship.velocity.length(), 0);
  }
});

test("warp routes around the Sun and can be interrupted without losing the actual position", () => {
  const ship = new ShipDynamics();
  const mercury = world.bodies.find((b) => b.id === "mercury");
  ship.position.fromArray(mercury.position).normalize().multiplyScalar(-14000);
  ship.target = "mercury";
  assert.equal(ship.startWarp(), null);
  for (let i = 0; i < 100; i++) {
    ship.step(0.05, emptyInput());
    assert(ship.position.length() > world.bodies[0].radius);
  }
  assert.equal(ship.warpPhase, "transit");
  const midway = ship.position.clone();
  ship.cancelWarp();
  assert.equal(ship.warpPhase, "cooldown");
  assert(ship.position.equals(midway));
  const restored = new ShipDynamics();
  assert(restored.restore(ship.snapshot()));
  assert(restored.position.equals(midway));
});

test("warp may pass through a non-target atmosphere while its continuous route avoids physical bodies", () => {
  for (const source of world.bodies.filter(body => body.atmosphereKm > 1000)) {
    const giant = { ...source, systemId: "solar", position: [0, 0, 0] };
    const impactRadius = giant.radius + (1000 + giant.atmosphereKm) / 2 / world.unitsKm;
    const earth = { ...world.bodies.find(body => body.id === "earth"), position: [100, 0, impactRadius] };
    const ship = new ShipDynamics({ ...world, bodies: [giant, earth] });
    ship.position.set(-100, 0, impactRadius);
    ship.target = "earth";
    assert.equal(ship.startWarp(), null, source.id);
    let previous = ship.position.clone(), crossedAtmosphere = false;
    for (let i = 0; i < 300 && ship.warpPhase !== "ready"; i++) {
      ship.step(0.05, emptyInput());
      const segment = ship.position.clone().sub(previous);
      const center = new THREE.Vector3().fromArray(giant.position);
      const t = segment.lengthSq() ? THREE.MathUtils.clamp(center.clone().sub(previous).dot(segment) / segment.lengthSq(), 0, 1) : 0;
      const nearest = previous.clone().addScaledVector(segment, t).distanceTo(center);
      assert(nearest > giant.radius, `${source.id}: a warp route must avoid the physical giant`);
      if (nearest < giant.radius + giant.atmosphereKm / world.unitsKm) crossedAtmosphere = true;
      previous.copy(ship.position);
    }
    assert.equal(ship.warpPhase, "ready", source.id);
    assert(crossedAtmosphere, "a safe straight route through atmosphere must not detour around an obsolete safety bubble");
  }
});

test("warp can depart near terrain, inside atmospheres and beside its selected target while state gates still reject re-entry", () => {
  for (const [id, groundAltitude, target] of [["earth", 0.1, "mars"], ["earth", 50, "earth"],
    ["earth", 500, "earth"], ["moon", 1, "earth"], ["jupiter", 1500, "mars"]]) {
    const ship = new ShipDynamics();
    const body = world.bodies.find(candidate => candidate.id === id);
    const destination = world.bodies.find(candidate => candidate.id === target);
    const normal = id === "earth" && target === "mars"
      ? new THREE.Vector3().fromArray(body.position).sub(new THREE.Vector3().fromArray(destination.position)).normalize()
      : new THREE.Vector3(0, 0, 1);
    placeAboveGround(ship, id, groundAltitude, normal);
    ship.target = target;
    const before = ship.snapshot();
    assert.equal(ship.warpBlockReason, null);
    assert.equal(ship.startWarp(), null, `${id} ${groundAltitude} km toward ${target}`);
    assert.equal(ship.warpPhase, "charging");
    assert(ship.startWarp(), "charging remains mutually exclusive");
    ship.step(0.05, emptyInput());
    assert.deepEqual(ship.position.toArray(), before.position, "charging must not teleport the near-ground departure");
    for (let i = 0; i < 400 && ship.warpPhase !== "ready"; i++) {
      ship.step(0.05, emptyInput());
      for (const obstacle of ship.activeBodies) assertOutsideEntity(ship.position, obstacle);
      assert(validateFlightState(ship.snapshot()));
    }
    assert.equal(ship.warpPhase, "ready");
  }
  const cancelled = new ShipDynamics();
  assert.equal(cancelled.startWarp(), null);
  cancelled.cancelWarp();
  const checkpoint = cancelled.snapshot();
  assert(cancelled.startWarp(), "cooldown still blocks immediate reuse");
  assert.deepEqual(cancelled.snapshot(), checkpoint);
});

test("user cruise speed applies in atmosphere and near the ground regardless of gear or the old protection zones", () => {
  for (const mode of ["atmospheric", "orbital", "planetary", "interstellar"]) {
    for (const [id, groundAltitude] of [["earth", 1], ["earth", 50], ["earth", 500], ["moon", 1], ["jupiter", 1500]]) for (const assist of [true, false]) for (const cruise of [100, 321]) {
      const ship = new ShipDynamics();
      placeAboveGround(ship, id, groundAltitude);
      faceOutward(ship);
      ship.assist = assist;
      assert.equal(ship.setEngineMode(mode), null);
      ship.setCruiseSpeed(cruise);
      ship.step(0.01, { ...emptyInput(), throttle: 1 });
      assert(Math.abs(speedKm(ship) - cruise) < 1e-8);
      assert.equal(ship.engine.id, mode);
      assert(Math.abs(ship.speedLimit * world.unitsKm - cruise) < 1e-8);
      assert.equal(ship.collision, null);
    }
  }
});

test("the cruise control accepts every finite value from 100 km/s without a nominal maximum and rejects invalid changes", () => {
  const ship = new ShipDynamics();
  assert.equal(ship.cruiseSpeedKm, 100);
  for (const value of [100, 133, 500000, 1e12, Number.MAX_VALUE]) {
    ship.setCruiseSpeed(value);
    assert.equal(ship.cruiseSpeedKm, value);
    assert.equal(ship.engineMode, "planetary");
  }
  for (const value of [99, 1, 0, -100, NaN, Infinity, -Infinity, "100"]) {
    ship.setCruiseSpeed(value);
    assert.equal(ship.cruiseSpeedKm, Number.MAX_VALUE, "invalid input must not invent a different cruise speed");
  }
  ship.setCruiseSpeed(500);
  placeAboveGround(ship, "earth", 1);
  ship.velocity.set(1000 / world.unitsKm, 0, 0);
  ship.setCruiseSpeed(200);
  assert(speedKm(ship) <= 200 + 1e-8, "reducing the user speed must constrain the actual current velocity");
});





test("crossing the former 10 km and atmospheric boundaries does not change manual propulsion", () => {
  for (const [groundAltitude, outward] of [[9.9, true], [10.1, false], [155.65, true], [155.85, false]]) {
    const ship = new ShipDynamics();
    placeAboveGround(ship, "earth", groundAltitude);
    if (outward) faceOutward(ship);
    else ship.orientation.identity();
    ship.setEngineMode("interstellar");
    ship.setCruiseSpeed(100);
    ship.step(0.01, { ...emptyInput(), throttle: 1 });
    assert(Math.abs(speedKm(ship) - 100) < 1e-8);
    assert.equal(ship.engine.id, "interstellar");
    assert.equal(ship.collision, null);
    assert(ship.environment.groundAltitudeKm > 0);
  }
});



test("a swept atmosphere crossing preserves the user speed and slow frame integration retains elapsed time", () => {
  const ship = new ShipDynamics();
  placeAboveGround(ship, "earth", 200);
  ship.assist = false;
  ship.orientation.identity();
  ship.setEngineMode("atmospheric");
  ship.setCruiseSpeed(500);
  const previous = ship.position.clone();
  ship.step(0.25, { ...emptyInput(), throttle: 1 });
  assert.equal(ship.elapsed, 0.25);
  assert(ship.environment.atmospheric);
  assert(ship.environment.groundAltitudeKm > 50);
  assert(Math.abs(speedKm(ship) - 500) < 1e-8);
  assert(Math.abs(ship.position.distanceTo(previous) * world.unitsKm - 125) < 1e-6,
    "crossing the old safety or atmospheric shell must not shorten the actual path");
  const a = new ShipDynamics(), b = new ShipDynamics();
  a.position.set(1e6, 0, 0); b.position.copy(a.position);
  const input = { ...emptyInput(), throttle: 1, yaw: 0.7 };
  a.step(0.25, input);
  for (let i = 0; i < 5; i++) b.step(0.05, input);
  assert(a.position.distanceTo(b.position) < 1e-10);
  assert(a.orientation.angleTo(b.orientation) < 1e-7);
});

test("assisted flight follows the heading, turns ease out, and S brakes before reversing", () => {
  const assisted = new ShipDynamics(), inertial = new ShipDynamics();
  for (const ship of [assisted, inertial]) {
    ship.position.set(1e6, 0, 0);
    ship.setCruiseSpeed(1000);
    ship.orientation.identity();
    ship.velocity.set(0, 0, -1000 / world.unitsKm);
  }
  inertial.assist = false;
  for (let i = 0; i < 30; i++) {
    assisted.step(0.05, { ...emptyInput(), yaw: 0.7 });
    inertial.step(0.05, { ...emptyInput(), yaw: 0.7 });
  }
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(assisted.orientation);
  assert(assisted.velocity.clone().normalize().dot(forward) > 0.95);
  assert(inertial.velocity.clone().normalize().dot(forward) < 0.5);
  const turn = assisted.angularVelocity.length();
  assisted.step(0.05, emptyInput());
  assert(assisted.angularVelocity.length() > 0 && assisted.angularVelocity.length() < turn);
  for (let i = 0; i < 30; i++) assisted.step(0.05, emptyInput());
  assert(assisted.angularVelocity.length() < 1e-5);
  assisted.orientation.identity();
  assisted.velocity.set(0, 0, -1000 / world.unitsKm);
  assisted.step(0.25, { ...emptyInput(), throttle: -1 });
  assert(assisted.velocity.z < 0 && assisted.velocity.length() * world.unitsKm < 600);
});

test("target projection uses the current camera turn and places off-screen and behind targets at screen edges", () => {
  const camera = new THREE.PerspectiveCamera(60, 2, 0.01, 200);
  const target = new THREE.Vector3(0, 0, -10);
  let projected = projectFlightTarget(target, camera);
  assert.equal(projected.targetX, 50); assert.equal(projected.targetY, 50);
  assert(projected.inView);
  camera.rotation.y = 0.2;
  projected = projectFlightTarget(target, camera);
  assert(projected.inView && projected.targetX > 55);
  camera.rotation.y = 0;
  for (const target of [new THREE.Vector3(100, 20, -10), new THREE.Vector3(0, 0, 10), new THREE.Vector3(-10, 2, 10)]) {
    const marker = projectFlightTarget(target, camera);
    assert.equal(marker.inView, false);
    assert(Number.isFinite(marker.angle));
    assert(marker.targetX >= 6 - 1e-9 && marker.targetX <= 94 + 1e-9);
    assert(marker.targetY >= 14 - 1e-9 && marker.targetY <= 86 + 1e-9);
    assert(Math.abs(marker.targetX - 50) >= 43.99 || Math.abs(marker.targetY - 50) >= 35.99);
  }
});


test("O directly chooses the orbital engine at every height and heading without arming a launch permission", () => {
  for (const [id, groundAltitude, inward] of [["earth", 1, false], ["earth", 10, true],
    ["earth", 50, true], ["moon", 1, true], ["jupiter", 1500, true]]) {
    const ship = new ShipDynamics();
    placeAboveGround(ship, id, groundAltitude);
    if (inward) ship.orientation.identity(); else faceOutward(ship);
    ship.velocity.copy(ship.environment.outward).multiplyScalar(-10 / world.unitsKm);
    ship.setEngineMode("interstellar");
    ship.setCruiseSpeed(200);
    const position = ship.position.clone(), orientation = ship.orientation.clone();
    assert.equal(ship.orbitalBlockReason, null);
    assert.equal(ship.startOrbitalEngine(), null);
    assert.equal(ship.engine.id, "orbital");
    assert.equal(ship.engineMode, "orbital");
    assert.equal(ship.cruiseSpeedKm, 200);
    assert(ship.position.equals(position));
    assert(ship.orientation.equals(orientation));
    assert(!("escapeBody" in ship.snapshot()));
  }
});

test("orbital selection is always available while warp and landing state gates remain separate", () => {
  const descending = new ShipDynamics();
  placeAboveGround(descending, "earth", 1);
  assert.equal(descending.startLanding(), null);
  assert.equal(descending.orbitalBlockReason, null);
  assert.equal(descending.startOrbitalEngine(), null);
  assert.equal(descending.engineMode, "orbital");
  assert.equal(descending.landingPhase, "descending");
  assert(descending.startWarp(), "automatic landing and warp must remain mutually exclusive");
  const warping = new ShipDynamics();
  assert.equal(warping.startWarp(), null);
  assert.equal(warping.orbitalBlockReason, null);
  assert.equal(warping.startOrbitalEngine(), null);
  assert.equal(warping.engineMode, "orbital");
  assert.equal(warping.warpPhase, "charging");
  assert(warping.startLanding(), "charging still blocks automatic landing");
});

test("all 26 moons have real parent-relative distances, valid saves and safe warp destinations", () => {
  const moons = JSON.parse(readFileSync(new URL("../shared/moons.json", import.meta.url), "utf8"));
  assert.equal(moons.length, 26);
  assert.equal(new Set(world.bodies.filter(body => bodySystem(body) === "solar").map(body => body.id)).size, 37);
  const ship = new ShipDynamics();
  for (const moon of moons) {
    const body = world.bodies.find(body => body.id === moon.id);
    const parent = world.bodies.find(body => body.id === moon.parentId);
    assert(Math.abs(body.radius * world.unitsKm - moon.radiusKm) < 1e-6);
    assert(Math.abs(Math.hypot(...body.position.map((n, axis) => n - parent.position[axis])) * world.unitsKm - moon.orbitRadiusKm) < 1e-5);
    ship.jump("earth");
    ship.target = moon.id;
    const departureSide = ship.targetRelative.negate().normalize();
    assert.equal(ship.startWarp(), null, moon.id);
    for (let i = 0; i < 300 && ship.warpPhase !== "ready"; i++) {
      ship.step(0.05, emptyInput());
      for (const obstacle of ship.activeBodies) {
        assert(ship.position.distanceTo(new THREE.Vector3().fromArray(obstacle.position)) > obstacle.radius, `moon route intersects ${obstacle.id}`);
      }
    }
    assert.equal(ship.warpPhase, "ready");
    assertNearbyArrival(ship, departureSide);
    assert.equal(ship.environment.body.id, moon.id);
    assert(ship.environment.altitudeKm >= 1099.99);
    assert(validateFlightState(ship.snapshot()));
    assert.equal(validateFlightState({ ...ship.snapshot(), version: 1 }), null);
  }
});

test("braking generates a decaying visual pulse; ordinary assisted drift does not", () => {
  const ship = new ShipDynamics();
  ship.position.set(1e6, 0, 0);
  ship.setCruiseSpeed(world.unitsKm);
  ship.velocity.set(0, 0, -1);
  ship.step(0.05, emptyInput());
  assert.equal(ship.deceleration, 0);
  ship.step(0.05, { ...emptyInput(), brake: true });
  assert(ship.deceleration > 0.5);
  const peak = ship.deceleration;
  ship.step(0.25, emptyInput());
  assert(ship.deceleration > 0 && ship.deceleration < peak);
});


test("former 1000 km and giant-atmosphere restrictions do not block user cruise, engine selection or warp", () => {
  for (const [id, groundAltitude] of [["earth", 1000], ["earth", 1000.1], ["jupiter", 1500]]) {
    const ship = new ShipDynamics();
    placeAboveGround(ship, id, groundAltitude);
    faceOutward(ship);
    ship.setEngineMode("interstellar");
    ship.setCruiseSpeed(700);
    ship.step(0.05, { ...emptyInput(), throttle: 1 });
    assert.equal(ship.engine.id, "interstellar");
    assert(Math.abs(speedKm(ship) - 700) < 1e-8);
    assert.equal(ship.warpBlockReason, null);
    assert.equal(ship.startWarp(), null);
  }
});

test("three Centauri stars and their planets use local coordinates and light-year navigation", () => {
  assert.equal(world.systems.length, 4);
  assert.equal(world.bodies.length, 44);
  const ship = new ShipDynamics();
  ship.target = "alpha-centauri-a";
  assert(Math.abs(ship.targetRelative.length() * world.unitsKm / world.lightYearKm - 4.37) < 0.001);
  const a = world.bodies.find(body => body.id === "alpha-centauri-a");
  const b = world.bodies.find(body => body.id === "alpha-centauri-b");
  assert(Math.abs(Math.hypot(...a.position.map((value, axis) => value - b.position[axis])) * world.unitsKm / world.auKm - 23.4) < 1e-8);
  assert.equal(a.kind, "star");
  ship.jump("proxima-b");
  assert.equal(ship.systemId, "proxima-centauri");
  assert.equal(ship.environment.body.id, "proxima-b");
  assert(ship.position.length() < 2000, "arrival coordinates stay precise and local");
  assert(validateFlightState(ship.snapshot()));
});

test("warps reach all Centauri bodies and return to Earth; transit snapshots remain restorable and routes avoid local stars", () => {
  const ship = new ShipDynamics();
  for (const target of ["alpha-centauri-a", "alpha-centauri-b", "proxima-centauri", "proxima-b", "proxima-d", "proxima-c", "betelgeuse", "earth"]) {
    ship.target = target;
    const departureSide = ship.targetRelative.negate().normalize();
    assert.equal(ship.startWarp(), null, target);
    let sawNewSystem = false;
    for (let i = 0; i < 320 && ship.warpPhase !== "ready"; i++) {
      ship.step(0.05, emptyInput());
      assert(validateFlightState(ship.snapshot()), `invalid transit save: ${target}`);
      if (ship.systemId !== "solar") sawNewSystem = true;
      for (const obstacle of ship.activeBodies) {
        assert(ship.position.distanceTo(new THREE.Vector3().fromArray(obstacle.position)) > obstacle.radius, `route intersects ${obstacle.id}`);
      }
    }
    assert.equal(ship.warpPhase, "ready");
    assertNearbyArrival(ship, departureSide);
    assert.equal(ship.environment.body.id, target);
    const restored = new ShipDynamics();
    assert(restored.restore(ship.snapshot()));
    assert.equal(restored.systemId, ship.systemId);
    assert(restored.position.equals(ship.position));
    if (target !== "earth") assert(sawNewSystem);
  }
});

test("Betelgeuse is a star-only red-supergiant system with real scale and restorable local coordinates", async (t) => {
  const bodies = world.bodies.filter(body => body.systemId === "betelgeuse");
  assert.deepEqual(bodies.map(body => body.id), ["betelgeuse"]);
  const star = bodies[0];
  assert.equal(star.kind, "star");
  assert(Math.abs(star.radius * world.unitsKm / 695700 - 764) < 1e-8);
  const ship = new ShipDynamics();
  ship.target = "betelgeuse";
  assert(Math.abs(ship.targetRelative.length() * world.unitsKm / world.lightYearKm - 548) < 0.001);
  ship.jump("betelgeuse");
  assert.match(ship.startLanding(), /恒星无法着陆/);
  const { url } = await fixture(t);
  const cookie = (await fetch(url + "/api/flight/save")).headers.get("set-cookie").split(";")[0];
  const saved = ship.snapshot();
  assert.equal((await fetch(url + "/api/flight/save", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(saved) })).status, 200);
  const stored = (await (await fetch(url + "/api/flight/save", { headers: { cookie } })).json()).state;
  const restored = new ShipDynamics();
  assert(restored.restore(stored));
  assert.equal(restored.systemId, "betelgeuse");
  assert.equal(restored.target, "betelgeuse");
  assert(restored.position.equals(ship.position));
  restored.position.set(0, 0, 0);
  restored.step(0.05, emptyInput());
  assert(restored.position.length() >= star.radius, "entity collision keeps the ship out of the photosphere");
  assert(restored.position.length() < star.radius * 1.0001, "the removed stellar protection bubble must not displace the ship far from the physical surface");
});

test("cancelling an interstellar warp preserves its coordinate frame and old saves default to the solar frame", () => {
  const ship = new ShipDynamics();
  ship.target = "proxima-b";
  assert.equal(ship.startWarp(), null);
  for (let i = 0; i < 130; i++) ship.step(0.05, emptyInput());
  assert.equal(ship.warpPhase, "transit");
  assert.equal(ship.systemId, "proxima-centauri");
  const saved = ship.snapshot();
  assert(Math.hypot(...saved.position) > 1e8);
  ship.cancelWarp();
  const restored = new ShipDynamics();
  assert(restored.restore(saved));
  assert.equal(restored.systemId, saved.systemId);
  assert(restored.position.equals(ship.position));
  for (let i = 0; i < 60; i++) ship.step(0.05, emptyInput());
  assert.equal(ship.startWarp(), null);
  const old = state(); delete old.systemId;
  assert.equal(validateFlightState(old).systemId, "solar");
  assert.equal(validateFlightState({ ...saved, systemId: "missing-system" }), null);
  assert.equal(validateFlightState({ ...saved, version: 1 }), null);
});

test("an atmospheric Proxima departure may immediately warp to an interstellar target", () => {
  const ship = new ShipDynamics();
  placeAboveGround(ship, "proxima-b", 1);
  ship.target = "earth";
  assert(ship.environment.atmospheric);
  assert.equal(ship.warpBlockReason, null);
  assert.equal(ship.startWarp(), null);
  for (let i = 0; i < 400 && ship.warpPhase !== "ready"; i++) ship.step(0.05, emptyInput());
  assert.equal(ship.warpPhase, "ready");
  assert.equal(ship.systemId, "solar");
  assert.equal(ship.environment.body.id, "earth");
});

function assertOutsideEntity(position, body) {
  const offset = position.clone().sub(new THREE.Vector3().fromArray(body.position));
  const distance = offset.length();
  const surface = surfaceProfile(body.id).solid
    ? terrainHeightKm(body.id, offset.clone().normalize().toArray()) + LANDING_CLEARANCE_KM : 0;
  const clearance = (distance - body.radius) * world.unitsKm - surface;
  assert(clearance >= -0.0001, `warp intersects physical ${body.id}`);
}

function assertNearbyArrival(ship, departureSide) {
  const target = world.bodies.find(body => body.id === ship.target);
  assert.equal(ship.systemId, bodySystem(target));
  const radial = ship.position.clone().sub(new THREE.Vector3().fromArray(target.position)).normalize();
  assert(radial.dot(departureSide) > 0.999999, `${target.id}: arrival must preserve the departure side`);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.orientation);
  assert(forward.dot(radial) < -0.99, `${target.id}: planet must remain ahead after arrival`);
  assert(ship.environment.altitudeKm >= 1099.99);
}

test("left, right and polar arrivals brake continuously with a fixed attitude", () => {
  const earth = world.bodies.find(body => body.id === "earth");
  for (const side of [new THREE.Vector3(-1,0,0),new THREE.Vector3(1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(0,0,1)]) {
    const ship = new ShipDynamics();
    ship.position.fromArray(earth.position).addScaledVector(side,15);
    if(side.z===1) ship.orientation.setFromUnitVectors(new THREE.Vector3(0,1,0),side);
    ship.target = "earth";
    assert.equal(ship.startWarp(),null);
    let arrivalStart, lastArrivalSpeed = Infinity, arrivalMovement = 0, lastTransitSpeed;
    for (let i=0; i<1500 && ship.warpPhase!=="cooldown"; i++) {
      const before = ship.warpPhase, previous = ship.position.clone(), facing = ship.orientation.clone();
      ship.step(0.01,emptyInput());
      if (before==="transit") lastTransitSpeed = ship.warpSpeedKm;
      if (before==="transit" && ship.warpPhase==="arrival") arrivalStart=ship.position.clone();
      if (before==="arrival") {
        arrivalMovement+=ship.position.distanceTo(previous);
        assert(ship.warpSpeedKm<=lastArrivalSpeed+1e-6,"arrival speed must decrease");
        if(lastArrivalSpeed===Infinity) assert(Math.abs(ship.warpSpeedKm-lastTransitSpeed)/lastTransitSpeed<0.04);
        lastArrivalSpeed=ship.warpSpeedKm;
        assert(ship.orientation.equals(facing),"arrival must not turn or level the ship");
        assert(ship.position.distanceTo(new THREE.Vector3().fromArray(earth.position))>1.17);
      }
    }
    assert.equal(ship.warpPhase,"cooldown");
    assert(arrivalStart && arrivalMovement>0.3);
    assertNearbyArrival(ship,side);
    assert(Math.abs(ship.environment.altitudeKm-1100)<1e-5);
    assert.equal(ship.warpSpeedKm,0);
  }
});

test("cancelling the arrival approach preserves position, orientation and a valid snapshot", () => {
  const ship = new ShipDynamics(); ship.target="mars";
  assert.equal(ship.startWarp(),null);
  while(ship.warpPhase!=="arrival") ship.step(0.05,emptyInput());
  ship.step(0.25,emptyInput());
  const position=ship.position.clone(),orientation=ship.orientation.clone();
  ship.cancelWarp();
  assert(ship.position.equals(position)); assert(ship.orientation.equals(orientation));
  const restored=new ShipDynamics(); assert(restored.restore(ship.snapshot()));
  assert(restored.position.equals(position)); assert.equal(ship.warpSpeedKm,0);
});

test("a distant planet grows continuously across the whole approach, including slow frames", () => {
  const earth = world.bodies.find(body => body.id === "earth");
  const center = new THREE.Vector3().fromArray(earth.position);
  for (const dt of [1 / 60, 0.1, 0.25]) {
    const ship = new ShipDynamics();
    ship.position.copy(center).add(new THREE.Vector3(0, 0, 256));
    ship.orientation.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.4);
    const attitude = ship.orientation.clone();
    ship.target = "earth";
    assert.equal(ship.startWarp(), null);
    while (ship.warpPhase !== "arrival") ship.step(dt, emptyInput());
    const entryAngle = Math.asin(earth.radius / ship.position.distanceTo(center));
    assert(entryAngle < 0.04, "braking must begin with a small planet, not a screen-filling globe");
    let previousAngle = entryAngle, previousSpeed = ship.warpSpeedKm, quarter = 0, halfway = 0;
    while (ship.warpPhase === "arrival") {
      const previousPosition = ship.position.clone();
      ship.step(dt, emptyInput());
      const angle = Math.asin(earth.radius / ship.position.distanceTo(center));
      assert(angle >= previousAngle, "planet must never shrink during approach");
      assert(angle - previousAngle < 0.18, "even a 250 ms frame must not jump from a dot to a large planet");
      assert(ship.position.distanceTo(previousPosition) <= previousSpeed * dt / world.unitsKm + 1e-8,
        "phase changes must not teleport the ship");
      assert(ship.warpSpeedKm <= previousSpeed + 1e-6);
      assert(ship.orientation.angleTo(attitude) < 1e-7, "keep the pilot's roll, with no final attitude adjustment");
      if (ship.warpProgress >= 0.25 && !quarter) quarter = angle;
      if (ship.warpProgress >= 0.5 && !halfway) halfway = angle;
      previousAngle = angle; previousSpeed = ship.warpSpeedKm;
    }
    assert(quarter > entryAngle * 3, "the zoom must already be visible in the first quarter");
    assert(halfway > quarter * 2 && halfway < previousAngle * 0.6, "growth must continue through both halves");
    assert(previousAngle > entryAngle * 25);
    assert(Math.abs(ship.environment.altitudeKm - 1100) < 1e-5);
    assert.equal(ship.warpSpeedKm, 0);
  }
});

test("a warp already inside the arrival margin preserves attitude and eases out to safety", () => {
  const earth = world.bodies.find(body => body.id === "earth");
  const ship = new ShipDynamics();
  ship.position.fromArray(earth.position).add(new THREE.Vector3(0, 0, earth.radius + 1001 / world.unitsKm));
  ship.orientation.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5);
  const facing = ship.orientation.clone();
  ship.target = "earth";
  assert.equal(ship.startWarp(), null);
  for (let i = 0; i < 200 && ship.warpPhase !== "ready"; i++) {
    ship.step(0.05, emptyInput());
    assert(ship.orientation.angleTo(facing) < 1e-7);
    assert(ship.environment.altitudeKm >= 1001 - 1e-5);
  }
  assert.equal(ship.warpPhase, "ready");
  assert(Math.abs(ship.environment.altitudeKm - 1100) < 1e-5);
});

test("physical hull length is 10 km, small beside Earth's diameter", () => {
  const model=createShip();
  const scale=SHIP_LENGTH_KM/(world.unitsKm*model.hullLength);
  model.group.scale.setScalar(scale); model.group.updateMatrixWorld(true);
  const hull=new THREE.Box3();
  for (const mesh of model.group.children.filter(child=>child instanceof THREE.Mesh)) hull.expandByObject(mesh);
  assert(Math.abs((hull.max.z-hull.min.z)*world.unitsKm-10)<1e-5);
  assert((hull.max.z-hull.min.z)/2<0.012);
});

test("render budget lowers sustained slow resolution and recovers slowly within its ceiling", () => {
  const budget=new RenderBudget(); budget.configure(true,3,1920,1080);
  assert(budget.ratio<=1.5); assert(1920*1080*budget.ratio**2<=2100000.01);
  const initial=budget.ratio;
  for(let i=0;i<240;i++)budget.sample(1/30);
  assert(budget.ratio<initial);assert(budget.ratio>=0.25);
  const low=budget.ratio;
  for(let i=0;i<120;i++)budget.sample(1/60);
  assert(budget.ratio<=low);
  for(let i=0;i<3000;i++)budget.sample(1/60);
  assert(budget.ratio>low);assert(budget.ratio<=initial);
  const previous=budget.ratio;budget.sample(0);budget.sample(5);assert.equal(budget.ratio,previous);
  const jitter=new RenderBudget();jitter.configure(true,1,1440,960);
  const sharp=jitter.ratio;
  for(let i=0;i<600;i++)jitter.sample(i%15===0?1/30:1/60);
  assert(jitter.ratio<sharp,"regular missed frames must reduce resolution even with a decent average FPS");
});

test("ultra quality preserves a 4K viewport and restores still-image detail after load", () => {
  const budget = new RenderBudget();
  budget.configure("ultra", 2, 3840, 2160);
  assert(budget.ratio >= 1, "4K screens should render at their native resolution");
  assert(3840 * 2160 * budget.ratio ** 2 <= 8_300_000.01);
  for (let i = 0; i < 240; i++) budget.sample(1 / 30);
  assert(budget.ratio < 1);
  assert(budget.rest());
  assert(budget.ratio >= 1);
  budget.configure("standard", 2, 3840, 2160);
  assert(3840 * 2160 * budget.ratio ** 2 <= 1_200_000.01);
});
