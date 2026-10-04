import { emptyInput, FlightInputState, flightActionForKey } from "./core/flight-input.ts";
import type { FlightInput, InputSource } from "./core/flight-input.ts";
export class FlightControls implements InputSource {
  private readonly state = new FlightInputState();
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
      const action = flightActionForKey(e.code);
      if (action) {
        e.preventDefault();
        this.state.setAction(action, true, `keyboard:${e.code}`);
      }
    }) as EventListener);
    on(window, "keyup", ((e: KeyboardEvent) => {
      const action = flightActionForKey(e.code);
      if (action) this.state.setAction(action, false, `keyboard:${e.code}`);
    }) as EventListener);
    on(window, "blur", (() => this.clear()) as EventListener);
    on(document, "visibilitychange", (() => this.clear()) as EventListener);
    on(canvas, "pointerdown", ((e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType === "mouse") return;
      this.pointer = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    }) as EventListener);
    on(canvas, "pointermove", ((e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      if (this.pointer !== e.pointerId) return;
      this.state.setSteering((e.clientX - this.lastX) / 80, (e.clientY - this.lastY) / 80);
    }) as EventListener);
    const stop = ((e: PointerEvent) => {
      if (this.pointer === e.pointerId) {
        this.pointer = null;
        if (e.pointerType !== "mouse") this.state.centerSteering();
      }
    }) as EventListener;
    on(canvas, "pointerup", stop);
    on(canvas, "pointercancel", stop);
    on(canvas, "lostpointercapture", stop);
    on(canvas, "pointerleave", (() => { if (this.pointer === null) this.state.centerSteering(); }) as EventListener);
    document
      .querySelectorAll<HTMLButtonElement>("[data-flight-input]")
      .forEach((button) => {
        const code = button.dataset.flightInput!;
        const action = flightActionForKey(code);
        if (!action) return;
        on(button, "pointerdown", ((e: PointerEvent) => {
          e.preventDefault();
          button.setPointerCapture(e.pointerId);
          this.state.setAction(action, true, `touch:${code}`);
          button.classList.add("held");
        }) as EventListener);
        const release = (() => {
          this.state.setAction(action, false, `touch:${code}`);
          button.classList.remove("held");
        }) as EventListener;
        on(button, "pointerup", release);
        on(button, "pointercancel", release);
        on(button, "lostpointercapture", release);
      });
  }
  read(): FlightInput {
    if (document.querySelector("dialog[open]")) {
      this.clear();
      return emptyInput();
    }
    return this.state.read();
  }
  get aim() { return this.state.aim; }
  clear() {
    this.state.clear();
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
