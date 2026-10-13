import { GRAPHICS_EVENT, graphicsPreset, readGraphics, writeGraphics } from './graphics-settings';
import type { GraphicsSettings } from './graphics-settings';
import './graphics-controls.css';

export class GraphicsControls {
  private readonly dialog = document.createElement('dialog');
  private settings = readGraphics();
  constructor() {
    this.dialog.id = 'graphics-dialog';
    this.dialog.setAttribute('aria-labelledby', 'graphics-title');
    const select = (key: string, title: string, options: [string,string][]) =>
      `<label class="graphics-field" for="graphics-${key}"><span>${title}</span><select id="graphics-${key}" data-graphics="${key}">${options.map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>`;
    const level = [['low','低'],['medium','中'],['high','高']] as [string,string][];
    this.dialog.innerHTML = `<div class="graphics-heading"><div><span class="eyebrow">DISPLAY & GRAPHICS</span><h2 id="graphics-title">画质设置</h2><p>调整即时生效，并自动保存到本机。</p></div><form method="dialog"><button class="graphics-close" aria-label="关闭画质设置">×</button></form></div>
      <div class="graphics-grid">
      ${select('preset','画质预设',[['standard','标准 · 节省资源'],['high','高清 · 均衡'],['ultra','超清 · 优先细节'],['custom','自定义']])}
      ${select('maxFps','最大帧率',[['30','30 FPS'],['60','60 FPS'],['90','90 FPS'],['120','120 FPS'],['144','144 FPS'],['240','240 FPS'],['0','跟随屏幕刷新率']])}
      <label class="graphics-field"><span>垂直同步</span><select aria-label="垂直同步" disabled><option>浏览器自动同步</option></select><small>网页无法关闭垂直同步；帧率上限可单独调整。</small></label>
      ${select('antialias','抗锯齿',[['0','关闭'],['2','MSAA 2×'],['4','MSAA 4×'],['8','MSAA 8×']])}
      <label class="graphics-field" for="graphics-renderScale"><span>渲染比例 <output id="graphics-scale-value">100%</output></span><input id="graphics-renderScale" data-graphics="renderScale" type="range" min="50" max="150" step="5"><small>只改变 3D 画面，界面文字保持清晰。</small></label>
      <label class="graphics-field graphics-check"><span>自动平衡画质</span><input id="graphics-adaptive" data-graphics="adaptive" type="checkbox"><small>持续掉帧时降低特效与分辨率，恢复后逐步提高。</small></label>
      ${select('textures','纹理质量',[['low','低 · 最高 2K'],['medium','中 · 最高 4K'],['high','高 · 最高 8K'],['ultra','超清 · 8K / 地球 16K 分块']])}
      ${select('anisotropy','各向异性过滤',[['1','关闭'],['4','4×'],['8','8×'],['16','16×']])}
      ${select('shadows','阴影质量',[['off','关闭'],...level])}
      ${select('reflections','反光效果',[['off','关闭'],...level])}
      ${select('atmosphere','大气质量',level)}
      ${select('clouds','云层质量',level)}
      <label class="graphics-field graphics-check"><span>辉光效果</span><input id="graphics-bloom" data-graphics="bloom" type="checkbox"><small>恒星、推进器与灯光的柔和高光。</small></label>
      </div><p id="graphics-capabilities" class="graphics-capabilities" role="status"></p><div class="graphics-actions"><button type="button" id="graphics-reset">恢复推荐设置</button><form method="dialog"><button>完成</button></form></div>`;
    document.querySelector('.observatory')!.append(this.dialog);
    document.querySelectorAll('[data-open-graphics]').forEach(button => button.addEventListener('click', () => this.open()));
    this.dialog.addEventListener('input', event => {
      const input = event.target as HTMLInputElement | HTMLSelectElement, key = input.dataset.graphics;
      if (!key) return;
      if (key === 'preset') {
        if (input.value !== 'custom') this.settings = writeGraphics(graphicsPreset(input.value as GraphicsSettings['baseQuality']));
      } else {
        const value = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked
          : ['antialias','maxFps','anisotropy'].includes(key) ? Number(input.value)
          : key === 'renderScale' ? Number(input.value) / 100 : input.value;
        this.settings = writeGraphics({ ...this.settings, [key]: value, preset: 'custom' });
      }
      this.sync();
    });
    this.dialog.querySelector('#graphics-reset')!.addEventListener('click', () => writeGraphics(graphicsPreset('high')));
    window.addEventListener(GRAPHICS_EVENT, event => { this.settings = (event as CustomEvent<GraphicsSettings>).detail; this.sync(); });
    this.dialog.addEventListener('click', event => { if (event.target === this.dialog) {
      const bounds = this.dialog.getBoundingClientRect();
      const pointer = event as MouseEvent;
      if (pointer.clientX < bounds.left || pointer.clientX > bounds.right || pointer.clientY < bounds.top || pointer.clientY > bounds.bottom) this.dialog.close();
    } });
    this.sync();
  }
  private open() {
    if (!!document.querySelector('.observatory.photo-mode')) return;
    this.settings = readGraphics(); this.sync(); this.dialog.showModal();
    window.dispatchEvent(new Event('voyager-graphics-open'));
  }
  private sync() {
    for (const control of this.dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-graphics]')) {
      const key = control.dataset.graphics as keyof GraphicsSettings;
      if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = Boolean(this.settings[key]);
      else control.value = String(key === 'renderScale' ? this.settings.renderScale * 100 : this.settings[key]);
    }
    this.dialog.querySelector('#graphics-scale-value')!.textContent = `${Math.round(this.settings.renderScale * 100)}%`;
    for (const control of document.querySelectorAll<HTMLSelectElement>('#quality,#flight-quality')) control.value = this.settings.baseQuality;
    const canvas = document.querySelector<HTMLCanvasElement>('#canvas-host canvas');
    const notes = [];
    if (canvas?.dataset.softwareRenderer === 'true') notes.push('当前为软件渲染，MSAA 不可用。');
    if (window.matchMedia('(pointer: coarse)').matches || ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4)
      notes.push('当前设备纹理上限为 4K，不加载地球 16K 分块。');
    notes.push('设置按显卡支持的上限执行；纹理切换可能需要短暂加载。');
    this.dialog.querySelector('#graphics-capabilities')!.textContent = notes.join(' ');
  }
}
