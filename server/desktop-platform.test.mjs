import { test } from "node:test";
import assert from "node:assert/strict";
import { createDesktopFlightServices, requireDesktopBridge } from "../src/platform/desktop.ts";
import { FlightStore } from "../src/flight-store.ts";
import { world } from "../shared/flight-state.mjs";

const checkpoint = (elapsed = 42) => ({
  version: 2, systemId: "solar", target: "earth", camera: "chase",
  position: [0, 0, 50], velocity: [0, 0, 0], orientation: [0, 0, 0, 1],
  assist: true, elapsed,
});
const bridge = (overrides = {}) => ({
  version: 1, readSave: async () => null, writeSave: async () => {},
  onBeforeClose: () => () => {}, readyToClose: async () => {}, ...overrides,
});

test("desktop launch requires the complete compatible native bridge", () => {
  for (const value of [undefined, {}, bridge({ version: 2 }), bridge({ readyToClose: undefined })])
    assert.throws(() => requireDesktopBridge(value), /客户端存档接口/);
  const native = bridge();
  assert.equal(requireDesktopBridge(native), native);
});

test("desktop saves use only native storage and the shared world", async () => {
  let value;
  const services = createDesktopFlightServices(bridge({
    readSave: async () => value,
    writeSave: async state => { value = state; },
  }));
  assert.equal(services.backend, undefined);
  const store = new FlightStore(services);
  assert.equal(await store.connect(), world);
  assert.equal(store.online, false);
  assert.equal(await store.save(checkpoint()), "local");
  assert.deepEqual(await store.read(), checkpoint());
});

test("native write failure is reported instead of storing in the browser", async () => {
  const store = new FlightStore(createDesktopFlightServices(bridge({
    writeSave: async () => { throw new Error("disk full"); },
  })));
  await assert.rejects(store.save(checkpoint()), /无法保存航行/);
});

test("shutdown waits for every queued checkpoint before acknowledging close", async () => {
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const written = [];
  const store = new FlightStore(createDesktopFlightServices(bridge({
    writeSave: async state => { if (state.elapsed === 1) await first; written.push(state.elapsed); },
  })));
  const saving = [store.save(checkpoint(1)), store.save(checkpoint(2))];
  let flushed = false;
  const flush = store.flush().then(() => { flushed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flushed, false);
  release();
  await Promise.all([...saving, flush]);
  assert.deepEqual(written, [1, 2]);
});

test("shutdown reports a failed checkpoint even after leaving flight, and a later successful save recovers", async () => {
  let fail = true;
  const store = new FlightStore(createDesktopFlightServices(bridge({
    writeSave: async () => { if (fail) throw new Error("disk full"); },
  })));
  await assert.rejects(store.save(checkpoint()), /无法保存航行/);
  await assert.rejects(store.flush(), /无法保存航行/);
  fail = false;
  await store.save(checkpoint(43));
  await store.flush();
});
