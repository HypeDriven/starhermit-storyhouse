// ui.js — responsive DOM shell: screens, HUD, overlays, focus management,
// settings, accessibility mirror, live regions, captions. UI state is kept
// separate from simulation state; closing a drawer can never affect a match.
import { PIECE_ICONS } from './render/pieces.js';
import { reasonText } from './rules.js';
import { ACHIEVEMENTS, THEMES, CHALLENGES, PRACTICE_DIFFICULTIES, LESSONS } from './content.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(handlers) {
    this.h = handlers;                  // intents forwarded to main.js
    this._screen = null;
    this._lastFocus = null;
    this._dialogPrevFocus = null;
    this._settings = null;
    this._captionsOn = false;
    this._captionTimer = 0;
    this._bind();
  }

  // ------------------------------------------------------------- wiring
  _bind() {
    document.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => this.h.onGoto(btn.dataset.goto));
    });
    $('btn-play').addEventListener('click', () => this.h.onPlay());
    $('btn-resume-session').addEventListener('click', () => this.h.onResumeSnapshot());
    $('btn-pause').addEventListener('click', () => this.h.onPauseToggle());
    $('btn-resume').addEventListener('click', () => this.h.onPauseToggle());
    $('btn-pause-settings').addEventListener('click', () => this.h.onOpenSettings());
    $('btn-pause-help').addEventListener('click', () => this.h.onOpenHelp());
    $('btn-pause-restart').addEventListener('click', () => this.h.onRestart());
    $('btn-pause-leave').addEventListener('click', () => this.h.onLeave());
    $('btn-hint').addEventListener('click', () => this.h.onHint());
    $('btn-undo').addEventListener('click', () => this.h.onUndo());
    $('btn-mirror').addEventListener('click', () => {
      const btn = $('btn-mirror');
      btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
      this.h.onToggleMirror?.();
    });
    $('btn-finish').addEventListener('click', () => this.h.onFinish());
    $('btn-setup-start').addEventListener('click', () => this.h.onSetupStart());
    $('btn-setup-back').addEventListener('click', () => this.h.onGoto('title'));
    $('btn-results-next').addEventListener('click', () => this.h.onResultsNext());
    $('btn-results-replay').addEventListener('click', () => this.h.onResultsReplay());
    $('btn-results-home').addEventListener('click', () => this.h.onGoto('title'));
    for (const [id, rail] of [['drawer-left-toggle', 'rail-left'], ['drawer-right-toggle', 'rail-right']]) {
      $(id).addEventListener('click', () => {
        const el = $(rail);
        const open = !el.classList.contains('open');
        this.closeDrawers();
        el.classList.toggle('open', open);
        $(id).setAttribute('aria-expanded', String(open));
        this.h.onSound?.(open ? 'open' : 'close');
      });
    }
    $('btn-compat-text').addEventListener('click', () => {
      $('compat-message').hidden = true;
      this.h.onTextMode();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('overlay-dialog').hidden) {
        e.stopImmediatePropagation(); // close the dialog without also pausing
        this.h.onSound?.('close');
        this._closeDialog();
      }
    });
    // Generic UI feedback for plain buttons/lists; game controls and widgets
    // with their own semantic sounds are excluded to avoid doubling.
    let lastHover = 0, lastScroll = 0;
    document.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.dataset.goto !== undefined || b.id.startsWith('drawer-')) return;
      if (b.closest('#hud, #tray, #dialog-buttons, #context-actions, #a11y-mirror')) return;
      this.h.onSound?.('click');
    });
    document.addEventListener('pointerover', (e) => {
      if (!e.target.closest('button')) return;
      const now = performance.now();
      if (now - lastHover < 90) return;
      lastHover = now;
      this.h.onSound?.('hover');
    });
    document.addEventListener('scroll', () => {
      const now = performance.now();
      if (now - lastScroll < 140) return;
      lastScroll = now;
      this.h.onSound?.('scroll');
    }, true);
  }

  closeDrawers() {
    for (const id of ['rail-left', 'rail-right']) $(id).classList.remove('open');
    for (const id of ['drawer-left-toggle', 'drawer-right-toggle']) $(id).setAttribute('aria-expanded', 'false');
  }

  // ------------------------------------------------------------- screens
  showScreen(name) {
    if (this._screen === 'settings' && name !== 'settings') this.h.onSound?.('settings-saved');
    for (const s of document.querySelectorAll('.screen')) s.hidden = true;
    this._screen = name;
    if (name) {
      const el = $(`screen-${name}`);
      if (el) {
        el.hidden = false;
        const focusable = el.querySelector('button, [href], input, select, [tabindex]');
        this._lastFocus = document.activeElement;
        focusable?.focus({ preventScroll: true });
      }
    } else if (this._lastFocus) {
      this._lastFocus = null;
    }
  }
  screen() { return this._screen; }

  setHudVisible(on) { $('hud').hidden = !on; }

  showPause(on) {
    $('overlay-pause').hidden = !on;
    if (on) { this._pausePrevFocus = document.activeElement; $('btn-resume').focus(); }
    else this._pausePrevFocus?.focus?.();
  }

  countdown(text) {
    $('overlay-countdown').hidden = !text;
    $('countdown-text').textContent = text || '';
  }

  showDialog({ title, text, buttons }) {
    this._dialogPrevFocus = document.activeElement;
    $('dialog-heading').textContent = title;
    $('dialog-text').textContent = text;
    const box = $('dialog-buttons');
    box.textContent = '';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = b.primary ? 'primary-btn' : (b.danger ? 'menu-btn danger' : 'menu-btn');
      btn.textContent = b.label;
      btn.addEventListener('click', () => {
        this.h.onSound?.(b.primary || b.danger ? 'confirm' : 'back');
        this._closeDialog();
        b.action?.();
      });
      box.appendChild(btn);
    }
    $('overlay-dialog').hidden = false;
    box.querySelector('button')?.focus();
    this.h.onSound?.('open');
  }
  _closeDialog() {
    $('overlay-dialog').hidden = true;
    this._dialogPrevFocus?.focus?.();
  }

  toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = text;
    $('toast-region').appendChild(el);
    setTimeout(() => el.remove(), 3400);
    this.live(text);
    if (kind !== 'bad') this.h.onSound?.('toast'); // errors already play ui-error
  }

  live(text, assertive = false) {
    const el = assertive ? $('live-assertive') : $('live-polite');
    el.textContent = '';
    requestAnimationFrame(() => { el.textContent = text; });
  }
  announceError(reason) {
    const text = reasonText(reason);
    this.toast(text, 'bad');
    this.live(text, true);
  }

  caption(text) {
    if (!this._captionsOn) return;
    const el = $('captions');
    el.hidden = false;
    el.textContent = `♪ ${text}`;
    clearTimeout(this._captionTimer);
    this._captionTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }
  setCaptions(on) { this._captionsOn = on; if (!on) $('captions').hidden = true; }

  // ----------------------------------------------------------------- HUD
  updateHud(v) {
    $('hud-stage-title').textContent = v.stageTitle;
    $('hud-objective-text').textContent = v.objective;
    $('hud-moves').textContent = v.movesText;
    $('hud-clock').textContent = v.clockText;
    $('hud-clock').classList.toggle('warn', !!v.clockWarn);
    $('hud-score').textContent = v.scoreText;
    $('btn-undo').disabled = !v.canUndo;
    $('btn-hint').disabled = !v.canHint;
    $('finish-note').textContent = v.finishNote || '';

    const list = $('card-list');
    list.textContent = '';
    for (const c of v.cards) {
      const li = document.createElement('li');
      li.className = c.done ? 'done' : '';
      li.innerHTML = `<span class="card-title"></span><span class="card-text"></span><span class="card-pts"></span>`;
      li.querySelector('.card-title').textContent = c.title;
      li.querySelector('.card-text').textContent = c.text;
      li.querySelector('.card-pts').textContent = `+${c.points}`;
      list.appendChild(li);
    }
    if (!v.cards.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="card-text">No discovery cards here — play freely.</span>';
      list.appendChild(li);
    }

    const log = $('beat-log');
    log.textContent = '';
    for (const b of v.beats.slice(-12).reverse()) {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = b.label;
      li.appendChild(strong);
      li.append(` — ${b.who} in the ${b.room}`);
      if (b.sig) { const s = document.createElement('span'); s.className = 'sig'; s.textContent = ' ✦ signature'; li.appendChild(s); }
      if (b.hab) { const s = document.createElement('span'); s.className = 'hab'; s.textContent = ' ⌂ at home'; li.appendChild(s); }
      log.appendChild(li);
    }

    // Context actions
    $('selection-desc').textContent = v.selectionDesc;
    const ctx = $('context-actions');
    ctx.textContent = '';
    for (const a of v.contextActions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-btn small';
      btn.textContent = a.label;
      btn.addEventListener('click', () => this.h.onContextAction(a));
      ctx.appendChild(btn);
    }

    // Lesson box
    $('lesson-box').hidden = !v.lesson;
    if (v.lesson) {
      $('lesson-title').textContent = v.lesson.title;
      $('lesson-step-text').textContent = v.lesson.stepText;
      $('lesson-progress').textContent = v.lesson.progress;
    }
  }

  setTray(items, selectedKey) {
    const tray = $('tray');
    tray.textContent = '';
    for (const it of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tray-item';
      btn.setAttribute('aria-pressed', String(it.key === selectedKey));
      btn.dataset.key = it.key;
      const icon = document.createElement('span');
      icon.className = 'tray-icon';
      icon.textContent = PIECE_ICONS[it.key] || '◼';
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = it.name;
      btn.append(icon, label);
      btn.title = `${it.name} (${it.kind})`;
      btn.addEventListener('click', () => this.h.onTraySelect(it.key));
      tray.appendChild(btn);
    }
    if (!items.length) {
      const span = document.createElement('span');
      span.className = 'fine-print';
      span.textContent = 'Tray is empty — everything is in the house.';
      tray.appendChild(span);
    }
  }

  // --------------------------------------------------------------- title
  setTitleInfo({ journeyDone, journeyTotal, dailyDone, profile, hasSnapshot }) {
    $('journey-sub').textContent = `${journeyDone} of ${journeyTotal} stages`;
    $('daily-sub').textContent = dailyDone ? 'Done today — see the board' : 'One shared house, today only';
    $('profile-badge').textContent = profile ? `Playing as ${profile.name}` : '';
    $('resume-line').hidden = !hasSnapshot;
  }

  // --------------------------------------------------------------- setup
  setupScreen({ mode, facts, ranked, rankedNote, startLabel, fields }) {
    $('setup-heading').textContent = mode;
    const body = $('setup-body');
    body.textContent = '';
    const dl = document.createElement('dl');
    dl.className = 'setup-facts';
    for (const [k, v] of facts) {
      const div = document.createElement('div');
      div.className = 'setup-fact';
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      div.append(dt, dd);
      dl.appendChild(div);
    }
    body.appendChild(dl);
    const badge = document.createElement('p');
    badge.className = ranked ? 'ranked-badge' : 'casual-badge';
    badge.textContent = ranked ? `◆ Ranked — ${rankedNote}` : `○ Casual — ${rankedNote}`;
    body.appendChild(badge);
    if (fields) body.appendChild(fields);
    $('btn-setup-start').textContent = startLabel || 'Start';
  }

  // -------------------------------------------------------------- results
  results(v) {
    $('results-heading').textContent = v.headline;
    const stars = $('results-stars');
    stars.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const s = document.createElement('span');
      s.textContent = '★';
      if (i >= v.stars) s.className = 'dim';
      stars.appendChild(s);
    }
    stars.setAttribute('aria-label', `${v.stars} of 3 stars`);
    const tbody = $('results-table').querySelector('tbody');
    const tfoot = $('results-table').querySelector('tfoot');
    tbody.textContent = ''; tfoot.textContent = '';
    for (const row of v.rows) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = row[0];
      const td2 = document.createElement('td'); td2.textContent = row[1];
      tr.append(td1, td2);
      tbody.appendChild(tr);
    }
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = 'Total';
    const td2 = document.createElement('td'); td2.textContent = v.total;
    tr.append(td1, td2); tfoot.appendChild(tr);

    const cards = $('results-cards');
    cards.textContent = '';
    for (const c of v.cards) {
      const d = document.createElement('div');
      d.className = 'mini-card' + (c.done ? ' done' : '');
      d.textContent = (c.done ? '✓ ' : '◇ ') + c.title;
      cards.appendChild(d);
    }
    const ach = $('results-achievements');
    ach.textContent = '';
    for (const a of v.achievements) {
      const p = document.createElement('p');
      p.className = 'ach-pop';
      p.textContent = `🏅 Achievement unlocked: ${a.name} — ${a.desc}`;
      ach.appendChild(p);
    }
    $('results-compare').textContent = v.compareText || '';
    $('btn-results-next').textContent = v.nextLabel;
    this.live(`${v.headline}. Score ${v.total}, ${v.stars} stars. ${v.summary}`, false);
  }

  // -------------------------------------------------------------- journey
  journeyMap(chapters, progress, onPick) {
    const map = $('journey-map');
    map.textContent = '';
    chapters.forEach((ch, ci) => {
      const block = document.createElement('div');
      block.className = 'chapter-block';
      const h = document.createElement('h2');
      h.textContent = `${ci + 1}. ${ch.title}`;
      block.appendChild(h);
      const grid = document.createElement('div');
      grid.className = 'chapter-grid';
      ch.stages.forEach((st) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'stage-btn' + (st.mastery ? ' mastery' : '') + (st.locked ? ' locked' : '') + (st.current ? ' current' : '');
        btn.disabled = st.locked;
        const num = document.createElement('span');
        num.textContent = st.index + 1;
        const stars = document.createElement('span');
        stars.className = 'st';
        stars.textContent = st.stars > 0 ? '★'.repeat(st.stars) : (st.mastery ? 'M' : '·');
        btn.append(num, stars);
        btn.title = st.label + (st.locked ? ' (finish earlier stages to unlock)' : '');
        btn.setAttribute('aria-label', `Stage ${st.index + 1}: ${st.label}${st.stars ? `, ${st.stars} stars` : ''}${st.locked ? ', locked' : ''}`);
        btn.addEventListener('click', () => onPick(st.index));
        grid.appendChild(btn);
      });
      block.appendChild(grid);
      map.appendChild(block);
    });
  }

  // ------------------------------------------------------------ scrapbook
  scrapbook({ scenes, mastery, achievements }) {
    const list = $('scene-list');
    list.textContent = '';
    if (!scenes.length) {
      const p = document.createElement('p');
      p.className = 'fine-print';
      p.textContent = 'No saved scenes yet — your finished stories will appear here.';
      list.appendChild(p);
    }
    for (const s of scenes) {
      const card = document.createElement('div');
      card.className = 'scene-card';
      if (s.thumbnail) {
        const img = document.createElement('img');
        img.src = s.thumbnail; img.alt = '';
        card.appendChild(img);
      } else {
        const d = document.createElement('div'); d.style.width = '84px'; card.appendChild(d);
      }
      const mid = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = s.label;
      const meta = document.createElement('div'); meta.className = 'scene-meta';
      meta.textContent = `${s.date} · ${s.beats.length} moments · ${s.cardsDone}/${s.cardsTotal} cards · score ${s.score}`;
      const beats = document.createElement('div'); beats.className = 'scene-meta';
      beats.textContent = s.beats.length ? s.beats.join(', ') : 'quiet house';
      mid.append(title, meta, beats);
      const del = document.createElement('button');
      del.className = 'text-btn'; del.type = 'button'; del.textContent = 'Delete';
      del.addEventListener('click', () => this.h.onDeleteScene(s.id));
      card.append(mid, del);
      list.appendChild(card);
    }
    const mt = $('mastery-track');
    mt.textContent = '';
    for (const row of mastery) {
      const div = document.createElement('div');
      div.className = 'mastery-row';
      const l = document.createElement('span'); l.textContent = row[0];
      const r = document.createElement('span'); r.textContent = row[1];
      div.append(l, r);
      mt.appendChild(div);
    }
    const al = $('achievement-list');
    al.textContent = '';
    for (const a of achievements) {
      const li = document.createElement('li');
      li.className = a.unlocked ? '' : 'locked';
      const n = document.createElement('span'); n.className = 'ach-name';
      n.textContent = (a.unlocked ? '🏅 ' : '🔒 ') + a.name;
      const d = document.createElement('span'); d.className = 'ach-desc';
      d.textContent = a.desc + (a.unlocked && a.at ? ` — unlocked ${new Date(a.at).toLocaleDateString()}` : '');
      li.append(n, d);
      al.appendChild(li);
    }
  }

  // ----------------------------------------------------------------- help
  help({ ruleCards, bindings }) {
    const hc = $('help-cards');
    hc.textContent = '';
    for (const card of ruleCards) {
      const div = document.createElement('div');
      div.className = 'rule-card';
      const h = document.createElement('h3'); h.textContent = card.title;
      const p = document.createElement('p'); p.textContent = card.text;
      div.append(h, p);
      if (card.example) {
        const ex = document.createElement('p');
        ex.className = 'fine-print';
        ex.textContent = 'Try: ' + card.example;
        div.appendChild(ex);
      }
      hc.appendChild(div);
    }
    const hb = $('help-bindings');
    hb.textContent = '';
    for (const [action, keys] of bindings) {
      const div = document.createElement('div');
      div.className = 'binding-row';
      const a = document.createElement('span'); a.textContent = action;
      const k = document.createElement('span');
      for (const key of keys) {
        const kbd = document.createElement('kbd'); kbd.textContent = key;
        k.appendChild(kbd);
        k.append(' ');
      }
      div.append(a, k);
      hb.appendChild(div);
    }
  }

  // ------------------------------------------------------------- settings
  bindSettings(settings, onChange) {
    this._settings = settings;
    const s = settings;
    // Property assignment (not addEventListener) so re-opening settings never stacks listeners.
    const bindRange = (id, key) => {
      const el = $(id);
      el.value = s[key];
      el.parentElement.querySelector('output').textContent = s[key];
      el.oninput = () => {
        el.parentElement.querySelector('output').textContent = el.value;
        const now = performance.now();
        if (now - (this._sliderSnd || 0) > 120) { this._sliderSnd = now; this.h.onSound?.('slider'); }
        onChange({ [key]: Number(el.value) });
      };
    };
    bindRange('set-music', 'music');
    bindRange('set-effects', 'effects');
    bindRange('set-ambience', 'ambience');
    bindRange('set-voice', 'voice');
    const bindCheck = (id, key) => {
      const el = $(id);
      el.checked = !!s[key];
      el.onchange = () => { this.h.onSound?.('toggle'); onChange({ [key]: el.checked }); };
    };
    bindCheck('set-mute', 'mute');
    bindCheck('set-captions', 'captions');
    bindCheck('set-reduced-motion', 'reducedMotion');
    bindCheck('set-high-contrast', 'highContrast');
    bindCheck('set-large-text', 'largeText');
    bindCheck('set-lefty', 'lefty');
    bindCheck('set-timing-assist', 'timingAssist');
    bindCheck('set-haptics-off', 'hapticsOff');
    bindCheck('set-telemetry', 'telemetry');
    const bindSelect = (id, key) => {
      const el = $(id);
      el.value = s[key];
      el.onchange = () => { this.h.onSound?.('toggle'); onChange({ [key]: el.value }); };
    };
    bindSelect('set-quality', 'quality');
    bindSelect('set-palette', 'palette');
    bindSelect('set-drag-mode', 'dragMode');
    $('btn-reset-bindings').onclick = () => this.h.onResetBindings();
    $('btn-replay-tutorials').onclick = () => this.h.onReplayTutorials();
    $('btn-wipe').onclick = () => this.h.onWipe();
  }

  bindingsEditor(settings, onCapture) {
    const box = $('bindings-editor');
    box.textContent = '';
    const rows = [
      ['confirm', 'Confirm / place'], ['cancel', 'Cancel'], ['pause', 'Pause'],
      ['undo', 'Undo'], ['hint', 'Hint'], ['camera', 'Camera reset'], ['mute', 'Mute'],
    ];
    for (const [action, label] of rows) {
      const div = document.createElement('div');
      div.className = 'binding-row';
      const a = document.createElement('span'); a.textContent = label;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'menu-btn small';
      btn.textContent = (settings.bindings[action] || []).join(' / ') || '—';
      btn.addEventListener('click', () => {
        btn.textContent = 'press a key…';
        onCapture(action, (keys) => { btn.textContent = keys.join(' / '); });
      });
      div.append(a, btn);
      box.appendChild(div);
    }
    // Gamepad bindings
    for (const [action, label] of [['confirm', 'Gamepad confirm'], ['cancel', 'Gamepad cancel'], ['interact', 'Gamepad interact'], ['hint', 'Gamepad hint'], ['undo', 'Gamepad undo'], ['pause', 'Gamepad pause']]) {
      const div = document.createElement('div');
      div.className = 'binding-row';
      const a = document.createElement('span'); a.textContent = label;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'menu-btn small';
      btn.textContent = 'button ' + (settings.gamepad[action] ?? '—');
      btn.addEventListener('click', () => {
        btn.textContent = 'press a gamepad button…';
        onCapture('pad:' + action, (v) => { btn.textContent = 'button ' + v; });
      });
      div.append(a, btn);
      box.appendChild(div);
    }
  }

  // -------------------------------------------------------- a11y mirror
  mirror(state, selectionKey, onAction) {
    const nav = $('a11y-mirror');
    nav.textContent = '';
    const h = document.createElement('h3');
    h.textContent = 'The house, as text';
    nav.appendChild(h);
    if (!state) return;
    for (const room of state.rooms) {
      const rh = document.createElement('h3');
      rh.textContent = `${room.name} (${room.type})`;
      nav.appendChild(rh);
      const ul = document.createElement('ul');
      room.slots.forEach((itemKey, i) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        const itemName = itemKey ? state.items[itemKey].name : 'empty spot';
        btn.textContent = selectionKey && !itemKey
          ? `Place ${state.items[selectionKey].name} here (spot ${i + 1})`
          : `${itemName} — spot ${i + 1}`;
        btn.setAttribute('aria-current', String(itemKey === selectionKey));
        btn.addEventListener('click', () => onAction({ room: room.id, slot: i, item: itemKey }));
        li.appendChild(btn);
        ul.appendChild(li);
      });
      nav.appendChild(ul);
    }
    const th = document.createElement('h3'); th.textContent = 'Tray';
    nav.appendChild(th);
    const ul = document.createElement('ul');
    for (const key of state.tray) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `Select ${state.items[key].name}`;
      btn.setAttribute('aria-current', String(key === selectionKey));
      btn.addEventListener('click', () => onAction({ tray: key }));
      li.appendChild(btn);
      ul.appendChild(li);
    }
    nav.appendChild(ul);
  }
  setMirrorVisible(on) { $('a11y-mirror').hidden = !on; }

  // ------------------------------------------------------------- compat
  showCompat() { $('compat-message').hidden = false; }

  applySettingsClasses(s) {
    const el = document.documentElement;
    el.classList.toggle('reduced-motion', !!s.reducedMotion);
    el.classList.toggle('high-contrast', !!s.highContrast);
    el.classList.toggle('large-text', !!s.largeText);
    el.classList.remove('palette-protan', 'palette-deutan', 'palette-tritan');
    if (s.palette && s.palette !== 'default') el.classList.add('palette-' + s.palette);
    el.dir = s.lefty ? 'rtl' : 'ltr';
  }
}

export { THEMES, CHALLENGES, PRACTICE_DIFFICULTIES, LESSONS, ACHIEVEMENTS };
