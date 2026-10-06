import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVoyagerServer } from "./server.mjs";
import { world, validateFlightState } from "../shared/flight-state.mjs";
import { bodySystem } from "../shared/world-navigation.mjs";
import { ShipDynamics, emptyInput } from "../src/ship-dynamics.ts";
import * as THREE from "three";
import { RenderBudget } from "../src/render-budget.ts";
import { createShip, SHIP_LENGTH_KM } from "../src/ship-model.ts";
import { projectFlightTarget } from "../src/flight-target.ts";
const state = () => new ShipDynamics().snapshot();
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
    JSON.stringify({ ...saved, position: [1e99, 0, 0] }),
    JSON.stringify({ ...saved, target: "pluto" }),
  ])
    assert.equal(
      (await fetch(url + "/api/flight/save", { method: "POST", headers, body }))
        .status,
      400,
    );
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
  assert(ship.velocity.length() > 0.003);
  assert(ship.orientation.angleTo(new ShipDynamics().orientation) > 0.2);
  const speed = ship.velocity.length();
  for (let i = 0; i < 15; i++)
    ship.step(0.05, { ...emptyInput(), brake: true });
  assert(ship.velocity.length() < speed * 0.01);
  assert(validateFlightState(ship.snapshot()));
});
test("continuous collision protection stops a fast ship before it tunnels through Earth", () => {
  const ship = new ShipDynamics({ ...world, boostSpeed: 120,
    engines: world.engines.map((engine) => engine.id === "orbital" ? { ...engine, maxSpeedKm: 120 * world.unitsKm } : engine) });
  const earth = world.bodies.find((body) => body.id === "earth");
  const center = { x: earth.position[0], y: earth.position[1], z: earth.position[2] };
  ship.position.set(center.x, center.y, center.z - 3);
  ship.velocity.set(0, 0, 120);
  ship.assist = false;
  ship.step(0.05, emptyInput());
  assert.equal(ship.collision, "earth");
  assert.equal(ship.velocity.length(), 0);
  assert(ship.position.distanceTo(center) >= earth.radius * 1.002);
  const saved = ship.snapshot();
  const restored = new ShipDynamics();
  assert(restored.restore(saved));
  assert.deepEqual(restored.snapshot(), saved);
  assert.equal(
    restored.restore({ ...saved, position: [Infinity, 0, 0] }),
    false,
  );
});

test("propulsion switches at 100 and 10000 km/s, including restored flight states", () => {
  const ship = new ShipDynamics();
  ship.position.set(1e6, 0, 0);
  for (const [speed, engine] of [
    [0, "orbital"], [1, "orbital"], [99.9, "orbital"],
    [100, "planetary"], [9999.9, "planetary"],
    [10000, "interstellar"], [50000, "interstellar"],
  ]) {
    ship.velocity.set(speed / world.unitsKm, 0, 0);
    assert.equal(ship.engine.id, engine, `${speed} km/s`);
    const restored = new ShipDynamics();
    assert(restored.restore(ship.snapshot()));
    assert.equal(restored.engine.id, engine);
    assert(Math.abs(restored.velocity.length() * world.unitsKm - speed) < 1e-8);
  }
  const overspeed = ship.snapshot();
  overspeed.velocity = [60000 / world.unitsKm, 0, 0];
  assert(ship.restore(overspeed));
  assert(Math.abs(ship.velocity.length() * world.unitsKm - 50000) < 1e-8);
});

test("normal and boosted six-axis thrust reach 50000 km/s, brake through all engines and preserve inertia", () => {
  for (const boost of [false, true]) {
    const ship = new ShipDynamics();
    ship.position.set(1e6, 0, 0);
    const engines = new Set();
    for (let i = 0; i < 600; i++) {
      engines.add(ship.engine.id);
      ship.step(0.05, { ...emptyInput(), throttle: 1, strafe: 1, lift: 1, boost });
      assert(ship.velocity.length() * world.unitsKm <= 50000 + 1e-8);
    }
    assert.deepEqual([...engines], ["orbital", "planetary", "interstellar"]);
    assert(Math.abs(ship.velocity.length() * world.unitsKm - 50000) < 1e-8);
    assert(validateFlightState(ship.snapshot()));
    ship.assist = false;
    const velocity = ship.velocity.clone();
    const position = ship.position.clone();
    ship.step(0.05, emptyInput());
    assert(ship.velocity.distanceTo(velocity) < 1e-12);
    assert(ship.position.distanceTo(position.clone().addScaledVector(velocity, 0.05)) < 1e-8);
    const brakingEngines = new Set();
    for (let i = 0; i < 80; i++) {
      brakingEngines.add(ship.engine.id);
      ship.step(0.05, { ...emptyInput(), brake: true });
    }
    assert.deepEqual([...brakingEngines], ["interstellar", "planetary", "orbital"]);
    assert.equal(ship.velocity.length(), 0);
    assert.equal(ship.engine.id, "orbital");
  }
});

test("backend saves and restores the new maximum cruise speed", async (t) => {
  const { url } = await fixture(t);
  const cookie = (await fetch(url + "/api/flight/save")).headers.get("set-cookie").split(";")[0];
  const saved = state();
  saved.velocity = [50000 / world.unitsKm, 0, 0];
  const response = await fetch(url + "/api/flight/save", {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(saved),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await (await fetch(url + "/api/flight/save", { headers: { cookie } })).json()).state, saved);
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
        assert(distance > body.radius * (body.kind === "star" ? 1.24 : 1.002), `route intersects ${body.id}`);
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
    assert(ship.position.length() > world.bodies[0].radius * 1.24);
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

test("planet proximity blocks warp without changing position or cooldown; changing target cannot bypass atmosphere", () => {
  const ship = new ShipDynamics();
  const earth = world.bodies.find((body) => body.id === "earth");
  const place = (altitudeKm) => ship.position.fromArray(earth.position).add(new THREE.Vector3(0, 0, earth.radius + altitudeKm / world.unitsKm));
  ship.target = "earth";
  for (const altitude of [100, 500, 1000]) {
    place(altitude);
    const previous = ship.snapshot();
    assert(ship.startWarp());
    assert.equal(ship.warpPhase, "ready");
    assert.deepEqual(ship.snapshot(), previous);
  }
  place(1001);
  assert.equal(ship.startWarp(), null);
  ship.cancelWarp();
  for (let i = 0; i < 50; i++) ship.step(0.05, emptyInput());
  place(50);
  ship.target = "mars";
  assert.match(ship.startWarp(), /1000 km/);
  assert.equal(ship.warpPhase, "ready");
});

test("inward or tangential flight below 1000 km uses the orbital engine, even with boost, assistance off and restored high speeds", () => {
  const ship = new ShipDynamics();
  const earth = world.bodies.find((body) => body.id === "earth");
  for (const [altitude, atmosphere] of [[50, true], [999, false]]) {
    ship.position.fromArray(earth.position).add(new THREE.Vector3(earth.radius + altitude / world.unitsKm, 0, 0));
    ship.velocity.set(0, 0, -50000 / world.unitsKm);
    ship.assist = false;
    assert.equal(ship.environment.atmospheric, atmosphere);
    assert.equal(ship.engine.id, "orbital");
    const restored = new ShipDynamics();
    assert(restored.restore(ship.snapshot()));
    assert(restored.velocity.length() * world.unitsKm <= 100 + 1e-8);
    for (let i = 0; i < 20; i++) {
      ship.step(0.05, { ...emptyInput(), throttle: 1, boost: true });
      assert.equal(ship.engine.id, "orbital");
      assert(ship.velocity.length() * world.unitsKm <= 100 + 1e-8);
    }
  }
  const threshold = Math.max(world.flightSafety.nearSurfaceMinKm, earth.radius * world.unitsKm * world.flightSafety.nearSurfaceRadiusFactor);
  ship.position.fromArray(earth.position).add(new THREE.Vector3(earth.radius + (threshold + 1) / world.unitsKm, 0, 0));
  ship.orientation.identity();
  ship.velocity.set(0, 0, -10000 / world.unitsKm);
  assert.equal(ship.engine.id, "interstellar");
  ship.step(0.05, { ...emptyInput(), throttle: 1, boost: true });
  assert(ship.velocity.length() * world.unitsKm > 10000);
});

test("a long frame cannot skip a planet safety zone and slow frame integration retains elapsed time", () => {
  const ship = new ShipDynamics();
  const earth = world.bodies.find((body) => body.id === "earth");
  ship.position.fromArray(earth.position).add(new THREE.Vector3(earth.radius + 4000 / world.unitsKm, 0, 0));
  ship.velocity.set(-50000 / world.unitsKm, 0, 0);
  ship.assist = false;
  ship.step(0.25, emptyInput());
  assert.equal(ship.elapsed, 0.25);
  assert(ship.position.distanceTo(new THREE.Vector3().fromArray(earth.position)) > earth.radius);
  assert(ship.velocity.length() * world.unitsKm <= 100 + 1e-8);
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


test("outward planetary launch below 100 km crosses the safety shell, restores and relocks when facing inward", () => {
  const earth = world.bodies.find(body => body.id === "earth");
  const ship = new ShipDynamics();
  ship.position.fromArray(earth.position).add(new THREE.Vector3(0, 0, earth.radius + 99 / world.unitsKm));
  ship.orientation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  assert.equal(ship.engine.id, "planetary");
  assert.match(ship.startWarp(), /1000 km/);
  ship.step(0.05, { ...emptyInput(), throttle: 1, boost: true });
  assert(ship.environment.altitudeKm > 100);
  assert(ship.environment.escaping);
  assert(ship.velocity.length() * world.unitsKm > 100);
  const restored = new ShipDynamics();
  assert(restored.restore(ship.snapshot()));
  assert(restored.environment.escaping);
  assert(restored.velocity.equals(ship.velocity));
  ship.orientation.identity();
  ship.step(0.05, emptyInput());
  assert(ship.velocity.length() * world.unitsKm <= 100 + 1e-8);
  assert(ship.deceleration > 0.5);
  restored.step(0.25, { ...emptyInput(), throttle: 1, boost: true });
  restored.step(0.25, { ...emptyInput(), throttle: 1, boost: true });
  assert(restored.environment.altitudeKm > 1000);
  assert.equal(restored.warpBlockReason, null);
  const direct = new ShipDynamics();
  direct.position.fromArray(earth.position).add(new THREE.Vector3(0, 0, earth.radius + 101 / world.unitsKm));
  direct.orientation.copy(restored.orientation);
  assert.equal(direct.engine.id, "orbital", "a departure can only start inside 100 km");
  direct.position.fromArray(earth.position).add(new THREE.Vector3(0, 0, earth.radius + 99 / world.unitsKm));
  direct.velocity.set(0, 0, -1);
  assert.equal(direct.engine.id, "orbital", "inward drift must brake before launch");
});

test("all 26 moons have real parent-relative distances, valid saves and safe warp destinations", () => {
  const moons = JSON.parse(readFileSync(new URL("../shared/moons.json", import.meta.url), "utf8"));
  assert.equal(moons.length, 26);
  assert.equal(new Set(world.bodies.filter(body => bodySystem(body) === "solar").map(body => body.id)).size, 35);
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
        assert(ship.position.distanceTo(new THREE.Vector3().fromArray(obstacle.position)) > obstacle.radius * (obstacle.kind === "star" ? 1.24 : 1.002), `moon route intersects ${obstacle.id}`);
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
  ship.velocity.set(0, 0, -1);
  ship.step(0.05, emptyInput());
  assert.equal(ship.deceleration, 0);
  ship.step(0.05, { ...emptyInput(), brake: true });
  assert(ship.deceleration > 0.5);
  const peak = ship.deceleration;
  ship.step(0.25, emptyInput());
  assert(ship.deceleration > 0 && ship.deceleration < peak);
});


test("every body uses the same 1000 km boundary, including large atmospheres", () => {
  const ship = new ShipDynamics();
  ship.orientation.identity();
  for (const body of world.bodies) {
    ship.systemId = bodySystem(body);
    ship.target = body.id;
    ship.position.fromArray(body.position).add(new THREE.Vector3(0, 0, body.radius + 1000 / world.unitsKm));
    ship.velocity.set(0, 0, 0);
    assert(ship.environment.restricted, `${body.id}: exactly 1000 km is restricted`);
    assert.equal(ship.engine.id, "orbital");
    assert(ship.warpBlockReason);
    ship.position.z += 0.1 / world.unitsKm;
    assert(!ship.environment.restricted, `${body.id}: above 1000 km is open`);
    ship.velocity.set(0, 0, -10000 / world.unitsKm);
    assert.equal(ship.engine.id, "interstellar");
    assert.equal(ship.warpBlockReason, null);
  }
  const jupiter = world.bodies.find(body => body.id === "jupiter");
  ship.systemId = "solar";
  ship.target = "mars";
  ship.position.fromArray(jupiter.position).add(new THREE.Vector3(0, 0, jupiter.radius + 1500 / world.unitsKm));
  assert(ship.environment.atmospheric);
  assert(!ship.environment.restricted);
  assert.equal(ship.engine.id, "interstellar");
  assert.equal(ship.warpBlockReason, null);
});


test("three Centauri stars and their planets use local coordinates and light-year navigation", () => {
  assert.equal(world.systems.length, 4);
  assert.equal(world.bodies.length, 42);
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
        assert(ship.position.distanceTo(new THREE.Vector3().fromArray(obstacle.position)) > obstacle.radius * (obstacle.kind === "star" ? 1.24 : 1.002), `route intersects ${obstacle.id}`);
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
  assert(restored.position.length() >= star.radius * 1.24, "stellar shield keeps the ship out of the photosphere");
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

test("a near Proxima planet blocks an interstellar target, outward departure still works", () => {
  const ship = new ShipDynamics();
  const body = world.bodies.find(body => body.id === "proxima-b");
  ship.jump("proxima-b");
  ship.position.fromArray(body.position).add(new THREE.Vector3(0, 0, body.radius + 50 / world.unitsKm));
  ship.orientation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  ship.target = "earth";
  assert.equal(ship.engine.id, "planetary");
  assert.match(ship.startWarp(), /1000 km/);
  for (let i = 0; i < 15; i++) ship.step(0.05, { ...emptyInput(), throttle: 1, boost: true });
  assert(ship.environment.altitudeKm > 1000);
  assert.equal(ship.startWarp(), null);
});

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

test("physical hull length is 150 km, small beside Earth's diameter", () => {
  const model=createShip();
  const scale=SHIP_LENGTH_KM/(world.unitsKm*model.hullLength);
  model.group.scale.setScalar(scale); model.group.updateMatrixWorld(true);
  const hull=new THREE.Box3();
  for (const mesh of model.group.children.filter(child=>child instanceof THREE.Mesh)) hull.expandByObject(mesh);
  assert(Math.abs((hull.max.z-hull.min.z)*world.unitsKm-150)<1e-5);
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
