import * as THREE from "three";
import { world, validateFlightState } from "../shared/flight-state.mjs";
import type { FlightState, WorldConfig } from "../shared/flight-state.mjs";
import { bodySystem, systemBodies, systemDisplacement } from "../shared/world-navigation.mjs";
import type { BodyId, SystemId } from "./solar-system";
// Centimetre tolerance compensates for subtraction at AU-scale coordinates.
const SURFACE_EPSILON_KM = 1e-5;
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
interface RoutePoint { systemId: SystemId; position: THREE.Vector3; }
export class ShipDynamics {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly orientation = new THREE.Quaternion();
  readonly angularVelocity = new THREE.Vector3();
  bank = 0;
  deceleration = 0;
  private escapeBody: BodyId | null = null;
  target: BodyId = "earth";
  systemId: SystemId = "solar";
  camera: "cockpit" | "chase" = "cockpit";
  assist = true;
  elapsed = 0;
  collision: BodyId | null = null;
  readonly config: WorldConfig;
  warpPhase: "ready" | "charging" | "transit" | "arrival" | "cooldown" = "ready";
  warpProgress = 0;
  warpSpeedKm = 0;
  private warpClock = 0;
  private warpRoute: RoutePoint[] = [];
  private warpTravelDistance = 0;
  private warpLength = 0;
  private warpTarget: BodyId = "earth";
  constructor(config: WorldConfig = world) {
    this.config = config;
    this.jump("earth");
  }
  jump(id: BodyId) {
    this.resetWarp();
    this.escapeBody = null;
    this.deceleration = 0;
    const body = this.config.bodies.find((b) => b.id === id)!;
    this.systemId = bodySystem(body);
    const center = new THREE.Vector3().fromArray(body.position);
    const side =
      id === "sun" || center.lengthSq() === 0
        ? new THREE.Vector3(0, 0.2, -1)
        : center
            .clone()
            .negate()
            .normalize()
            .add(new THREE.Vector3(0, 0.18, 0))
            .normalize();
    const distance = Math.max(body.radius * (id === "saturn" ? 5 : 3.8), body.radius + 1100 / this.config.unitsKm);
    this.position.copy(center).addScaledVector(side, distance);
    this.velocity.set(0, 0, 0);
    this.target = id;
    this.align();
    this.collision = null;
  }
  align() {
    this.angularVelocity.set(0, 0, 0);
    this.bank = 0;
    this.orientation.setFromRotationMatrix(new THREE.Matrix4().lookAt(
      new THREE.Vector3(), this.targetRelative, new THREE.Vector3(0, 1, 0),
    ));
  }
  get activeBodies() { return systemBodies(this.config, this.systemId); }
  get targetRelative() {
    const target = this.config.bodies.find(body => body.id === this.target)!;
    return new THREE.Vector3().fromArray(systemDisplacement(this.config, this.systemId,
      this.position.toArray(), bodySystem(target), target.position));
  }
  snapshot(): FlightState {
    return {
      version: 2,
      systemId: this.systemId,
      ...(this.escapeBody ? { escapeBody: this.escapeBody } : {}),
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
    this.escapeBody = null;
    this.deceleration = 0;
    this.systemId = saved.systemId;
    this.position.fromArray(saved.position);
    this.velocity.fromArray(saved.velocity).clampLength(0, this.config.boostSpeed);
    this.orientation.fromArray(saved.orientation);
    this.angularVelocity.set(0, 0, 0);
    this.bank = 0;
    this.target = saved.target;
    this.escapeBody = saved.escapeBody ?? null;
    this.camera = saved.camera;
    this.assist = saved.assist;
    this.elapsed = saved.elapsed;
    this.resolveCollision(this.position.clone());
    this.velocity.clampLength(0, this.speedLimit);
    return true;
  }
  get environment() {
    let body = this.activeBodies[0], altitudeKm = Infinity;
    for (const candidate of this.activeBodies) {
      const altitude = (Math.hypot(
        this.position.x - candidate.position[0],
        this.position.y - candidate.position[1],
        this.position.z - candidate.position[2],
      ) - candidate.radius) * this.config.unitsKm;
      if (altitude < altitudeKm) { body = candidate; altitudeKm = altitude; }
    }
    const nearHeightKm = this.config.flightSafety.nearSurfaceMinKm;
    const atmospheric = !!body.atmosphereKm && altitudeKm <= body.atmosphereKm;
    const outward = this.position.clone().sub(new THREE.Vector3().fromArray(body.position)).normalize();
    const headingOut = new THREE.Vector3(0, 0, -1).applyQuaternion(this.orientation).dot(outward) > 0.25;
    const movingOut = this.velocity.dot(outward) >= -1e-9;
    const escaping = altitudeKm <= nearHeightKm + SURFACE_EPSILON_KM && headingOut && movingOut
      && (altitudeKm <= 100 + SURFACE_EPSILON_KM || this.escapeBody === body.id);
    const restricted = altitudeKm <= nearHeightKm + SURFACE_EPSILON_KM && !escaping;
    return { body, altitudeKm: Math.max(0, altitudeKm), atmospheric, restricted, nearHeightKm, escaping };
  }
  get speedLimit() {
    const environment = this.environment;
    return (environment.restricted ? this.config.engines[0].maxSpeedKm
      : environment.escaping ? this.config.engines[1].maxSpeedKm
      : this.config.boostSpeed * this.config.unitsKm) / this.config.unitsKm;
  }
  get engine() {
    const environment = this.environment;
    if (environment.restricted) return this.config.engines[0];
    if (environment.escaping) return this.config.engines[1];
    const speedKm = this.velocity.length() * this.config.unitsKm;
    return this.config.engines.find((engine) => speedKm < engine.maxSpeedKm)
      ?? this.config.engines[this.config.engines.length - 1];
  }
  step(seconds: number, input: FlightInput) {
    const duration = Math.max(0, Math.min(seconds, 0.25));
    if (!duration) return;
    this.deceleration *= Math.exp(-duration * 3);
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
    const environment = this.environment;
    this.escapeBody = environment.escaping ? environment.body.id : null;
    const previousSpeedKm = this.velocity.length() * this.config.unitsKm;
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
      for (const body of this.activeBodies) {
        const center = new THREE.Vector3().fromArray(body.position);
        // An outward departure may cross its own safety shell; other bodies still brake it.
        if (this.escapeBody === body.id && environment.escaping) continue;
        const radius = body.radius + this.config.flightSafety.nearSurfaceMinKm / this.config.unitsKm;
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
    const lostSpeedKm = previousSpeedKm - this.velocity.length() * this.config.unitsKm;
    if (lostSpeedKm > 0.05 && (input.brake || slowing || lostSpeedKm > Math.max(2, previousSpeedKm * 0.015)))
      this.deceleration = Math.max(this.deceleration, Math.min(1, lostSpeedKm / Math.max(10, previousSpeedKm * 0.15)));
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
    if (environment.altitudeKm <= this.config.flightSafety.nearSurfaceMinKm + SURFACE_EPSILON_KM) return "距天体表面 1000 km 内禁止跃迁，请先向太空离开";
    const target = this.config.bodies.find((body) => body.id === this.target)!;
    const altitudeKm = (this.targetRelative.length() - target.radius) * this.config.unitsKm;
    const minimumKm = Math.max(this.config.flightSafety.warpTargetMinKm,
      target.radius * this.config.unitsKm * this.config.flightSafety.warpTargetRadiusFactor);
    if (altitudeKm <= minimumKm + SURFACE_EPSILON_KM) return "距离目标太近，无法启动跃迁，请直接驾驶接近";
    return null;
  }
  startWarp(): string | null {
    const blocked = this.warpBlockReason;
    if (blocked) return blocked;
    const target = this.config.bodies.find((b) => b.id === this.target)!;
    const destination = new ShipDynamics(this.config);
    destination.jump(this.target);
    if (destination.systemId === this.systemId && destination.position.distanceTo(this.position) < target.radius * 0.01)
      return "已在目标附近，可自由驾驶接近";
    let points: RoutePoint[];
    if (destination.systemId === this.systemId) {
      const route = this.safeRoute(this.position, destination.position, this.systemId);
      if (!route) return "当前航线无法安全跃迁，请调整位置";
      points = route.map(position => ({ systemId: this.systemId, position }));
    } else {
      const direction = this.targetRelative.normalize();
      const gateDistance = this.config.auKm * 100 / this.config.unitsKm;
      const departure = this.position.clone().addScaledVector(direction, gateDistance);
      const arrival = destination.position.clone().addScaledVector(direction, -gateDistance);
      const leaving = this.safeRoute(this.position, departure, this.systemId);
      const entering = this.safeRoute(arrival, destination.position, destination.systemId);
      if (!leaving || !entering) return "跨恒星系统航线受阻，请先调整位置";
      points = [...leaving.map(position => ({ systemId: this.systemId, position })),
        ...entering.map(position => ({ systemId: destination.systemId, position }))];
    }
    this.warpRoute = points;
    this.warpLength = points.slice(1).reduce((sum, point, i) => sum + this.routeDisplacement(points[i], point).length(), 0);
    this.warpTravelDistance = 0;
    this.warpTarget = this.target;
    this.warpPhase = "charging";
    this.warpClock = 0;
    this.warpProgress = 0;
    this.velocity.set(0, 0, 0);
    this.align();
    return null;
  }
  private routeDisplacement(a: RoutePoint, b: RoutePoint) {
    return new THREE.Vector3().fromArray(systemDisplacement(this.config, a.systemId,
      a.position.toArray(), b.systemId, b.position.toArray()));
  }
  private safeRoute(from: THREE.Vector3, to: THREE.Vector3, systemId: SystemId): THREE.Vector3[] | null {
    const points = [from.clone(), to.clone()];
    for (let attempt = 0; attempt < 64; attempt++) {
      let obstacle = false;
      for (let i = 0; i < points.length - 1 && !obstacle; i++) {
        const a = points[i], b = points[i + 1];
        const line = b.clone().sub(a), lengthSq = line.lengthSq();
        if (!lengthSq) continue;
        for (const body of systemBodies(this.config, systemId)) {
          const center = new THREE.Vector3().fromArray(body.position);
          const t = THREE.MathUtils.clamp(center.clone().sub(a).dot(line) / lengthSq, 0, 1);
          const closest = a.clone().addScaledVector(line, t);
          const radius = Math.max(body.radius * (body.kind === "star" ? 1.3 : 1.005),
            body.radius + this.config.flightSafety.nearSurfaceMinKm / this.config.unitsKm);
          if (closest.distanceTo(center) >= radius) continue;
          if (t <= 0 || t >= 1) return null;
          const outward = closest.sub(center);
          if (outward.lengthSq() < 1e-12) outward.crossVectors(line, new THREE.Vector3(0, 1, 0));
          if (outward.lengthSq() < 1e-12) outward.set(1, 0, 0);
          points.splice(i + 1, 0, center.addScaledVector(outward.normalize(), radius * 2));
          obstacle = true;
          break;
        }
      }
      if (!obstacle) return points;
    }
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
      const t = this.warpProgress;
      const travelled = t * t * (3 - 2 * t) * this.warpLength;
      let distance = travelled;
      for (let i = 0; i < this.warpRoute.length - 1; i++) {
        const a = this.warpRoute[i], b = this.warpRoute[i + 1];
        const displacement = this.routeDisplacement(a, b), length = displacement.length();
        if (distance <= length || i === this.warpRoute.length - 2) {
          const blend = length ? Math.min(1, distance / length) : 1;
          // Interpolate from the closer local origin. The final approach never
          // subtracts two light-year-scale coordinates to recover a small height.
          if (a.systemId === b.systemId || blend <= 0.5) {
            this.systemId = a.systemId;
            this.position.copy(a.position).addScaledVector(displacement, blend);
          } else {
            this.systemId = b.systemId;
            this.position.copy(b.position).addScaledVector(displacement, -(1 - blend));
          }
          this.orientation.setFromRotationMatrix(new THREE.Matrix4().lookAt(
            new THREE.Vector3(), displacement, new THREE.Vector3(0, 1, 0)));
          break;
        }
        distance -= length;
      }
      this.warpSpeedKm = (travelled - this.warpTravelDistance) * this.config.unitsKm / dt;
      this.warpTravelDistance = travelled;
    }
    if (this.warpProgress < 1) return;
    this.warpClock = 0;
    this.warpProgress = 0;
    if (this.warpPhase === "charging") this.warpPhase = "transit";
    else if (this.warpPhase === "transit") {
      const arrival = this.warpRoute[this.warpRoute.length - 1];
      this.systemId = arrival.systemId;
      this.position.copy(arrival.position);
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
    for (const body of this.activeBodies) {
      const center = new THREE.Vector3().fromArray(body.position);
      const radius = body.radius * (body.kind === "star" ? 1.24 : 1.002) + 0.000002;
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
