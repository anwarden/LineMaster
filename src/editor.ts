/**
 * Live level editor — debug-only DOM panel that mutates the game state in place.
 * Toggle with backtick (`) or the gear icon top-right.
 *
 * Wired against a small subset of Game's public API (see GameApi below) so it
 * doesn't pull in the full Game class.
 */
import { COLORS, ColorKey } from './types';

const COLOR_KEYS = Object.keys(COLORS) as ColorKey[];

export type GameApi = {
  getDebugSnapshot: () => {
    levelIdx: number;
    levelName: string;
    duration: number;
    collision: boolean;
    dimensions: boolean;
    dimension: 'surface' | 'tunnel';
    targetColor: ColorKey | null;
    score: number;
    streak: number;
    stations: Array<{ id: string; x: number; z: number; colorKey: ColorKey }>;
  };
  applyDebugLevelParams: (p: { duration?: number; collision?: boolean; dimensions?: boolean }) => void;
  updateStationLive: (id: string, p: Partial<{ x: number; z: number; colorKey: ColorKey }>) => void;
  addStationLive: (def: { x: number; z: number; colorKey: ColorKey; id?: string }) => void;
  removeStationLive: (id: string) => void;
  resetLevelDebug: () => void;
  skipLevelDebug: () => void;
  forceWinDebug: () => void;
  forceFailDebug: () => void;
  // ── Visual level editor ──────────────────────────────────────
  setEditorMode: (on: boolean) => void;
  setEditorColor: (color: ColorKey) => void;
  clearStationsForEditor: () => void;
  exportEditorJSON: () => string;
  importEditorJSON: (json: string) => void;
};

export class LevelEditor {
  private root: HTMLDivElement;
  private toggleBtn: HTMLButtonElement;
  private content: HTMLDivElement;
  private nextDbgId = 1000;
  private autoRefreshInterval: number | null = null;
  private editorActive = false;
  private editorColor: ColorKey = 'PINK';

  constructor(private game: GameApi) {
    this.root = document.createElement('div');
    this.root.id = 'debug-panel';
    this.root.innerHTML = `
      <div class="dbg-header">
        <div class="dbg-title">⚙ DEBUG</div>
        <small>~ to toggle</small>
      </div>
      <div class="dbg-content"></div>
    `;
    this.content = this.root.querySelector('.dbg-content') as HTMLDivElement;

    this.toggleBtn = document.createElement('button');
    this.toggleBtn.id = 'debug-toggle';
    this.toggleBtn.textContent = '⚙';
    this.toggleBtn.title = 'Toggle debug panel ( ` )';

    document.body.appendChild(this.root);
    document.body.appendChild(this.toggleBtn);

    this.toggleBtn.addEventListener('click', () => this.toggle());
    window.addEventListener('keydown', (e) => {
      // Backtick (US) and most layouts. Also handle the AZERTY "²" shortcut.
      if ((e.key === '`' || e.key === '²') && !this.isTyping(e.target)) {
        e.preventDefault();
        this.toggle();
      }
    });

    this.refresh();
  }

  // ============================================================
  private toggle() {
    const wasOpen = this.root.classList.toggle('open');
    if (wasOpen) {
      this.refresh();
      // Live polling so the panel reflects state changes (level transitions, etc.)
      this.autoRefreshInterval = window.setInterval(() => this.refreshLight(), 600);
    } else if (this.autoRefreshInterval !== null) {
      window.clearInterval(this.autoRefreshInterval);
      this.autoRefreshInterval = null;
    }
  }

  private isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  }

  // Light refresh: only update read-only header text. Avoids stomping on inputs
  // that might be focused.
  private refreshLight() {
    const snap = this.game.getDebugSnapshot();
    const h = this.content.querySelector('.dbg-level-h4');
    if (h) h.innerHTML = `Level: <b>${snap.levelName}</b> <span class="muted">idx ${snap.levelIdx} · score ${snap.score} · ${snap.dimension}</span>`;
  }

  private refresh() {
    const snap = this.game.getDebugSnapshot();
    this.content.innerHTML = '';

    // ── Level params ──────────────────────────────────────────
    const params = document.createElement('section');
    params.className = 'dbg-section';
    params.innerHTML = `
      <h4 class="dbg-level-h4">Level: <b>${snap.levelName}</b> <span class="muted">idx ${snap.levelIdx} · score ${snap.score} · ${snap.dimension}</span></h4>
      <label><input type="checkbox" data-field="collision" ${snap.collision ? 'checked' : ''}> Crossing detection</label>
      <label><input type="checkbox" data-field="dimensions" ${snap.dimensions ? 'checked' : ''}> Dimensions enabled</label>
    `;
    (params.querySelector('[data-field="collision"]') as HTMLInputElement).addEventListener('change', (e) => {
      this.game.applyDebugLevelParams({ collision: (e.target as HTMLInputElement).checked });
    });
    (params.querySelector('[data-field="dimensions"]') as HTMLInputElement).addEventListener('change', (e) => {
      this.game.applyDebugLevelParams({ dimensions: (e.target as HTMLInputElement).checked });
    });
    this.content.appendChild(params);

    // ── Actions ──────────────────────────────────────────────
    const actions = document.createElement('section');
    actions.className = 'dbg-section';
    actions.innerHTML = `
      <h4>Actions</h4>
      <div class="dbg-buttons">
        <button data-act="reset">Reset</button>
        <button data-act="skip">Next level</button>
        <button data-act="win">Force win</button>
        <button data-act="fail">Force fail</button>
      </div>
    `;
    actions.querySelector('[data-act="reset"]')!.addEventListener('click', () => { this.game.resetLevelDebug(); setTimeout(() => this.refresh(), 50); });
    actions.querySelector('[data-act="skip"]')!.addEventListener('click', () => { this.game.skipLevelDebug(); setTimeout(() => this.refresh(), 50); });
    actions.querySelector('[data-act="win"]')!.addEventListener('click', () => this.game.forceWinDebug());
    actions.querySelector('[data-act="fail"]')!.addEventListener('click', () => this.game.forceFailDebug());
    this.content.appendChild(actions);

    // ── Visual editor ────────────────────────────────────────
    const editor = document.createElement('section');
    editor.className = 'dbg-section dbg-editor';
    editor.innerHTML = `
      <h4>Level Editor
        <label class="dbg-edit-toggle">
          <input type="checkbox" data-field="editor" ${this.editorActive ? 'checked' : ''}>
          <span>EDIT MODE</span>
        </label>
      </h4>
      <div class="dbg-editor-tip">
        Click empty area = place • Drag a node = move • Right-click = delete
      </div>
      <div class="dbg-swatches">
        ${COLOR_KEYS.map((k) => `
          <button class="dbg-swatch ${k === this.editorColor ? 'sel' : ''}"
                  data-color="${k}" title="${k}"
                  style="--c:${COLORS[k]}"></button>
        `).join('')}
      </div>
      <div class="dbg-buttons">
        <button data-act="ed-clear">Clear board</button>
        <button data-act="ed-export">Copy JSON</button>
        <button data-act="ed-import">Paste JSON</button>
      </div>
    `;
    const editToggle = editor.querySelector('[data-field="editor"]') as HTMLInputElement;
    editToggle.addEventListener('change', () => {
      this.editorActive = editToggle.checked;
      this.game.setEditorMode(this.editorActive);
      document.body.classList.toggle('editor-mode', this.editorActive);
      setTimeout(() => this.refresh(), 50);
    });
    editor.querySelectorAll<HTMLButtonElement>('.dbg-swatch').forEach((btn) => {
      btn.addEventListener('click', () => {
        const c = btn.dataset.color as ColorKey;
        this.editorColor = c;
        this.game.setEditorColor(c);
        editor.querySelectorAll('.dbg-swatch').forEach((b) => b.classList.remove('sel'));
        btn.classList.add('sel');
      });
    });
    (editor.querySelector('[data-act="ed-clear"]') as HTMLButtonElement).addEventListener('click', () => {
      this.game.clearStationsForEditor();
      setTimeout(() => this.refresh(), 50);
    });
    (editor.querySelector('[data-act="ed-export"]') as HTMLButtonElement).addEventListener('click', () => {
      const json = this.game.exportEditorJSON();
      navigator.clipboard?.writeText(json).catch(() => { /* ignore */ });
      // Also drop it into a textarea so the user can grab it manually if
      // clipboard permission isn't granted.
      const ta = document.createElement('textarea');
      ta.className = 'dbg-json-out';
      ta.value = json;
      ta.readOnly = true;
      ta.rows = 8;
      const old = editor.querySelector('.dbg-json-out');
      if (old) old.remove();
      editor.appendChild(ta);
      ta.select();
    });
    (editor.querySelector('[data-act="ed-import"]') as HTMLButtonElement).addEventListener('click', () => {
      const json = window.prompt('Paste JSON station array:');
      if (!json) return;
      try {
        this.game.importEditorJSON(json);
        setTimeout(() => this.refresh(), 50);
      } catch (err) {
        window.alert((err as Error).message);
      }
    });
    this.content.appendChild(editor);

    // ── Stations ─────────────────────────────────────────────
    const stationsSec = document.createElement('section');
    stationsSec.className = 'dbg-section dbg-stations';
    stationsSec.innerHTML = `
      <h4>Stations <button class="dbg-add">+ ADD</button></h4>
      <div class="dbg-station-row dbg-station-head">
        <span></span><span>x</span><span>z</span><span>color</span><span></span>
      </div>
      <div class="dbg-station-list"></div>
    `;
    const list = stationsSec.querySelector('.dbg-station-list') as HTMLDivElement;
    for (const s of snap.stations) {
      const row = document.createElement('div');
      row.className = 'dbg-station-row';
      row.innerHTML = `
        <span class="dbg-id" title="${s.id}">${s.id.length > 7 ? s.id.slice(0, 6) + '…' : s.id}</span>
        <input type="number" class="dbg-x" value="${Math.round(s.x)}" step="10">
        <input type="number" class="dbg-z" value="${Math.round(s.z)}" step="10">
        <select class="dbg-color">${COLOR_KEYS.map((k) => `<option value="${k}" ${k === s.colorKey ? 'selected' : ''}>${k}</option>`).join('')}</select>
        <button class="dbg-remove" title="remove">×</button>
      `;
      const inputX = row.querySelector('.dbg-x') as HTMLInputElement;
      const inputZ = row.querySelector('.dbg-z') as HTMLInputElement;
      const selectColor = row.querySelector('.dbg-color') as HTMLSelectElement;
      const onPos = () => {
        const x = parseFloat(inputX.value);
        const z = parseFloat(inputZ.value);
        if (Number.isFinite(x) && Number.isFinite(z)) {
          this.game.updateStationLive(s.id, { x, z });
        }
      };
      inputX.addEventListener('input', onPos);
      inputZ.addEventListener('input', onPos);
      selectColor.addEventListener('change', () => {
        this.game.updateStationLive(s.id, { colorKey: selectColor.value as ColorKey });
      });
      (row.querySelector('.dbg-remove') as HTMLButtonElement).addEventListener('click', () => {
        this.game.removeStationLive(s.id);
        this.refresh();
      });
      list.appendChild(row);
    }
    (stationsSec.querySelector('.dbg-add') as HTMLButtonElement).addEventListener('click', () => {
      this.game.addStationLive({ id: `dbg_${this.nextDbgId++}`, x: 0, z: 0, colorKey: 'PINK' });
      this.refresh();
    });
    this.content.appendChild(stationsSec);

    // ── Hint footer ───────────────────────────────────────────
    const hint = document.createElement('section');
    hint.className = 'dbg-hint';
    hint.innerHTML = `Tip: edit <code>x</code>/<code>z</code> live; color change rebuilds the station.<br>Existing connections won't follow stations — hit <em>Reset</em> for a clean state.`;
    this.content.appendChild(hint);
  }
}
