// Gameplay profiles: density and terrain are illustrative, not weather or elevation data.
const profiles = {
  sun: { solid: false, sky: "#ff9b42", gravity: 274 },
  "alpha-centauri-a": { solid: false, sky: "#fff1cf", gravity: 200 },
  "alpha-centauri-b": { solid: false, sky: "#ffcb92", gravity: 300 },
  "proxima-centauri": { solid: false, sky: "#ff805a", gravity: 1000 },
  betelgeuse: { solid: false, sky: "#ff9d63", gravity: 0.007 },
  "proxima-b": { sky: "#af8976", ground: "#a2785c", gravity: 10, density: 0.6, scaleKm: 9 },
  "proxima-c": { sky: "#93bdce", ground: "#81999f", gravity: 12, density: 1, scaleKm: 40 },
  "proxima-d": { ground: "#aa8872", gravity: 5 },
  mercury: { sky: "#000000", ground: "#84796b", gravity: 3.7 },
  venus: { sky: "#d9a45c", ground: "#a16c3b", gravity: 8.87, density: 8, scaleKm: 16 },
  earth: { sky: "#72b8ef", ground: "#657d49", gravity: 9.81, density: 1, scaleKm: 8.5 },
  mars: { sky: "#c89477", ground: "#ab5334", gravity: 3.71, density: 0.04, scaleKm: 11 },
  jupiter: { solid: false, sky: "#c7aa8d", gravity: 24.79, density: 3, scaleKm: 180 },
  saturn: { solid: false, sky: "#dfc899", gravity: 10.44, density: 2, scaleKm: 160 },
  uranus: { solid: false, sky: "#83cbd0", gravity: 8.69, density: 2, scaleKm: 100 },
  neptune: { solid: false, sky: "#547bbd", gravity: 11.15, density: 2, scaleKm: 100 },
  titan: { sky: "#cc9856", ground: "#a38355", gravity: 1.35, density: 1.5, scaleKm: 40 },
};
export function surfaceProfile(id) {
  return { solid: true, sky: "#000000", ground: "#aaa79b", gravity: 1.62, density: 0, scaleKm: 1, ...profiles[id] };
}
// A continuous function of the radial direction keeps collision and regenerated tiles identical.
export function terrainHeightKm(id, normal) {
  if (!surfaceProfile(id).solid) return 0;
  const [x, y, z] = normal;
  const seed = [...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) * 0.17;
  const broad = Math.sin(x * 1900 + seed) * Math.sin(y * 1700 - seed) * Math.cos(z * 2100);
  const fine = Math.sin(x * 7200 + y * 3600 + seed) * Math.cos(z * 6400 - y * 3200);
  return 0.065 + broad * 0.045 + fine * 0.009;
}
export const LANDING_CLEARANCE_KM = 0.006;
