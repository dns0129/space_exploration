import type { FlightState } from "../../shared/flight-state.mjs";
import type { FlightStoreServices } from "./flight-services";

export interface DesktopCloseResult {
  saved: boolean;
  message?: string;
}

/** Narrow IPC contract: no filesystem paths or Electron objects enter the page. */
export interface DesktopBridge {
  readonly version: 1;
  readSave(): Promise<unknown>;
  writeSave(state: FlightState): Promise<void>;
  onBeforeClose(callback: () => void): () => void;
  readyToClose(result: DesktopCloseResult): Promise<void>;
}

declare global {
  interface Window {
    voyagerDesktop?: DesktopBridge;
  }
}

export function requireDesktopBridge(value: unknown): DesktopBridge {
  const bridge = value as Partial<DesktopBridge> | undefined;
  if (!bridge || bridge.version !== 1 ||
      ![bridge.readSave, bridge.writeSave, bridge.onBeforeClose, bridge.readyToClose]
        .every(method => typeof method === "function"))
    throw new Error("客户端存档接口未能启动，请重新打开完整的客户端。");
  return bridge as DesktopBridge;
}

export function createDesktopFlightServices(bridge: DesktopBridge): FlightStoreServices {
  const native = requireDesktopBridge(bridge);
  return {
    saves: {
      read: () => native.readSave(),
      write: state => native.writeSave(state),
    },
  };
}
