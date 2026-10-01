/** Rendering units are Earth radii. This first milestone implements Earth only. */
export const EARTH = {
  id: "earth",
  name: "地球",
  radiusKm: 6371,
  axialTiltDeg: 23.44,
  distanceFromSunMillionKm: 149.6,
  orbitalPeriodDays: 365.25,
} as const;

export const SOLAR_SYSTEM = [
  { id: "sun", name: "太阳", english: "SUN", color: "#f8bd67" },
  { id: "mercury", name: "水星", english: "MERCURY", color: "#9e958d" },
  { id: "venus", name: "金星", english: "VENUS", color: "#d9b18a" },
  { id: "earth", name: "地球", english: "EARTH", color: "#75c8ef" },
  { id: "mars", name: "火星", english: "MARS", color: "#cd886c" },
  { id: "jupiter", name: "木星", english: "JUPITER", color: "#ccab89" },
  { id: "saturn", name: "土星", english: "SATURN", color: "#d9c59b" },
  { id: "uranus", name: "天王星", english: "URANUS", color: "#b1dadc" },
  { id: "neptune", name: "海王星", english: "NEPTUNE", color: "#678acd" },
] as const;
