import { createBrowserFlightServices } from "./browser";
import { createDesktopFlightServices, requireDesktopBridge } from "./desktop";
import type { FlightStoreServices } from "./flight-services";

export const desktopBridge = import.meta.env.VITE_DESKTOP === "true"
  ? requireDesktopBridge(window.voyagerDesktop)
  : undefined;

export function createRuntimeFlightServices(): FlightStoreServices {
  return desktopBridge
    ? createDesktopFlightServices(desktopBridge)
    : createBrowserFlightServices();
}
