export interface TerrainField {
  id: string; sourceId: string; width: number; height: number; data: Uint8Array; waterMask?: Uint8Array;
  heightOffsetKm: number; heightScaleKm: number; tiltRad: number; yawRad: number; mapOffset: number;
  fineSeed: number; fineEnabled: boolean;
}
export const terrainDefinitions: Record<string, Omit<TerrainField, 'width' | 'height' | 'data' | 'waterMask'>>;
export function getTerrainHeightField(id: string): TerrainField | undefined;
export function prepareTerrainFields(ids: string[]): Promise<void>;
export function registerTerrainHeightField(id: string, field: TerrainField): void;
