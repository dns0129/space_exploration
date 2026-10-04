import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssetResolver } from "../src/platform/assets.ts";

test("web texture URLs respect root, project and relative deployment bases", () => {
  assert.equal(createAssetResolver("/").texture("earth-day.jpg"), "/textures/earth-day.jpg");
  assert.equal(createAssetResolver("/space_exploration/").texture("milky-way-4k.jpg"), "/space_exploration/textures/milky-way-4k.jpg");
  assert.equal(createAssetResolver("/custom").texture("betelgeuse-4k.jpg"), "/custom/textures/betelgeuse-4k.jpg");
  assert.equal(createAssetResolver("./").texture("moon-real.jpg"), "./textures/moon-real.jpg");
});

test("desktop adapters can resolve local protocol URLs without browser globals", () => {
  assert.equal(createAssetResolver("asset://voyager/").texture("earth-clouds.png"), "asset://voyager/textures/earth-clouds.png");
  assert.equal(createAssetResolver("file:///Applications/Voyager/assets/").texture("betelgeuse-8k.jpg"), "file:///Applications/Voyager/assets/textures/betelgeuse-8k.jpg");
});

test("embedded manifests cover core, Earth, lazy and compact textures with no fallback", () => {
  const manifest = Object.fromEntries([
    "earth-day.jpg", "earth-night.jpg", "earth-height.jpg", "earth-water.png", "earth-clouds.png",
    "milky-way-4k.jpg", "jupiter-real.jpg", "moon-real.jpg", "betelgeuse-8k.jpg", "betelgeuse-4k.jpg",
  ].map((file) => [file, "data:image/jpeg;base64,AA=="]));
  const assets = createAssetResolver("https://must-not-fetch.invalid/", manifest);
  for (const file of Object.keys(manifest)) assert.equal(assets.texture(file), manifest[file]);
  assert.throws(() => assets.texture("new-moon.jpg"), /missing from the manifest/);
  assert.throws(() => assets.texture("toString"), /missing from the manifest/);
  assert.throws(() => createAssetResolver("https://must-not-fetch.invalid/", {}).texture("earth-day.jpg"), /missing from the manifest/);
});

test("texture names cannot escape the platform asset directory", () => {
  const assets = createAssetResolver("/space_exploration/");
  for (const file of ["", "../earth-day.jpg", "images/../earth-day.jpg", "/earth-day.jpg", "//example.com/map.jpg", "https://example.com/map.jpg", "earth-day.jpg?url=https://example.com", "earth-day.jpg#fragment", "images\\earth-day.jpg", "%2e%2e/map.jpg"]) {
    assert.throws(() => assets.texture(file), /Invalid texture asset/);
  }
});
