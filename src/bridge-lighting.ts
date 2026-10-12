import * as THREE from "three";
import type { FlightState, WorldConfig } from "../shared/flight-state.mjs";
import { sampleStellarLighting } from "./stellar-light";
import type { LightBody, StellarSample } from "./stellar-light";

export interface PlanetBounce {
  direction: THREE.Vector3;
  color: THREE.Color;
  irradiance: number;
}

/** Diffuse Earthshine follows distance, the illuminated phase and eclipses.
 * Static ephemerides share a cached stellar sample; the moving observer does not. */
export class Earthshine {
  private config?: WorldConfig;
  private earth?: LightBody;
  private sources: StellarSample[] = [];
  sample(config: WorldConfig, observer: THREE.Vector3): PlanetBounce | undefined {
    if (this.config !== config) {
      this.config = config;
      this.earth = config.bodies.find(body => body.id === "earth");
      this.sources = this.earth ? sampleStellarLighting(config.bodies.filter(body => body.systemId === "solar"),
        new THREE.Vector3().fromArray(this.earth.position), config.unitsKm, "earth") : [];
    }
    if (!this.earth) return;
    const direction = new THREE.Vector3().fromArray(this.earth.position).sub(observer);
    const distance = direction.length();
    if (distance <= this.earth.radius || this.earth.radius / distance < 0.002) return;
    direction.divideScalar(distance);
    let illumination = 0;
    for (const source of this.sources) {
      const angle = Math.acos(THREE.MathUtils.clamp(-source.direction.dot(direction), -1, 1));
      const phase = (Math.sin(angle) + (Math.PI - angle) * Math.cos(angle)) / Math.PI;
      illumination += phase * source.energy * source.visibility;
    }
    return { direction, color: new THREE.Color("#b6cde3"),
      irradiance: 0.3 * Math.pow(this.earth.radius / distance, 2) * illumination };
  }
}

/** A real, paused vessel/cabin pose; never a background picture or a saved checkpoint. */
export function bridgeEarthState(config: WorldConfig): FlightState {
  const earth = config.bodies.find(body => body.id === "earth")!;
  const sun = config.bodies.find(body => body.id === "sun")!;
  const center = new THREE.Vector3().fromArray(earth.position);
  const light = new THREE.Vector3().fromArray(sun.position).sub(center).normalize();
  const tangent = new THREE.Vector3(0, 1, 0).cross(light).normalize();
  const radial = light.multiplyScalar(0.65).addScaledVector(tangent, 0.45)
    .add(new THREE.Vector3(0, -0.6, 0)).normalize();
  const position = center.clone().addScaledVector(radial, earth.radius + 8500 / config.unitsKm);
  const orientation = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(position, center, new THREE.Vector3(0, 1, 0)));
  return { version: 2, worldLayoutVersion: config.layoutVersion, systemId: "solar", target: "earth",
    position: position.toArray(), velocity: [0, 0, 0], orientation: orientation.toArray(),
    camera: "cockpit", assist: true, elapsed: 0, referenceFrame: { kind: "system" },
    stationVisit: { bodyId: "earth-station", vessel: true, piloting: false,
      positionM: [0.8, 0, -35.4], yaw: -0.04, pitch: 0, camera: "first" } };
}
