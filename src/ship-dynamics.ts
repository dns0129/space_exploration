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
  target: BodyId = "earth";
  camera: "cockpit" | "chase" = "cockpit";
  assist = true;
  elapsed = 0;
  collision: BodyId | null = null;
  readonly config: WorldConfig;
  constructor(config: WorldConfig = world) {
    this.config = config;
    this.jump("earth");
  }
  jump(id: BodyId) {
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
    const distance = body.radius * (id === "saturn" ? 5 : 3.8) + 0.5;
    this.position.copy(center).addScaledVector(side, distance);
    this.velocity.set(0, 0, 0);
    this.target = id;
    this.align();
    this.collision = null;
  }
  align() {
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
      version: 1,
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
    this.position.fromArray(saved.position);
    this.velocity.fromArray(saved.velocity);
    this.orientation.fromArray(saved.orientation);
    this.target = saved.target;
    this.camera = saved.camera;
    this.assist = saved.assist;
    this.elapsed = saved.elapsed;
    this.resolveCollision(this.position.clone());
    return true;
  }
  step(seconds: number, input: FlightInput) {
    const dt = Math.max(0, Math.min(seconds, 0.05));
    if (!dt) return;
    const rotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        input.pitch * dt * 1.1 - input.mouseY,
        input.yaw * dt * 1.1 - input.mouseX,
        input.roll * dt * 1.4,
        "YXZ",
      ),
    );
    this.orientation.multiply(rotation).normalize();
    const acceleration = new THREE.Vector3(
      input.strafe,
      input.lift,
      -input.throttle,
    );
    if (acceleration.lengthSq() > 1) acceleration.normalize();
    acceleration
      .applyQuaternion(this.orientation)
      .multiplyScalar(
        input.boost ? this.config.boostAcceleration : this.config.acceleration,
      );
    this.velocity.addScaledVector(acceleration, dt);
    if (input.brake) this.velocity.multiplyScalar(Math.exp(-8 * dt));
    else if (this.assist) {
      this.velocity.multiplyScalar(
        Math.exp(
          -(this.velocity.length() > this.config.cruiseSpeed && !input.boost
            ? 0.9
            : 0.1) * dt,
        ),
      );
    }
    this.velocity.clampLength(0, this.config.boostSpeed);
    if (this.velocity.length() < 0.003) this.velocity.set(0, 0, 0);
    const previous = this.position.clone();
    this.position.addScaledVector(this.velocity, dt);
    this.resolveCollision(previous);
    this.elapsed += dt;
  }
  private resolveCollision(previous: THREE.Vector3) {
    this.collision = null;
    const travel = this.position.clone().sub(previous);
    let earliest = 1,
      hit: { id: BodyId; center: THREE.Vector3; radius: number } | undefined;
    for (const body of this.config.bodies) {
      const center = new THREE.Vector3().fromArray(body.position);
      const radius = body.radius * (body.id === "sun" ? 1.24 : 1.04) + 0.24;
      const offset = previous.clone().sub(center);
      const c = offset.lengthSq() - radius * radius;
      if (c < 0) {
        const normal = this.position.clone().sub(center);
        if (!normal.lengthSq()) normal.set(0, 1, 0);
        this.position
          .copy(center)
          .addScaledVector(normal.normalize(), radius + 0.001);
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
      this.position.addScaledVector(normal, 0.002);
      this.velocity.set(0, 0, 0);
      this.collision = hit.id;
    }
  }
}
