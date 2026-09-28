// gfx-panel.js — the Graphics controls inside Settings: quality preset, render
// scale, one override per effect, adaptive resolution, frame-rate readout and
// a "GPU · cost · W×H px" summary. Every control applies immediately; stable
// ids / data attributes let tests drive them.
import { CATEGORIES, PRESETS, choosePreset, presetTier, defaultGfx } from './gfx.js';
import { gfxStrings, fmt } from './gfx-i18n.js';

export class GraphicsPanel {
  /**
   * @param {HTMLElement} root   container inside the Graphics fieldset
   * @param {{get:()=>object, set:(gfx:object)=>void, info:(words:object)=>object|null, lang?:string}} api
   */
  constructor(root, api) {
    this.root = root;
    this.api = api;
    this.t = gfxStrings(api.lang || (typeof navigator !== 'undefined' ? navigator.language : 'en-US'));
    this._build();
  }

  _build() {
    const t = this.t;
    const r = this.root;
    r.textContent = '';
    const row = (labelText, control, id) => {
      const l = document.createElement('label');
      l.className = 'gfx-row';
      l.htmlFor = id;
      const s = document.createElement('span');
      s.textContent = labelText;
      l.append(s, control);
      r.append(l);
      return l;
    };
    const select = (id, attrs) => {
      const el = document.createElement('select');
      el.id = id;
      for (const [k, v] of Object.entries(attrs)) el.dataset[k] = v;
      return el;
    };

    this.preset = select('gfx-preset', { gfx: 'preset' });
    for (const p of ['auto', ...PRESETS]) this.preset.append(new Option(p === 'auto' ? t.auto : t.presets[p], p));
    this.preset.onchange = () => this._set(choosePreset(this._saved(), this.preset.value));
    row(t.quality, this.preset, 'gfx-preset');

    const scaleWrap = document.createElement('span');
    scaleWrap.className = 'gfx-scale';
    this.scale = document.createElement('input');
    Object.assign(this.scale, { type: 'range', id: 'gfx-scale', min: '50', max: '200', step: '5' });
    this.scale.dataset.gfx = 'render_scale';
    this.scaleOut = document.createElement('output');
    this.scaleOut.htmlFor = 'gfx-scale';
    scaleWrap.append(this.scale, this.scaleOut);
    this.scale.oninput = () => { this.scaleOut.textContent = `${this.scale.value}%`; };
    this.scale.onchange = () => this._set({ ...this._saved(), render_scale: Number(this.scale.value) / 100 });
    row(t.renderScale, scaleWrap, 'gfx-scale');

    const sub = document.createElement('p');
    sub.className = 'gfx-subhead';
    sub.textContent = t.effects;
    r.append(sub);

    this.cats = {};
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      const el = select(`gfx-${cat}`, { gfxCat: cat });
      el.append(new Option('', 'preset'));
      for (const tier of tiers) el.append(new Option(t.tiers[tier] || tier, tier));
      el.onchange = () => {
        const s = { ...this._saved() };
        if (el.value === 'preset') delete s[cat]; else s[cat] = el.value;
        this._set(s);
      };
      this.cats[cat] = el;
      row(t.cats[cat], el, el.id);
    }

    const check = (id, key, label) => {
      const l = document.createElement('label');
      l.className = 'check';
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.id = id;
      el.dataset.gfx = key;
      el.onchange = () => this._set({ ...this._saved(), [key]: el.checked });
      l.append(el, ` ${label}`);
      r.append(l);
      return el;
    };
    this.adaptive = check('gfx-adaptive', 'adaptive', t.adaptive);
    this.fps = check('gfx-fps', 'show_fps', t.showFps);

    this.summary = document.createElement('p');
    this.summary.id = 'gfx-summary';
    this.summary.className = 'fine-print gfx-summary';
    this.summary.setAttribute('aria-live', 'polite');
    this.note = document.createElement('p');
    this.note.id = 'gfx-post-note';
    this.note.className = 'fine-print gfx-note';
    this.note.textContent = t.postFailed;
    this.note.hidden = true;
    r.append(this.summary, this.note);
  }

  _saved() {
    return { ...defaultGfx(), ...(this.api.get() || {}) };
  }

  _set(gfx) {
    this.api.set(gfx);
    this.sync();
    // Pixel sizes and post-chain status settle after the next frames.
    requestAnimationFrame(() => requestAnimationFrame(() => this.sync()));
  }

  /** Reflect saved settings and the renderer's resolved state in the controls. */
  sync() {
    const t = this.t;
    const s = this._saved();
    const info = this.api.info(t.sum);
    const detected = info?.detected || 'balanced';
    const preset = info?.resolved?.preset || (PRESETS.includes(s.preset) ? s.preset : detected);
    this.preset.options[0].textContent = fmt(t.auto, { tier: t.presets[detected] });
    this.preset.value = PRESETS.includes(s.preset) ? s.preset : 'auto';
    const pct = Math.round((Number(s.render_scale) || 1) * 100);
    this.scale.value = String(pct);
    this.scaleOut.textContent = `${pct}%`;
    for (const [cat, el] of Object.entries(this.cats)) {
      const tier = presetTier(preset, cat);
      el.options[0].textContent = fmt(t.fromPreset, { tier: t.tiers[tier] || tier });
      el.value = CATEGORIES[cat].includes(s[cat]) ? s[cat] : 'preset';
    }
    this.adaptive.checked = s.adaptive !== false;
    this.fps.checked = !!s.show_fps;
    if (info) {
      this.summary.textContent = `${info.gpu || t.unknownGpu} · ${info.summary}`;
      this.note.hidden = !info.postFailed;
    } else {
      this.summary.textContent = '';
    }
  }
}
