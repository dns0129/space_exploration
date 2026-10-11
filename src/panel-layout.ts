import "./panel-layout.css";

type Dock = "left" | "right" | "bottom";
type Workspace = Record<Dock, HTMLElement>;

/** Keep the existing controls and handlers; only their layout and disclosure change. */
export class PanelLayout {
  private observe: Workspace;
  private flight: Workspace;
  private destinations: HTMLElement;
  private bodies: HTMLElement;
  private settings: HTMLElement;

  constructor() {
    this.observe = this.workspace(document.querySelector(".main")!, "observe");
    this.flight = this.workspace(document.querySelector("#flight-ui")!, "flight");
    this.bodies = this.panel(".planet-rail", "天体导航", "bodies", this.observe.left);
    this.destinations = this.panel(".destination-selectors", "目的地", "destinations", this.observe.right);
    this.panel(".planet-info", "天体档案", "body-info", this.observe.left);
    this.panel(".viewport-tools", "视角工具", "view-tools", this.observe.right);
    this.panel(".altitude", "观测高度", "altitude", this.observe.right);
    this.panel(".surface-placement", "地表探索", "placement", this.observe.right);
    this.settings = this.panel("#control-panel", "观测设置", "settings", this.observe.bottom);
    this.panel(".flight-title", "航行状态", "status", this.flight.left);
    this.panel(".flight-navigation", "目标与着陆", "navigation", this.flight.left);
    this.panel("#flight-propulsion", "推进控制", "propulsion", this.flight.left);
    this.panel(".flight-toolbar", "驾驶控制", "toolbar", this.flight.right);
    this.panel("#warp-engine", "跃迁引擎", "warp", this.flight.right);
    this.panel("#flight-surface", "着陆系统", "surface", this.flight.right);
    this.panel("#walking-panel", "探索仪表", "walking", this.flight.right);
    this.panel("#station-map", "舰内导览", "deck-map", this.flight.right);
    this.panel(".flight-instruments", "航行仪表", "instruments", this.flight.bottom);
    this.panel(".flight-touch", "触屏操控", "touch", this.flight.bottom);
    this.panel(".flight-key-guide", "快捷操作", "keys", this.flight.bottom);
    this.expand(this.settings, true);
  }

  setMode(flying: boolean) {
    const workspace = flying ? this.flight : this.observe;
    workspace.left.prepend(this.bodies);
    workspace.right.prepend(this.destinations);
    // Mode switches must not leave a panel scrolled out of reach.
    for (const dock of Object.values(workspace)) dock.scrollTop = 0;
  }

  toggleSettings() {
    this.expand(this.settings, this.settings.dataset.collapsed === "true");
  }

  closeSettings() {
    this.expand(this.settings, false);
  }

  private workspace(parent: Element, mode: string): Workspace {
    const root = document.createElement("div");
    root.className = `ui-workspace ui-workspace-${mode}`;
    const docks = {} as Workspace;
    for (const name of ["left", "right", "bottom"] as const) {
      const dock = document.createElement("div");
      dock.className = `ui-dock ui-dock-${name}`;
      docks[name] = dock;
      root.append(dock);
    }
    parent.append(root);
    return docks;
  }

  private panel(selector: string, title: string, id: string, dock: HTMLElement) {
    const panel = document.querySelector<HTMLElement>(selector)!;
    panel.classList.add("ui-panel");
    panel.dataset.panel = id;
    const body = document.createElement("div");
    body.className = "ui-panel-body";
    body.id = `panel-content-${id}`;
    const inner = document.createElement("div");
    inner.className = "ui-panel-inner";
    inner.append(...panel.childNodes);
    body.append(inner);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ui-panel-toggle";
    toggle.setAttribute("aria-controls", body.id);
    toggle.innerHTML = `<span>${title}</span><span class="ui-panel-chevron" aria-hidden="true">⌃</span>`;
    // Let the native button handle Space/Enter without sending a brake/jump command.
    for (const event of ["keydown", "keyup"] as const) {
      toggle.addEventListener(event, e => {
        if (e.code === "Space" || e.code === "Enter") e.stopPropagation();
      });
    }
    toggle.addEventListener("click", () => this.expand(panel, panel.dataset.collapsed === "true"));
    panel.append(toggle, body);
    dock.append(panel);
    this.expand(panel, true);
    return panel;
  }

  private expand(panel: HTMLElement, expanded: boolean) {
    const toggle = panel.querySelector<HTMLButtonElement>(":scope > .ui-panel-toggle")!;
    const body = panel.querySelector<HTMLElement>(":scope > .ui-panel-body")!;
    // A collapsed control must also leave the keyboard tab order.
    if (!expanded && body.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    if (!expanded) {
      // Folding a touch pad while another finger holds thrust must release that input.
      body.querySelectorAll<HTMLButtonElement>("[data-flight-input].held").forEach(button =>
        button.dispatchEvent(new Event("pointercancel")));
    }
    body.inert = !expanded;
    body.setAttribute("aria-hidden", String(!expanded));
    panel.dataset.collapsed = String(!expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", `${expanded ? "收起" : "展开"}${toggle.firstElementChild!.textContent}`);
    if (panel === this.settings) {
      document.querySelector("#mobile-settings")?.setAttribute("aria-expanded", String(expanded));
    }
  }
}
