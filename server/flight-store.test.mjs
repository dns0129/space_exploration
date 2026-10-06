import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FlightStore } from "../src/flight-store.ts";
import { BrowserFlightSaves, FLIGHT_SAVE_KEY } from "../src/platform/browser-storage.ts";
import { HttpFlightBackend } from "../src/platform/http-flight-backend.ts";
import { createBrowserFlightServices } from "../src/platform/browser.ts";
import { world, validateFlightState } from "../shared/flight-state.mjs";

const state = (elapsed = 42) => ({
  version: 2, systemId: "solar", target: "earth", camera: "chase",
  position: [0, 0, 50], velocity: [0, 0, 0], orientation: [0, 0, 0, 1],
  assist: true, elapsed,
});
const memory = (initial = null) => {
  let value = initial;
  return { read: async () => value, write: async (saved) => { value = saved; } };
};
const backend = (overrides = {}) => ({
  readWorld: async () => world, readSave: async () => null,
  writeSave: async () => true, ...overrides,
});

test("the same save policy persists through a file adapter without browser globals", async (t) => {
  assert.equal(typeof document, "undefined");
  const folder = await mkdtemp(join(tmpdir(), "voyager-platform-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, "flight.json");
  const saves = {
    read: async () => JSON.parse(await readFile(file, "utf8")),
    write: async (saved) => writeFile(file, JSON.stringify(saved)),
  };
  const first = new FlightStore({ saves });
  assert.equal(await first.connect(), world);
  assert.equal(await first.read(), null);
  assert.equal(await first.save(state()), "local");
  const restarted = new FlightStore({ saves });
  assert.deepEqual(await restarted.read(), state());
});

test("compatible backend is used while keeping a recoverable local checkpoint", async () => {
  const saves = memory();
  const store = new FlightStore({ saves, backend: backend({ readSave: async () => state(99) }) });
  await store.connect();
  assert(store.online);
  assert.equal((await store.read()).elapsed, 99);
  assert.equal(await store.save(state()), "server");
  assert.deepEqual(await saves.read(), state());
});

test("incompatible worlds never send saves to the backend", async () => {
  let sent = false;
  const store = new FlightStore({ saves: memory(), backend: backend({
    readWorld: async () => ({ ...world, version: -1 }),
    writeSave: async () => { sent = true; return true; },
  }) });
  assert.equal(await store.connect(), world);
  assert.equal(await store.save(state()), "local");
  assert.equal(sent, false);
});

test("invalid remote saves and interrupted connections preserve local recovery", async () => {
  const saves = memory(state());
  const remote = backend({ readSave: async () => ({ version: 2, target: "invalid" }) });
  const store = new FlightStore({ saves, backend: remote });
  await store.connect();
  assert.deepEqual(await store.read(), state());
  remote.readSave = async () => { throw new Error("Disconnected"); };
  assert.deepEqual(await store.read(), state());
  assert.equal(store.online, false);
  await store.connect();
  remote.writeSave = async () => false;
  assert.equal(await store.save(state(77)), "local");
  assert.deepEqual(await store.read(), state(77));
});

test("server saving still works when obtaining browser storage throws", async () => {
  const saves = new BrowserFlightSaves(() => { throw new Error("Storage disabled"); });
  const store = new FlightStore({ saves, backend: backend() });
  await store.connect();
  assert.equal(await store.save(state()), "server");
  const offline = new FlightStore({ saves });
  assert.equal(await offline.read(), null);
  await assert.rejects(offline.save(state()), /无法保存航行/);
});

test("invalid checkpoints cannot reach either storage adapter", async () => {
  let writes = 0;
  const store = new FlightStore({
    saves: { read: async () => null, write: async () => { writes++; } },
    backend: backend({ writeSave: async () => { writes++; return true; } }),
  });
  await store.connect();
  await assert.rejects(store.save({ ...state(), elapsed: Infinity }), /Invalid flight state/);
  assert.equal(writes, 0);
});

test("the original browser key and legacy checkpoints remain readable", async () => {
  const legacy = { ...state(), version: 1, position: [0, 0, 44], velocity: [2, 0, 0] };
  const values = new Map([["voyager-flight-v1", JSON.stringify(legacy)]]);
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(FLIGHT_SAVE_KEY, "voyager-flight-v1");
  const store = new FlightStore({ saves: new BrowserFlightSaves(() => storage) });
  assert.deepEqual(await store.read(), validateFlightState(legacy));
  await store.save(state());
  assert.deepEqual(JSON.parse(values.get("voyager-flight-v1")), state());
  values.set("voyager-flight-v1", "broken JSON");
  assert.equal(await store.read(), null);
});

test("Pages, file exports and offline development do not make backend requests", async () => {
  let requests = 0;
  for (const options of [
    { publicSite: true, protocol: "https:", online: true },
    { publicSite: false, protocol: "file:", online: true },
    { publicSite: false, protocol: "http:", online: false },
  ]) {
    const values = new Map();
    const services = createBrowserFlightServices({
      ...options, isOnline: () => options.online,
      storage: () => ({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }),
      request: async () => { requests++; throw new Error("Unexpected backend request"); },
    });
    const store = new FlightStore(services);
    assert.equal(await store.connect(), world);
    assert.equal(await store.save(state()), "local");
    assert.deepEqual(await store.read(), state());
  }
  assert.equal(requests, 0);
});

test("HTTP adapter supports an explicit backend origin and unchanged save payload", async () => {
  const calls = [];
  const remote = new HttpFlightBackend(async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith("/world") ? world : { state: state() });
  }, "https://game.example/api/");
  assert.deepEqual(await remote.readWorld(), world);
  assert.deepEqual(await remote.readSave(), state());
  assert.equal(await remote.writeSave(state()), true);
  assert.equal(calls[0].url, "https://game.example/api/world");
  assert.equal(calls[2].url, "https://game.example/api/flight/save");
  assert.equal(calls[2].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[2].options.body), state());
});

test("overlapping asynchronous saves finish in order and capture their original state", async () => {
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const checkpoints = [];
  const saves = {
    read: async () => checkpoints.at(-1),
    write: async (saved) => {
      if (saved.elapsed === 1) { firstStarted(); await gate; }
      checkpoints.push(saved);
    },
  };
  const store = new FlightStore({ saves });
  const first = store.save(state(1));
  await started;
  const last = state(2);
  const second = store.save(last);
  last.elapsed = 999;
  assert.equal(checkpoints.length, 0);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(checkpoints.map((saved) => saved.elapsed), [1, 2]);
  assert.equal((await store.read()).elapsed, 2);
});

test("a failed checkpoint does not block later saves", async () => {
  const saves = memory();
  const write = saves.write;
  saves.write = async (saved) => {
    if (saved.elapsed === 1) throw new Error("Disk temporarily unavailable");
    await write(saved);
  };
  const store = new FlightStore({ saves });
  const first = store.save(state(1));
  const second = store.save(state(2));
  await assert.rejects(first, /无法保存航行/);
  assert.equal(await second, "local");
  assert.equal((await store.read()).elapsed, 2);
});
