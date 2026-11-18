import { world, validateFlightState } from "../shared/flight-state.mjs";
import type { WorldConfig, FlightState } from "../shared/flight-state.mjs";
import { prepareTerrainFields } from "../shared/terrain-fields.mjs";

async function prepareSavedTerrain(value: unknown) {
  if (!value || typeof value !== "object") return;
  const state = value as Partial<FlightState>;
  const ids = [state.landedBody, state.walking?.bodyId, state.referenceFrame?.kind === 'body-fixed' ? state.referenceFrame.bodyId : undefined]
    .filter((id): id is NonNullable<typeof id> => typeof id === "string" && world.bodies.some(body => body.id === id));
  await prepareTerrainFields(ids);
}

const key = "voyager-flight-v1";
const pendingKey = "voyager-flight-pending-sync";

async function fetchWithDeadline<T>(
  path: string,
  timeoutMs: number,
  consume: (response: Response) => Promise<T> | T,
  init?: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  // A native AbortSignal timeout can expire while terrain creation blocks the
  // main thread, aborting a response that has already arrived. A cancellable
  // main-thread timer yields once before aborting, letting queued headers and
  // body completion run after a long task. Keep the deadline active through
  // JSON consumption so a stalled response body still falls back.
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    abortTimer = setTimeout(() => controller.abort(), 0);
  }, timeoutMs);
  try {
    return await consume(await fetch(path, { ...init, signal: controller.signal }));
  } finally {
    clearTimeout(timer);
    clearTimeout(abortTimer);
  }
}

export class FlightStore {
  online = false;
  private serverUnconfirmed = false;
  private writes: Promise<void> = Promise.resolve();
  async connect(): Promise<WorldConfig> {
    this.online = false;
    this.serverUnconfirmed = false;
    if (import.meta.env.VITE_PUBLIC_SITE === "true" || !["http:", "https:"].includes(location.protocol))
      return world;
    this.serverUnconfirmed = true;
    if (!navigator.onLine) return world;
    try {
      const config = await fetchWithDeadline(
        "/api/world", 2500,
        (response) => response.ok ? response.json() : null,
      );
      if (JSON.stringify(config) === JSON.stringify(world)) {
        this.online = true;
        this.serverUnconfirmed = false;
        return config;
      }
    } catch {
      /* Offline navigation keeps the local world. */
    }
    return world;
  }
  async read(): Promise<FlightState | null> {
    await this.writes;
    let readError = this.serverUnconfirmed;
    if (!navigator.onLine && this.online) {
      readError = true;
      this.serverUnconfirmed = true;
      this.online = false;
    }
    // A successful local fallback is newer than the last acknowledged server
    // checkpoint. Reconnecting must not discard it during a graphics-heavy reload.
    try {
      const local = localStorage.getItem(key);
      if (local && localStorage.getItem(pendingKey) === local) {
        const value = JSON.parse(local);
        await prepareSavedTerrain(value);
        const state = validateFlightState(value);
        if (state) return state;
      }
    } catch { /* Storage may be unavailable; retain the server path. */ }
    if (this.online)
      try {
        const saved = await fetchWithDeadline(
          "/api/flight/save", 2500,
          (response) => response.ok ? response.json() : null,
        );
        if (!saved || !("state" in saved)) throw new Error("无法读取服务端存档");
        await prepareSavedTerrain(saved.state);
        const state = validateFlightState(saved?.state);
        if (state) return state;
        if (saved.state !== null) throw new Error("服务端存档无效");
      } catch {
        readError = true;
        this.serverUnconfirmed = true;
        this.online = false;
      }
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const value = JSON.parse(raw);
      await prepareSavedTerrain(value);
      const state = validateFlightState(value);
      if (state) return state;
      throw new Error("无法读取本机存档");
    }
    if (readError) throw new Error("无法读取服务端存档");
    return null;
  }
  save(state: FlightState): Promise<"server" | "local"> {
    const writing = this.writes.then(() => this.write(state));
    this.writes = writing.then(() => {}, () => {});
    return writing;
  }
  private async write(state: FlightState): Promise<"server" | "local"> {
    if (!navigator.onLine) this.online = false;
    await prepareSavedTerrain(state);
    const safe = validateFlightState(state);
    if (!safe) throw new Error("Invalid flight state");
    let local = false;
    const serialized = JSON.stringify(safe);
    try {
      localStorage.setItem(key, serialized);
      local = true;
      localStorage.setItem(pendingKey, serialized);
    } catch {
      /* Server storage can still succeed. */
    }
    if (this.online)
      try {
        const saved = await fetchWithDeadline(
          "/api/flight/save", 4000,
          (response) => response.ok,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(safe),
          },
        );
        if (saved) {
          try {
            if (localStorage.getItem(pendingKey) === serialized) localStorage.removeItem(pendingKey);
          } catch { /* A server acknowledgement remains valid without local storage. */ }
          return "server";
        }
      } catch {
        /* Fall back to a local save. */
      }
    this.online = false;
    if (local) return "local";
    throw new Error("无法保存航行，请检查浏览器存储空间。");
  }
}
