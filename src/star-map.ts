import "./star-map.css";
import type { SolarScene } from "./planet-scene";
import { SOLAR_SYSTEM, getBody, getSystemGroup } from "./solar-system";
import type { BodyId, SystemGroupId } from "./solar-system";
import { MAP_SYSTEMS, mapSystem, mapPrimary, mapBodies, mapChildren, mapSatellites, isMapStar } from "./star-map-data";
import type { MapSelection, MapTarget } from "./star-map-data";

const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>';
const back = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M19 12H5m5-5-5 5 5 5"/></svg>';
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

export class StarMapInterface {
  active = false;
  selection: MapSelection = { group: "solar" };
  private focused: BodyId = "earth";
  private projection = "3d";
  private readonly shell: HTMLElement;
  private readonly dossier: HTMLElement;
  private readonly labels: HTMLElement;
  private readonly root = $(".observatory");
  get target() { return this.focused; }

  constructor(private readonly getScene: () => SolarScene | undefined,
    private readonly observe: (id: BodyId) => void, private readonly travel: (id: BodyId) => void) {
    $(".main").insertAdjacentHTML("beforeend", `
      <section class="star-map-shell" id="star-map" aria-label="星际星图" hidden>
        <div class="map-vignette" aria-hidden="true"></div>
        <div class="map-labels" id="star-map-labels"></div>
        <div class="map-topbar">
          <nav class="map-breadcrumb" aria-label="星图层级"><button id="map-back" aria-label="返回上一级">${back}</button><button id="map-galaxy">星图</button><span>/</span><button id="map-system"></button><span id="map-orbit-crumb"></span></nav>
          <div class="map-projection" role="group" aria-label="星图维度"><span>视图</span><button data-map-projection="2d" aria-pressed="false">2D</button><button data-map-projection="3d" aria-pressed="true">3D</button></div>
        </div>
        <aside class="map-dossier" id="map-dossier" aria-label="当前星系概况" aria-live="polite"></aside>
        <div class="map-utilities"><button id="map-zoom-in" aria-label="放大星图">＋</button><button id="map-zoom-out" aria-label="缩小星图">−</button><span></span><button id="map-reset" aria-label="重置星图视角">⟲</button><button id="map-motion" aria-label="暂停星图动态" aria-pressed="false">Ⅱ</button></div>
        <div class="map-bottom"><div class="map-explore-hint"><span class="map-live-dot"></span><span id="map-hint">点击行星，展开卫星轨道</span><small>拖动环绕 · 滚轮 / 双指缩放</small></div><nav class="map-system-tabs" aria-label="星图航区">${MAP_SYSTEMS.map((system, i) => `<button data-map-system="${system.id}" aria-pressed="${i === 0}"><i style="--system-color:${getBody(mapPrimary(system.id)).color}"></i>${system.name}</button>`).join("")}</nav><p class="map-scale-note">轨道距离与天体大小经视觉压缩 · 运动为演示 · 非实时星历</p></div>
      </section>
      <button class="map-return" id="return-star-map" hidden>${back} 返回星图</button>
    `);
    this.shell = $("#star-map");
    this.dossier = $("#map-dossier");
    this.labels = $("#star-map-labels");
    $("#map-galaxy").onclick = () => this.open({ group: this.selection.group, galaxy: true });
    $("#map-system").onclick = () => this.open({ group: this.selection.group });
    $("#map-back").onclick = () => this.back();
    $("#map-reset").onclick = () => this.getScene()?.mapView?.reset();
    $("#map-zoom-in").onclick = () => this.getScene()?.mapView?.zoom(0.82);
    $("#map-zoom-out").onclick = () => this.getScene()?.mapView?.zoom(1.22);
    $("#map-motion").onclick = () => {
      const view = this.getScene()?.mapView;
      if (!view) return;
      view.paused = !view.paused;
      this.updateMotion();
    };
    this.shell.querySelectorAll<HTMLButtonElement>("[data-map-projection]").forEach(button => {
      button.onclick = () => {
        this.projection = button.dataset.mapProjection!;
        this.getScene()?.mapView?.setProjection(this.projection === "2d");
        this.shell.querySelectorAll<HTMLButtonElement>("[data-map-projection]").forEach(item =>
          item.setAttribute("aria-pressed", String(item === button)));
      };
    });
    this.shell.querySelectorAll<HTMLButtonElement>("[data-map-system]").forEach(button => {
      button.onclick = () => this.open({ group: button.dataset.mapSystem as SystemGroupId });
    });
    this.dossier.addEventListener("click", event => {
      const target = (event.target as Element).closest<HTMLButtonElement>("button");
      if (target?.dataset.mapPick) this.choose({ body: target.dataset.mapPick as BodyId });
      else if (target?.id === "map-observe") this.observe(this.focused);
      else if (target?.id === "map-travel") this.travel(this.focused);
    });
  }

  open(selection: MapSelection = this.selection, focused?: BodyId) {
    if (!this.getScene()) return;
    this.selection = { ...selection };
    this.focused = focused ?? selection.parent ?? (selection.group === "solar" ? "earth" : mapPrimary(selection.group));
    this.active = true;
    this.shell.hidden = false;
    $("#return-star-map").hidden = true;
    this.root.classList.add("star-map-mode");
    this.getScene()!.showStarMap(this.selection, this.labels, target => this.choose(target));
    this.getScene()?.mapView?.setProjection(this.projection === "2d");
    this.render(focused);
    this.updateMotion();
    this.saveHash();
  }

  close() {
    this.active = false;
    this.shell.hidden = true;
    this.root.classList.remove("star-map-mode");
    this.getScene()?.hideStarMap();
    $("#return-star-map").hidden = false;
  }

  back() {
    if (this.selection.parent) this.open({ group: this.selection.group });
    else if (!this.selection.galaxy) this.open({ group: this.selection.group, galaxy: true });
  }

  private choose(target: MapTarget) {
    if (!this.active) return;
    if (target.group) this.open({ group: target.group });
    else if (isMapStar(target.body) || target.body === this.selection.parent || this.selection.parent) {
      this.focused = target.body;
      this.render(target.body);
    } else this.open({ group: getSystemGroup(target.body), parent: target.body });
  }

  private updateMotion() {
    const paused = this.getScene()?.mapView?.paused ?? true;
    $("#map-motion").setAttribute("aria-pressed", String(paused));
    $("#map-motion").setAttribute("aria-label", paused ? "继续星图动态" : "暂停星图动态");
    $("#map-motion").textContent = paused ? "▷" : "Ⅱ";
  }

  private render(selected?: BodyId) {
    const { group, parent, galaxy } = this.selection;
    const system = mapSystem(group);
    const bodies = mapBodies(group);
    const stars = bodies.filter(body => isMapStar(body.id)).length;
    const planets = bodies.filter(body => !body.parentId && !isMapStar(body.id)).length;
    const satellites = bodies.filter(body => body.parentId && body.kind !== "station").length;
    const body = selected ? getBody(selected) : parent ? getBody(parent) : undefined;
    $("#map-system").textContent = system.name;
    $("#map-system").hidden = !!galaxy;
    $("#map-orbit-crumb").textContent = parent ? `/ ${getBody(parent).name}轨道` : "";
    $("#map-back").setAttribute("aria-disabled", String(!!galaxy));
    $<HTMLButtonElement>("#map-back").disabled = !!galaxy;
    $("#map-hint").textContent = galaxy ? "选择一处航区，开始探索" : parent ? "点击卫星，查看天体概况" : "点击行星，展开卫星轨道";
    this.shell.dataset.level = galaxy ? "galaxy" : parent ? "orbit" : "system";
    this.shell.dataset.group = group;
    this.shell.dataset.parent = parent ?? "";
    this.shell.querySelectorAll<HTMLButtonElement>("[data-map-system]").forEach(button =>
      button.setAttribute("aria-pressed", String(!galaxy && button.dataset.mapSystem === group)));
    const children = parent ? mapChildren(parent) : bodies.filter(item => !item.parentId && !isMapStar(item.id));
    const title = galaxy ? "群星之间" : body ? body.name : system.name;
    const english = galaxy ? "THE INTERSTELLAR ATLAS" : body ? body.english : system.english;
    const description = galaxy ? "每一个光点，都是一个新的世界。选择一处航区，查看恒星系概况，沿行星轨道继续向内探索。" : body ? body.description.replaceAll("<br>", "") : system.description;
    const count = (value: number, label: string) => `<div><strong>${String(value).padStart(2, "0")}</strong><span>${label}</span></div>`;
    this.dossier.innerHTML = `
      <p class="map-eyebrow"><i></i>${galaxy ? "VOYAGER / 星际图鉴" : parent ? "ORBITAL EXPLORER / 行星轨道" : "SYSTEM OVERVIEW / 星系概况"}</p>
      <h2 class="map-title" aria-level="1">${title}<small>${english}</small></h2>
      <div class="map-tags">${(galaxy ? ["6 处航区", "逐层探索"] : body ? [...body.tags].slice(0, 2) : [system.type, group === "solar" ? "真实天体 · 示意布局" : group === "echo-rift" || group === "black-hole" ? "虚构设定" : "观测与概念示意"]).map(tag => `<span>${tag}</span>`).join("")}</div>
      <p class="map-description">${description}</p>
      <div class="map-stats">${galaxy ? count(6, "探索航区") + count(SOLAR_SYSTEM.length, "收录天体") + count(3, "探索层级") : parent ? count(mapSatellites(parent).length, "天然卫星") + count(mapChildren(parent).filter(item => item.kind === "station").length, "轨道设施") : count(stars, "恒星 / 中心") + count(planets, "行星 / 矮行星") + count(satellites, "天然卫星")}</div>
      ${body ? `<dl class="map-facts"><div><dt>${body.radiusConceptual ? "半径 · 概念值" : "平均半径"}</dt><dd>${body.radiusKm.toLocaleString("zh-CN")} <small>km</small></dd></div><div><dt>${isMapStar(body.id) ? "天体类型" : "公转周期"}</dt><dd>${isMapStar(body.id) ? body.tags[0] : `${body.orbitalPeriodDays.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} <small>天</small>`}</dd></div></dl>` : ""}
      ${!galaxy ? `<div class="map-catalog"><h2>${parent ? "轨道成员" : "探索天体"}<span>${String(children.length).padStart(2, "0")}</span></h2><div class="map-object-list">${children.map(item => `<button data-map-pick="${item.id}" aria-label="${parent ? "查看" : "进入"}${item.name}${parent ? "" : "轨道"}" aria-pressed="${item.id === this.focused}"><i style="--body-color:${item.color}"></i><span>${item.name}</span><small>${parent ? item.kind === "station" ? "设施" : "卫星" : `${mapSatellites(item.id).length} 卫星`}</small>${arrow}</button>`).join("") || `<p class="map-empty">${parent ? "目前没有收录该行星的天然卫星。" : "当前航区仅收录中心天体。"}</p>`}</div></div><div class="map-actions"><button class="map-primary" id="map-observe">近距离观测${getBody(this.focused).name} ${arrow}</button><button id="map-travel">驾驶飞船前往 ↗</button></div>` : `<p class="map-atlas-note">真实恒星航区与原创虚构航区分别标注。<br>航区间位置为导航示意，不代表光年比例。</p>`}
    `;
    this.dossier.setAttribute("aria-label", `${title}概况`);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
      this.dossier.animate([{ opacity: 0.25, transform: "translateY(7px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 380, easing: "ease-out" });
    this.dossier.scrollTop = 0;
    document.title = `远航 VOYAGER · ${title}星图`;
    $("#connection-text").textContent = "星图导航在线";
    $("#render-status").textContent = galaxy ? "星际图鉴 · 6 处航区" : `${system.name} · ${parent ? "卫星轨道" : "恒星系星图"}`;
    for (const label of this.labels.querySelectorAll<HTMLElement>(".map-node")) {
      label.dataset.selected = String(label.dataset.mapBody === this.focused);
    }
  }

  private saveHash() {
    const params = new URLSearchParams({ map: this.selection.galaxy ? "galaxy" : this.selection.group });
    if (this.selection.parent) params.set("orbit", this.selection.parent);
    try { history.replaceState(null, "", `#${params}`); } catch { /* Embedded previews can restrict history. */ }
  }
}
