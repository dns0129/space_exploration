import { emptyInput } from "./ship-dynamics";
import type { FlightInput } from "./ship-dynamics";
export class FlightControls {
  private keys = new Set<string>();
  private touch = new Set<string>();
  private mouseX = 0;
  private mouseY = 0;
  private pointer: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private canvas: HTMLCanvasElement;
  private cleanups: (() => void)[] = [];
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const on = (target: EventTarget, name: string, handler: EventListener) => {
      target.addEventListener(name, handler);
      this.cleanups.push(() => target.removeEventListener(name, handler));
    };
    on(window, "keydown", ((e: KeyboardEvent) => {
      if (
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        document.querySelector("dialog[open]") ||
        (e.target instanceof Element &&
          e.target.closest("input,select,textarea"))
      )
        return;
      if (
        [
          "KeyW",
          "KeyS",
          "KeyA",
          "KeyD",
          "KeyR",
          "KeyF",
          "KeyQ",
          "KeyE",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Space",
          "ShiftLeft",
          "ShiftRight",
        ].includes(e.code)
      ) {
        e.preventDefault();
        this.keys.add(e.code);
      }
    }) as EventListener);
    on(window, "keyup", ((e: KeyboardEvent) => {
      this.keys.delete(e.code);
    }) as EventListener);
    on(window, "blur", (() => this.clear()) as EventListener);
    on(document, "visibilitychange", (() => this.clear()) as EventListener);
    on(canvas, "pointerdown", ((e: PointerEvent) => {
      if (e.button !== 0) return;
      this.pointer = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    }) as EventListener);
    on(canvas, "pointermove", ((e: PointerEvent) => {
      if (this.pointer !== e.pointerId) return;
      this.mouseX += (e.clientX - this.lastX) * 0.003;
      this.mouseY += (e.clientY - this.lastY) * 0.003;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }) as EventListener);
    const stop = ((e: PointerEvent) => {
      if (this.pointer === e.pointerId) this.pointer = null;
    }) as EventListener;
    on(canvas, "pointerup", stop);
    on(canvas, "pointercancel", stop);
    on(canvas, "lostpointercapture", stop);
    document
      .querySelectorAll<HTMLButtonElement>("[data-flight-input]")
      .forEach((button) => {
        const action = button.dataset.flightInput!;
        on(button, "pointerdown", ((e: PointerEvent) => {
          e.preventDefault();
          button.setPointerCapture(e.pointerId);
          this.touch.add(action);
          button.classList.add("held");
        }) as EventListener);
        const release = (() => {
          this.touch.delete(action);
          button.classList.remove("held");
        }) as EventListener;
        on(button, "pointerup", release);
        on(button, "pointercancel", release);
        on(button, "lostpointercapture", release);
      });
  }
  read(): FlightInput {
    const has = (...keys: string[]) =>
      keys.some((k) => this.keys.has(k) || this.touch.has(k));
    const value = (positive: string, negative: string) =>
      Number(has(positive)) - Number(has(negative));
    const input = {
      ...emptyInput(),
      throttle: value("KeyW", "KeyS"),
      strafe: value("KeyD", "KeyA"),
      lift: value("KeyR", "KeyF"),
      yaw: value("ArrowLeft", "ArrowRight"),
      pitch: value("ArrowUp", "ArrowDown"),
      roll: value("KeyQ", "KeyE"),
      boost: has("ShiftLeft", "ShiftRight"),
      brake: has("Space"),
      mouseX: this.mouseX,
      mouseY: this.mouseY,
    };
    this.mouseX = 0;
    this.mouseY = 0;
    return input;
  }
  clear() {
    this.keys.clear();
    this.touch.clear();
    this.mouseX = 0;
    this.mouseY = 0;
    this.pointer = null;
    document
      .querySelectorAll("[data-flight-input]")
      .forEach((b) => b.classList.remove("held"));
  }
  dispose() {
    const pointer = this.pointer;
    this.cleanups.forEach((f) => f());
    if (pointer !== null && this.canvas.hasPointerCapture(pointer))
      this.canvas.releasePointerCapture(pointer);
    this.clear();
  }
}
