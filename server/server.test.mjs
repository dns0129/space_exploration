import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVoyagerServer } from "./server.mjs";
import { world, validateFlightState } from "../shared/flight-state.mjs";
import { ShipDynamics, emptyInput } from "../src/ship-dynamics.ts";
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
test("backend serves the game and nine-body world; blocks invalid files and methods", async (t) => {
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
  const ship = new ShipDynamics({ ...world, boostSpeed: 120 });
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
