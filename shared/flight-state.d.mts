import type { BodyId, SystemId, SystemGroupId } from "../src/solar-system";
export interface FlightState {
  version: 2;
  position: number[];
  velocity: number[];
  orientation: number[];
  target: BodyId;
  camera: "cockpit" | "chase";
  assist: boolean;
  elapsed: number;
  escapeBody?: BodyId;
  engineMode?: "standard" | "interstellar";
  atmosphericSpeedMps?: number;
  landedBody?: BodyId;
  systemId: SystemId;
}
export interface WorldConfig {
  version: number;
  unitsKm: number;
  auKm: number;
  lightYearKm: number;
  systems: { id: SystemId; groupId: SystemGroupId; name: string; positionLy: number[]; primaryStar: BodyId; backgroundFile: string; backgroundIntensity: number; backgroundRotation: number[] }[];
  cruiseSpeed: number;
  boostSpeed: number;
  flightSafety: {
    nearSurfaceMinKm: number;
    nearSurfaceRadiusFactor: number;
    warpTargetMinKm: number;
    warpTargetRadiusFactor: number;
  };
  engines: {
    id: "atmospheric" | "orbital" | "planetary" | "interstellar";
    name: string;
    minSpeedKm: number;
    maxSpeedKm: number;
    accelerationKm: number;
    boostAccelerationKm: number;
  }[];
  warp: { chargeSeconds: number; travelSeconds: number; arrivalSeconds: number; cooldownSeconds: number };
  bodies: { id: BodyId; radius: number; position: number[]; systemId: SystemId; kind?: "star" | "planet" | "station"; hostStarId?: BodyId; atmosphereKm?: number }[];
}
export const world: WorldConfig;
export function validateFlightState(value: unknown): FlightState | null;
