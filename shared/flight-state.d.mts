import type { BodyId } from "../src/solar-system";
export interface FlightState {
  version: 1;
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
  acceleration: number;
  boostAcceleration: number;
  cruiseSpeed: number;
  boostSpeed: number;
  bodies: { id: BodyId; radius: number; position: number[] }[];
}
export const world: WorldConfig;
export function validateFlightState(value: unknown): FlightState | null;
