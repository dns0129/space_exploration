import WorkerConstructor from './walking-terrain.worker.ts?worker&inline';
import { terrainHeightField } from '../shared/surface.mjs';
import type { WorldConfig } from '../shared/flight-state.mjs';
import type { BodyId } from './solar-system';
import type { TerrainBuild } from './walking-terrain';

export class WalkingTerrainWorker {
  private worker = new WorkerConstructor();
  private next = 0;
  private pending = new Map<number, { resolve: (result: TerrainBuild) => void; reject: (error: Error) => void }>();
  readonly ready: Promise<TerrainBuild>;
  constructor(config: WorldConfig, bodyId: BodyId) {
    this.worker.onmessage = event => {
      const item = this.pending.get(event.data.id);
      if (!item) return;
      this.pending.delete(event.data.id);
      if (event.data.error) item.reject(new Error(event.data.error));
      else item.resolve(event.data.result);
    };
    this.worker.onerror = () => this.dispose();
    this.ready = this.request({ type: 'init', config, bodyId, field: terrainHeightField(bodyId) });
  }
  private request(message: object): Promise<TerrainBuild> {
    const id = ++this.next;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ ...message, id }); });
  }
  async build(radialM: number[], originRadialM: number[]) {
    await this.ready;
    return this.request({ type: 'build', radialM, originRadialM });
  }
  dispose() {
    this.worker.terminate();
    for (const item of this.pending.values()) item.reject(new Error('Terrain worker closed'));
    this.pending.clear();
  }
}
