import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { PhysicsWorld } from '../systems/PhysicsWorld.js';
import { InputManager } from './InputManager.js';
import { EventBus } from './EventBus.js';
import { Player } from '../entities/Player.js';
import { Island } from '../world/Island.js';
import { CoverSystem } from '../world/CoverSystem.js';
import { FlagPoint } from '../world/FlagPoint.js';
import { ScoreManager } from '../systems/ScoreManager.js';
import { SpawnSystem } from '../systems/SpawnSystem.js';
import { AIManager } from '../ai/AIManager.js';
import { TracerSystem } from '../vfx/TracerSystem.js';
import { ImpactVFX } from '../vfx/ImpactVFX.js';
import { Minimap } from '../ui/Minimap.js';
import { KillFeed } from '../ui/KillFeed.js';
import { SpectatorMode } from './SpectatorMode.js';

export class Game {
    constructor() {
        this.eventBus = new EventBus();
        this.input = new InputManager();
        this.clock = new THREE.Clock();
        this.paused = false;
        this.gameMode = 'spectator'; // 'spectator' | 'playing'

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.setClearColor(0x87CEEB);
        document.body.appendChild(this.renderer.domElement);

        // Scene
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.Fog(0x87CEEB, 100, 300);

        // Camera
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);

        // Lighting
        this._setupLighting();

        // Physics
        this.physics = new PhysicsWorld();

        // Cover system
        this.coverSystem = new CoverSystem();

        // Island
        const seed = Math.random() * 65536;
        this.island = new Island(this.scene, this.physics, this.coverSystem, seed);

        // Flags
        this.flags = [];
        this._setupFlags();

        // Score manager
        this.scoreManager = new ScoreManager(this.eventBus);

        // Spawn system
        this.spawnSystem = new SpawnSystem(this.flags);

        // Player (created lazily when joining a team)
        this.player = null;

        // Tracer VFX
        this.tracerSystem = new TracerSystem(this.scene);

        // Impact particle VFX
        this.impactVFX = new ImpactVFX(this.scene);

        // AI Manager (24 COMs total: 12 per team)
        this.aiManager = new AIManager(
            this.scene, this.physics, this.flags, this.coverSystem,
            (x, z) => this.island.getHeightAt(x, z),
            this.eventBus
        );
        this.aiManager.tracerSystem = this.tracerSystem;
        this.aiManager.impactVFX = this.impactVFX;

        this._threatVisState = 0; // 0=off, 1=teamA, 2=teamB

        // HUD elements
        this._createAllHUD();
        this._setPlayerHUDVisible(false);
        this.minimap = new Minimap(this.island.width, this.island.depth);
        this.killFeed = new KillFeed();

        // Events
        this.eventBus.on('gameOver', (data) => this._onGameOver(data));
        this.eventBus.on('playerDied', () => this._onPlayerDied());
        this.eventBus.on('playerHit', (hit) => this._onPlayerHit(hit));
        this.eventBus.on('kill', (data) => this._onKill(data));
        this.eventBus.on('aiFired', (data) => this._onAIFired(data));

        // Blocker / pointer lock — show loading state
        this.blocker = document.getElementById('blocker');
        this.blocker.querySelector('p').textContent = 'Loading...';
        this.blocker.style.cursor = 'default';
        this.blocker.addEventListener('click', () => {
            if (this._ready && !this.paused) this.input.requestPointerLock();
        });
        document.addEventListener('pointerlockchange', () => {
            if (document.pointerLockElement) {
                this.blocker.classList.add('hidden');
            } else {
                if (!this.paused) this.blocker.classList.remove('hidden');
            }
        });

        // Key listeners for mode switching
        document.addEventListener('keydown', (e) => this._onGlobalKey(e));

        // Resize
        window.addEventListener('resize', () => this._onResize());

        // Build NavGrid in Worker, then start the game
        this._ready = false;
        this._initNavGrid();
    }

    _setupLighting() {
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
        const sun = new THREE.DirectionalLight(0xfff5e0, 1.0);
        sun.position.set(50, 80, 30);
        sun.castShadow = true;
        sun.shadow.mapSize.width = 2048;
        sun.shadow.mapSize.height = 2048;
        sun.shadow.camera.near = 0.5;
        sun.shadow.camera.far = 300;
        sun.shadow.camera.left = -150;
        sun.shadow.camera.right = 150;
        sun.shadow.camera.top = 150;
        sun.shadow.camera.bottom = -150;
        this.scene.add(sun);
        this.scene.add(new THREE.HemisphereLight(0x87CEEB, 0x556B2F, 0.3));
    }

    _setupFlags() {
        const flagPositions = this.island.getFlagPositions();
        const names = ['A', 'B', 'C', 'D', 'E'];
        for (let i = 0; i < flagPositions.length; i++) {
            this.flags.push(new FlagPoint(this.scene, flagPositions[i], names[i], i, (x, z) => this.island.getHeightAt(x, z)));
        }
    }

    async _initNavGrid() {
        const { navGrid, heightGrid } = await this.island.buildNavGridAsync();
        this.aiManager.setNavGrid(navGrid, heightGrid, this.island.collidables);

        // Threat map visualization (must be after heightGrid is set so mesh follows terrain)
        this.aiManager.threatMapA.createVisualization(this.scene);
        this.aiManager.threatMapB.createVisualization(this.scene);

        // NavGrid blocked-cell visualization (toggle with B key)
        navGrid.createBlockedVisualization(
            this.scene, (x, z) => this.island.getHeightAt(x, z)
        );
        navGrid.setBlockedVisible(false);

        // Spectator mode
        this.spectator = new SpectatorMode(this.camera, this.input, this.aiManager);
        this.spectator.activate();

        // Ready — update blocker and start game loop
        this._ready = true;
        this.blocker.style.cursor = 'pointer';
        this._updateBlockerText();
        this._animate();
    }

    // ───── Mode Switching ─────

    _onGlobalKey(e) {
        if (this.paused || !this._ready) return;

        // Threat map visualization toggle (works in any mode)
        if (e.code === 'KeyT') {
            this._threatVisState = (this._threatVisState + 1) % 3;
            this.aiManager.threatMapA.setVisible(this._threatVisState === 1);
            this.aiManager.threatMapB.setVisible(this._threatVisState === 2);
        }

        // NavGrid blocked-cell visualization toggle
        if (e.code === 'KeyB' && this.island.navGrid) {
            const vis = this.island.navGrid._blockedVis;
            if (vis) vis.visible = !vis.visible;
        }

        if (this.gameMode === 'spectator') {
            if (e.code === 'Tab') {
                e.preventDefault();
                this.spectator.nextTarget();
            } else if (e.code === 'KeyV') {
                this.spectator.toggleView();
            } else if (e.code === 'Digit1') {
                this._joinTeam('teamA');
            } else if (e.code === 'Digit2') {
                this._joinTeam('teamB');
            }
        } else if (this.gameMode === 'playing') {
            if (e.code === 'Escape') {
                // Only leave team if pointer lock is already released (second Esc)
                // First Esc releases pointer lock (browser default), second Esc returns to spectator
                if (!this.input.isPointerLocked) {
                    e.preventDefault();
                    this._leaveTeam();
                }
            }
        }
    }

    _joinTeam(team) {
        // Create player if first time
        if (!this.player) {
            this.player = new Player(this.scene, this.camera, this.physics, this.input, this.eventBus);
            this.player.weapon.tracerSystem = this.tracerSystem;
            this.player.weapon.impactVFX = this.impactVFX;
        }

        this.player.team = team;
        this.player.alive = true;
        this.player.hp = this.player.maxHP;
        this.player.mesh.visible = false; // FPS: own mesh hidden

        // Spawn at team flag
        const spawnFlag = team === 'teamA' ? this.flags[0] : this.flags[this.flags.length - 1];
        const angle = Math.random() * Math.PI * 2;
        const dist = 5 + Math.random() * 5;
        const sx = spawnFlag.position.x + Math.cos(angle) * dist;
        const sz = spawnFlag.position.z + Math.sin(angle) * dist;
        const sy = this.island.getHeightAt(sx, sz) + 2;
        this.player.body.position.set(sx, sy, sz);
        this.player.body.velocity.set(0, 0, 0);

        // Register with AI
        this.aiManager.setPlayer(this.player);

        // Switch mode
        this.gameMode = 'playing';
        this.spectator.deactivate();
        this._setPlayerHUDVisible(true);
        this._updateBlockerText();

        // Request pointer lock
        this.input.requestPointerLock();
    }

    _leaveTeam() {
        if (!this.player) return;

        // Remove player from game world
        this.player.alive = false;
        this.player.mesh.visible = false;
        // Move physics body far away to avoid interactions
        this.player.body.position.set(0, -100, 0);
        this.player.body.velocity.set(0, 0, 0);

        // Unregister from AI
        this.aiManager.removePlayer();

        // Switch mode
        this.gameMode = 'spectator';
        this.spectator.activate();
        this._setPlayerHUDVisible(false);
        this._updateBlockerText();
        this.deathScreen.style.display = 'none';
        this.damageIndicator.style.background = 'none';
    }

    _updateBlockerText() {
        const h1 = this.blocker.querySelector('h1');
        const p = this.blocker.querySelector('p');
        if (this.gameMode === 'spectator') {
            h1.textContent = 'Island Conquest';
            p.innerHTML = 'Click to spectate<br><small style="color:#888">[1] Team A &nbsp; [2] Team B</small>';
        } else {
            h1.textContent = 'Island Conquest';
            p.innerHTML = 'Click to resume<br><small style="color:#888">[Esc] Back to spectator</small>';
        }
    }

    _setPlayerHUDVisible(visible) {
        const display = visible ? 'block' : 'none';
        if (this.ammoHUD) this.ammoHUD.style.display = display;
        if (this.healthHUD) this.healthHUD.style.display = display;
        const crosshair = document.getElementById('crosshair');
        if (crosshair) crosshair.style.display = display;
    }

    // ───── HUD ─────

    _createAllHUD() {
        this._createCrosshair();
        this._createAmmoHUD();
        this._createHealthHUD();
        this._createScoreHUD();
        this._createDamageIndicator();
        this._createDeathScreen();
        this._createGameOverScreen();
        this._createKeyHints();
    }

    _createCrosshair() {
        const el = document.createElement('div');
        el.id = 'crosshair';
        el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            width:20px;height:20px;pointer-events:none;z-index:100;`;
        el.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20">
            <line x1="10" y1="3" x2="10" y2="8" stroke="white" stroke-width="2" opacity="0.8"/>
            <line x1="10" y1="12" x2="10" y2="17" stroke="white" stroke-width="2" opacity="0.8"/>
            <line x1="3" y1="10" x2="8" y2="10" stroke="white" stroke-width="2" opacity="0.8"/>
            <line x1="12" y1="10" x2="17" y2="10" stroke="white" stroke-width="2" opacity="0.8"/>
            <circle cx="10" cy="10" r="1" fill="white" opacity="0.6"/></svg>`;
        document.body.appendChild(el);
    }

    _createAmmoHUD() {
        const el = document.createElement('div');
        el.id = 'ammo-hud';
        el.style.cssText = `position:fixed;bottom:30px;right:30px;color:white;
            font-family:Consolas,monospace;font-size:16px;background:rgba(0,0,0,0.5);
            padding:12px 18px;border-radius:6px;pointer-events:none;z-index:100;min-width:120px;`;
        document.body.appendChild(el);
        this.ammoHUD = el;
    }

    _createHealthHUD() {
        const el = document.createElement('div');
        el.id = 'health-hud';
        el.style.cssText = `position:fixed;bottom:30px;left:30px;color:white;
            font-family:Consolas,monospace;background:rgba(0,0,0,0.5);
            padding:12px 18px;border-radius:6px;pointer-events:none;z-index:100;min-width:150px;`;
        document.body.appendChild(el);
        this.healthHUD = el;
    }

    _createScoreHUD() {
        const el = document.createElement('div');
        el.id = 'score-hud';
        el.style.cssText = `position:fixed;top:15px;left:50%;transform:translateX(-50%);
            color:white;font-family:Consolas,monospace;font-size:18px;
            background:rgba(0,0,0,0.5);padding:8px 24px;border-radius:6px;
            pointer-events:none;z-index:100;text-align:center;`;
        document.body.appendChild(el);
        this.scoreHUD = el;
    }

    _createDamageIndicator() {
        const el = document.createElement('div');
        el.id = 'damage-indicator';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            pointer-events:none;z-index:99;`;
        document.body.appendChild(el);
        this.damageIndicator = el;
    }

    _createDeathScreen() {
        const el = document.createElement('div');
        el.id = 'death-screen';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(139,0,0,0.3);display:none;align-items:center;justify-content:center;
            flex-direction:column;pointer-events:none;z-index:101;`;
        el.innerHTML = `
            <div style="color:white;font-family:Arial,sans-serif;text-align:center;">
                <div style="font-size:36px;font-weight:bold;margin-bottom:10px;">YOU DIED</div>
                <div id="respawn-timer" style="font-size:20px;color:#ccc;"></div>
                <div id="respawn-prompt" style="font-size:16px;color:#aaa;margin-top:10px;display:none;">
                    Press <b>SPACE</b> to respawn &nbsp; | &nbsp; <b>ESC</b> to spectate
                </div>
            </div>`;
        document.body.appendChild(el);
        this.deathScreen = el;
    }

    _createGameOverScreen() {
        const el = document.createElement('div');
        el.id = 'game-over';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(0,0,0,0.8);display:none;align-items:center;justify-content:center;
            flex-direction:column;z-index:200;`;
        el.innerHTML = `
            <div style="color:white;font-family:Arial,sans-serif;text-align:center;">
                <div id="winner-text" style="font-size:48px;font-weight:bold;margin-bottom:20px;"></div>
                <div id="final-score" style="font-size:24px;color:#ccc;"></div>
            </div>`;
        document.body.appendChild(el);
        this.gameOverScreen = el;
    }

    _createKeyHints() {
        const el = document.createElement('div');
        el.id = 'key-hints';
        el.style.cssText = `position:fixed;bottom:12px;left:12px;
            font-family:Consolas,monospace;font-size:12px;color:rgba(255,255,255,0.5);
            line-height:1.6;pointer-events:none;z-index:100;`;
        el.innerHTML = [
            '<b style="color:rgba(255,255,255,0.7)">Keys</b>',
            '<span style="color:#fff">T</span> Threat map',
            '<span style="color:#fff">B</span> NavGrid',
            '<span style="color:#fff">Tab</span> Next COM',
            '<span style="color:#fff">V</span> Camera mode',
            '<span style="color:#fff">1/2</span> Join team',
            '<span style="color:#fff">Esc</span> Leave team',
        ].join('<br>');
        document.body.appendChild(el);
    }

    _updateHUD() {
        if (this.gameMode !== 'playing' || !this.player) return;

        const p = this.player;
        const w = p.weapon;
        const s = this.scoreManager.scores;

        // Ammo
        const reloadText = w.isReloading ? `<span style="color:#ffaa00">RELOADING...</span>` : '';
        this.ammoHUD.innerHTML = `
            <div style="font-size:12px;color:#aaa;margin-bottom:4px">AR-15</div>
            <div style="font-size:28px;font-weight:bold">
                ${w.currentAmmo}<span style="font-size:16px;color:#888"> / ${w.magazineSize}</span>
            </div>${reloadText}`;

        // Health
        const hpPct = Math.round(p.hp);
        const hpColor = hpPct > 60 ? '#4f4' : hpPct > 30 ? '#ff4' : '#f44';
        const barWidth = Math.max(0, p.hp / p.maxHP * 100);
        this.healthHUD.innerHTML = `
            <div style="font-size:12px;color:#aaa;margin-bottom:4px">HEALTH</div>
            <div style="font-size:28px;font-weight:bold;color:${hpColor}">${hpPct}</div>
            <div style="width:120px;height:6px;background:#333;border-radius:3px;margin-top:4px;">
                <div style="width:${barWidth}%;height:100%;background:${hpColor};border-radius:3px;"></div>
            </div>`;

        // Damage direction indicator
        this._updateDamageIndicator();

        // Death screen
        this._updateDeathScreen();
    }

    _updateScoreHUD() {
        const s = this.scoreManager.scores;
        const aFlagCount = this.flags.filter(f => f.owner === 'teamA').length;
        const bFlagCount = this.flags.filter(f => f.owner === 'teamB').length;
        this.scoreHUD.innerHTML = `
            <span style="color:#4488ff;font-weight:bold">${s.teamA}</span>
            <span style="color:#aaa;font-size:14px;margin:0 6px">
                Team A [${aFlagCount}] &mdash; [${bFlagCount}] Team B
            </span>
            <span style="color:#ff4444;font-weight:bold">${s.teamB}</span>`;
    }

    _updateDamageIndicator() {
        if (!this.player) return;
        const p = this.player;
        if (p.damageIndicatorTimer > 0 && p.lastDamageDirection) {
            const opacity = Math.min(1, p.damageIndicatorTimer) * 0.6;

            const forward = new THREE.Vector3(0, 0, -1);
            const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);
            forward.applyQuaternion(yawQuat);

            const dmgDir = p.lastDamageDirection;
            const angle = Math.atan2(dmgDir.x, dmgDir.z) - Math.atan2(forward.x, forward.z);

            const gradAngle = (-angle * 180 / Math.PI + 90);
            this.damageIndicator.style.background = `
                linear-gradient(${gradAngle}deg,
                rgba(255,0,0,${opacity}) 0%,
                transparent 30%,
                transparent 100%)`;
            this.damageIndicator.style.display = 'block';
        } else {
            this.damageIndicator.style.background = 'none';
        }
    }

    _updateDeathScreen() {
        if (!this.player) return;
        const p = this.player;
        if (!p.alive) {
            this.deathScreen.style.display = 'flex';
            const timer = document.getElementById('respawn-timer');
            const prompt = document.getElementById('respawn-prompt');

            if (p.canRespawn()) {
                timer.textContent = '';
                prompt.style.display = 'block';

                if (this.input.isKeyDown('Space')) {
                    const spawnPoints = this.spawnSystem.getSpawnPoints(
                        p.team, [], (x, z) => this.island.getHeightAt(x, z)
                    );
                    if (spawnPoints.length > 0) {
                        p.respawn(spawnPoints[0].position);
                    }
                }
            } else {
                timer.textContent = `Respawn in ${Math.ceil(p.deathTimer)}s`;
                prompt.style.display = 'none';
            }
        } else {
            this.deathScreen.style.display = 'none';
        }
    }

    // ───── Events ─────

    _onPlayerDied() {
        // Could add kill feed entry here later
    }

    _onPlayerHit(hit) {
        if (!this.player) return;
        let obj = hit.target;
        while (obj) {
            if (obj.userData && obj.userData.soldier) {
                const soldier = obj.userData.soldier;
                if (!soldier.alive) return;
                if (soldier.team === this.player.team) return;
                const headshot = hit.target === soldier.headMesh;
                const result = soldier.takeDamage(hit.damage, this.player.getPosition(), headshot);
                if (result.killed) {
                    this.eventBus.emit('kill', {
                        killerName: 'You',
                        killerTeam: this.player.team,
                        victimName: `${soldier.team === 'teamA' ? 'A' : 'B'}-${soldier.id}`,
                        victimTeam: soldier.team,
                        headshot,
                    });
                }
                return;
            }
            obj = obj.parent;
        }
    }

    _onKill(data) {
        this.killFeed.addKill(data.killerName, data.killerTeam, data.victimName, data.victimTeam, data.headshot);
    }

    _onAIFired(data) {
        this.minimap.onEnemyFired(data.soldierId);
    }

    _onGameOver(data) {
        this.paused = true;
        this.input.exitPointerLock();
        this.gameOverScreen.style.display = 'flex';
        const winColor = data.winner === 'teamA' ? '#4488ff' : '#ff4444';
        const winName = data.winner === 'teamA' ? 'TEAM A' : 'TEAM B';
        document.getElementById('winner-text').innerHTML =
            `<span style="color:${winColor}">${winName} WINS!</span>`;
        document.getElementById('final-score').textContent =
            `Final Score: ${data.scores.teamA} — ${data.scores.teamB}`;
    }

    _updateShootTargets() {
        if (!this.player) return;
        const enemyMeshes = this.aiManager.getAllSoldierMeshes();
        this.player.shootTargets = [...this.island.collidables, ...enemyMeshes];
    }

    _onResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    // ───── Game Loop ─────

    _animate() {
        requestAnimationFrame(() => this._animate());
        if (this.paused) return;

        const dt = Math.min(this.clock.getDelta(), 0.1);

        this.physics.step(dt);

        // Update tracers
        this.tracerSystem.update(dt);

        // Update impact particles
        this.impactVFX.update(dt);

        // Update AI
        this.aiManager.update(dt, this.island.collidables);

        if (this.gameMode === 'spectator') {
            // Spectator camera
            this.spectator.update(dt);
        } else if (this.gameMode === 'playing' && this.player) {
            // Player update
            if (this.input.isPointerLocked) {
                this.player.update(dt);
            }
            // Refresh shoot targets
            this._updateShootTargets();
        }

        // Update flags — include AI + player positions
        const aiTeamAPos = this.aiManager.getTeamPositions('teamA');
        const aiTeamBPos = this.aiManager.getTeamPositions('teamB');
        const teamAPositions = [...aiTeamAPos];
        const teamBPositions = [...aiTeamBPos];
        if (this.player && this.player.alive && this.player.team) {
            const playerPos = this.player.getPosition();
            if (this.player.team === 'teamA') teamAPositions.push(playerPos);
            else teamBPositions.push(playerPos);
        }
        for (const flag of this.flags) {
            flag.update(teamAPositions, teamBPositions, dt);
        }

        // Update scores
        this.scoreManager.update(this.flags, dt);

        // Update HUD
        this._updateScoreHUD();
        this._updateHUD();

        // Update minimap
        const playerPos = this.player && this.player.alive ? this.player.getPosition() : null;
        const playerYaw = this.player ? this.player.yaw : 0;
        const playerTeam = this.player ? this.player.team : 'teamA';
        this.minimap.update({
            playerPos,
            playerYaw,
            playerTeam,
            flags: this.flags,
            teamASoldiers: this.aiManager.teamA.soldiers,
            teamBSoldiers: this.aiManager.teamB.soldiers,
            dt,
        });

        // Update kill feed
        this.killFeed.update(dt);

        this.renderer.render(this.scene, this.camera);
    }
}
