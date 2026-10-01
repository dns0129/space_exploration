import { world, validateFlightState } from "../shared/flight-state.mjs";
import type { WorldConfig, FlightState } from "../shared/flight-state.mjs";
const key = "voyager-flight-v1";
export class FlightStore {
  online = false;
  async connect(): Promise<WorldConfig> {
    this.online = false;
    if (!["http:", "https:"].includes(location.protocol) || !navigator.onLine)
      return world;
    try {
      const response = await fetch("/api/world", {
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) return world;
      const config = await response.json();
      if (JSON.stringify(config) === JSON.stringify(world)) {
        this.online = true;
        return config;
      }
    } catch {
      /* Offline navigation keeps the local world. */
    }
    return world;
  }
  async read(): Promise<FlightState | null> {
    if (!navigator.onLine) this.online = false;
    if (this.online)
      try {
        const response = await fetch("/api/flight/save", {
          signal: AbortSignal.timeout(2500),
        });
        if (response.ok) {
          const saved = await response.json();
          const state = validateFlightState(saved.state);
          if (state) return state;
        }
      } catch {
        this.online = false;
      }
    try {
      return validateFlightState(
        JSON.parse(localStorage.getItem(key) ?? "null"),
      );
    } catch {
      return null;
    }
  }
  async save(state: FlightState): Promise<"server" | "local"> {
    if (!navigator.onLine) this.online = false;
    const safe = validateFlightState(state);
    if (!safe) throw new Error("Invalid flight state");
    let local = false;
    try {
      localStorage.setItem(key, JSON.stringify(safe));
      local = true;
    } catch {
      /* Server storage can still succeed. */
    }
    if (this.online)
      try {
        const response = await fetch("/api/flight/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(safe),
          signal: AbortSignal.timeout(4000),
        });
        if (response.ok) return "server";
      } catch {
        /* Fall back to a local save. */
      }
    this.online = false;
    if (local) return "local";
    throw new Error("无法保存航行，请检查浏览器存储空间。");
  }
}
