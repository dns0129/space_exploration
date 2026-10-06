import { world, validateFlightState } from "../shared/flight-state.mjs";
import type { WorldConfig, FlightState } from "../shared/flight-state.mjs";
import type { FlightStoreServices } from "./platform/flight-services";

/** Save policy shared by web and desktop; no browser globals or HTTP here. */
export class FlightStore {
  online = false;
  private readonly services: FlightStoreServices;
  private pendingSave: Promise<void> = Promise.resolve();
  private lastSave: Promise<"server" | "local"> | undefined;

  constructor(services: FlightStoreServices) {
    this.services = services;
  }

  private available() {
    return this.services.isOnline?.() ?? true;
  }

  async connect(): Promise<WorldConfig> {
    this.online = false;
    if (!this.services.backend || !this.available()) return world;
    try {
      const config = await this.services.backend.readWorld();
      if (JSON.stringify(config) === JSON.stringify(world)) {
        this.online = true;
        return world;
      }
    } catch {
      /* Offline navigation keeps the local world. */
    }
    return world;
  }

  async read(): Promise<FlightState | null> {
    if (!this.available()) this.online = false;
    if (this.online && this.services.backend)
      try {
        const state = validateFlightState(await this.services.backend.readSave());
        if (state) return state;
      } catch {
        this.online = false;
      }
    try {
      return validateFlightState(await this.services.saves.read());
    } catch {
      return null;
    }
  }

  async save(state: FlightState): Promise<"server" | "local"> {
    const safe = validateFlightState(state);
    if (!safe) throw new Error("Invalid flight state");
    // File and IPC adapters are asynchronous: checkpoints must finish in order.
    const saving = this.pendingSave.then(() => this.write(safe));
    this.pendingSave = saving.then(() => {}, () => {});
    this.lastSave = saving;
    return saving;
  }

  /** Wait for checkpoints queued when leaving flight before native shutdown. */
  flush(): Promise<void> {
    return this.lastSave ? this.lastSave.then(() => {}) : Promise.resolve();
  }

  private async write(safe: FlightState): Promise<"server" | "local"> {
    if (!this.available()) this.online = false;
    let local = false;
    try {
      await this.services.saves.write(safe);
      local = true;
    } catch {
      /* Server storage can still succeed. */
    }
    if (this.online && this.services.backend)
      try {
        if (await this.services.backend.writeSave(safe)) return "server";
      } catch {
        /* Fall back to a local save. */
      }
    this.online = false;
    if (local) return "local";
    throw new Error("无法保存航行，请检查存储空间。");
  }
}
