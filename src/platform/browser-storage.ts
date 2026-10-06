import type { FlightState } from "../../shared/flight-state.mjs";
import type { FlightSaveRepository } from "./flight-services";

// Keep the existing key so users retain their current and legacy saves.
export const FLIGHT_SAVE_KEY = "voyager-flight-v1";

export interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class BrowserFlightSaves implements FlightSaveRepository {
  private readonly storage: () => BrowserStorage;

  constructor(storage: () => BrowserStorage) {
    // Delay access: even obtaining localStorage can fail in restricted browsers.
    this.storage = storage;
  }

  async read(): Promise<unknown> {
    return JSON.parse(this.storage().getItem(FLIGHT_SAVE_KEY) ?? "null");
  }

  async write(state: FlightState): Promise<void> {
    this.storage().setItem(FLIGHT_SAVE_KEY, JSON.stringify(state));
  }
}
