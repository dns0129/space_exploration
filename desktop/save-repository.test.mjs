import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesktopSaveRepository, MAX_SAVE_BYTES } from "./save-repository.mjs";
import { validateFlightState } from "../shared/flight-state.mjs";

const state = (elapsed = 42) => ({
  version: 2, systemId: "solar", target: "earth", camera: "chase",
  position: [0, 0, 50], velocity: [0, 0, 0], orientation: [0, 0, 0, 1], assist: true, elapsed,
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "voyager-desktop-save-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, saves: new DesktopSaveRepository(directory) };
}

test("desktop checkpoints persist across repository instances using a fixed user-data file", async (t) => {
  const { directory, saves } = await fixture(t);
  assert.equal(await saves.read(), null);
  await saves.write(state());
  await saves.flush();
  assert.deepEqual(await new DesktopSaveRepository(directory).read(), state());
  assert.deepEqual(await readdir(directory), ["flight.json"]);
  if (process.platform !== "win32") assert.equal((await stat(saves.file)).mode & 0o077, 0);
});

test("queued file writes retain invocation order and clone each checkpoint immediately", async (t) => {
  const { saves } = await fixture(t);
  const checkpoints = Array.from({ length: 25 }, (_, index) => state(index));
  const writes = checkpoints.map((checkpoint) => saves.write(checkpoint));
  checkpoints.at(-1).elapsed = 999;
  checkpoints.at(-1).position[0] = 999;
  await Promise.all(writes);
  assert.deepEqual(await saves.read(), state(24));
});

test("atomic replacements never expose a partly written JSON checkpoint", async (t) => {
  const { saves } = await fixture(t);
  await saves.write(state(0));
  let finished = false;
  const writes = Promise.all(Array.from({ length: 20 }, (_, index) => saves.write(state(index + 1)))).finally(() => { finished = true; });
  let observations = 0;
  do {
    const observed = JSON.parse(await readFile(saves.file, "utf8"));
    assert(validateFlightState(observed));
    assert(observed.elapsed >= 0 && observed.elapsed <= 20);
    observations++;
  } while (!finished);
  await writes;
  assert(observations > 0);
  assert.equal((await saves.read()).elapsed, 20);
});

test("invalid and oversized input leave the existing checkpoint unchanged", async (t) => {
  const { saves } = await fixture(t);
  await saves.write(state());
  const original = await readFile(saves.file, "utf8");
  await assert.rejects(saves.write({ ...state(), elapsed: Infinity }), /无效/);
  await assert.rejects(saves.write({ ...state(), padding: "x".repeat(MAX_SAVE_BYTES) }), /8 KiB/);
  const cyclic = state(); cyclic.extra = cyclic;
  await assert.rejects(saves.write(cyclic), /无效/);
  assert.equal(await readFile(saves.file, "utf8"), original);
});

test("failed atomic renames clean temporary files and do not poison later writes", async (t) => {
  const { directory, saves } = await fixture(t);
  await mkdir(saves.file);
  await assert.rejects(saves.write(state(1)));
  await assert.rejects(saves.flush());
  assert.deepEqual(await readdir(directory), ["flight.json"]);
  await rm(saves.file, { recursive: true });
  await saves.write(state(2));
  await saves.flush();
  assert.equal((await saves.read()).elapsed, 2);
});

test("legacy saves migrate while broken, oversized and symlinked files stay unreadable", async (t) => {
  const { directory, saves } = await fixture(t);
  const legacy = { ...state(), version: 1, position: [0, 0, 44], velocity: [2, 0, 0] };
  await writeFile(saves.file, JSON.stringify(legacy));
  assert.deepEqual(await saves.read(), validateFlightState(legacy));
  await writeFile(saves.file, "{broken");
  assert.equal(await saves.read(), null);
  await writeFile(saves.file, "x".repeat(MAX_SAVE_BYTES + 1));
  assert.equal(await saves.read(), null);
  await rm(saves.file);
  const other = join(directory, "other.json");
  await writeFile(other, JSON.stringify(state()));
  try { await symlink(other, saves.file, "file"); }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Windows lacks permission to create file symlinks; legacy, corrupt and oversized file checks completed.");
      return;
    }
    throw error;
  }
  assert.equal(await saves.read(), null);
});
