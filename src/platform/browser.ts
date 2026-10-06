import { BrowserFlightSaves } from "./browser-storage.ts";
import type { BrowserStorage } from "./browser-storage.ts";
import { HttpFlightBackend } from "./http-flight-backend.ts";
import type { FlightFetch } from "./http-flight-backend.ts";
import type { FlightStoreServices } from "./flight-services";

export interface BrowserFlightOptions {
  publicSite?: boolean;
  protocol?: string;
  storage?: () => BrowserStorage;
  request?: FlightFetch;
  isOnline?: () => boolean;
  apiBase?: string;
}

/** The application entry point chooses the platform; save policy stays shared. */
export function createBrowserFlightServices(
  options: BrowserFlightOptions = {},
): FlightStoreServices {
  const publicSite = options.publicSite ?? import.meta.env.VITE_PUBLIC_SITE === "true";
  const protocol = options.protocol ?? location.protocol;
  return {
    saves: new BrowserFlightSaves(options.storage ?? (() => localStorage)),
    isOnline: options.isOnline ?? (() => navigator.onLine),
    // Pages and file exports have no backend, even while a network is available.
    backend: !publicSite && ["http:", "https:"].includes(protocol)
      ? new HttpFlightBackend(options.request ?? ((url, init) => fetch(url, init)), options.apiBase)
      : undefined,
  };
}
