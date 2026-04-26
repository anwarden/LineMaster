# Metro Evolution 3D — Historique & description

Document combiné : la chronologie des conversations qui ont conduit au projet, suivie d'une description complète de l'état actuel.

---

## 1. Historique des conversations

### Étape 1 — Brief initial (sibling project `VodooGameJam/`)
Le projet a démarré comme un MVP type Mini Metro. Le premier prompt (en français) demandait un jeu navigateur où :
- des stations de différentes formes (cercle, carré, triangle, étoile…) apparaissent sur la carte ;
- des passagers spawnent dans les stations et veulent rejoindre une station de leur forme ;
- le joueur trace des lignes de métro entre les stations ;
- on perd si une station déborde trop longtemps.

Première implémentation : prototype `index.html` standalone en three.js (CDN), single-file, ~770 lignes. Logique de jeu, drag-and-drop des lignes, dijkstra simplifié pour les correspondances, écran HUD intégré.

### Étape 2 — Pivot vers Phaser
L'utilisateur a réécrit `PROMPT.md` avec une spec plus structurée demandant **Phaser 3 + TypeScript + Vite** avec :
- séparation simulation / rendu (sim layer pure TS, Phaser uniquement pour le rendu) ;
- 3 niveaux JSON (L1 = 2 formes, L2 = 3 formes + budget serré, L3 = 4 formes + rush events) ;
- upgrade cards entre niveaux (Add Train, Bigger Cars, Faster Trains, More Track) ;
- HUD DOM en overlay ;
- pas d'éditeur (out of scope).

Le prototype three.js a été supprimé, le projet `VodooGameJam/` reconstruit en Phaser/TS/Vite avec :
- `src/sim/` : `types.ts`, `createInitialState.ts`, `lineSystem.ts`, `trainSystem.ts`, `passengerSystem.ts`, `scoringSystem.ts`, `levelRules.ts`, `updateSimulation.ts` ;
- `src/game/` : `PhaserGame.ts`, `BootScene.ts`, `GameScene.ts` ;
- `src/levels/` : 3 fichiers JSON ;
- `src/ui/` : `Hud.ts`, `UpgradeOverlay.ts`, `EndScreen.ts` ;
- `src/main.ts` orchestrant la progression L1 → L2 → L3.

Vérifications : `tsc --noEmit` ✓, `npm run build` ✓, dev server sur le port 5173.

### Étape 3 — Gamification "Voodoo"
L'utilisateur a demandé des idées de gamification hyper-casual. Discussion autour de :
- combo system avec multiplicateur sur livraisons rapprochées ;
- endless mode après le L3 ;
- coins + skins de stations (skipped pour scope).

Implémentation : combo + juice (camera punch, popups colorés, callouts MEGA/INSANE), endless mode avec spawn de stations dynamique et highscore localStorage, puis start screen avec bouton "Play Campaign" / "Endless".

L'utilisateur a ensuite **manuellement reverté** ces ajouts sur `VodooGameJam/` (probablement scope creep) — le projet Phaser revient à sa baseline pré-gamification.

### Étape 4 — Tests d'expérimentation `test8.html` / `test9.html`
L'utilisateur a créé deux prototypes canvas 2D dans `VodooGameJam/` :

- **`test8.html`** — *Metro Master, Logic & Speed* : 2 niveaux. L1 = matching simple de 3 couleurs sans contrainte. L2 = 5 couleurs avec **détection de croisement** (les lignes ne doivent pas se traverser). Timer countdown.

- **`test9.html`** — *Metro Evolution, Dimension Shift* : 1 niveau. 5 couleurs en disposition X qui force les croisements. Mécanique nouvelle : un **switch dimensionnel** (`surface` / `tunnel`) qui tag les lignes ; les lignes d'une dimension n'entrent en collision qu'avec celles de la **même dimension**. Effet visuel CSS `perspective rotateX(30deg)` quand on bascule en tunnel.

### Étape 5 — Port three.js → `MetroEvolution3D/`
L'utilisateur a demandé : *« read test8 et test9, and make it a threejs project »*.

Choix faits via `AskUserQuestion` :
- **Format** : nouveau projet Vite + TS three.js (sibling de `VodooGameJam/`).
- **3D depth** : vraie 3D avec deux plans à Y différents (au lieu du fake-perspective CSS de test9).

Création de `/Users/noe/Game-Jam/MetroEvolution3D/` avec :
- 3 niveaux fusionnés (L1 = test8 niv 1, L2 = test8 niv 2, L3 = test9) ;
- couches sim sim / rendu / UI séparées ;
- dev server sur le port 5174.

### Étape 6 — Itérations de fix
1. **Stations énormes / hors champ** : caméra trop proche. Reculée à `(0, 480, 90)`, FOV réajusté à 50, monde élargi, stations rétrécies.
2. **Lignes pas vraiment 3D** (utilisaient `Line2` qui sont des rubans screen-space) : remplacement par `TubeGeometry` + `CatmullRomCurve3`. Vrais tubes 3D avec ombrage Lambert.
3. **App pas réactive** : caméra reframée dynamiquement selon l'aspect ratio (`computeFitDistance`), HUD passé en `clamp()` / `vw` partout.
4. **Switch de dimension cassé** : la version initiale téléportait les stations entre Y=0 et Y=−55, ce qui trahissait le principe de test9 et masquait l'intérêt 3D. Refonte vers le vrai paradigme :
   - stations = poteaux verticaux qui traversent les deux couches, fixes ;
   - lignes surface à Y=+18, lignes tunnel à Y=−18, **les deux à 100% d'opacité** ;
   - séparation **physique** dans l'espace 3D : on voit littéralement une ligne passer au-dessus d'une autre ;
   - `hasCrash` continue de filtrer par dimension (cohérent avec test9).
5. **Tilt sur switch** : ajout d'un lerp d'inclinaison caméra (14° en surface → 36° en tunnel) pour donner une sensation de plongée sans bouger le lookAt.
6. **Lignes tunnel invisibles** : le plancher opaque masquait les lignes en dessous. Plancher passé en `transparent: true, opacity: 0.55, depthWrite: false` pour voir à travers, surtout au tilt oblique.

---

## 2. Description du projet `MetroEvolution3D`

### 2.1 Concept

Mini-jeu de logique et réflexes en 3D. Le joueur doit relier des paires de stations de même couleur en traçant une ligne à la souris, sous contrainte de temps.

Trois niveaux progressifs :
| Niveau | Nom | Mécaniques | Durée par mission |
|---|---|---|---|
| 1 | First connections | 3 couleurs, paires alignées, **pas de détection de croisement** | 12 s |
| 2 | Don't cross | 5 couleurs, dispo aléatoire (seedée), croisement = perte instantanée | 9 s |
| 3 | Dimensions | 5 couleurs en X, **switch surface/tunnel** pour passer au-dessus / en-dessous | 16 s |

Boucle :
- Une **mission** = une couleur cible désignée (timer plein) ; le joueur doit tracer une ligne entre les deux stations de cette couleur.
- Succès → score++, nouvelle couleur tirée au hasard parmi celles non encore reliées.
- Échec → modal CRASHED (timer écoulé OU collision OU collision dans la même dimension).
- Toutes couleurs reliées d'un niveau → bascule auto au niveau suivant. Niveau 3 terminé → modal VICTORY.

### 2.2 Stack & arborescence

```
MetroEvolution3D/
├── package.json              # three ^0.160 + vite ^5 + typescript ^5
├── tsconfig.json             # strict, moduleResolution=bundler
├── vite.config.ts            # port 5174
├── index.html                # entry Vite + DOM HUD/modals
├── HISTORY.md                # ce fichier
└── src/
    ├── main.ts               # bootstrap : lit #three-root, instancie Game
    ├── types.ts              # ColorKey, Dimension, Station, Connection, LevelConfig + constantes
    ├── levels.ts             # 3 LevelConfig avec buildStations() chacun (RNG seedé pour L2)
    ├── scene.ts              # SceneRig : THREE.Scene + caméra perspective + plancher unique + tilt-lerp
    ├── stations.ts           # Stations comme poteaux verticaux (caps haut + bas + halo ground)
    ├── lines.ts              # TubeGeometry + CatmullRomCurve3 pour preview live & commit
    ├── game.ts               # Game class : pointer events, state, mission picking, niveau→niveau
    ├── hud.ts                # Wrappers DOM (timer, score, level info, dimension toggle, modals)
    └── styles/app.css        # HUD réactif (clamp/vw partout) + modals + start overlay
```

### 2.3 Architecture & flow

```
window.pointerdown
        │
        ▼
   Game.onPointerDown
   ├─ rig.pickFloor(mouse) → Vector3 sur plan Y=0
   ├─ findStationAt(point) → Station si dans hit radius
   ├─ vérif couleur cible
   └─ démarre LinePreview (TubeGeometry à Y = DIMENSION_LINE_Y[currentDimension])

window.pointermove
   └─ ajoute point au currentPath, rebuild TubeGeometry preview
        + hasCrash() filtré par dimension → fail si collision

window.pointerup
   └─ findStationAt(end), vérif couleur cible + couleur ≠ start
        ├─ valide → commitConnection (TubeGeometry permanent), score++, pickMission()
        └─ invalide → cancelDraft

bouton dimension toggle
   └─ Game.toggleDimension → Game.setDimension('surface'|'tunnel')
        └─ rig.setActiveDimension → tilt-lerp caméra + tween fond
```

### 2.4 Coordonnées & monde

- **X** horizontal (gauche-droite), **Z** profondeur (du joueur vers l'horizon), **Y** vertical.
- Le plan principal est XZ à Y=0 (`MeshLambertMaterial` semi-transparent).
- Stations : poteaux verticaux centrés à leur (x, z), le pôle gris s'étend de Y=−18 à Y=+18, deux pastilles colorées coiffent les extrémités.
- Tubes "surface" : `THREE.TubeGeometry` à **Y = +18**.
- Tubes "tunnel" : `THREE.TubeGeometry` à **Y = −18**.
- Caméra fitée dynamiquement à l'aspect ratio (`computeFitDistance`) avec marge 18 %.

### 2.5 Mécanique de dimensions (le cœur du L3)

**Principe** : exploiter la 3D pour rendre **physique** la non-collision entre couches.

- En mode `surface`, le prochain trait sera dessiné à Y=+18.
- En mode `tunnel`, à Y=−18.
- Une ligne déjà tracée vit à sa propre Y → quand deux lignes se croisent en projection top-down, elles ne se touchent pas réellement dans l'espace 3D si elles sont dans des dimensions différentes.
- `hasCrash()` filtre : `if (c.dimension !== currentDim) continue;` — exactement comme dans `test9.html`.
- Le toggle UI bascule juste **la hauteur de tracé** + un retour visuel léger (tilt caméra + teinte de fond).

**Tilt camera** : 14° en surface, 36° en tunnel. Le lerp dure ~300 ms, la `lookAt` reste figée à `(0, 0, 0)` — la caméra ne descend pas, elle s'incline plus, donnant l'impression de regarder "sous" le sol depuis un angle plus oblique.

**Plancher transparent** : `opacity: 0.55, transparent: true, depthWrite: false` pour que les tubes tunnel restent visibles à travers le sol, en particulier quand la caméra s'incline.

### 2.6 Détails graphiques

- Lumière : un `AmbientLight` (0.78) + un `DirectionalLight` (0.65) positionné en haut-avant pour ombrer joliment les pastilles colorées des stations et le dessus des tubes.
- Halo des stations cibles : un `RingGeometry` au sol, opacité oscillant en `sin(elapsed × 5)` pour le pulse, `MeshBasicMaterial` transparent.
- Pulse de la station cible : `s.group.scale.setScalar(1 + sin(elapsed × 6) × 0.06)`.
- Preview de ligne en cours de tracé : opacity 0.85 (subtilement plus translucide que le commit final à 1.0).

### 2.7 Réactivité

| Élément | Comportement |
|---|---|
| Caméra | `computeFitDistance()` recalcule la distance à chaque resize pour cadrer le monde quel que soit l'aspect (portrait, paysage, ultra-wide). Compense aussi le tilt courant via `1/cos(tilt)`. |
| Score géant | `clamp(48px, 9vw, 96px)` |
| Timer bar | `width: min(320px, 70vw)` |
| Dimension toggle | `clamp(70px, 9vw, 92px)` carré |
| Titres modals | `clamp(40px, 8vw, 68px)` |
| Boutons | padding `clamp(12px, 1.6vw, 16px) × clamp(28px, 5vw, 48px)` |

### 2.8 Comment lancer

```bash
cd /Users/noe/Game-Jam/VodooGameJam
npm install         # une seule fois
npm run dev         # http://localhost:5174
npm run build       # build prod dans dist/
npm run typecheck   # tsc --noEmit
```

Vérifications dernier état :
- `tsc --noEmit` → 0 erreur
- `vite build` → 12 modules, ~483 KB JS (gzipped 124 KB)

### 2.9 Hors scope explicite (par rapport à `test8`/`test9`)

- Pas d'effet sonore (les originaux n'en avaient pas non plus).
- Pas de support tactile spécifique mobile (les `pointer*` events natifs gèrent les deux mais pas optimisés).
- Pas de level editor / import-export JSON.
- Pas de coins / skins / shop (scope hyper-casual reporté).

---

## 3. État actuel du repo

Après l'étape de consolidation, `VodooGameJam/` **est devenu** Metro Evolution 3D : le dossier sœur `MetroEvolution3D/` a été fusionné dedans pour ne garder qu'un seul projet à la racine de `Game-Jam/`. Les anciens fichiers Phaser ont disparu (déjà retirés en amont), seuls subsistent les artefacts du port three.js et les protos historiques :

```
/Users/noe/Game-Jam/VodooGameJam/
├── HISTORY.md                # ce fichier
├── package.json              # three ^0.160 + vite ^5 + typescript ^5
├── tsconfig.json
├── vite.config.ts            # dev port 5174
├── index.html                # entry Vite + DOM HUD/modals
├── test8.html                # proto canvas 2D source — matching + crossing
├── test9.html                # proto canvas 2D source — dimension switching
├── .git/                     # historique préservé du repo original
└── src/
    ├── main.ts
    ├── types.ts
    ├── levels.ts
    ├── scene.ts
    ├── stations.ts
    ├── lines.ts
    ├── game.ts
    ├── hud.ts
    └── styles/app.css
```

`test8.html` et `test9.html` sont conservés à la racine en tant que **références historiques** — les protos canvas 2D qui ont inspiré les mécaniques du port three.js. Ils restent ouvrables directement dans un navigateur sans serveur (`open test8.html`).
