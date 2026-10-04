/** Platform-independent commands consumed by the flight simulation. */
export interface FlightInput {
  throttle: number;
  strafe: number;
  lift: number;
  yaw: number;
  pitch: number;
  roll: number;
  boost: boolean;
  brake: boolean;
  mouseX: number;
  mouseY: number;
}

export const emptyInput = (): FlightInput => ({
  throttle: 0,
  strafe: 0,
  lift: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  boost: false,
  brake: false,
  mouseX: 0,
  mouseY: 0,
});

export interface FlightAim {
  x: number;
  y: number;
  active: boolean;
}

/** A browser, gamepad or desktop adapter can supply the same flight commands. */
export interface InputSource {
  read(): FlightInput;
  readonly aim: FlightAim;
  clear(): void;
  dispose(): void;
}

export type FlightAction =
  | "forward" | "reverse" | "right" | "left" | "up" | "down"
  | "yawLeft" | "yawRight" | "pitchUp" | "pitchDown"
  | "rollLeft" | "rollRight" | "boost" | "brake";

const keyActions = new Map<string, FlightAction>([
  ["KeyW", "forward"], ["KeyS", "reverse"],
  ["KeyD", "right"], ["KeyA", "left"],
  ["KeyR", "up"], ["KeyF", "down"],
  ["ArrowLeft", "yawLeft"], ["ArrowRight", "yawRight"],
  ["ArrowUp", "pitchUp"], ["ArrowDown", "pitchDown"],
  ["KeyQ", "rollLeft"], ["KeyE", "rollRight"],
  ["ShiftLeft", "boost"], ["ShiftRight", "boost"],
  ["Space", "brake"],
]);

export const flightActionForKey = (code: string): FlightAction | undefined =>
  keyActions.get(code);

/** Stores held actions without depending on DOM events or a rendering engine. */
export class FlightInputState {
  private readonly sources = new Map<string, Set<FlightAction>>();
  private steeringX = 0;
  private steeringY = 0;
  private steering = false;

  setAction(action: FlightAction, pressed: boolean, source: string) {
    if (pressed) {
      let actions = this.sources.get(source);
      if (!actions) this.sources.set(source, actions = new Set());
      actions.add(action);
    } else {
      const actions = this.sources.get(source);
      actions?.delete(action);
      if (actions?.size === 0) this.sources.delete(source);
    }
  }

  setSteering(x: number, y: number) {
    this.steeringX = Math.max(-1, Math.min(1, x));
    this.steeringY = Math.max(-1, Math.min(1, y));
    this.steering = true;
  }

  get aim(): FlightAim {
    return { x: this.steeringX, y: this.steeringY, active: this.steering };
  }

  read(): FlightInput {
    const has = (action: FlightAction) => {
      for (const actions of this.sources.values())
        if (actions.has(action)) return true;
      return false;
    };
    const value = (positive: FlightAction, negative: FlightAction) =>
      Number(has(positive)) - Number(has(negative));
    const deadzone = (value: number) =>
      Math.sign(value) * Math.max(0, (Math.abs(value) - 0.08) / 0.92);
    return {
      throttle: value("forward", "reverse"),
      strafe: value("right", "left"),
      lift: value("up", "down"),
      yaw: value("yawLeft", "yawRight"),
      pitch: value("pitchUp", "pitchDown"),
      roll: value("rollLeft", "rollRight"),
      boost: has("boost"),
      brake: has("brake"),
      mouseX: deadzone(this.steeringX),
      mouseY: deadzone(this.steeringY),
    };
  }

  centerSteering() {
    this.steeringX = 0;
    this.steeringY = 0;
    this.steering = false;
  }

  clear() {
    this.sources.clear();
    this.centerSteering();
  }
}
