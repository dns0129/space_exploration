import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const root = new URL("https://dns0129.github.io/space_exploration/");
const expected = process.env.GITHUB_SHA;
assert.match(expected ?? "", /^[a-f0-9]{40}$/, "An exact target commit is required");
const evidence = { expectedRevision: expected, checkedAt: null, requests: [], version: null };
async function get(path, json = false) {
  const url = new URL(path, root);
  url.searchParams.set("verify", expected);
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30000) });
  evidence.requests.push({ url: url.href, status: response.status });
  assert.equal(response.status, 200, `${path} must return public HTTP 200`);
  return json ? response.json() : response.text();
}
await mkdir("test-results/public", { recursive: true });
try {
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      evidence.version = await get("version.json", true);
      if (evidence.version.revision === expected) break;
    } catch (error) {
      console.log(`Public version check ${attempt + 1}: ${error.message}`);
    }
    if (attempt < 15) await new Promise(resolve => setTimeout(resolve, 15000));
  }
  assert.equal(evidence.version?.revision, expected, "Public version.json must match the deployed commit");
  const home = await get("");
  const game = await get("game.html");
  const downloaded = new Map();
  for (const [name, html] of [["home", home], ["game", game]]) {
    const entries = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
    assert(entries.length > 0, `Public ${name} must load a built JavaScript entry`);
    const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map(match => match[1]);
    let revisionEmbedded = false;
    for (const path of new Set([...entries, ...preloads])) {
      if (!downloaded.has(path)) downloaded.set(path, await get(path));
      const asset = downloaded.get(path);
      assert(asset.length > 1000, `Public asset ${path} must be available`);
      revisionEmbedded ||= asset.includes(expected);
    }
    assert(revisionEmbedded, `Public ${name} JavaScript must embed the exact build revision`);
  }
  evidence.checkedAt = new Date().toISOString();
  console.log(`PASS public home/game/assets HTTP 200; version.json revision ${expected}`);
} finally {
  await writeFile("test-results/public/deployment.json", JSON.stringify(evidence, null, 2) + "\n");
}
