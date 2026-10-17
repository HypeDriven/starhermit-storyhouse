// ui.js — responsive DOM shell: screens, HUD, overlays, focus management,
// settings, accessibility mirror, live regions, captions. UI state is kept
// separate from simulation state; closing a drawer can never affect a match.
import { PIECE_ICONS } from './render/pieces.js';
import { reasonText } from './rules.js';
import { codeLabel } from './persist.js';
import { shText } from './sh-i18n.js';
import { ACHIEVEMENTS, THEMES, CHALLENGES, PRACTICE_DIFFICULTIES, LESSONS } from './content.js';
import { T } from './i18n.js';
import { itemName, itemKind, roomName, roomTypeName } from './loc.js';

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
    this._trackTrayHeight();
  }

  // Toasts and the portrait text mirror sit above the bottom tray, whose
  // height changes as it wraps; expose it (layout px) as --tray-h.
  _trackTrayHeight() {
    const tray = $('tray');
    if (!tray || typeof ResizeObserver !== 'function') return;
    const app = $('app');
    const set = () => app.style.setProperty('--tray-h', `${tray.offsetHeight}px`);
    new ResizeObserver(set).observe(tray);
    set();
  }

  // ------------------------------------------------------------- wiring
  _bind() {
    document.querySelectorAll('[data-goto]').forEach(btn => {
      btn.addEventListener('click', () => this.h.onGoto(btn.dataset.goto));
    });
    $('btn-play').addEventListener('click', () => this.h.onPlay());
    this.labelAccount();
    $('btn-signin').addEventListener('click', () => this.h.onSignIn());
    $('btn-invite').addEventListener('click', () => this.h.onInvite());
    $('btn-resume-session').addEventListener('click', () => this.h.onResumeSnapshot());
    $('btn-pause').addEventListener('click', () => this.h.onPauseToggle());
    $('btn-resume').addEventListener('click', () => this.h.onPauseToggle());
    $('btn-pause-settings').addEventListener('click', () => this.h.onOpenSettings());
    $('btn-pause-help').addEventListener('click', () => this.h.onOpenHelp());
    $('btn-pause-restart').addEventListener('click', () => this.h.onRestart());
    $('btn-pause-leave').addEventListener('click', () => this.h.onLeave());
    $('btn-hint').addEventListener('click', () => this.h.onHint());
    $('btn-camera').addEventListener('click', () => this.h.onCameraReset?.());
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

  /** Account buttons in the current language (sh-i18n.js). */
  labelAccount() {
    $('btn-signin').textContent = shText('signIn');
    $('btn-invite').textContent = shText('invite');
  }

  /** Rebuild a live list without throwing keyboard focus back to the body:
   *  the element carrying the same data-focus-key regains focus afterwards. */
  _rebuildKeepingFocus(container, rebuild) {
    const active = document.activeElement;
    const key = active && container.contains(active) ? active.dataset.focusKey : null;
    rebuild();
    if (!key) return;
    const esc = window.CSS?.escape ? CSS.escape(key) : key.replace(/["\\]/g, '\\$&');
    container.querySelector(`[data-focus-key="${esc}"]`)?.focus({ preventScroll: true });
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
    // gameplay drawers never sit over a help/pause/results screen
    if (name) this.closeDrawers();
    document.body.classList.toggle('screen-open', !!name);
    if (name) {
      const el = $(`screen-${name}`);
      if (el) {
        el.hidden = false;
        el.scrollTop = 0;
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

  /** The HUD pause chip is a toggle: say which way it goes. Backgrounding the
   *  tab pauses silently, so this is the only visible way back in. */
  setPaused(on) {
    this._paused = !!on;
    const btn = $('btn-pause');
    btn.setAttribute('aria-pressed', String(!!on));
    btn.title = on ? T('Resume (Esc or P)') : T('Pause (Esc or P)');
    btn.textContent = '';
    btn.append(on ? '▶ ' : '⏸ ');
    const label = document.createElement('span');
    label.className = 'btn-label';
    label.textContent = on ? T('Resume') : T('Pause');
    btn.appendChild(label);
  }

  countdown(text) {
    $('overlay-countdown').hidden = !text;
    $('countdown-text').textContent = text || '';
  }

  showDialog(spec) {
    // title/text/labels are English keys, translated here (and again on a language change).
    const { title, text, buttons } = spec;
    this._dialog = spec;
    this._dialogPrevFocus = document.activeElement;
    $('dialog-heading').textContent = T(title);
    $('dialog-text').textContent = T(text);
    const box = $('dialog-buttons');
    box.textContent = '';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = b.primary ? 'primary-btn' : (b.danger ? 'menu-btn danger' : 'menu-btn');
      btn.textContent = T(b.label);
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
  /** Language change: relabel an open dialog in place. */
  relabelDialog() {
    if ($('overlay-dialog').hidden || !this._dialog) return;
    $('dialog-heading').textContent = T(this._dialog.title);
    $('dialog-text').textContent = T(this._dialog.text);
    [...$('dialog-buttons').children].forEach((btn, i) => { if (this._dialog.buttons[i]) btn.textContent = T(this._dialog.buttons[i].label); });
  }
  _closeDialog() {
    this._dialog = null;
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
    const text = T(reasonText(reason));
    this.toast(text, 'bad');
    this.live(text, true);
  }

  caption(text) {
    if (!this._captionsOn) return;
    const el = $('captions');
    el.hidden = false;
    el.textContent = `♪ ${T(text)}`;
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
      li.innerHTML = '<span class="card-text"></span>';
      li.firstChild.textContent = T('No discovery cards here — play freely.');
      list.appendChild(li);
    }

    const log = $('beat-log');
    log.textContent = '';
    for (const b of v.beats.slice(-12).reverse()) {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = b.label;
      li.appendChild(strong);
      li.append(' — ' + T('{who} in the {room}', { who: b.who, room: b.room }));
      if (b.sig) { const s = document.createElement('span'); s.className = 'sig'; s.textContent = ' ✦ ' + T('signature'); li.appendChild(s); }
      if (b.hab) { const s = document.createElement('span'); s.className = 'hab'; s.textContent = ' ⌂ ' + T('at home'); li.appendChild(s); }
      log.appendChild(li);
    }

    // Context actions
    $('selection-desc').textContent = v.selectionDesc;
    const ctx = $('context-actions');
    // The HUD refreshes every second (clock); rebuild the buttons only when the
    // actions change, so a click is never lost to a re-created button.
    const ctxKey = JSON.stringify(v.contextActions.map((a) => [a.kind, a.item, a.room, a.a, a.b, a.label]));
    if (ctxKey !== this._ctxKey || ctx.childElementCount !== v.contextActions.length) this._rebuildKeepingFocus(ctx, () => {
      this._ctxKey = ctxKey;
      ctx.textContent = '';
      for (const a of v.contextActions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-btn small';
        btn.textContent = a.label;
        btn.dataset.focusKey = `ctx:${a.kind}:${a.item ?? `${a.a}+${a.b}`}`;
        btn.addEventListener('click', () => this.h.onContextAction(a));
        ctx.appendChild(btn);
      }
    });

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
    this._rebuildKeepingFocus(tray, () => this._fillTray(tray, items, selectedKey));
  }
  _fillTray(tray, items, selectedKey) {
    tray.textContent = '';
    for (const it of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tray-item';
      btn.setAttribute('aria-pressed', String(it.key === selectedKey));
      btn.dataset.key = it.key;
      btn.dataset.focusKey = `tray:${it.key}`;
      const icon = document.createElement('span');
      icon.className = 'tray-icon';
      icon.textContent = PIECE_ICONS[it.key] || '◼';
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = itemName(it.key);
      btn.append(icon, label);
      btn.title = `${itemName(it.key)} (${itemKind(it.kind)})`;
      btn.addEventListener('click', () => this.h.onTraySelect(it.key));
      tray.appendChild(btn);
    }
    if (!items.length) {
      const span = document.createElement('span');
      span.className = 'fine-print';
      span.textContent = T('Tray is empty — everything is in the house.');
      tray.appendChild(span);
    }
  }

  // --------------------------------------------------------------- title
  setTitleInfo({ journeyDone, journeyTotal, dailyDone, profile, sync, hasSnapshot, canSignIn = false, canInvite = false }) {
    $('btn-signin').hidden = !canSignIn;
    $('btn-invite').hidden = !canInvite;
    $('journey-sub').textContent = T('{done} of {total} stages', { done: journeyDone, total: journeyTotal });
    $('daily-sub').textContent = dailyDone ? T('Done today — see the board') : T('One shared house, today only');
    const name = profile ? (profile.local ? T('Local Guest') : profile.name) : '';
    $('profile-badge').textContent = profile ? T('Playing as {name}', { name }) + (sync ? ` · ${T(sync)}` : '') : '';
    $('resume-line').hidden = !hasSnapshot;
  }

  /** Keyboard hint line under the canvas, from the effective bindings. */
  setKeyHints(b) {
    const k = (a) => (b[a] || []).map(codeLabel).join('/') || '—';
    this._keyHints = b;
    $('canvas-keys').textContent = T('Arrows move the cursor · {confirm} select/place · {cancel} cancel · {hint} hint · {undo} undo · {camera} camera', {
      confirm: k('confirm'), cancel: k('cancel'), hint: k('hint'), undo: k('undo'), camera: k('camera'),
    });
  }

  // --------------------------------------------------------------- setup
  setupScreen({ mode, facts, ranked, rankedNote, startLabel, fields }) {
    $('setup-heading').textContent = T(mode);
    const body = $('setup-body');
    body.textContent = '';
    const dl = document.createElement('dl');
    dl.className = 'setup-facts';
    for (const [k, v] of facts) {
      const div = document.createElement('div');
      div.className = 'setup-fact';
      const dt = document.createElement('dt'); dt.textContent = T(k);
      const dd = document.createElement('dd'); dd.textContent = typeof v === 'function' ? v() : String(v);
      div.append(dt, dd);
      dl.appendChild(div);
    }
    body.appendChild(dl);
    const badge = document.createElement('p');
    badge.className = ranked ? 'ranked-badge' : 'casual-badge';
    badge.textContent = ranked ? `◆ ${T('Ranked')} — ${T(rankedNote)}` : `○ ${T('Casual')} — ${T(rankedNote)}`;
    body.appendChild(badge);
    if (fields) body.appendChild(fields);
    $('btn-setup-start').textContent = T(startLabel || 'Start');
  }

  // -------------------------------------------------------------- results
  results(v, relabel) {
    this._results = v;
    $('results-heading').textContent = T(v.headline);
    const stars = $('results-stars');
    stars.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const s = document.createElement('span');
      s.textContent = '★';
      if (i >= v.stars) s.className = 'dim';
      stars.appendChild(s);
    }
    stars.setAttribute('aria-label', T('{n} of 3 stars', { n: v.stars }));
    const tbody = $('results-table').querySelector('tbody');
    const tfoot = $('results-table').querySelector('tfoot');
    tbody.textContent = ''; tfoot.textContent = '';
    for (const row of v.rows) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = T(row[0]);
      const td2 = document.createElement('td'); td2.textContent = typeof row[1] === 'function' ? row[1]() : row[1];
      tr.append(td1, td2);
      tbody.appendChild(tr);
    }
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = T('Total');
    const td2 = document.createElement('td'); td2.textContent = v.total;
    tr.append(td1, td2); tfoot.appendChild(tr);

    const cards = $('results-cards');
    cards.textContent = '';
    for (const c of v.cards) {
      const d = document.createElement('div');
      d.className = 'mini-card' + (c.done ? ' done' : '');
      d.textContent = (c.done ? '✓ ' : '◇ ') + (typeof c.title === 'function' ? c.title() : c.title);
      cards.appendChild(d);
    }
    const ach = $('results-achievements');
    ach.textContent = '';
    for (const a of v.achievements) {
      const p = document.createElement('p');
      p.className = 'ach-pop';
      p.textContent = '🏅 ' + T('Achievement unlocked: {name} — {desc}', { name: T(a.name), desc: T(a.desc) });
      ach.appendChild(p);
    }
    $('results-compare').textContent = typeof v.compareText === 'function' ? v.compareText() : (v.compareText ? T(v.compareText) : '');
    $('btn-results-next').textContent = T(v.nextLabel);
    if (!relabel) this.live(T('{headline}. Score {n}, {stars} stars. {summary}', { headline: T(v.headline), n: v.total, stars: v.stars, summary: typeof v.summary === 'function' ? v.summary() : v.summary }), false);
  }

  // -------------------------------------------------------------- journey
  journeyMap(chapters, progress, onPick) {
    const map = $('journey-map');
    map.textContent = '';
    chapters.forEach((ch, ci) => {
      const block = document.createElement('div');
      block.className = 'chapter-block';
      const h = document.createElement('h2');
      h.textContent = `${ci + 1}. ${T(ch.title)}`;
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
        btn.title = T(st.label) + (st.locked ? ' ' + T('(finish earlier stages to unlock)') : '');
        btn.setAttribute('aria-label', T('Stage {n}: {name}', { n: st.index + 1, name: T(st.label) }) + (st.stars ? T(', {n} stars', { n: st.stars }) : '') + (st.locked ? T(', locked') : ''));
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
      p.textContent = T('No saved scenes yet — your finished stories will appear here.');
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
      meta.textContent = T('{date} · {n} moments · {done}/{total} cards · score {score}', { date: s.date, n: s.beats.length, done: s.cardsDone, total: s.cardsTotal, score: s.score });
      const beats = document.createElement('div'); beats.className = 'scene-meta';
      beats.textContent = s.beats.length ? s.beats.map((b) => T(b)).join(', ') : T('quiet house');
      mid.append(title, meta, beats);
      const del = document.createElement('button');
      del.className = 'text-btn'; del.type = 'button'; del.textContent = T('Delete');
      del.addEventListener('click', () => this.h.onDeleteScene(s.id));
      card.append(mid, del);
      list.appendChild(card);
    }
    const mt = $('mastery-track');
    mt.textContent = '';
    for (const row of mastery) {
      const div = document.createElement('div');
      div.className = 'mastery-row';
      const l = document.createElement('span'); l.textContent = T(row[0]);
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
      n.textContent = (a.unlocked ? '🏅 ' : '🔒 ') + T(a.name);
      const d = document.createElement('span'); d.className = 'ach-desc';
      d.textContent = T(a.desc) + (a.unlocked && a.at ? ' — ' + T('unlocked {date}', { date: new Date(a.at).toLocaleDateString(document.documentElement.lang || undefined) }) : '');
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
      const h = document.createElement('h3'); h.textContent = T(card.title);
      const p = document.createElement('p'); p.textContent = typeof card.text === 'function' ? card.text() : T(card.text);
      div.append(h, p);
      if (card.example) {
        const ex = document.createElement('p');
        ex.className = 'fine-print';
        ex.textContent = T('Try: {example}', { example: typeof card.example === 'function' ? card.example() : T(card.example) });
        div.appendChild(ex);
      }
      hc.appendChild(div);
    }
    const hb = $('help-bindings');
    hb.textContent = '';
    for (const [action, keys] of bindings) {
      const div = document.createElement('div');
      div.className = 'binding-row';
      const a = document.createElement('span'); a.textContent = T(action);
      const k = document.createElement('span');
      for (const key of keys) {
        const kbd = document.createElement('kbd'); kbd.textContent = T(key);
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
    bindSelect('set-palette', 'palette');
    bindSelect('set-drag-mode', 'dragMode');
    $('btn-reset-bindings').onclick = () => this.h.onResetBindings();
    $('btn-replay-tutorials').onclick = () => this.h.onReplayTutorials();
    $('btn-wipe').onclick = () => this.h.onWipe();
  }

  bindingsEditor(settings, onCapture) {
    const box = $('bindings-editor');
    box.textContent = '';
    this._bindingsArgs = [settings, onCapture];
    const rows = [
      ['confirm', 'Confirm / place'], ['cancel', 'Cancel'], ['pause', 'Pause'],
      ['undo', 'Undo'], ['hint', 'Hint'], ['camera', 'Camera reset'], ['mute', 'Mute'],
    ];
    for (const [action, label] of rows) {
      const div = document.createElement('div');
      div.className = 'binding-row';
      const a = document.createElement('span'); a.textContent = T(label);
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'menu-btn small';
      btn.textContent = (settings.bindings[action] || []).map(codeLabel).join(' / ') || '—';
      btn.addEventListener('click', () => {
        btn.textContent = T('press a key…');
        onCapture(action, (keys) => { btn.textContent = (keys || []).map(codeLabel).join(' / ') || '—'; });
      });
      div.append(a, btn);
      box.appendChild(div);
    }
    // Gamepad bindings
    for (const [action, label] of [['confirm', 'Gamepad confirm'], ['cancel', 'Gamepad cancel'], ['interact', 'Gamepad interact'], ['hint', 'Gamepad hint'], ['undo', 'Gamepad undo'], ['pause', 'Gamepad pause']]) {
      const div = document.createElement('div');
      div.className = 'binding-row';
      const a = document.createElement('span'); a.textContent = T(label);
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'menu-btn small';
      btn.textContent = T('button {n}', { n: settings.gamepad[action] ?? '—' });
      btn.addEventListener('click', () => {
        btn.textContent = T('press a gamepad button…');
        onCapture('pad:' + action, (v) => { btn.textContent = T('button {n}', { n: v }); });
      });
      div.append(a, btn);
      box.appendChild(div);
    }
  }

  // -------------------------------------------------------- a11y mirror
  mirror(state, selectionKey, onAction) {
    const nav = $('a11y-mirror');
    this._rebuildKeepingFocus(nav, () => this._fillMirror(nav, state, selectionKey, onAction));
  }
  _fillMirror(nav, state, selectionKey, onAction) {
    nav.textContent = '';
    const h = document.createElement('h3');
    h.textContent = T('The house, as text');
    nav.appendChild(h);
    if (!state) return;
    for (const room of state.rooms) {
      const rh = document.createElement('h3');
      rh.textContent = `${roomName(room)} (${roomTypeName(room.type)})`;
      nav.appendChild(rh);
      const ul = document.createElement('ul');
      room.slots.forEach((itemKey, i) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        const name = itemKey ? itemName(itemKey) : T('empty spot');
        btn.textContent = selectionKey && !itemKey
          ? T('Place {name} here (spot {n})', { name: itemName(selectionKey), n: i + 1 })
          : T('{name} — spot {n}', { name, n: i + 1 });
        btn.setAttribute('aria-current', String(itemKey === selectionKey));
        btn.dataset.focusKey = `slot:${room.id}:${i}`;
        btn.addEventListener('click', () => onAction({ room: room.id, slot: i, item: itemKey }));
        li.appendChild(btn);
        ul.appendChild(li);
      });
      nav.appendChild(ul);
    }
    const th = document.createElement('h3'); th.textContent = T('Tray');
    nav.appendChild(th);
    const ul = document.createElement('ul');
    for (const key of state.tray) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = T('Select {name}', { name: itemName(key) });
      btn.setAttribute('aria-current', String(key === selectionKey));
      btn.dataset.focusKey = `mirror-tray:${key}`;
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
