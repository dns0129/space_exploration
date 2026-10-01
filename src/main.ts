import "./style.css";
import { EarthScene } from "./earth-scene";
import type { Layer, View } from "./earth-scene";
import { SOLAR_SYSTEM } from "./solar-system";

const icons: Record<string, string> = {
  orbit:
    '<ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-35 12 12)"/><circle cx="12" cy="12" r="4"/><path d="m20 4 1 1"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-3 5-5 3 3-5z"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 7h14M5 17h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  reset: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 8a2.5 2.5 0 1 1 4 2l-1.5 1.5V13m0 3v.01"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  moon: '<path d="M20 13a8 8 0 0 1-9-9 9 9 0 1 0 9 9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
};
const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <div class="observatory">
    <header class="header">
      <a class="brand" href="./" aria-label="远航首页">${icon("orbit")}<span>远航 <b>VOYAGER</b></span></a>
      <nav class="main-nav" aria-label="主导航"><span class="nav-active">行星观测</span><span class="nav-planned">航行模拟 <small>即将启航</small></span></nav>
      <div class="header-tools"><span class="connection"><i></i><span id="connection-text">正在连接观测站</span></span><button class="icon-button" id="help" aria-label="操作指南" title="操作指南（H）">${icon("help")}</button></div>
    </header>

    <nav class="planet-rail" aria-label="太阳系天体">
      <span class="rail-label">SOLAR<br>SYSTEM</span>
      ${SOLAR_SYSTEM.map((planet, index) => `<button class="planet-item ${planet.id === "earth" ? "active" : ""}" style="--planet-color:${planet.color}" ${planet.id === "earth" ? 'aria-current="page" aria-label="地球，当前观测天体"' : `disabled aria-label="${planet.name}，后续建设" title="${planet.name} · 后续建设"`}><span class="planet-dot ${planet.id}"></span><span class="planet-name">${planet.name}</span><span class="planet-order">${String(index).padStart(2, "0")}</span></button>`).join("")}
      <span class="rail-progress"><b>01</b> / 09</span>
    </nav>

    <main class="main">
      <aside class="planet-info" aria-label="地球信息">
        <div class="eyebrow"><span class="tiny-line"></span>我们的蓝色家园</div>
        <h1>地球<span>EARTH</span></h1>
        <div class="planet-tags"><span>岩石行星</span><span>宜居带</span></div>
        <p class="description">在浩瀚宇宙中，<br>一颗承载生命的蓝色星球。<br>你的星际旅程，从这里开始。</p>
        <dl class="facts"><div><dt>平均半径</dt><dd>6,371 <small>km</small></dd></div><div><dt>距太阳</dt><dd>1.496 <small>亿 km</small></dd></div><div><dt>公转周期</dt><dd>365.25 <small>天</small></dd></div><div><dt>地轴倾角</dt><dd>23.44<small>°</small></dd></div></dl>
        <button class="primary-button scene-control" data-view="close" disabled>进入近地轨道 ${icon("arrow")}</button>
        <span class="milestone">FIRST DESTINATION <i></i> 第 01 站</span>
      </aside>

      <section class="space-stage" id="space-stage" aria-label="地球观测场景">
        <div class="canvas-host" id="canvas-host"></div>
        <div class="scene-coordinate top-coordinate"><span>SECTOR 001</span><span>太阳系 · 地球</span></div>
        <div class="sun-label">${icon("sun")}<span>太阳光方向</span><i></i></div>
        <div class="scene-coordinate earth-caption"><i></i><span>TERRA / SOL III</span></div>
        <div class="reticle reticle-top"></div><div class="reticle reticle-bottom"></div>
        <div class="loading-overlay" id="loading-overlay" role="status" aria-live="polite"><div class="loader-orbit"></div><span id="loading-text">正在展开地球 · 0%</span><div class="loading-track"><i id="loading-progress"></i></div><small>准备高清地表与云层</small></div>
        <div class="error-panel" id="error-panel" role="alert" hidden><span class="eyebrow">观测暂时中断</span><h2>暂时无法打开地球场景</h2><p id="error-message"></p><button class="primary-button" id="retry">重新加载 ${icon("reset")}</button></div>
      </section>

      <div class="viewport-tools" aria-label="视角工具"><button class="icon-button scene-control" id="zoom-in" aria-label="放大" title="放大（+）" disabled>${icon("plus")}</button><button class="icon-button scene-control" id="zoom-out" aria-label="缩小" title="缩小（−）" disabled>${icon("minus")}</button><span class="tool-divider"></span><button class="icon-button scene-control" id="reset" aria-label="重置视角" title="重置视角（R）" disabled>${icon("reset")}</button><button class="icon-button" id="fullscreen" aria-label="全屏" title="全屏">${icon("expand")}</button></div>
      <div class="altitude"><span>观测高度</span><strong id="altitude">— <small>km</small></strong><span class="altitude-line"></span></div>
      <div class="interaction-hint"><span class="mouse-icon"></span> 拖动环绕 <i>·</i> 滚轮缩放 <i>·</i> <kbd>空格</kbd> 暂停自转</div>
      <button class="mobile-settings" id="mobile-settings" aria-controls="control-panel" aria-expanded="false">${icon("settings")} 观测设置</button>

      <section class="control-panel" id="control-panel" aria-label="观测设置">
        <div class="control-group views"><span class="control-label">观测视角 <small>VIEWPOINT</small></span><div class="segmented"><button class="scene-control selected" data-view="overview" aria-pressed="true" disabled>${icon("globe")} 全景</button><button class="scene-control" data-view="close" aria-pressed="false" disabled>${icon("compass")} 近地</button><button class="scene-control" data-view="night" aria-pressed="false" disabled>${icon("moon")} 夜景</button></div></div>
        <div class="control-group layers"><span class="control-label">画面图层 <small>LAYERS</small></span><div class="layer-switches"><button class="switch scene-control" role="switch" aria-checked="true" data-layer="clouds" disabled><span>云层</span><i></i></button><button class="switch scene-control" role="switch" aria-checked="true" data-layer="atmosphere" disabled><span>大气</span><i></i></button><button class="switch scene-control" role="switch" aria-checked="true" data-layer="stars" disabled><span>星空</span><i></i></button></div></div>
        <div class="control-group rotation"><span class="control-label">星球自转 <small>ROTATION</small></span><div class="rotation-controls"><button class="icon-button scene-control" id="pause" aria-label="暂停自转" aria-pressed="false" disabled>${icon("pause")}</button><label class="speed-label" for="speed">演示速度</label><select class="scene-control" id="speed" aria-label="自转演示速度" disabled><option value="0.25">0.25×</option><option value="1" selected>1×</option><option value="5">5×</option><option value="10">10×</option></select></div></div>
        <div class="control-group quality"><label class="control-label" for="quality">渲染画质 <small>QUALITY</small></label><select class="scene-control" id="quality" disabled><option value="high">高清</option><option value="standard">标准</option></select></div>
      </section>
    </main>

    <footer class="footer"><span><i></i><span id="render-status">准备观测系统</span></span><span class="footer-center">探索，始于仰望。</span><span>地球观测 · 阶段 01 <b>V 0.1</b></span></footer>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>

    <dialog id="help-dialog"><form method="dialog"><button class="icon-button dialog-close" aria-label="关闭操作指南">${icon("close")}</button></form><span class="eyebrow">WELCOME ABOARD</span><h2>从地球，望向宇宙。</h2><p class="dialog-intro">你正在体验远航的第一个目的地。环绕地球，欣赏昼夜交界、城市灯光与大气微光。</p><dl class="guide"><div><dt>环绕观察</dt><dd>鼠标拖动 / 单指拖动 / 方向键</dd></div><div><dt>拉近与拉远</dt><dd>滚轮 / 双指捏合 / <kbd>+</kbd> <kbd>−</kbd></dd></div><div><dt>暂停星球自转</dt><dd><kbd>空格</kbd></dd></div><div><dt>回到全景</dt><dd><kbd>R</kbd></dd></div><div><dt>操作指南</dt><dd><kbd>H</kbd> / <kbd>Esc</kbd> 关闭</dd></div></dl><p class="scope-note">本阶段可观测地球。太阳及其他七颗行星将在后续阶段建设。自转为加速演示，观测高度由相机距离换算；画面尚未模拟航天动力学。</p><details class="credits"><summary>影像与素材来源</summary><p>4K 地表与夜间影像：NASA Earth imagery，收录于 <a href="https://github.com/vasturiano/three-globe" target="_blank" rel="noopener noreferrer">three-globe</a>；云层、地形与海洋贴图收录于 <a href="https://github.com/turban/webgl-earth" target="_blank" rel="noopener noreferrer">Bjorn Sandvik / WebGL Earth</a>。完整来源见项目 ASSETS.md。</p></details></dialog>
  </div>
`;

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T =>
  document.querySelector<T>(selector)!;
const state = {
  ready: false,
  paused: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  view: "overview" as View,
  layers: { clouds: true, atmosphere: true, stars: true },
};
let scene: EarthScene | undefined;
let toastTimer: ReturnType<typeof setTimeout>;
const toast = (message: string) => {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 2400);
};

function updatePause() {
  const button = $("#pause");
  button.innerHTML = icon(state.paused ? "play" : "pause");
  button.setAttribute("aria-label", state.paused ? "继续自转" : "暂停自转");
  button.setAttribute("aria-pressed", String(state.paused));
  scene?.setPaused(state.paused);
}

function selectView(view: View) {
  state.view = view;
  scene?.setView(view);
  document
    .querySelectorAll<HTMLButtonElement>("[data-view]")
    .forEach((button) => {
      button.classList.toggle("selected", button.dataset.view === view);
      button.setAttribute("aria-pressed", String(button.dataset.view === view));
    });
}

function showError(message: string) {
  state.ready = false;
  delete $("#canvas-host").dataset.ready;
  $("#loading-overlay").hidden = true;
  $("#error-panel").hidden = false;
  $("#error-message").textContent = message;
  $("#connection-text").textContent = "观测站离线";
  $("#render-status").textContent = "场景加载失败";
  document
    .querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".scene-control")
    .forEach((element) => {
      element.disabled = true;
    });
  scene?.dispose();
  scene = undefined;
}

async function start() {
  scene?.dispose();
  state.ready = false;
  delete $("#canvas-host").dataset.ready;
  $("#error-panel").hidden = true;
  $("#loading-overlay").hidden = false;
  $("#loading-progress").style.width = "0%";
  $("#loading-text").textContent = "正在展开地球 · 0%";
  $("#connection-text").textContent = "正在连接观测站";
  try {
    scene = new EarthScene(
      $("#canvas-host"),
      ({ altitudeKm }) => {
        $("#altitude").innerHTML =
          `${Math.round(altitudeKm).toLocaleString("zh-CN")} <small>km</small>`;
      },
      showError,
    );
    await scene.load((percent) => {
      $("#loading-text").textContent = `正在展开地球 · ${percent}%`;
      $("#loading-progress").style.width = `${percent}%`;
    });
    state.ready = true;
    document
      .querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".scene-control")
      .forEach((element) => {
        element.disabled = false;
      });
    $("#loading-overlay").hidden = true;
    $("#connection-text").textContent = "地球观测在线";
    $("#render-status").textContent = "4K 地表 · 实时 3D 渲染";
    $("#canvas-host").dataset.ready = "true";
    updatePause();
    for (const [layer, visible] of Object.entries(state.layers))
      scene.setLayer(layer as Layer, visible);
    scene.setSpeed(Number($<HTMLSelectElement>("#speed").value));
    scene.setQuality($<HTMLSelectElement>("#quality").value === "high");
    selectView(state.view);
  } catch (error) {
    console.error("Earth scene initialization failed:", error);
    showError(
      error instanceof Error && /WebGL|context/i.test(error.message)
        ? "当前浏览器无法启用 WebGL 2。请使用支持硬件加速的现代浏览器，并开启图形加速后重试。"
        : "高清贴图未能完整加载。请检查连接后重新加载场景。",
    );
  }
}

document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) =>
  button.addEventListener("click", () => {
    if (state.ready) selectView(button.dataset.view as View);
  }),
);
$(".planet-item.active").addEventListener("click", () => {
  if (state.ready) selectView("overview");
});
document.querySelectorAll<HTMLButtonElement>("[data-layer]").forEach((button) =>
  button.addEventListener("click", () => {
    const layer = button.dataset.layer as Layer;
    state.layers[layer] = !state.layers[layer];
    button.setAttribute("aria-checked", String(state.layers[layer]));
    scene?.setLayer(layer, state.layers[layer]);
  }),
);
$("#pause").addEventListener("click", () => {
  state.paused = !state.paused;
  updatePause();
});
$("#speed").addEventListener("change", () =>
  scene?.setSpeed(Number($<HTMLSelectElement>("#speed").value)),
);
$("#quality").addEventListener("change", () => {
  const high = $<HTMLSelectElement>("#quality").value === "high";
  scene?.setQuality(high);
  toast(high ? "已切换高清画质" : "已切换标准画质，降低渲染负载");
});
$("#zoom-in").addEventListener("click", () => scene?.zoom(0.85));
$("#zoom-out").addEventListener("click", () => scene?.zoom(1.15));
$("#reset").addEventListener("click", () => selectView("overview"));
$("#retry").addEventListener("click", start);
$("#help").addEventListener("click", () =>
  $<HTMLDialogElement>("#help-dialog").showModal(),
);
$("#help-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget)
    $<HTMLDialogElement>("#help-dialog").close();
});
$("#fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toast("当前浏览器不支持全屏模式");
  }
});
$("#mobile-settings").addEventListener("click", () => {
  const expanded =
    $("#mobile-settings").getAttribute("aria-expanded") !== "true";
  $("#mobile-settings").setAttribute("aria-expanded", String(expanded));
  $("#control-panel").classList.toggle("mobile-open", expanded);
});
document.addEventListener("keydown", (event) => {
  if (
    event.target instanceof Element &&
    event.target.closest("button, input, select, textarea, a, dialog")
  )
    return;
  if (
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    $<HTMLDialogElement>("#help-dialog").open
  )
    return;
  if (event.key.toLowerCase() === "h") {
    $<HTMLDialogElement>("#help-dialog").showModal();
    return;
  }
  if (!state.ready) return;
  if (event.code === "Space") {
    event.preventDefault();
    state.paused = !state.paused;
    updatePause();
  } else if (event.key.toLowerCase() === "r") selectView("overview");
  else if (event.key === "+" || event.key === "=") scene?.zoom(0.9);
  else if (event.key === "-") scene?.zoom(1.1);
  else if (event.key.startsWith("Arrow")) {
    event.preventDefault();
    scene?.rotate(
      event.key === "ArrowLeft" ? -0.1 : event.key === "ArrowRight" ? 0.1 : 0,
      event.key === "ArrowUp" ? -0.1 : event.key === "ArrowDown" ? 0.1 : 0,
    );
  }
});
window.addEventListener("pagehide", () => {
  scene?.dispose();
  clearTimeout(toastTimer);
});
updatePause();
void start();
