import type { RenderQuality } from "./earth-detail";
import { FlightStore } from "./flight-store";
import { getBody, STAR_SYSTEMS } from "./solar-system";
import type { BodyId } from "./solar-system";
import type { SolarScene, FlightStats, FlightTrackingStats } from "./planet-scene";
import type { FlightState } from "../shared/flight-state.mjs";
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
export class FlightInterface {
  active = false;
  private scene?: SolarScene;
  private readonly store: FlightStore;
  private saved: FlightState | null = null;
  private paused = false;
  private warpPhase: FlightStats["warpPhase"] = "ready";
  private landingPhase: FlightStats["landingPhase"] = "manual";
  private generation = 0;
  private saving = false;
  private saveRevision = 0;
  private lastAutoElapsed = 0;
  private timer?: ReturnType<typeof setInterval>;
  private marker!: HTMLElement;
  private markerName!: HTMLElement;
  private aim!: HTMLElement;
  private deceleration!: HTMLElement;
  private trackedTarget?: BodyId;
  private notify: (message: string) => void;
  private changed: (active: boolean, target?: BodyId) => void;
  constructor(
    notify: (message: string) => void,
    changed: (active: boolean, target?: BodyId) => void,
    store: FlightStore,
  ) {
    this.store = store;
    this.notify = notify;
    this.changed = changed;
    document.querySelector(".main")!.insertAdjacentHTML(
      "beforeend",
      `<section id="flight-ui" class="flight-ui" aria-label="飞船驾驶台" hidden>
  <div class="flight-title"><span class="eyebrow">REAL SCALE / 星际航行</span><h2>VOYAGER <b>01</b></h2><span id="flight-system" class="flight-system">当前位置 · 太阳系</span><span id="flight-status">手动驾驶 · 引擎待命</span></div>
  <div class="flight-toolbar"><button id="flight-camera" aria-pressed="false">切换外部视角 <kbd>C</kbd></button><button id="flight-assist" aria-pressed="true">驾驶辅助：开</button><button id="flight-pause" aria-pressed="false">暂停航行</button><button id="flight-save">保存航行</button><button id="flight-resume" disabled>恢复存档</button><select id="flight-quality" aria-label="航行画质"><option value="ultra">超清</option><option value="high">高清</option><option value="standard">标准</option></select></div>
  <aside class="flight-navigation"><span class="eyebrow">导航目标 / DESTINATION</span><h3 id="flight-target">地球</h3><p><strong id="flight-distance">—</strong><small id="flight-distance-unit"> km</small></p><small id="flight-distance-au"></small><div><button id="flight-align">对准目标</button><button id="flight-jump">启动跃迁 <kbd>J</kbd></button></div><button id="flight-land">自动着陆（L）</button><small class="flight-nav-note">真实距离 · 1 AU ≈ 1.496 亿 km</small></aside>
  <aside class="warp-engine" id="warp-engine" data-phase="ready" aria-label="跃迁引擎"><span class="eyebrow">HYPERDRIVE / 跃迁引擎</span><strong id="warp-label">引擎就绪</strong><div class="warp-track"><i id="warp-progress"></i></div><small id="warp-hint">选择目的地，按 J 蓄能启航</small><button id="warp-cancel" hidden>中止跃迁</button></aside>
  <aside id="flight-surface" class="flight-surface" data-phase="manual" aria-label="着陆系统"><span class="eyebrow">SURFACE / 着陆系统</span><strong id="flight-surface-state">手动航行</strong><b id="flight-surface-altitude">— m</b><small id="flight-atmosphere">真空环境</small><small id="flight-landing-hint">L 自动着陆</small></aside>
  <div id="flight-deceleration" class="flight-deceleration" aria-hidden="true"><span>减速制动 / DECELERATING</span></div>
  <div class="flight-crosshair" aria-hidden="true"><i></i><b></b></div><div class="flight-aim" id="flight-aim" aria-hidden="true" hidden></div><div class="flight-marker" id="flight-marker" aria-hidden="true"><i></i><span>地球</span></div>
  <div class="cockpit-frame" aria-hidden="true"><i class="cockpit-left"></i><i class="cockpit-right"></i><i class="cockpit-dashboard"></i></div>
  <div class="flight-instruments"><div><span>航速 / SPEED</span><strong id="flight-speed">0</strong><small id="flight-speed-unit">km/s</small><small id="flight-engine" data-engine="orbital">近地轨道引擎 · 自动</small><small id="flight-engine-range">1–100 km/s</small></div><div><span>最近天体 / NEAREST</span><strong id="flight-nearest">地球</strong><small id="flight-altitude">— km 高度</small></div><div><span>航向 / HEADING</span><strong id="flight-heading">000°</strong><small id="flight-time">00:00</small></div><div class="flight-save-info"><span>航行存档 / SAVE</span><strong id="flight-storage">准备存档</strong><small>每 20 秒自动保存</small></div></div>
  <p class="flight-key-guide"><kbd>W S</kbd> 前进/减速 <kbd>A D</kbd> 平移 <kbd>R F</kbd> 升降 <kbd>Q E</kbd> 翻滚 <kbd>↑ ↓ ← →</kbd> 转向 <kbd>Shift</kbd> 加速 <kbd>空格</kbd> 刹车</p>
  <div class="flight-touch" aria-label="触屏驾驶控制"><div class="flight-thrust-pad"><button data-flight-input="KeyR" aria-label="飞船上升">升</button><button data-flight-input="KeyW" aria-label="飞船前进">前进</button><button data-flight-input="KeyF" aria-label="飞船下降">降</button><button data-flight-input="KeyA" aria-label="飞船左移">左移</button><button data-flight-input="Space" aria-label="飞船刹车">刹车</button><button data-flight-input="KeyD" aria-label="飞船右移">右移</button><button data-flight-input="KeyQ" aria-label="飞船左翻滚">↶</button><button data-flight-input="KeyS" aria-label="飞船减速或倒车">减速</button><button data-flight-input="KeyE" aria-label="飞船右翻滚">↷</button></div><div class="flight-steer-pad"><button data-flight-input="ArrowUp" aria-label="飞船抬头">↑</button><button data-flight-input="ArrowLeft" aria-label="飞船左转">←</button><button data-flight-input="ShiftLeft" aria-label="飞船加速">加速</button><button data-flight-input="ArrowRight" aria-label="飞船右转">→</button><button data-flight-input="ArrowDown" aria-label="飞船低头">↓</button></div></div>
 </section>`,
    );
    this.marker = $("#flight-marker");
    this.markerName = this.marker.querySelector("span")!;
    this.aim = $("#flight-aim");
    this.deceleration = $("#flight-deceleration");
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
        this.lastAutoElapsed = this.saved.elapsed;
        this.changed(true, this.saved.target);
        this.sync();
        this.notify("已恢复航行存档");
      }
    };
    $("#flight-align").onclick = () => {
      this.scene?.alignFlight();
      this.notify("航向已对准目标，按 W 启动推力");
    };
    $("#flight-jump").onclick = () => this.jump();
    $("#flight-land").onclick = () => this.land();
    $("#warp-cancel").onclick = () => {
      this.scene?.cancelWarp();
      this.notify("跃迁已中止，当前位置可继续手动驾驶");
    };
    if (window.matchMedia("(pointer: coarse)").matches || ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4)
      $<HTMLSelectElement>("#flight-quality").value = "high";
    $("#flight-quality").onchange = () =>
      this.scene?.setQuality(
        $<HTMLSelectElement>("#flight-quality").value as RenderQuality,
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
      if (event.code === "KeyJ") {
        event.preventDefault();
        this.jump();
      }
      if (event.code === "KeyL") {
        event.preventDefault();
        this.land();
      }
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
    scene.setFlightTargetHandler((stats) => this.updateTracking(stats));
    const ready = await scene.enterFlight(id, config, onProgress);
    if (!ready || version !== this.generation) return false;
    this.active = true;
    this.paused = false;
    this.warpPhase = "ready";
    this.lastAutoElapsed = 0;
    this.pause(false);
    scene.setQuality($<HTMLSelectElement>("#flight-quality").value as RenderQuality);
    this.saved = null;
    $("#flight-resume").setAttribute("disabled", "");
    this.changed(true, id);
    $("#flight-ui").hidden = false;
    this.sync();
    $("#flight-storage").textContent = this.store.online
      ? "服务端存档"
      : "本机存档";
    this.timer = setInterval(() => {
      const elapsed = this.scene?.flightState()?.elapsed ?? 0;
      if (this.active && !this.paused && this.warpPhase === "ready" && elapsed - this.lastAutoElapsed >= 20)
        void this.save(true);
    }, 1000);
    const revision = this.saveRevision;
    void this.store.read().then((saved) => {
      if (this.generation !== version || revision !== this.saveRevision) return;
      this.saved = saved;
      $<HTMLButtonElement>("#flight-resume").disabled = !saved;
    });
    return true;
  }
  async saveBeforeClose(): Promise<void> {
    this.pause(true);
    const state = this.active ? this.scene?.flightState() : undefined;
    // Queue a fresh checkpoint even when an autosave is still being written.
    if (state) await this.store.save(state);
    await this.store.flush();
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
    if (["charging", "transit", "arrival"].includes(this.warpPhase)) return;
    this.scene?.setDestination(id);
    $("#flight-target").textContent = getBody(id).name;
  }
  private jump() {
    const error = this.scene?.jumpFlight();
    if (error) { this.notify(error); return; }
    this.pause(false);
    this.notify("跃迁引擎开始蓄能，可随时暂停或中止");
  }
  private land() {
    const previous = this.landingPhase;
    const error = this.scene?.landFlight();
    if (error) { this.notify(error); return; }
    this.pause(false);
    this.notify(previous === "landed" ? "起飞辅助启动，正在离开地表" : previous === "manual"
      ? "自动着陆启动，刹车或手动操纵可中止" : "已中止自动航行，恢复手动驾驶");
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
      this.lastAutoElapsed = state.elapsed;
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
    const lightspeed = stats.warpPhase === "transit" && stats.speedKm > 299792.458;
    const metres = !lightspeed && stats.environment.profile.solid && stats.environment.groundAltitudeKm < 20 && stats.speedKm < 1;
    $("#flight-speed").textContent = lightspeed
      ? (stats.speedKm / 299792.458).toLocaleString("zh-CN", { maximumFractionDigits: 1 })
      : (stats.speedKm * (metres ? 1000 : 1)).toLocaleString("zh-CN", { maximumFractionDigits: 1 });
    $("#flight-speed-unit").textContent = lightspeed ? "× 光速" : metres ? "m/s" : "km/s";
    const lightYearKm = 9460730472580.8;
    const useLy = stats.distanceKm >= lightYearKm * 0.05;
    const useAu = !useLy && stats.distanceKm > 1_000_000;
    $("#flight-distance").textContent = useLy ? (stats.distanceKm / lightYearKm).toFixed(3) : useAu ? (stats.distanceKm / 149597870.7).toFixed(3) : number(stats.distanceKm);
    $("#flight-distance-unit").textContent = useLy ? " 光年" : useAu ? " AU" : " km";
    $("#flight-distance-au").textContent = useLy ? `${(stats.distanceKm / 149597870.7).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} AU` : useAu ? `${number(stats.distanceKm)} km` : `${(stats.distanceKm / 149597870.7).toFixed(6)} AU`;
    $("#flight-system").textContent = `当前位置 · ${STAR_SYSTEMS.find(system => system.id === stats.systemId)!.name}`;
    const labels = { ready: "引擎就绪", charging: "引擎蓄能", transit: "跃迁航行", arrival: "减速抵达", cooldown: "引擎冷却" };
    const activeWarp = ["charging", "transit", "arrival"].includes(stats.warpPhase);
    if (stats.landingPhase === "landed" && this.landingPhase !== "landed") this.notify(`已在${getBody(stats.nearest).name}地表着陆，按 L 或 R 起飞`);
    this.landingPhase = stats.landingPhase;
    const flightLand = $<HTMLButtonElement>("#flight-land");
    flightLand.textContent = stats.landingPhase === "landed" ? "起飞（L）" : stats.landingPhase === "descending"
      ? "中止着陆（L）" : stats.landingPhase === "ascending" ? "中止起飞（L）" : "自动着陆（L）";
    flightLand.disabled = activeWarp || (stats.landingPhase === "manual" && !!stats.landingBlockReason);
    flightLand.title = stats.landingBlockReason ?? "连续下降并降落到地表";
    $("#flight-surface").dataset.phase = stats.landingPhase;
    $("#flight-surface-state").textContent = { manual: "手动航行", descending: "自动下降 · 起落架展开", landed: "已着陆 · 引擎待命", ascending: "起飞辅助 · 正在爬升" }[stats.landingPhase];
    $("#flight-surface-altitude").textContent = stats.environment.profile.solid
      ? `离地 ${(stats.environment.groundAltitudeKm * 1000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} m`
      : "无固体地表";
    $("#flight-atmosphere").textContent = stats.environment.atmospheric
      ? `大气密度 ${stats.environment.density.toFixed(3)} · ${stats.environment.density > 0.02 ? "气动阻力生效" : "稀薄大气"}`
      : "真空环境 · 无大气阻力";
    $("#flight-landing-hint").textContent = stats.landingPhase === "landed" ? "L / R 起飞 · 可保存地表位置"
      : stats.landingPhase === "descending" || stats.landingPhase === "ascending" ? "空格或手动操纵中止 · 暂停冻结进度"
      : stats.landingBlockReason ?? "L 自动着陆 · 近地自动限速";
    const nearGround = stats.environment.profile.solid && stats.environment.groundAltitudeKm < 5;
    const zone = nearGround ? "近地精细驾驶" : stats.environment.escaping ? "向太空离地" : stats.environment.atmospheric ? "大气层" : stats.environment.restricted ? "安全区" : "自动";
    $("#flight-engine").textContent = activeWarp ? "跃迁引擎" : `${stats.engine.name} · ${zone}`;
    $("#flight-ui").dataset.environment = stats.environment.atmospheric ? "atmosphere" : stats.environment.restricted ? "near" : "space";
    $("#flight-engine").dataset.engine = activeWarp ? "warp" : stats.engine.id;
    $("#flight-engine-range").textContent = activeWarp
      ? "按航程自动调速"
      : stats.landingPhase !== "manual" ? "自动着陆与起飞"
      : nearGround ? `当前上限 ${number(stats.speedLimitKm * 1000)} m/s`
      : `${number(stats.engine.minSpeedKm)}–${number(stats.engine.maxSpeedKm)} km/s`;
    if (this.warpPhase === "arrival" && stats.warpPhase === "cooldown") this.notify("跃迁完成，已减速抵达目标附近");
    this.warpPhase = stats.warpPhase;
    $("#warp-engine").dataset.phase = stats.warpPhase;
    $("#warp-label").textContent = stats.warpPhase === "ready" && stats.warpBlockReason ? "跃迁受限" : labels[stats.warpPhase];
    $("#warp-progress").style.width = `${stats.warpProgress * 100}%`;
    $("#warp-hint").textContent = stats.warpPhase === "ready" ? stats.warpBlockReason ?? "选择目的地，按 J 蓄能启航" : stats.warpPhase === "cooldown" ? "可自由驾驶，冷却后可再次跃迁" : `${Math.round(stats.warpProgress * 100)}% · ${getBody(stats.target).name}`;
    $("#warp-cancel").hidden = !activeWarp;
    $<HTMLButtonElement>("#flight-jump").disabled = !!stats.warpBlockReason;
    $("#flight-jump").title = stats.warpBlockReason ?? "启动跃迁（J）";
    $<HTMLButtonElement>("#flight-align").disabled = activeWarp || stats.landingPhase !== "manual";
    $<HTMLButtonElement>("#flight-resume").disabled = activeWarp || !this.saved;
    document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("[data-body], #satellite-target, #star-system").forEach((button) => { button.disabled = activeWarp; });
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
      : stats.landingPhase !== "manual" ? { descending: "自动着陆 · 下降与减速", landed: "已在地表着陆 · 按 L 起飞", ascending: "起飞辅助 · 离开地表" }[stats.landingPhase]
      : activeWarp
        ? labels[stats.warpPhase]
      : stats.collision
        ? "安全护盾已制动 · 请转向离开"
        : nearGround ? "近地精细飞行 · 自动限速"
        : stats.environment.escaping
          ? "离地推进 · 行星引擎可用，跃迁受限"
        : stats.environment.restricted && stats.environment.atmospheric
          ? "大气层飞行 · 最高 100 km/s"
        : stats.environment.restricted
          ? "近行星安全区 · 最高 100 km/s"
        : stats.boosting
          ? "加速航行 · 推力增强"
          : stats.speedKm < 1
            ? "手动驾驶 · 引擎待命"
            : "手动驾驶 · 自由航行";
  }
  private updateTracking(stats: FlightTrackingStats) {
    if (!this.active) return;
    this.marker.style.transform = `translate3d(${stats.targetX * stats.width / 100}px, ${stats.targetY * stats.height / 100}px, 0) translate(-50%, -50%)`;
    this.marker.style.setProperty("--target-angle", `${stats.angle}deg`);
    this.marker.classList.toggle("offscreen", !stats.inView);
    if (stats.target !== this.trackedTarget) {
      this.markerName.textContent = getBody(stats.target).name;
      this.trackedTarget = stats.target;
    }
    this.deceleration.style.opacity = stats.deceleration.toFixed(3);
    this.deceleration.style.setProperty("--brake-scale", String(0.72 + stats.deceleration * 0.28));
    this.aim.hidden = !stats.steering;
    this.aim.style.transform = `translate3d(${(0.5 + stats.aimX * 0.35) * stats.width}px, ${(0.5 + stats.aimY * 0.35) * stats.height}px, 0) translate(-50%, -50%)`;
  }
}
