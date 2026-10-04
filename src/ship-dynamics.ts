import * as THREE from "three";
import { world, validateFlightState } from "../shared/flight-state.mjs";
import type { FlightState, WorldConfig } from "../shared/flight-state.mjs";
import { surfaceProfile, terrainHeightKm, LANDING_CLEARANCE_KM } from "../shared/surface.mjs";
import { bodySystem, systemBodies, systemDisplacement } from "../shared/world-navigation.mjs";
import type { BodyId, SystemId } from "./solar-system";
import type { FlightInput } from "./core/flight-input.ts";
export type { FlightInput } from "./core/flight-input.ts";
export { emptyInput } from "./core/flight-input.ts";
// Centimetre tolerance compensates for subtraction at AU-scale coordinates.
const SURFACE_EPSILON_KM = 1e-5;
interface RoutePoint { systemId: SystemId; position: THREE.Vector3; }
interface WarpApproach {
  center: THREE.Vector3;
  radial: THREE.Vector3;
  entryRadius: number;
  endRadius: number;
}
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
  landedBody: BodyId | null = null;
  landingPhase: "manual" | "descending" | "landed" | "ascending" = "manual";
  private landingBody: BodyId | null = null;
  readonly config: WorldConfig;
  warpPhase: "ready" | "charging" | "transit" | "arrival" | "cooldown" = "ready";
  warpProgress = 0;
  warpSpeedKm = 0;
  private warpClock = 0;
  private warpRoute: RoutePoint[] = [];
  private warpLength = 0;
  private warpTarget: BodyId = "earth";
  private warpApproach?: WarpApproach;
  private readonly warpUp = new THREE.Vector3(0, 1, 0);
  private warpApproachSpeed = 0;
  private warpTransitSeconds = 7;
  constructor(config: WorldConfig = world) {
    this.config = config;
    this.jump("earth");
  }
  jump(id: BodyId) {
    this.resetWarp();
    this.landedBody = null;
    this.landingBody = null;
    this.landingPhase = "manual";
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
      ...(this.landedBody ? { landedBody: this.landedBody } : {}),
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
    this.landedBody = saved.landedBody ?? null;
    this.landingBody = this.landedBody;
    this.landingPhase = this.landedBody ? "landed" : "manual";
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
    const profile = surfaceProfile(body.id);
    const groundHeightKm = terrainHeightKm(body.id, outward.toArray());
    const groundAltitudeKm = Math.max(0, altitudeKm - groundHeightKm - LANDING_CLEARANCE_KM);
    const density = atmospheric ? profile.density * Math.exp(-Math.max(0, altitudeKm) / profile.scaleKm) : 0;
    const headingOut = new THREE.Vector3(0, 0, -1).applyQuaternion(this.orientation).dot(outward) > 0.25;
    const movingOut = this.velocity.dot(outward) >= -1e-9;
    const escaping = altitudeKm <= nearHeightKm + SURFACE_EPSILON_KM && headingOut && movingOut
      && (altitudeKm <= 100 + SURFACE_EPSILON_KM || this.escapeBody === body.id);
    const restricted = altitudeKm <= nearHeightKm + SURFACE_EPSILON_KM && !escaping;
    return { body, altitudeKm: Math.max(0, altitudeKm), atmospheric, restricted, nearHeightKm, escaping,
      profile, density, groundHeightKm, groundAltitudeKm, outward };
  }
  get speedLimit() {
    const environment = this.environment;
    if (environment.profile.solid && environment.groundAltitudeKm < 5)
      return Math.min(100, 0.02 + environment.groundAltitudeKm * 4) / this.config.unitsKm;
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
    if (this.landingPhase === "landed") {
      this.elapsed += dt;
      this.velocity.set(0, 0, 0);
      if (input.lift > 0) this.takeOff();
      return;
    }
    if (this.landingPhase === "descending" || this.landingPhase === "ascending") {
      if (input.brake || input.throttle || input.strafe || input.lift || input.yaw || input.pitch || input.roll || input.mouseX || input.mouseY)
        this.cancelLanding();
      else { this.stepLanding(dt); return; }
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
    if (environment.atmospheric) this.velocity.multiplyScalar(Math.exp(-Math.min(4, environment.density * 0.45) * dt));
    // Assisted near-ground flight counters local gravity; inertial flight must use lift.
    if (!this.assist && environment.profile.solid && environment.groundAltitudeKm < 5)
      this.velocity.addScaledVector(environment.outward, -environment.profile.gravity / 1000 / this.config.unitsKm * dt);
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
    this.warpApproach = undefined;
  }
  get warpBlockReason(): string | null {
    if (this.landingPhase !== "manual") return "请先起飞或中止着陆，再启动跃迁";
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
    const destinationSystem = bodySystem(target);
    const center = new THREE.Vector3().fromArray(target.position);
    // Preserve the departure side, including transfers between systems.
    const radial = this.targetRelative.negate().normalize();
    const radius = Math.max(target.radius + Math.max(1100, (target.atmosphereKm ?? 0) + 300) / this.config.unitsKm,
      target.radius * (target.kind === "star" ? 1.35 : target.id === "saturn" ? 2.45 : 1.015));
    const end = center.clone().addScaledVector(radial, radius);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.orientation);
    this.warpUp.copy(up);
    const departureRadius = this.targetRelative.length();
    // Begin braking while the planet is still a small disc. Nearby departures
    // keep their actual scale instead of travelling away to manufacture a zoom.
    let entryRadius = departureRadius <= radius ? departureRadius
      : Math.min(Math.max(target.radius * 32, radius * 8), radius + (departureRadius - radius) * 0.75);
    const approachSpeed = (distance: number) =>
      (distance > radius ? 2 * distance * Math.log(distance / radius) : 3 * (radius - distance)) / this.config.warp.arrivalSeconds;
    if (destinationSystem === this.systemId && departureRadius > radius) {
      const facing = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(
        new THREE.Vector3(), radial.clone().negate(), up));
      const steeringSeconds = Math.min(this.config.warp.travelSeconds,
        this.orientation.angleTo(facing) / 1.8 + 1);
      // Complete transit steering before the straight approach locks attitude.
      // Reserve enough distance to join it at the same speed, even on short hops.
      let low = radius, high = entryRadius;
      for (let i = 0; i < 32; i++) {
        const candidate = (low + high) / 2;
        if (approachSpeed(candidate) * steeringSeconds <= departureRadius - candidate) low = candidate;
        else high = candidate;
      }
      entryRadius = low;
    }
    let entry = center.clone().addScaledVector(radial, entryRadius);
    let clearApproach = false;
    for (let i = 0; i < 24; i++) {
      const segment = this.safeRoute(entry, end, destinationSystem);
      if (segment?.length === 2) { clearApproach = true; break; }
      // A moon or parent planet may obstruct a long radial approach. Keep the
      // safe, uninterrupted final section; transit handles any earlier detour.
      entryRadius = (entryRadius + radius) / 2;
      entry = center.clone().addScaledVector(radial, entryRadius);
    }
    if (!clearApproach) return "接近航线受阻，请先调整位置";
    let points: RoutePoint[];
    if (destinationSystem === this.systemId) {
      const route = this.safeRoute(this.position, entry, this.systemId);
      if (!route) return "当前航线无法安全跃迁，请调整位置";
      points = route.map(position => ({ systemId: this.systemId, position }));
    } else {
      const direction = this.targetRelative.normalize();
      const gateDistance = this.config.auKm * 100 / this.config.unitsKm;
      const departure = this.position.clone().addScaledVector(direction, gateDistance);
      const arrival = entry.clone().addScaledVector(direction, -gateDistance);
      const leaving = this.safeRoute(this.position, departure, this.systemId);
      const entering = this.safeRoute(arrival, entry, destinationSystem);
      if (!leaving || !entering) return "跨恒星系统航线受阻，请先调整位置";
      points = [...leaving.map(position => ({ systemId: this.systemId, position })),
        ...entering.map(position => ({ systemId: destinationSystem, position }))];
    }
    this.warpRoute = points;
    this.warpLength = points.slice(1).reduce((sum, point, i) => sum + this.routeDisplacement(points[i], point).length(), 0);
    this.warpApproach = { center, radial, entryRadius, endRadius: radius };
    this.warpApproachSpeed = approachSpeed(entryRadius);
    this.warpTransitSeconds = this.warpLength < 1e-8 ? 0
      : Math.min(this.config.warp.travelSeconds, this.warpLength / this.warpApproachSpeed);
    this.warpTarget = this.target;
    this.warpPhase = "charging";
    this.warpClock = 0;
    this.warpProgress = 0;
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.bank = 0;
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
    const duration = this.warpPhase === "charging" ? durations.chargeSeconds : this.warpPhase === "transit" ? this.warpTransitSeconds : durations.arrivalSeconds;
    this.warpProgress = Math.min(1, this.warpClock / duration);
    this.warpSpeedKm = 0;
    if (this.warpPhase === "transit") {
      const t = this.warpProgress;
      const slope = Math.min(1, this.warpApproachSpeed * duration / this.warpLength);
      const travelled = (t * t * (3 - 2 * t) + slope * (t * t * t - t * t)) * this.warpLength;
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
          // Keep the destination visible after an avoidance detour. Finish
          // transit steering here; the arrival approach never changes attitude.
          this.faceWarpDirection(i === this.warpRoute.length - 2 ? this.targetRelative : displacement, dt);
          break;
        }
        distance -= length;
      }
      this.warpSpeedKm = (6 * t * (1 - t) + slope * (3 * t * t - 2 * t)) * this.warpLength * this.config.unitsKm / duration;
    } else if (this.warpPhase === "arrival" && this.warpApproach) {
      const t = this.warpProgress;
      const approach = this.warpApproach;
      const ratio = Math.log(approach.entryRadius / approach.endRadius);
      // Ease distance logarithmically so angular size grows throughout the
      // approach, with continuous entry speed and a complete stop at the end.
      const distance = ratio > 0 ? approach.endRadius * Math.exp(ratio * (1 - t) ** 2)
        : approach.endRadius + (approach.entryRadius - approach.endRadius) * (1 - t) ** 3;
      this.position.copy(approach.center).addScaledVector(approach.radial, distance);
      this.warpSpeedKm = (ratio > 0 ? distance * 2 * ratio * (1 - t)
        : 3 * (approach.endRadius - approach.entryRadius) * (1 - t) ** 2) * this.config.unitsKm / duration;
      this.deceleration = 0.45 * (1 - t);
    }
    if (this.warpProgress < 1) return;
    this.warpClock = 0;
    this.warpProgress = 0;
    if (this.warpPhase === "charging") this.warpPhase = this.warpTransitSeconds > 0 ? "transit" : "arrival";
    else if (this.warpPhase === "transit") {
      const arrival = this.warpRoute[this.warpRoute.length - 1];
      this.systemId = arrival.systemId;
      this.position.copy(arrival.position);
      this.target = this.warpTarget;
      this.warpPhase = "arrival";
    } else {
      this.warpPhase = "cooldown";
      this.velocity.set(0, 0, 0);
      this.warpSpeedKm = 0;
      this.resolveCollision(this.position.clone());
    }
  }
  private faceWarpDirection(direction: THREE.Vector3, dt: number) {
    const facing = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(
      new THREE.Vector3(), direction, this.warpUp));
    const angle = this.orientation.angleTo(facing);
    this.orientation.slerp(facing, Math.min(1 - Math.exp(-dt * 6), angle > 1e-9 ? dt * 1.8 / angle : 1));
  }
  private resolveCollision(previous: THREE.Vector3) {
    this.collision = null;
    if (this.landedBody) return;
    const travel = this.position.clone().sub(previous);
    let earliest = 1,
      hit: { id: BodyId; center: THREE.Vector3; radius: number; gentle: boolean } | undefined;
    for (const body of this.activeBodies) {
      const center = new THREE.Vector3().fromArray(body.position);
      const solid = surfaceProfile(body.id).solid;
      const gentle = solid && this.velocity.length() * this.config.unitsKm <= 0.3;
      const normal = this.position.clone().sub(center).normalize();
      const shieldRadius = body.radius * (body.kind === "star" ? 1.24 : 1.002) + 0.000002;
      // Once inside the outer shield, never push a departing ship back out to orbit.
      const radius = solid && (gentle || previous.distanceTo(center) < shieldRadius)
        ? body.radius + (terrainHeightKm(body.id, normal.toArray()) + LANDING_CLEARANCE_KM) / this.config.unitsKm
        : shieldRadius;
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
        if (gentle) this.touchDown(body.id);
        return;
      }
      const a = travel.lengthSq(),
        b = 2 * offset.dot(travel),
        disc = b * b - 4 * a * c;
      if (a > 1e-24 && disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        if (t >= 0 && t <= earliest) {
          earliest = t;
          hit = { id: body.id, center, radius, gentle };
        }
      }
    }
    if (hit) {
      this.position.copy(previous).addScaledVector(travel, earliest);
      const normal = this.position.clone().sub(hit.center).normalize();
      this.position.addScaledVector(normal, 0.0000002);
      this.velocity.set(0, 0, 0);
      this.collision = hit.id;
      if (hit.gentle)
        this.touchDown(hit.id);
    }
  }

  get landingBlockReason(): string | null {
    if (this.warping) return "跃迁期间无法着陆";
    const environment = this.environment;
    if (!environment.profile.solid) return environment.body.kind === "star" ? "恒星无法着陆" : "气态或冰巨行星没有可降落的固体地表，请选择卫星";
    if (environment.body.id !== this.target) return "请先接近并选择要着陆的天体";
    if (environment.altitudeKm > Math.max(environment.body.radius * this.config.unitsKm * 5, 2000))
      return "距离地表太远，请先跃迁或驾驶接近目标";
    return null;
  }
  startLanding(): string | null {
    const blocked = this.landingBlockReason;
    if (blocked) return blocked;
    this.landingBody = this.environment.body.id;
    this.landingPhase = "descending";
    this.landedBody = null;
    this.escapeBody = null;
    this.collision = null;
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.bank = 0;
    return null;
  }
  cancelLanding() {
    if (this.landingPhase === "landed") return;
    this.landingPhase = "manual";
    this.landingBody = null;
    this.velocity.set(0, 0, 0);
  }
  takeOff(): string | null {
    if (!this.landedBody) return "请先在地表着陆";
    this.landingBody = this.landedBody;
    this.landedBody = null;
    this.landingPhase = "ascending";
    this.collision = null;
    this.velocity.set(0, 0, 0);
    return null;
  }
  private surfaceAttitude(normal: THREE.Vector3, ascending = false) {
    let forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.orientation).projectOnPlane(normal);
    if (forward.lengthSq() < 1e-8) forward = new THREE.Vector3(0, 1, 0).cross(normal);
    if (forward.lengthSq() < 1e-8) forward.set(1, 0, 0);
    forward.normalize();
    const up = ascending ? forward.clone().negate() : normal;
    const target = ascending ? normal : forward;
    this.orientation.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), target, up));
  }
  private touchDown(id: BodyId) {
    const body = this.config.bodies.find((candidate) => candidate.id === id)!;
    const center = new THREE.Vector3().fromArray(body.position);
    const normal = this.position.clone().sub(center).normalize();
    const height = terrainHeightKm(id, normal.toArray()) + LANDING_CLEARANCE_KM;
    this.position.copy(center).addScaledVector(normal, body.radius + height / this.config.unitsKm);
    this.surfaceAttitude(normal);
    this.landedBody = id;
    this.landingBody = id;
    this.landingPhase = "landed";
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.bank = 0;
    this.collision = null;
  }
  private stepLanding(dt: number) {
    const body = this.config.bodies.find((candidate) => candidate.id === this.landingBody)!;
    const center = new THREE.Vector3().fromArray(body.position);
    const normal = this.position.clone().sub(center).normalize();
    const ground = terrainHeightKm(body.id, normal.toArray()) + LANDING_CLEARANCE_KM;
    const altitude = (this.position.distanceTo(center) - body.radius) * this.config.unitsKm - ground;
    const ascending = this.landingPhase === "ascending";
    this.surfaceAttitude(normal, ascending);
    const speedKm = ascending ? Math.min(0.5, Math.max(0.015, altitude * 0.8))
      : Math.min(2500, Math.max(0.005, altitude * 0.65));
    const nextAltitude = ascending ? altitude + speedKm * dt : Math.max(0, altitude - speedKm * dt);
    this.position.copy(center).addScaledVector(normal, body.radius + (ground + nextAltitude) / this.config.unitsKm);
    this.velocity.copy(normal).multiplyScalar((ascending ? 1 : -1) * speedKm / this.config.unitsKm);
    this.elapsed += dt;
    if (!ascending && nextAltitude <= 0.00001) this.touchDown(body.id);
    else if (ascending && nextAltitude >= 2) { this.landingPhase = "manual"; this.landingBody = null; }
  }
}
