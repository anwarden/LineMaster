import { Game } from './game';
import { LevelEditor } from './editor';

const root = document.getElementById('three-root');
if (!root) throw new Error('Missing #three-root element');

const game = new Game(root);
new LevelEditor(game);

// Bring up the title screen on first paint instead of auto-starting L1.
game.goToTitle();
