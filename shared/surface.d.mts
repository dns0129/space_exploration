import type { BodyId } from "../src/solar-system";
export function surfaceProfile(id: BodyId): { solid: boolean; sky: string; ground: string; gravity: number; density: number; scaleKm: number };
export function terrainHeightKm(id: BodyId, normal: number[]): number;
export const LANDING_CLEARANCE_KM: number;
