import type { FlightState } from "../../shared/flight-state.mjs";

/** A browser, desktop IPC or file-backed adapter can implement this contract. */
export interface FlightSaveRepository {
  read(): Promise<unknown>;
  write(state: FlightState): Promise<void>;
}

/** Transport details and session handling belong to the platform adapter. */
export interface FlightBackend {
  readWorld(): Promise<unknown>;
  readSave(): Promise<unknown>;
  writeSave(state: FlightState): Promise<boolean>;
}

export interface FlightStoreServices {
  saves: FlightSaveRepository;
  backend?: FlightBackend;
  isOnline?: () => boolean;
}
