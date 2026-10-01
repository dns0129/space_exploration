import { FlightStore } from "./flight-store";
import { getBody } from "./solar-system";
import type { BodyId } from "./solar-system";
import type { SolarScene, FlightStats } from "./planet-scene";
import type { FlightState } from "../shared/flight-state.mjs";
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
export class FlightInterface {
  active = false;
  private scene?: SolarScene;
  private store = new FlightStore();
  private saved: FlightState | null = null;
  private paused = false;
  private generation = 0;
  private saving = false;
  private saveRevision = 0;
  private timer?: ReturnType<typeof setInterval>;
  private notify: (message: string) => void;
  private changed: (active: boolean, target?: BodyId) => void;
  constructor(
    notify: (message: string) => void,
    changed: (active: boolean, target?: BodyId) => void,
  ) {
    this.notify = notify;
    this.changed = changed;
    document.querySelector(".main")!.insertAdjacentHTML(
      "beforeend",
      `<section id="flight-ui" class="flight-ui" aria-label="飞船驾驶台" hidden>
  <div class="flight-title"><span class="eyebrow">FREE FLIGHT / 自由航行</span><h2>VOYAGER <b>01</b></h2><span id="flight-status">手动驾驶 · 引擎待命</span></div>
  <div class="flight-toolbar"><button id="flight-camera" aria-pressed="false">切换外部视角 <kbd>C</kbd></button><button id="flight-assist" aria-pressed="true">驾驶辅助：开</button><button id="flight-pause" aria-pressed="false">暂停航行</button><button id="flight-save">保存航行</button><button id="flight-resume" disabled>恢复存档</button><select id="flight-quality" aria-label="航行画质"><option value="high">高清</option><option value="standard">标准</option></select></div>
  <aside class="flight-navigation"><span class="eyebrow">导航目标 / DESTINATION</span><h3 id="flight-target">地球</h3><p><strong id="flight-distance">—</strong><small> km</small></p><div><button id="flight-align">对准目标</button><button id="flight-jump">跃迁至目标</button></div><small class="flight-nav-note">点击天体导航选择目的地，或自由驾驶</small></aside>
  <div class="flight-crosshair" aria-hidden="true"><i></i><b></b></div><div class="flight-marker" id="flight-marker" aria-hidden="true"><i></i><span>地球</span></div>
  <div class="cockpit-frame" aria-hidden="true"><i class="cockpit-left"></i><i class="cockpit-right"></i><i class="cockpit-dashboard"></i></div>
  <div class="flight-instruments"><div><span>航速 / SPEED</span><strong id="flight-speed">0</strong><small>km/s</small></div><div><span>最近天体 / NEAREST</span><strong id="flight-nearest">地球</strong><small id="flight-altitude">— km 高度</small></div><div><span>航向 / HEADING</span><strong id="flight-heading">000°</strong><small id="flight-time">00:00</small></div><div class="flight-save-info"><span>航行存档 / SAVE</span><strong id="flight-storage">准备存档</strong><small>每 20 秒自动保存</small></div></div>
  <p class="flight-key-guide"><kbd>W S</kbd> 推力 <kbd>A D</kbd> 平移 <kbd>R F</kbd> 升降 <kbd>Q E</kbd> 翻滚 <kbd>↑ ↓ ← →</kbd> / 拖动转向 <kbd>Shift</kbd> 加速 <kbd>空格</kbd> 刹车</p>
  <div class="flight-touch" aria-label="触屏驾驶控制"><div class="flight-thrust-pad"><button data-flight-input="KeyR" aria-label="飞船上升">升</button><button data-flight-input="KeyW" aria-label="飞船前进">前进</button><button data-flight-input="KeyF" aria-label="飞船下降">降</button><button data-flight-input="KeyA" aria-label="飞船左移">左移</button><button data-flight-input="Space" aria-label="飞船刹车">刹车</button><button data-flight-input="KeyD" aria-label="飞船右移">右移</button><button data-flight-input="KeyQ" aria-label="飞船左翻滚">↶</button><button data-flight-input="KeyS" aria-label="飞船后退">后退</button><button data-flight-input="KeyE" aria-label="飞船右翻滚">↷</button></div><div class="flight-steer-pad"><button data-flight-input="ArrowUp" aria-label="飞船抬头">↑</button><button data-flight-input="ArrowLeft" aria-label="飞船左转">←</button><button data-flight-input="ShiftLeft" aria-label="飞船加速">加速</button><button data-flight-input="ArrowRight" aria-label="飞船右转">→</button><button data-flight-input="ArrowDown" aria-label="飞船低头">↓</button></div></div>
 </section>`,
    );
    $("#flight-camera").onclick = () => this.camera();
    $("#flight-assist").onclick = () => {
      const state = this.scene?.flightState();
      if (!state) return;
      this.scene?.setFlightAssist(!state.assist);
      this.sync();
    };
    $("#flight-pause").onclick = () => this.pause(!this.paused);
    $("#flight-save").onclick = () => void this.save(false);
    $("#flight-resume").onclick = () => {
      if (this.saved && this.scene?.restoreFlight(this.saved)) {
        this.changed(true, this.saved.target);
        this.sync();
        this.notify("已恢复航行存档");
      }
    };
    $("#flight-align").onclick = () => {
      this.scene?.alignFlight();
      this.notify("航向已对准目标，按 W 启动推力");
    };
    $("#flight-jump").onclick = () => {
      this.scene?.jumpFlight();
      this.notify("跃迁完成，已抵达目标附近");
    };
    $("#flight-quality").onchange = () =>
      this.scene?.setQuality(
        $<HTMLSelectElement>("#flight-quality").value === "high",
      );
    document.addEventListener("keydown", (event) => {
      if (
        !this.active ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        document.querySelector("dialog[open]") ||
        (event.target instanceof Element &&
          event.target.closest("input,select,textarea"))
      )
        return;
      if (event.code === "KeyC") {
        event.preventDefault();
        this.camera();
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (this.active && document.hidden) this.pause(true);
    });
  }
  async launch(scene: SolarScene, id: BodyId, onProgress: (p: number) => void) {
    const version = ++this.generation;
    this.scene = scene;
    const config = await this.store.connect();
    if (version !== this.generation) return false;
    scene.setFlightHandler((stats) => this.update(stats));
    const ready = await scene.enterFlight(id, config, onProgress);
    if (!ready || version !== this.generation) return false;
    this.active = true;
    this.paused = false;
    this.pause(false);
    scene.setQuality($<HTMLSelectElement>("#flight-quality").value === "high");
    this.saved = null;
    $("#flight-resume").setAttribute("disabled", "");
    this.changed(true, id);
    $("#flight-ui").hidden = false;
    this.sync();
    $("#flight-storage").textContent = this.store.online
      ? "服务端存档"
      : "本机存档";
    this.timer = setInterval(() => {
      if (this.active) void this.save(true);
    }, 20_000);
    const revision = this.saveRevision;
    void this.store.read().then((saved) => {
      if (this.generation !== version || revision !== this.saveRevision) return;
      this.saved = saved;
      $<HTMLButtonElement>("#flight-resume").disabled = !saved;
    });
    return true;
  }
  stop() {
    if (this.active) {
      const state = this.scene?.flightState();
      if (state) void this.store.save(state).catch(() => {});
    }
    ++this.generation;
    clearInterval(this.timer);
    this.scene?.leaveFlight();
    this.active = false;
    $("#flight-ui").hidden = true;
    this.changed(false);
  }
  target(id: BodyId) {
    this.scene?.setDestination(id);
    $("#flight-target").textContent = getBody(id).name;
  }
  private sync() {
    const state = this.scene?.flightState();
    if (!state) return;
    $("#flight-camera").innerHTML =
      `${state.camera === "cockpit" ? "切换外部视角" : "切换座舱视角"} <kbd>C</kbd>`;
    $("#flight-camera").setAttribute(
      "aria-pressed",
      String(state.camera === "chase"),
    );
    $(".cockpit-frame").hidden = state.camera === "chase";
    $("#flight-assist").textContent = `驾驶辅助：${state.assist ? "开" : "关"}`;
    $("#flight-assist").setAttribute("aria-pressed", String(state.assist));
    $("#flight-target").textContent = getBody(state.target).name;
  }
  private camera() {
    const state = this.scene?.flightState();
    if (!state) return;
    this.scene?.setFlightCamera(
      state.camera === "cockpit" ? "chase" : "cockpit",
    );
    this.sync();
  }
  pause(paused: boolean) {
    if (!this.active) return;
    this.paused = paused;
    this.scene?.setFlightPaused(paused);
    $("#flight-pause").textContent = paused ? "继续航行" : "暂停航行";
    $("#flight-pause").setAttribute("aria-pressed", String(paused));
  }
  private async save(automatic: boolean) {
    const state = this.scene?.flightState();
    if (!state || !this.active || this.saving) return;
    this.saving = true;
    ++this.saveRevision;
    const generation = this.generation;
    $<HTMLButtonElement>("#flight-save").disabled = true;
    $("#flight-storage").textContent = "正在保存…";
    try {
      const source = await this.store.save(state);
      if (generation !== this.generation) return;
      this.saved = state;
      $<HTMLButtonElement>("#flight-resume").disabled = false;
      $("#flight-storage").textContent =
        source === "server" ? "已保存 · 服务端" : "已保存 · 本机";
      if (!automatic) this.notify("航行状态已保存");
    } catch (error) {
      if (generation === this.generation) {
        $("#flight-storage").textContent = "保存失败";
        this.notify(
          error instanceof Error ? error.message : "航行存档未能保存，请重试",
        );
      }
    } finally {
      this.saving = false;
      $<HTMLButtonElement>("#flight-save").disabled = false;
    }
  }
  private update(stats: FlightStats) {
    if (!this.active) return;
    const number = (n: number) => Math.round(n).toLocaleString("zh-CN");
    $("#flight-speed").textContent = number(stats.speedKm);
    $("#flight-distance").textContent = number(stats.distanceKm);
    $("#flight-nearest").textContent = getBody(stats.nearest).name;
    $("#flight-altitude").textContent = `${number(stats.altitudeKm)} km 高度`;
    $("#flight-heading").textContent =
      `${Math.round(stats.heading).toString().padStart(3, "0")}°`;
    const seconds = Math.floor(stats.elapsed);
    $("#flight-time").textContent = `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
    $("#flight-status").textContent = this.paused
      ? "航行已暂停"
      : stats.collision
        ? "安全护盾已制动 · 请转向离开"
        : stats.boosting
          ? "加速航行 · 推力增强"
          : stats.speedKm < 1
            ? "手动驾驶 · 引擎待命"
            : "手动驾驶 · 自由航行";
    const marker = $("#flight-marker");
    marker.style.left = `${stats.targetX}%`;
    marker.style.top = `${stats.targetY}%`;
    marker.classList.toggle("offscreen", !stats.inView);
    marker.querySelector("span")!.textContent = getBody(stats.target).name;
  }
}
