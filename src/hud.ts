import { Dimension } from './types';

export type HudCallbacks = {
  /** Title screen → level select */
  onPlay: () => void;
  /** Level select → start a specific level (idx in LEVELS array) */
  onLevelSelect: (idx: number) => void;
  /** From level select back to title */
  onBackToTitle: () => void;
  /** From in-game back to level select */
  onBackToLevels: () => void;
  /** Toggle surface ↔ tunnel during play */
  onDimensionToggle: () => void;
  /** Level select → open the visual level editor on a blank board */
  onOpenEditor: () => void;
  /** Editor toolbar → copy the current layout JSON to clipboard */
  onEditorExport: () => void;
  /** Editor toolbar → play-test the current layout, with return-to-editor on exit */
  onEditorTest: () => void;
};

export class Hud {
  private el = {
    levelInfo:        q('#level-info'),
    instruction:      q('#instruction'),
    score:            q('#score-display'),
    dimToggle:        q<HTMLButtonElement>('#dimension-toggle'),
    dimText:          q('#dim-text'),
    titleOverlay:     q('#start-overlay'),
    levelSelect:      q('#level-select-overlay'),
    winOverlay:       q('#win-overlay'),
    btnPlay:          q<HTMLButtonElement>('#btn-start'),
    btnBackToTitle:   q<HTMLButtonElement>('#btn-back-to-title'),
    btnBackToLevels:  q<HTMLButtonElement>('#btn-back'),
    btnReplay:        q<HTMLButtonElement>('#btn-replay'),
    btnEditorTest:    q<HTMLButtonElement>('#btn-editor-test'),
    btnEditorExport:  q<HTMLButtonElement>('#btn-editor-export'),
    body:             document.body,
    threeRoot:        q('#three-root'),
    peelFlash:        q('#peel-flash'),
    errorFlash:       q('#error-flash'),
  };

  constructor(private cb: HudCallbacks) {
    this.el.btnPlay.addEventListener('click', () => this.cb.onPlay());
    this.el.btnBackToTitle.addEventListener('click', () => this.cb.onBackToTitle());
    this.el.btnBackToLevels.addEventListener('click', () => this.cb.onBackToLevels());
    this.el.btnReplay.addEventListener('click', () => this.cb.onBackToTitle());
    this.el.dimToggle.addEventListener('click', () => this.cb.onDimensionToggle());
    this.el.btnEditorTest.addEventListener('click', () => this.cb.onEditorTest());
    this.el.btnEditorExport.addEventListener('click', () => this.cb.onEditorExport());

    // Wire level-select cards. They live inside #level-select-overlay so we look
    // them up at construction time after the DOM is built.
    const cards = this.el.levelSelect.querySelectorAll<HTMLButtonElement>('.level-card');
    cards.forEach((card) => {
      card.addEventListener('click', () => {
        if (card.dataset.action === 'editor') { this.cb.onOpenEditor(); return; }
        const idx = parseInt(card.dataset.levelIdx ?? '-1', 10);
        if (Number.isInteger(idx) && idx >= 0) this.cb.onLevelSelect(idx);
      });
    });
  }

  setLevel(name: string, instruction: string) {
    this.el.levelInfo.textContent = name;
    this.el.instruction.textContent = instruction;
  }

  setScore(value: number) {
    this.el.score.textContent = String(value);
    this.el.score.classList.remove('bump');
    void (this.el.score as HTMLElement).offsetWidth;
    this.el.score.classList.add('bump');
  }

  setDimensionToggleVisible(visible: boolean) {
    this.el.dimToggle.hidden = !visible;
  }

  setDimensionState(dim: Dimension) {
    this.el.dimText.textContent = dim.toUpperCase();
    this.el.dimToggle.classList.toggle('tunnel', dim === 'tunnel');
    this.el.body.classList.toggle('in-tunnel', dim === 'tunnel');

    this.el.dimToggle.classList.remove('pulse');
    void (this.el.dimToggle as HTMLElement).offsetWidth;
    this.el.dimToggle.classList.add('pulse');

    this.el.threeRoot.classList.remove('peel');
    void (this.el.threeRoot as HTMLElement).offsetWidth;
    this.el.threeRoot.classList.add('peel');

    this.el.peelFlash.classList.toggle('tunnel', dim === 'tunnel');
    this.el.peelFlash.classList.remove('go');
    void (this.el.peelFlash as HTMLElement).offsetWidth;
    this.el.peelFlash.classList.add('go');
  }

  shake() {
    this.el.threeRoot.classList.remove('shake');
    void (this.el.threeRoot as HTMLElement).offsetWidth;
    this.el.threeRoot.classList.add('shake');
  }

  errorFlash() {
    this.el.errorFlash.classList.add('flash');
    setTimeout(() => this.el.errorFlash.classList.remove('flash'), 180);
  }

  // ──────────────────────────────────────────────
  // Screen visibility helpers
  // ──────────────────────────────────────────────
  showTitle()        { this.el.titleOverlay.hidden = false; this.el.btnBackToLevels.hidden = true; }
  hideTitle()        { this.el.titleOverlay.hidden = true; }
  showLevelSelect()  { this.el.levelSelect.hidden = false; this.el.btnBackToLevels.hidden = true; }
  hideLevelSelect()  { this.el.levelSelect.hidden = true; this.el.btnBackToLevels.hidden = false; }
  showWin()          { this.el.winOverlay.hidden = false; }
  hideWin()          { this.el.winOverlay.hidden = true; }
}

function q<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Element not found: ${sel}`);
  return el;
}
