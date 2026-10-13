import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Keep Node's synchronous geology while shipping browser rasters outside the entry bundle. */
export function runtimeTerrain({ emit = true } = {}) {
  const source = readFileSync(new URL('../shared/terrain-fields.mjs', import.meta.url), 'utf8');
  const declaration = source.match(/^const rasterDefinitions = (\{[^\n]+\});$/m);
  if (!declaration) throw new Error('Canonical terrain declaration changed');
  const rasters = JSON.parse(declaration[1]);
  const files = {}, assets = new Map();
  for (const [id, raster] of Object.entries(rasters)) {
    const bytes = JSON.stringify(raster);
    const filename = `terrain/${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.json`;
    files[id] = filename; assets.set(filename, bytes);
  }
  const loader = `const rasterDefinitions = {};
const terrainSourceFiles = ${JSON.stringify(files)};
const terrainRequests = new Map();
async function loadRaster(sourceId) {
  if (rasterDefinitions[sourceId]) return;
  let request = terrainRequests.get(sourceId);
  if (!request) {
    request = fetch(import.meta.env.BASE_URL + terrainSourceFiles[sourceId]).then(async response => {
      if (!response.ok) throw new Error('地形数据加载失败，请检查连接后重试');
      const raster = await response.json();
      if (!Number.isInteger(raster.width) || !Number.isInteger(raster.height) || typeof raster.data !== 'string')
        throw new Error('地形数据不完整');
      rasterDefinitions[sourceId] = raster;
    }).finally(() => terrainRequests.delete(sourceId));
    terrainRequests.set(sourceId, request);
  }
  await request;
}
export async function prepareTerrainFields(ids) {
  const sources = [...new Set(ids.map(id => terrainDefinitions[id]?.sourceId).filter(Boolean))];
  // Bound downloads and JSON/decode work, including duplicate bodies sharing a source.
  for (let i = 0; i < sources.length; i += 4) await Promise.all(sources.slice(i, i + 4).map(loadRaster));
}
`;
  const browserSource = source.replace(/export async function prepareTerrainFields\(ids\) \{[^}]+\}\s*/g, '')
    .replace(declaration[0], loader)
    .replace('const encoded = rasterDefinitions[sourceId];',
      `const encoded = rasterDefinitions[sourceId];
    if (!encoded) throw new Error('Prepare terrain before sampling ' + id);`);
  return {
    name: 'voyager-runtime-terrain', enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0].endsWith('/shared/terrain-fields.mjs')) return { code: browserSource, map: null };
    },
    generateBundle() {
      if (!emit) return;
      for (const [fileName, bytes] of assets) this.emitFile({ type: 'asset', fileName, source: bytes });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0].replace(/^\//, '');
        const bytes = assets.get(pathname);
        if (!bytes) return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.end(bytes);
      });
    },
  };
}
