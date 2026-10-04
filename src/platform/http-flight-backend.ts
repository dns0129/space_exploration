import type { FlightState } from "../../shared/flight-state.mjs";
import type { FlightBackend } from "./flight-services";

export type FlightFetch = (url: string, options: RequestInit) => Promise<Response>;

export class HttpFlightBackend implements FlightBackend {
  private readonly request: FlightFetch;
  private readonly base: string;

  constructor(request: FlightFetch, base = "/api") {
    this.request = request;
    this.base = base.replace(/\/+$/, "");
  }

  async readWorld(): Promise<unknown> {
    const response = await this.request(`${this.base}/world`, {
      signal: AbortSignal.timeout(2500),
    });
    return response.ok ? response.json() : null;
  }

  async readSave(): Promise<unknown> {
    const response = await this.request(`${this.base}/flight/save`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    const saved = await response.json();
    return saved?.state ?? null;
  }

  async writeSave(state: FlightState): Promise<boolean> {
    const response = await this.request(`${this.base}/flight/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
      signal: AbortSignal.timeout(4000),
    });
    return response.ok;
  }
}
