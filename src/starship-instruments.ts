import * as THREE from "three";
import type { ShipDynamics, FlightInput } from "./ship-dynamics";
import { getBody } from "./solar-system";

const W = 2048, H = 1024;
const INK = "#b7d7df", DIM = "#53727e", CYAN = "#76c4d0", GOLD = "#d4b07a";
const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: value < 100 ? 1 : 0 });

/** Original 2K vector instruments. Only live display faces use canvas textures;
 * all surrounding controls and the complete exterior are manufactured geometry.
 * The source canvas is drawn at native resolution, with mipmaps and anisotropy.
 */
export class StarshipInstruments {
  readonly group = new THREE.Group();
  private readonly panels: { context: CanvasRenderingContext2D; texture: THREE.CanvasTexture }[] = [];
  private nextUpdate = 0;
  private previous = "";

  constructor(renderer: THREE.WebGLRenderer, textures: Set<THREE.Texture>) {
    this.group.name = "TERRA / live flight instruments";
    for (const x of [-1.32, 0, 1.32]) {
      const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
      const context = canvas.getContext("2d")!;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      textures.add(texture); this.panels.push({ context, texture });
      const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.16, 0.58), material);
      mesh.rotation.x = -0.5;
      mesh.position.set(x, 1.14, -38.63).add(new THREE.Vector3(0, 0, 0.052).applyEuler(mesh.rotation));
      this.group.add(mesh);
    }
  }

  update(ship: ShipDynamics, input: FlightInput, time: number) {
    if (time < this.nextUpdate) return false;
    this.nextUpdate = time + 500;
    const attitude = new THREE.Euler().setFromQuaternion(ship.orientation, "YXZ");
    const speed = ship.warping ? ship.warpSpeedKm : ship.velocity.length() * ship.config.unitsKm;
    const setSpeed = ship.speedLimit * ship.config.unitsKm;
    const altitude = ship.environment.altitudeKm;
    const target = getBody(ship.target);
    const distance = Math.max(0, ship.targetRelative.length() * ship.config.unitsKm - target.radiusKm);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.orientation);
    const heading = (THREE.MathUtils.radToDeg(Math.atan2(forward.x, -forward.z)) + 360) % 360;
    const pitch = THREE.MathUtils.radToDeg(attitude.x), roll = THREE.MathUtils.radToDeg(attitude.z);
    const key = [number(speed), number(setSpeed), number(altitude), number(distance), ship.target,
      heading.toFixed(1), pitch.toFixed(1), roll.toFixed(1), ship.warpPhase, ship.warpProgress.toFixed(2),
      ship.assist, Math.floor(ship.elapsed), input.throttle, input.strafe, input.lift,
      ship.angularVelocity.toArray().map(n => n.toFixed(2))].join("|");
    if (key === this.previous) return false;
    this.previous = key;
    const text = (c: CanvasRenderingContext2D, value: string, x: number, y: number, size = 32, color = INK) => {
      c.fillStyle = color; c.font = `${size >= 55 ? 500 : 400} ${size}px monospace`; c.fillText(value, x, y);
    };
    const line = (c: CanvasRenderingContext2D, x: number, y: number, ex: number, ey: number, color = DIM, width = 2) => {
      c.strokeStyle = color; c.lineWidth = width; c.beginPath(); c.moveTo(x, y); c.lineTo(ex, ey); c.stroke();
    };
    const base = (c: CanvasRenderingContext2D, title: string, index: number) => {
      c.fillStyle = "#030b11"; c.fillRect(0, 0, W, H);
      c.strokeStyle = "#10212b"; c.lineWidth = 1;
      for (let x = 64; x < W; x += 80) line(c, x, 120, x, 920, "#10212b", 1);
      for (let y = 140; y < 920; y += 80) line(c, 64, y, W - 64, y, "#10212b", 1);
      text(c, `TERRA  /  ${title}`, 64, 68, 38);
      text(c, `0${index + 1}`, 1880, 68, 38, GOLD);
      line(c, 64, 99, 1984, 99);
      line(c, 64, 934, 1984, 934);
      const elapsed = Math.floor(ship.elapsed), hours = Math.floor(elapsed / 3600);
      text(c, `MET ${String(hours).padStart(2, "0")}:${String(Math.floor(elapsed / 60) % 60).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`, 64, 990, 30, DIM);
      text(c, ship.assist ? "FLIGHT ASSIST / ON" : "INERTIAL / FREE", 1430, 990, 30, GOLD);
    };
    const nav = this.panels[0].context; base(nav, "NAVIGATION", 0);
    text(nav, "VELOCITY", 80, 167, 30, DIM);
    text(nav, number(speed), 80, 295, 112);
    text(nav, "km/s", 790, 286, 34, CYAN);
    text(nav, "COMMANDED", 1110, 167, 30, DIM);
    text(nav, number(setSpeed), 1110, 272, 76, GOLD);
    text(nav, "km/s", 1740, 265, 32, DIM);
    line(nav, 80, 334, 1968, 334);
    text(nav, "ALTITUDE / NEAREST BODY", 80, 395, 30, DIM);
    text(nav, `${number(altitude)} km`, 80, 483, 67);
    text(nav, getBody(ship.environment.body.id).english.toUpperCase().slice(0, 24), 1120, 466, 34, CYAN);
    text(nav, "NAV TARGET", 80, 583, 30, DIM);
    text(nav, target.english.toUpperCase().slice(0, 22), 80, 650, 50);
    text(nav, "RANGE TO SURFACE", 1110, 583, 30, DIM);
    text(nav, `${number(distance)} km`, 1110, 650, 52);
    // Compass and course pointer follow the real vessel orientation.
    for (let i = 0; i <= 36; i++) {
      const x = 90 + i * 51.7;
      line(nav, x, 850, x, i % 3 === 0 ? 812 : 835, i % 3 === 0 ? INK : DIM);
      if (i % 6 === 0) text(nav, `${i * 10}`.padStart(3, "0"), x - 20, 791, 27, DIM);
    }
    const course = 90 + heading / 360 * 1861;
    line(nav, course, 739, course, 888, GOLD, 4);
    text(nav, `HDG ${heading.toFixed(1).padStart(5, "0")}°`, 800, 894, 36, GOLD);

    const adi = this.panels[1].context; base(adi, "ATTITUDE", 1);
    const cx = 900, cy = 510, radius = 324;
    adi.save(); adi.beginPath(); adi.arc(cx, cy, radius, 0, Math.PI * 2); adi.clip();
    adi.translate(cx, cy); adi.rotate(-attitude.z);
    const horizon = THREE.MathUtils.clamp(pitch, -90, 90) * 5;
    adi.fillStyle = "#152f3e"; adi.fillRect(-700, -1000 + horizon, 1400, 1000);
    adi.fillStyle = "#302d28"; adi.fillRect(-700, horizon, 1400, 1000);
    line(adi, -700, horizon, 700, horizon, INK, 4);
    for (let a = -90; a <= 90; a += 10) {
      if (!a) continue;
      const y = horizon - a * 5, length = a % 20 === 0 ? 150 : 95;
      line(adi, -length, y, -30, y, CYAN); line(adi, 30, y, length, y, CYAN);
      text(adi, String(a), -length - 70, y + 10, 25, INK);
      text(adi, String(a), length + 15, y + 10, 25, INK);
    }
    adi.restore();
    for (const r of [radius, radius + 13]) {
      adi.strokeStyle = DIM; adi.lineWidth = 2; adi.beginPath(); adi.arc(cx, cy, r, 0, Math.PI * 2); adi.stroke();
    }
    for (let i = 0; i < 72; i++) {
      const a = i * Math.PI / 36, inner = radius + 22, outer = inner + (i % 6 === 0 ? 24 : 9);
      line(adi, cx + Math.sin(a) * inner, cy - Math.cos(a) * inner,
        cx + Math.sin(a) * outer, cy - Math.cos(a) * outer, i % 6 === 0 ? INK : DIM);
    }
    line(adi, cx - 125, cy, cx - 35, cy, GOLD, 5); line(adi, cx + 35, cy, cx + 125, cy, GOLD, 5);
    line(adi, cx, cy - 16, cx, cy + 16, GOLD, 5);
    text(adi, "PITCH", 1400, 336, 30, DIM); text(adi, `${pitch.toFixed(1)}°`, 1400, 405, 65);
    text(adi, "ROLL", 1400, 529, 30, DIM); text(adi, `${roll.toFixed(1)}°`, 1400, 598, 65);
    text(adi, `HEADING  ${heading.toFixed(1).padStart(5, "0")}°`, 580, 151, 40, GOLD);
    text(adi, "INERTIAL REFERENCE", 663, 898, 29, DIM);

    const prop = this.panels[2].context; base(prop, "PROPULSION", 2);
    text(prop, "VELOCITY / SETPOINT", 80, 163, 30, DIM);
    text(prop, `${number(speed)} / ${number(setSpeed)}`, 80, 257, 75);
    const response = THREE.MathUtils.clamp(speed / Math.max(1e-6, setSpeed), 0, 1);
    for (let i = 0; i < 40; i++) {
      prop.fillStyle = i / 40 < response ? CYAN : "#18303c";
      prop.fillRect(80 + i * 46, 290, 31, 30);
    }
    text(prop, "THRUST COMMAND", 80, 409, 30, DIM);
    const axes = [input.throttle, input.strafe, input.lift];
    ["FWD / REV", "LATERAL", "VERTICAL"].forEach((name, i) => {
      const y = 480 + i * 92;
      text(prop, name, 80, y, 34);
      line(prop, 440, y - 13, 1080, y - 13);
      line(prop, 760, y - 32, 760, y + 6, INK);
      prop.fillStyle = CYAN; prop.fillRect(756 + axes[i] * 306, y - 31, 8, 36);
      text(prop, `${Math.round(axes[i] * 100)}%`, 1120, y, 38, GOLD);
    });
    text(prop, "ANGULAR RATE / °s", 1370, 409, 29, DIM);
    ship.angularVelocity.toArray().forEach((n, i) => text(prop,
      `${["P", "Y", "R"][i]}  ${THREE.MathUtils.radToDeg(n).toFixed(1)}`, 1370, 480 + i * 92, 40));
    line(prop, 80, 730, 1968, 730);
    text(prop, "WARP DRIVE", 80, 797, 30, DIM);
    text(prop, ship.warpPhase.toUpperCase(), 80, 874, 60, GOLD);
    text(prop, `${Math.round(ship.warpProgress * 100)}%`, 1490, 874, 60, CYAN);
    this.panels.forEach(panel => { panel.texture.needsUpdate = true; });
    return true;
  }
}
