import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVoyagerServer } from "./server.mjs";
import { world, validateFlightState } from "../shared/flight-state.mjs";
import { ShipDynamics, emptyInput } from "../src/ship-dynamics.ts";
import * as THREE from "three";
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
      for (const body of world.bodies) {
        const distance = Math.hypot(...ship.position.toArray().map((n, axis) => n - body.position[axis]));
        assert(distance > body.radius * (body.id === "sun" ? 1.24 : 1.002), `route intersects ${body.id}`);
      }
      assert(validateFlightState(ship.snapshot()));
    }
    assert(sawTransit && movedInTransit && sawArrival);
    assert.equal(ship.warpPhase, "ready");
    const expected = new ShipDynamics(); expected.jump(target);
    assert(ship.position.distanceTo(expected.position) < 1e-8);
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
  assert.equal(new Set(world.bodies.map(body => body.id)).size, 35);
  const ship = new ShipDynamics();
  for (const moon of moons) {
    const body = world.bodies.find(body => body.id === moon.id);
    const parent = world.bodies.find(body => body.id === moon.parentId);
    assert(Math.abs(body.radius * world.unitsKm - moon.radiusKm) < 1e-6);
    assert(Math.abs(Math.hypot(...body.position.map((n, axis) => n - parent.position[axis])) * world.unitsKm - moon.orbitRadiusKm) < 1e-5);
    ship.jump("earth");
    ship.target = moon.id;
    assert.equal(ship.startWarp(), null, moon.id);
    for (let i = 0; i < 300 && ship.warpPhase !== "ready"; i++) {
      ship.step(0.05, emptyInput());
      for (const obstacle of world.bodies) {
        assert(ship.position.distanceTo(new THREE.Vector3().fromArray(obstacle.position)) > obstacle.radius * (obstacle.id === "sun" ? 1.24 : 1.002), `moon route intersects ${obstacle.id}`);
      }
    }
    assert.equal(ship.warpPhase, "ready");
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
  ship.position.fromArray(jupiter.position).add(new THREE.Vector3(0, 0, jupiter.radius + 1500 / world.unitsKm));
  assert(ship.environment.atmospheric);
  assert(!ship.environment.restricted);
  assert.equal(ship.engine.id, "interstellar");
  assert.equal(ship.warpBlockReason, null);
});
