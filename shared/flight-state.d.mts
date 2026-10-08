import type { BodyId, SystemId, SystemGroupId } from "../src/solar-system";
export interface WalkingState {
  bodyId: BodyId;
  /** Metres along world axes relative to the parked ship, measured at the character's feet. */
  offsetM: number[];
  velocityMps: number[];
  orientation: number[];
  pitch: number;
  grounded: boolean;
  camera?: "first" | "third";
}
import type { EngineMode } from "./propulsion.mjs";
export type { EngineMode } from "./propulsion.mjs";
/** Persisted physical reference, independent of the temporary floating origin. */
export type ReferenceFrameState = { kind: "system" } | {
  kind: "body-fixed";
  bodyId: BodyId;
  /** Exact body-centred position in metres, with axes parallel to system axes. */
  radialM: number[];
};
export interface FlightState {
  version: 2;
  coordinateVersion?: 1;
  referenceFrame?: ReferenceFrameState;
  worldLayoutVersion?: number;
  /** Surface-height revision; omitted historical saves use terrain revision 1. */
  terrainVersion?: number;
  position: number[];
  velocity: number[];
  orientation: number[];
  target: BodyId;
  camera: "cockpit" | "chase";
  assist: boolean;
  elapsed: number;
  engineMode?: EngineMode;
  cruiseSpeedKm?: number;
  lowFlightSpeedMps?: number;
  landedBody?: BodyId;
  walking?: WalkingState;
  systemId: SystemId;
}
export interface WorldConfig {
  version: number;
  layoutVersion?: number;
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
    id: EngineMode;
    name: string;
    accelerationKm: number;
    boostAccelerationKm: number;
  }[];
  warp: { chargeSeconds: number; travelSeconds: number; arrivalSeconds: number; cooldownSeconds: number };
  bodies: { id: BodyId; radius: number; position: number[]; previousPosition?: number[]; orbit?: { inclinationDeg: number; ascendingNodeDeg: number; longitudeDeg: number }; systemId: SystemId; kind?: "star" | "planet" | "station"; hostStarId?: BodyId; parentId?: BodyId; orbitRadiusKm?: number; atmosphereKm?: number }[];
}
export const world: WorldConfig;
/** Maximum capsule foot lift above radial terrain while touching a slope. */
export const WALKING_GROUNDED_CLEARANCE_M: number;
export function validateFlightState(value: unknown): FlightState | null;
export function validateWalkingState(value: unknown, flight: Pick<FlightState, "position" | "velocity" | "landedBody" | "systemId" | "referenceFrame">, config?: WorldConfig): WalkingState | null;
