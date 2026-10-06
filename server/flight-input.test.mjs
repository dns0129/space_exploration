import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyInput, FlightInputState, flightActionForKey } from "../src/core/flight-input.ts";
import { emptyInput as compatibleEmptyInput, ShipDynamics } from "../src/ship-dynamics.ts";

test("platform-independent input commands drive the existing simulation without a DOM", () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(compatibleEmptyInput, emptyInput);
  const input = new FlightInputState();
  input.setAction("forward", true, "controller:trigger");
  input.setAction("yawLeft", true, "controller:stick");
  const ship = new ShipDynamics();
  const before = ship.snapshot();
  ship.step(0.05, input.read());
  assert.notDeepEqual(ship.position.toArray(), before.position);
  assert.notDeepEqual(ship.orientation.toArray(), before.orientation);
});

test("opposing actions cancel while releasing one source preserves another source's hold", () => {
  const input = new FlightInputState();
  input.setAction("forward", true, "keyboard:KeyW");
  input.setAction("forward", true, "touch:KeyW");
  input.setAction("reverse", true, "keyboard:KeyS");
  assert.equal(input.read().throttle, 0);
  input.setAction("reverse", false, "keyboard:KeyS");
  input.setAction("forward", false, "touch:KeyW");
  assert.equal(input.read().throttle, 1);
  input.setAction("forward", false, "keyboard:KeyW");
  assert.equal(input.read().throttle, 0);

  input.setAction(flightActionForKey("ShiftLeft"), true, "keyboard:ShiftLeft");
  input.setAction(flightActionForKey("ShiftRight"), true, "keyboard:ShiftRight");
  input.setAction(flightActionForKey("ShiftLeft"), false, "keyboard:ShiftLeft");
  assert.equal(input.read().boost, true);
  input.setAction(flightActionForKey("ShiftRight"), false, "keyboard:ShiftRight");
  assert.equal(input.read().boost, false);
});

test("existing key bindings retain all six flight axes and brake", () => {
  const input = new FlightInputState();
  for (const code of ["KeyW", "KeyD", "KeyR", "ArrowLeft", "ArrowUp", "KeyQ", "Space"])
    input.setAction(flightActionForKey(code), true, `keyboard:${code}`);
  assert.deepEqual(input.read(), {
    ...emptyInput(), throttle: 1, strafe: 1, lift: 1, yaw: 1, pitch: 1, roll: 1, brake: true,
  });
  assert.equal(flightActionForKey("KeyH"), undefined);
});

test("steering retains its deadzone and limits, and clearing prevents stale commands", () => {
  const input = new FlightInputState();
  input.setSteering(0.04, -0.08);
  assert.equal(input.read().mouseX, 0);
  assert.equal(Math.abs(input.read().mouseY), 0);
  assert.deepEqual(input.aim, { x: 0.04, y: -0.08, active: true });
  input.setSteering(4, -4);
  assert.equal(input.read().mouseX, 1);
  assert.equal(input.read().mouseY, -1);
  input.setAction("forward", true, "keyboard:KeyW");
  input.setAction("boost", true, "touch:ShiftLeft");
  input.clear();
  assert.deepEqual(input.read(), emptyInput());
  assert.deepEqual(input.aim, { x: 0, y: 0, active: false });
});
