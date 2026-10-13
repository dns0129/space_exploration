import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVoyagerServer } from './server.mjs';

test('static resources stream gzip with validators; hashed assets cache, and files remain byte-identical', async () => {
  const root = await mkdtemp(join(tmpdir(),'voyager-static-'));
  await mkdir(join(root,'assets')); await mkdir(join(root,'terrain'));
  const code = 'export const sample = 123;\n'.repeat(4000);
  await writeFile(join(root,'assets/sample-abcdef.js'),code);
  await writeFile(join(root,'index.html'),'<h1>Voyager</h1>');
  await writeFile(join(root,'terrain/abcdef0123456789.json'),'{"height":123}');
  const server = createVoyagerServer({ staticRoot: root, dataDir: join(root,'saves') });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(origin+'/assets/sample-abcdef.js', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(response.headers.get('content-encoding'),'gzip');
    assert.match(response.headers.get('cache-control'),/immutable/);
    assert.equal(await response.text(),code);
    const cached = await fetch(origin+'/assets/sample-abcdef.js', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': response.headers.get('etag') } });
    assert.equal(cached.status,304); assert.equal(await cached.text(),'');
    const uncompressed = await fetch(origin+'/assets/sample-abcdef.js', { headers: { 'Accept-Encoding': 'gzip;q=0' } });
    assert.equal(uncompressed.headers.get('content-encoding'),null);
    assert.equal(await uncompressed.text(),code);
    const head = await fetch(origin+'/index.html', { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(head.status,200); assert.equal(await head.text(),'');
    assert.equal(head.headers.get('content-length'),'16');
  } finally { await new Promise(resolve=>server.close(resolve)); await rm(root,{recursive:true,force:true}); }
});
