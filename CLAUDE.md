# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Island Conquest** — a single-player 3D FPS flag-capture game running entirely in the browser. Two AI teams (15 soldiers each, 5 squads × 3) fight over 5 flag points on a procedurally generated tropical island. The player can spectate or join either team.

## Development

No build tools or bundler. The app uses native ES modules with an importmap in `index.html` (Three.js r0.162, cannon-es 0.20 from CDN). No package.json, no npm dependencies, no tests.

**Run locally:**
```
npx http-server -p 8080 -c-1 --cors
```
Then open `http://localhost:8080`.

## Architecture

**Entry:** `src/main.js` → creates `Game` instance.

**`src/core/Game.js`** is the main orchestrator. It owns the game loop (`_animate`), renderer, scene, camera, and all subsystems. Game modes: `'spectator'` (default) and `'playing'`. All HUD elements are created as DOM overlays in Game.js directly (no framework).

### Module Layout

- **`core/`** — `Game.js` (orchestrator + HUD), `EventBus.js` (pub/sub), `InputManager.js` (keyboard/mouse + pointer lock), `SpectatorMode.js`
- **`entities/`** — `Soldier.js` (base entity: mesh, physics body, HP/regen/death), `Player.js` (extends Soldier with FPS camera + input), `Weapon.js` (hitscan rifle: ammo, recoil, reload, raycasting)
- **`world/`** — `Island.js` (procedural terrain + vegetation + cover generation), `CoverSystem.js` (cover point registry), `FlagPoint.js` (capture mechanics), `Noise.js` (simplex-like noise)
- **`ai/`** — `AIManager.js` (creates & updates all COMs per team), `AIController.js` (per-soldier behavior tree + movement + aiming + shooting), `BehaviorTree.js` (lightweight BT engine: Selector/Sequence/Condition/Action), `Personality.js` (6 personality types with tuning weights), `SquadCoordinator.js` (squad-level tactics), `TeamIntel.js` (shared enemy sighting board), `ThreatMap.js` (spatial threat heatmap), `NavGrid.js` (grid-based pathfinding with A*), `TacticalActions.js` (flanking, pre-aim, suppression helpers)
- **`systems/`** — `PhysicsWorld.js` (cannon-es wrapper), `ScoreManager.js` (flag-based scoring to 500), `SpawnSystem.js` (respawn point selection)
- **`vfx/`** — `TracerSystem.js` (bullet tracer lines), `ImpactVFX.js` (hit particles)
- **`ui/`** — `Minimap.js` (canvas-based minimap), `KillFeed.js` (kill notifications), `SpectatorHUD.js`
- **`workers/`** — `navgrid-worker.js` (off-thread NavGrid construction)

### Key Patterns

- **EventBus** for decoupled communication (`kill`, `gameOver`, `playerDied`, `playerHit`, `aiFired`). Systems subscribe in constructors.
- **Staggered AI updates**: AI soldiers update in round-robin batches across frames to stay within per-frame budget (not all 30 each frame).
- **NavGrid built in Web Worker** at startup (`Island.buildNavGridAsync()` → `navgrid-worker.js`), then handed to `AIManager`.
- **Hitscan shooting**: both player and AI use `THREE.Raycaster` against `island.collidables` + soldier meshes. No projectile simulation.
- **Soldier is the shared base** for both Player and AI COMs. Player adds FPS camera control; AI adds AIController with behavior tree.

## Known API Pitfalls (cannon-es)

- `Quaternion` has no `setFromEulerAngles()` — use `setFromAxisAngle(axis, angle)`.
- `Heightfield` height runs along local Z axis — requires rotation to align with Three.js Y-up world.

## Weapon System Notes

- Recoil recovery must check `triggerHeld` (whether fire key is held), not single-frame `isFiring`. Otherwise cooldown frames between shots trigger recovery and cancel accumulated recoil offset.

## Debug Visualizations

In-game key toggles (work in both spectator and playing modes):
- **T** — Threat map overlay (off → Team A → Team B)
- **B** — NavGrid blocked cells
