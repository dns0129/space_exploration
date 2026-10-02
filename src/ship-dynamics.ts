import * as THREE from "three";
import { world, validateFlightState } from "../shared/flight-state.mjs";
import type { FlightState, WorldConfig } from "../shared/flight-state.mjs";
import type { BodyId } from "./solar-system";
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
export class ShipDynamics {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly orientation = new THREE.Quaternion();
  readonly angularVelocity = new THREE.Vector3();
  bank = 0;
  target: BodyId = "earth";
  camera: "cockpit" | "chase" = "cockpit";
  assist = true;
  elapsed = 0;
  collision: BodyId | null = null;
  readonly config: WorldConfig;
  warpPhase: "ready" | "charging" | "transit" | "arrival" | "cooldown" = "ready";
  warpProgress = 0;
  warpSpeedKm = 0;
  private warpClock = 0;
  private warpRoute: THREE.Vector3[] = [];
  private warpLength = 0;
  private warpTarget: BodyId = "earth";
  constructor(config: WorldConfig = world) {
    this.config = config;
    this.jump("earth");
  }
  jump(id: BodyId) {
    this.resetWarp();
    const body = this.config.bodies.find((b) => b.id === id)!;
    const center = new THREE.Vector3().fromArray(body.position);
    const side =
      id === "sun"
        ? new THREE.Vector3(0, 0.2, -1)
        : center
            .clone()
            .negate()
            .normalize()
            .add(new THREE.Vector3(0, 0.18, 0))
            .normalize();
    const distance = body.radius * (id === "saturn" ? 5 : 3.8);
    this.position.copy(center).addScaledVector(side, distance);
    this.velocity.set(0, 0, 0);
    this.target = id;
    this.align();
    this.collision = null;
  }
  align() {
    this.angularVelocity.set(0, 0, 0);
    this.bank = 0;
    const b = this.config.bodies.find((b) => b.id === this.target)!;
    this.orientation.setFromRotationMatrix(
      new THREE.Matrix4().lookAt(
        this.position,
        new THREE.Vector3().fromArray(b.position),
        new THREE.Vector3(0, 1, 0),
      ),
    );
  }
  snapshot(): FlightState {
    return {
      version: 2,
      position: this.position.toArray(),
      velocity: this.velocity.toArray(),
      orientation: this.orientation.toArray(),
      target: this.target,
      camera: this.camera,
      assist: this.assist,
      elapsed: this.elapsed,
    };
  }
  restore(value: unknown) {
    const saved = validateFlightState(value);
    if (!saved) return false;
    this.resetWarp();
    this.position.fromArray(saved.position);
    this.velocity.fromArray(saved.velocity).clampLength(0, this.config.boostSpeed);
    this.orientation.fromArray(saved.orientation);
    this.angularVelocity.set(0, 0, 0);
    this.bank = 0;
    this.target = saved.target;
    this.camera = saved.camera;
    this.assist = saved.assist;
    this.elapsed = saved.elapsed;
    this.resolveCollision(this.position.clone());
    this.velocity.clampLength(0, this.speedLimit);
    return true;
  }
  get environment() {
    let body = this.config.bodies[0], altitudeKm = Infinity;
    for (const candidate of this.config.bodies) {
      const altitude = (Math.hypot(
        this.position.x - candidate.position[0],
        this.position.y - candidate.position[1],
        this.position.z - candidate.position[2],
      ) - candidate.radius) * this.config.unitsKm;
      if (altitude < altitudeKm) { body = candidate; altitudeKm = altitude; }
    }
    const nearHeightKm = Math.max(this.config.flightSafety.nearSurfaceMinKm,
      body.radius * this.config.unitsKm * this.config.flightSafety.nearSurfaceRadiusFactor);
    const atmospheric = !!body.atmosphereKm && altitudeKm <= body.atmosphereKm;
    const restricted = atmospheric || altitudeKm <= nearHeightKm;
    return { body, altitudeKm: Math.max(0, altitudeKm), atmospheric, restricted, nearHeightKm };
  }
  get speedLimit() {
    return this.environment.restricted
      ? this.config.engines[0].maxSpeedKm / this.config.unitsKm
      : this.config.boostSpeed;
  }
  get engine() {
    if (this.environment.restricted) return this.config.engines[0];
    const speedKm = this.velocity.length() * this.config.unitsKm;
    // Shared boundaries belong to the faster engine; stopping remains possible.
    return this.config.engines.find((engine) => speedKm < engine.maxSpeedKm)
      ?? this.config.engines[this.config.engines.length - 1];
  }
  step(seconds: number, input: FlightInput) {
    const duration = Math.max(0, Math.min(seconds, 0.25));
    if (!duration) return;
    if (this.warping) { this.stepWarp(duration); return; }
    for (let remaining = duration; remaining > 1e-9; remaining -= 0.05)
      this.stepManual(Math.min(remaining, 0.05), input);
  }
  private stepManual(dt: number, input: FlightInput) {
    if (!dt) return;
    if (this.warpPhase === "cooldown") {
      this.warpClock += dt;
      this.warpProgress = Math.min(1, this.warpClock / this.config.warp.cooldownSeconds);
      if (this.warpProgress >= 1) this.resetWarp();
    }
    const turn = new THREE.Vector3(
      THREE.MathUtils.clamp(input.pitch - input.mouseY, -1, 1) * 1.25,
      THREE.MathUtils.clamp(input.yaw - input.mouseX, -1, 1) * 1.25,
      input.roll * 1.7,
    );
    this.angularVelocity.lerp(turn, 1 - Math.exp(-dt * 9));
    this.bank = THREE.MathUtils.lerp(this.bank, -this.angularVelocity.y * 0.3, 1 - Math.exp(-dt * 5));
    const rotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        this.angularVelocity.x * dt,
        this.angularVelocity.y * dt,
        this.angularVelocity.z * dt,
        "YXZ",
      ),
    );
    this.orientation.multiply(rotation).normalize();
    if (this.assist && !input.strafe && !input.lift) {
      // Assisted flight carves a turn instead of sliding sideways indefinitely.
      const local = this.velocity.clone().applyQuaternion(this.orientation.clone().invert());
      const forwardSpeed = Math.sqrt(Math.max(0, this.velocity.lengthSq()
        - (local.x * local.x + local.y * local.y) * Math.exp(-dt * 7)));
      local.x *= Math.exp(-dt * 3.5);
      local.y *= Math.exp(-dt * 3.5);
      local.z = (local.z > 0 ? 1 : -1) * forwardSpeed;
      this.velocity.copy(local.applyQuaternion(this.orientation));
    }
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.orientation);
    const slowing = input.throttle < 0 && this.velocity.dot(forward) * this.config.unitsKm > 1;
    const acceleration = new THREE.Vector3(
      input.strafe,
      input.lift,
      slowing ? 0 : -input.throttle,
    );
    if (acceleration.lengthSq() > 1) acceleration.normalize();
    const engine = this.engine;
    acceleration
      .applyQuaternion(this.orientation)
      .multiplyScalar(
        (input.boost ? engine.boostAccelerationKm : engine.accelerationKm)
          / this.config.unitsKm,
      );
    this.velocity.addScaledVector(acceleration, dt);
    if (input.brake || slowing) this.velocity.multiplyScalar(Math.exp(-(input.brake ? 8 : 2.8) * dt));
    else if (this.assist) {
      this.velocity.multiplyScalar(Math.exp(-0.1 * dt));
    }
    this.velocity.clampLength(0, this.speedLimit);
    if (this.velocity.length() < 0.000000001) this.velocity.set(0, 0, 0);
    const previous = this.position.clone();
    // Check the swept path too: a fast frame cannot skip the low-speed zone.
    const travel = this.velocity.clone().multiplyScalar(dt);
    if (travel.lengthSq()) {
      for (const body of this.config.bodies) {
        const center = new THREE.Vector3().fromArray(body.position);
        const radius = body.radius + Math.max(this.config.flightSafety.nearSurfaceMinKm / this.config.unitsKm,
          body.radius * this.config.flightSafety.nearSurfaceRadiusFactor);
        const t = THREE.MathUtils.clamp(center.clone().sub(previous).dot(travel) / travel.lengthSq(), 0, 1);
        if (previous.clone().addScaledVector(travel, t).distanceTo(center) <= radius) {
          this.velocity.clampLength(0, this.config.engines[0].maxSpeedKm / this.config.unitsKm);
          break;
        }
      }
    }
    this.position.addScaledVector(this.velocity, dt);
    this.resolveCollision(previous);
    this.velocity.clampLength(0, this.speedLimit);
    this.elapsed += dt;
  }
  get warping() {
    return this.warpPhase === "charging" || this.warpPhase === "transit" || this.warpPhase === "arrival";
  }
  private resetWarp() {
    this.warpPhase = "ready";
    this.warpClock = 0;
    this.warpProgress = 0;
    this.warpSpeedKm = 0;
    this.warpRoute = [];
  }
  get warpBlockReason(): string | null {
    if (this.warpPhase !== "ready") return "跃迁引擎正在工作或冷却";
    const environment = this.environment;
    if (environment.atmospheric) return "大气层内仅可使用近地轨道引擎，请先离开大气层";
    if (environment.restricted) return "处于近行星安全区，请先远离天体再启动跃迁";
    const target = this.config.bodies.find((body) => body.id === this.target)!;
    const altitudeKm = (Math.hypot(...target.position.map((value, axis) => value - this.position.getComponent(axis)))
      - target.radius) * this.config.unitsKm;
    const minimumKm = Math.max(this.config.flightSafety.warpTargetMinKm,
      target.radius * this.config.unitsKm * this.config.flightSafety.warpTargetRadiusFactor);
    if (altitudeKm <= minimumKm) return "距离目标太近，无法启动跃迁，请直接驾驶接近";
    return null;
  }
  startWarp(): string | null {
    const blocked = this.warpBlockReason;
    if (blocked) return blocked;
    const target = this.config.bodies.find((b) => b.id === this.target)!;
    const destination = new ShipDynamics(this.config);
    destination.jump(this.target);
    if (destination.position.distanceTo(this.position) < target.radius * 0.01)
      return "已在目标附近，可自由驾驶接近";
    const points = [this.position.clone(), destination.position.clone()];
    // Route around the actual solid bodies instead of teleporting through them.
    let clear = false;
    for (let attempt = 0; attempt < 64; attempt++) {
      let obstacle = false;
      for (let i = 0; i < points.length - 1 && !obstacle; i++) {
        const a = points[i], b = points[i + 1];
        const line = b.clone().sub(a), lengthSq = line.lengthSq();
        for (const body of this.config.bodies) {
          const center = new THREE.Vector3().fromArray(body.position);
          const t = THREE.MathUtils.clamp(center.clone().sub(a).dot(line) / lengthSq, 0, 1);
          const closest = a.clone().addScaledVector(line, t);
          const radius = Math.max(body.radius * (body.id === "sun" ? 1.3 : 1.005),
            body.radius + Math.max(this.config.flightSafety.nearSurfaceMinKm / this.config.unitsKm,
              body.radius * this.config.flightSafety.nearSurfaceRadiusFactor));
          if (closest.distanceTo(center) >= radius) continue;
          if (t <= 0 || t >= 1) return "请先离开天体表面的跃迁限制区";
          const outward = closest.sub(center);
          if (outward.lengthSq() < 1e-12) outward.crossVectors(line, new THREE.Vector3(0, 1, 0));
          if (outward.lengthSq() < 1e-12) outward.set(1, 0, 0);
          points.splice(i + 1, 0, center.addScaledVector(outward.normalize(), radius * 2));
          obstacle = true;
          break;
        }
      }
      if (!obstacle) { clear = true; break; }
    }
    if (!clear) return "当前航线无法安全跃迁，请调整位置";
    this.warpRoute = points;
    this.warpLength = points.slice(1).reduce((sum, point, i) => sum + point.distanceTo(points[i]), 0);
    this.warpTarget = this.target;
    this.warpPhase = "charging";
    this.warpClock = 0;
    this.warpProgress = 0;
    this.velocity.set(0, 0, 0);
    this.align();
    return null;
  }
  cancelWarp() {
    if (!this.warping) return;
    this.warpPhase = "cooldown";
    this.warpClock = 0;
    this.warpProgress = 0;
    this.warpSpeedKm = 0;
    this.velocity.set(0, 0, 0);
    this.resolveCollision(this.position.clone());
  }
  private stepWarp(dt: number) {
    this.warpClock += dt;
    this.elapsed += dt;
    const durations = this.config.warp;
    const duration = this.warpPhase === "charging" ? durations.chargeSeconds : this.warpPhase === "transit" ? durations.travelSeconds : durations.arrivalSeconds;
    this.warpProgress = Math.min(1, this.warpClock / duration);
    this.warpSpeedKm = 0;
    if (this.warpPhase === "transit") {
      const previous = this.position.clone();
      const t = this.warpProgress;
      let distance = t * t * (3 - 2 * t) * this.warpLength;
      for (let i = 0; i < this.warpRoute.length - 1; i++) {
        const a = this.warpRoute[i], b = this.warpRoute[i + 1];
        const length = a.distanceTo(b);
        if (distance <= length || i === this.warpRoute.length - 2) {
          this.position.copy(a).lerp(b, Math.min(1, distance / length));
          this.orientation.setFromRotationMatrix(new THREE.Matrix4().lookAt(a, b, new THREE.Vector3(0, 1, 0)));
          break;
        }
        distance -= length;
      }
      this.warpSpeedKm = previous.distanceTo(this.position) * this.config.unitsKm / dt;
    }
    if (this.warpProgress < 1) return;
    this.warpClock = 0;
    this.warpProgress = 0;
    if (this.warpPhase === "charging") this.warpPhase = "transit";
    else if (this.warpPhase === "transit") {
      this.position.copy(this.warpRoute[this.warpRoute.length - 1]);
      this.target = this.warpTarget;
      this.align();
      this.warpSpeedKm = 0;
      this.warpPhase = "arrival";
    } else {
      this.warpPhase = "cooldown";
      this.velocity.set(0, 0, 0);
      this.resolveCollision(this.position.clone());
    }
  }
  private resolveCollision(previous: THREE.Vector3) {
    this.collision = null;
    const travel = this.position.clone().sub(previous);
    let earliest = 1,
      hit: { id: BodyId; center: THREE.Vector3; radius: number } | undefined;
    for (const body of this.config.bodies) {
      const center = new THREE.Vector3().fromArray(body.position);
      const radius = body.radius * (body.id === "sun" ? 1.24 : 1.002) + 0.000002;
      const offset = previous.clone().sub(center);
      const c = offset.lengthSq() - radius * radius;
      if (c < 0) {
        const normal = this.position.clone().sub(center);
        if (!normal.lengthSq()) normal.set(0, 1, 0);
        this.position
          .copy(center)
          .addScaledVector(normal.normalize(), radius + 0.0000002);
        this.velocity.set(0, 0, 0);
        this.collision = body.id;
        return;
      }
      const a = travel.lengthSq(),
        b = 2 * offset.dot(travel),
        disc = b * b - 4 * a * c;
      if (a > 1e-12 && disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        if (t >= 0 && t <= earliest) {
          earliest = t;
          hit = { id: body.id, center, radius };
        }
      }
    }
    if (hit) {
      this.position.copy(previous).addScaledVector(travel, earliest);
      const normal = this.position.clone().sub(hit.center).normalize();
      this.position.addScaledVector(normal, 0.0000002);
      this.velocity.set(0, 0, 0);
      this.collision = hit.id;
    }
  }
}
