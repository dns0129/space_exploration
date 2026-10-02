import type { BodyId } from "../src/solar-system";
export interface FlightState {
  version: 2;
  position: number[];
  velocity: number[];
  orientation: number[];
  target: BodyId;
  camera: "cockpit" | "chase";
  assist: boolean;
  elapsed: number;
}
export interface WorldConfig {
  version: number;
  unitsKm: number;
  auKm: number;
  cruiseSpeed: number;
  boostSpeed: number;
  engines: {
    id: "orbital" | "planetary" | "interstellar";
    name: string;
    minSpeedKm: number;
    maxSpeedKm: number;
    accelerationKm: number;
    boostAccelerationKm: number;
  }[];
  warp: { chargeSeconds: number; travelSeconds: number; arrivalSeconds: number; cooldownSeconds: number };
  bodies: { id: BodyId; radius: number; position: number[] }[];
}
export const world: WorldConfig;
export function validateFlightState(value: unknown): FlightState | null;
