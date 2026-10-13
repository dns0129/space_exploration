import { buildWalkingTerrain } from './walking-terrain';
import { registerTerrainHeightField } from '../shared/terrain-fields.mjs';
import type { TerrainHeightField } from '../shared/surface.mjs';
import type { WorldConfig } from '../shared/flight-state.mjs';
import type { BodyId } from './solar-system';

let config: WorldConfig;
let bodyId: BodyId;
self.onmessage = (event: MessageEvent) => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      config = message.config; bodyId = message.bodyId;
      if (message.field) registerTerrainHeightField(bodyId, message.field as TerrainHeightField);
      self.postMessage({ id: message.id, ready: true });
    } else {
      const result = buildWalkingTerrain(config, bodyId, message.radialM, message.originRadialM);
      self.postMessage({ id: message.id, result }, { transfer: [result.vertices.buffer, result.renderPositions.buffer,
        result.renderRadials.buffer, result.renderColors.buffer, result.renderNormals.buffer] });
    }
  } catch (error) { self.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
};
