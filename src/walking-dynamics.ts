import * as THREE from "three";
import { world, validateWalkingState } from "../shared/flight-state.mjs";
import type { WalkingState, WorldConfig } from "../shared/flight-state.mjs";
import { surfaceProfile, terrainHeightKm } from "../shared/surface.mjs";
import type { BodyId } from "./solar-system";
import type { FlightInput, ShipDynamics } from "./ship-dynamics";

export const BOARD_DISTANCE_M = 12;
export const WALK_JUMP_SPEED_MPS = 4.5;
// Suit return assist is a gameplay safety mechanism for tiny moons, not their real gravity.
export const SUIT_MIN_FALL_ACCELERATION_MPS2 = 0.35;
const MAX_WALK_SLOPE = Math.tan(50 * Math.PI / 180);

/** Radial gravity with metre-scale integration independent of the AU-scale rendering position. */
export class WalkingDynamics {
  active = false;
  bodyId: BodyId | null = null;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly orientation = new THREE.Quaternion();
  readonly anchor = new THREE.Vector3();
  readonly offsetM = new THREE.Vector3();
  pitch = 0;
  grounded = false;
  private readonly anchorRadialM = new THREE.Vector3();
  private readonly radialM = new THREE.Vector3();
  private jumpHeld = false;
  readonly config: WorldConfig;

  constructor(config: WorldConfig = world) { this.config = config; }

  get gravity() { return this.bodyId ? surfaceProfile(this.bodyId).gravity : 0; }
  get speedMps() { return this.velocity.length(); }
  get distanceToShipM() { return this.offsetM.length(); }
  get outward() { return this.radialM.clone().normalize(); }
  get groundClearanceM() {
    if (!this.bodyId) return 0;
    return this.radialM.length() - this.groundRadiusM(this.outward);
  }
  get suitAssisted() { return this.active && this.gravity < SUIT_MIN_FALL_ACCELERATION_MPS2; }

  disembark(ship: ShipDynamics): string | null {
    if (this.active) return "已经在地表探索中";
    const body = this.config.bodies.find(candidate => candidate.id === ship.landedBody);
    if (ship.landingPhase !== "landed" || !body || !surfaceProfile(body.id).solid
      || (body.systemId ?? "solar") !== ship.systemId) return "请先在固体星球或卫星表面着陆，再离开飞船";
    this.bodyId = body.id;
    this.anchor.copy(ship.position);
    this.anchorRadialM.copy(ship.position).sub(new THREE.Vector3().fromArray(body.position))
      .multiplyScalar(this.config.unitsKm * 1000);
    this.radialM.copy(this.anchorRadialM);
    this.orientation.copy(ship.orientation);
    this.alignToSurface();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.orientation);
    this.radialM.addScaledVector(right, 10);
    const normal = this.outward;
    this.radialM.copy(normal).multiplyScalar(this.groundRadiusM(normal));
    this.velocity.set(0, 0, 0);
    this.pitch = 0;
    this.grounded = true;
    this.jumpHeld = false;
    this.active = true;
    this.alignToSurface();
    this.updatePosition();
    return null;
  }

  board(ship: ShipDynamics): string | null {
    if (!this.active) return "当前正在飞船内";
    if (ship.landingPhase !== "landed" || ship.landedBody !== this.bodyId
      || ship.position.distanceToSquared(this.anchor) > 1e-20) return "停泊飞船位置已改变，请恢复地表存档";
    if (!this.grounded) return "请先落回地面，再进入飞船";
    if (this.distanceToShipM > BOARD_DISTANCE_M) return "请靠近停泊飞船至 12 米内，再进入飞船";
    this.reset();
    return null;
  }

  step(seconds: number, input: FlightInput) {
    if (!this.active || !this.bodyId || !Number.isFinite(seconds)) return;
    const duration = Math.max(0, Math.min(seconds, 0.25));
    if (!duration) return;
    const jumpPressed = input.brake && !this.jumpHeld;
    this.jumpHeld = input.brake;
    if (jumpPressed && this.grounded) {
      this.velocity.addScaledVector(this.outward, WALK_JUMP_SPEED_MPS);
      this.grounded = false;
    }
    for (let remaining = duration; remaining > 1e-9; remaining -= 1 / 120)
      this.stepSurface(Math.min(remaining, 1 / 120), input);
    this.updatePosition();
  }

  private stepSurface(dt: number, input: FlightInput) {
    const normal = this.outward;
    const previous = this.radialM.clone();
    const previousFloor = this.groundRadiusM(normal);
    const yaw = THREE.MathUtils.clamp(input.yaw - input.mouseX, -1, 1) * 1.8 * dt;
    this.orientation.premultiply(new THREE.Quaternion().setFromAxisAngle(normal, yaw));
    this.pitch = THREE.MathUtils.clamp(this.pitch + (input.pitch - input.mouseY) * dt * 1.3, -1.35, 1.35);
    this.alignToSurface();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.orientation);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.orientation);
    const wish = forward.multiplyScalar(THREE.MathUtils.clamp(input.throttle, -1, 1))
      .addScaledVector(right, THREE.MathUtils.clamp(input.strafe, -1, 1)).clampLength(0, 1);
    const traction = THREE.MathUtils.clamp(Math.sqrt(this.gravity / 9.81), 0.12, 1.15);
    const maxSpeed = (input.boost ? 5.5 : 2.8) / Math.max(1, Math.sqrt(this.gravity / 9.81));
    const vertical = this.velocity.dot(normal);
    const tangent = this.velocity.clone().addScaledVector(normal, -vertical);
    if (wish.lengthSq()) {
      const response = this.grounded ? 9 * traction : 0.65 * traction;
      tangent.lerp(wish.multiplyScalar(maxSpeed), 1 - Math.exp(-dt * response));
    } else if (this.grounded) tangent.multiplyScalar(Math.exp(-dt * 10 * traction));
    this.velocity.copy(tangent).addScaledVector(normal, vertical);
    const onGround = this.grounded;
    if (!onGround) {
      const body = this.config.bodies.find(candidate => candidate.id === this.bodyId)!;
      const radiusM = body.radius * this.config.unitsKm * 1000;
      const gravity = this.gravity * Math.min(1, (radiusM / this.radialM.length()) ** 2);
      this.velocity.addScaledVector(normal, -Math.max(gravity, SUIT_MIN_FALL_ACCELERATION_MPS2) * dt);
    }
    this.radialM.addScaledVector(this.velocity, dt);
    const nextNormal = this.outward;
    const floor = this.groundRadiusM(nextNormal);
    const horizontalTravel = this.radialM.clone().sub(previous).projectOnPlane(normal).length();
    const terrainRise = floor - previousFloor;
    // Follow ordinary slopes, stop uphill at 50°, and fall freely after leaving a steeper edge.
    // The comparison uses slope per metre rather than a per-frame step, so small substeps
    // cannot turn an unclimbable wall into a staircase or keep feet glued to a cliff.
    if (onGround && horizontalTravel > 1e-7 && terrainRise > horizontalTravel * MAX_WALK_SLOPE + 1e-7) {
      this.radialM.copy(previous);
      this.velocity.set(0, 0, 0);
      this.grounded = true;
    } else if (onGround && horizontalTravel > 1e-7 && terrainRise < -horizontalTravel * MAX_WALK_SLOPE - 1e-7) {
      this.grounded = false;
    } else if (onGround || this.radialM.length() <= floor) {
      this.radialM.copy(nextNormal).multiplyScalar(floor);
      this.velocity.projectOnPlane(nextNormal);
      this.grounded = true;
      if (this.velocity.lengthSq() < 1e-7) this.velocity.set(0, 0, 0);
    }
    this.alignToSurface();
  }

  private groundRadiusM(normal: THREE.Vector3) {
    const body = this.config.bodies.find(candidate => candidate.id === this.bodyId)!;
    return body.radius * this.config.unitsKm * 1000 + terrainHeightKm(body.id, normal.toArray()) * 1000;
  }

  private alignToSurface() {
    const normal = this.outward;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.orientation).projectOnPlane(normal);
    if (forward.lengthSq() < 1e-10) {
      forward.copy(Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).cross(normal);
    }
    forward.normalize();
    this.orientation.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), forward, normal));
  }

  private updatePosition() {
    this.offsetM.copy(this.radialM).sub(this.anchorRadialM);
    this.position.copy(this.offsetM).divideScalar(this.config.unitsKm * 1000).add(this.anchor);
  }

  snapshot(): WalkingState | undefined {
    if (!this.active || !this.bodyId) return undefined;
    return { bodyId: this.bodyId, offsetM: this.offsetM.toArray(), velocityMps: this.velocity.toArray(),
      orientation: this.orientation.toArray(), pitch: this.pitch, grounded: this.grounded };
  }

  restore(payload: WalkingState | undefined, ship: ShipDynamics) {
    this.reset();
    if (!payload || ship.landingPhase !== "landed") return;
    const saved = validateWalkingState(payload, ship.snapshot(), this.config);
    if (!saved) return;
    const body = this.config.bodies.find(candidate => candidate.id === saved.bodyId)!;
    this.bodyId = saved.bodyId;
    this.anchor.copy(ship.position);
    this.anchorRadialM.copy(ship.position).sub(new THREE.Vector3().fromArray(body.position))
      .multiplyScalar(this.config.unitsKm * 1000);
    this.offsetM.fromArray(saved.offsetM);
    this.radialM.copy(this.anchorRadialM).add(this.offsetM);
    this.velocity.fromArray(saved.velocityMps);
    this.orientation.fromArray(saved.orientation);
    this.pitch = saved.pitch;
    this.grounded = saved.grounded;
    this.active = true;
    this.alignToSurface();
    this.updatePosition();
  }

  reset() {
    this.active = false;
    this.bodyId = null;
    this.grounded = false;
    this.jumpHeld = false;
    this.pitch = 0;
    this.velocity.set(0, 0, 0);
    this.offsetM.set(0, 0, 0);
    this.anchor.set(0, 0, 0);
    this.anchorRadialM.set(0, 0, 0);
    this.radialM.set(0, 0, 0);
    this.position.set(0, 0, 0);
    this.orientation.identity();
  }
}
