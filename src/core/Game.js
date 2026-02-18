import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { PhysicsWorld } from '../systems/PhysicsWorld.js';
import { InputManager } from './InputManager.js';
import { EventBus } from './EventBus.js';
import { Player } from '../entities/Player.js';
import { WeaponDefs } from '../entities/WeaponDefs.js';
import { Island } from '../world/Island.js';
import { CoverSystem } from '../world/CoverSystem.js';
import { FlagPoint } from '../world/FlagPoint.js';
import { ScoreManager } from '../systems/ScoreManager.js';
import { SpawnSystem } from '../systems/SpawnSystem.js';
import { AIManager } from '../ai/AIManager.js';
import { AIController } from '../ai/AIController.js';
import { TracerSystem } from '../vfx/TracerSystem.js';
import { ImpactVFX } from '../vfx/ImpactVFX.js';
import { GrenadeManager } from '../systems/GrenadeManager.js';
import { DroppedGunManager } from '../systems/DroppedGunManager.js';
import { VehicleManager } from '../systems/VehicleManager.js';
import { Minimap } from '../ui/Minimap.js';
import { KillFeed } from '../ui/KillFeed.js';
import { SpectatorMode } from './SpectatorMode.js';
import Stats from 'three/addons/libs/stats.module.js';

// Module-level reusable objects for hot paths
const _gDmgFwd = new THREE.Vector3();
const _gDmgQuat = new THREE.Quaternion();
const _gYAxis = new THREE.Vector3(0, 1, 0);

export class Game {
    constructor() {
        this.eventBus = new EventBus();
        this.input = new InputManager();
        this.clock = new THREE.Clock();
        this.paused = false;
        this.gameMode = 'spectator'; // 'spectator' | 'joining' | 'playing' | 'dead'
        this._pendingTeam = null;    // team chosen during 'joining' phase
        this._pendingWeapon = 'AR15';

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        this.renderer.setClearColor(0x87CEEB);
        document.body.appendChild(this.renderer.domElement);

        // Scene
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.Fog(0x87CEEB, 100, 300);

        // Camera (must be in scene so children like gun meshes and muzzle flash are rendered)
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);
        this.scene.add(this.camera);

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
        this.impactVFX = new ImpactVFX(this.scene, (x, z) => this.island.getHeightAt(x, z));

        // AI Manager (30 COMs total: 15 per team)
        this.aiManager = new AIManager(
            this.scene, this.physics, this.flags, this.coverSystem,
            (x, z) => this.island.getHeightAt(x, z),
            this.eventBus
        );
        this.aiManager.tracerSystem = this.tracerSystem;
        this.aiManager.impactVFX = this.impactVFX;
        // Dropped gun manager
        this.droppedGunManager = new DroppedGunManager(this.scene, this.physics, this.impactVFX);

        // Give soldiers impactVFX + droppedGunManager references
        for (const s of this.aiManager.teamA.soldiers) {
            s.impactVFX = this.impactVFX;
            s.droppedGunManager = this.droppedGunManager;
        }
        for (const s of this.aiManager.teamB.soldiers) {
            s.impactVFX = this.impactVFX;
            s.droppedGunManager = this.droppedGunManager;
        }

        // Grenade manager
        this.grenadeManager = new GrenadeManager(this.scene, this.physics, this.impactVFX, this.eventBus);
        this.aiManager.grenadeManager = this.grenadeManager;
        this.grenadeManager.droppedGunManager = this.droppedGunManager;

        // Vehicle manager
        this.vehicleManager = new VehicleManager(
            this.scene, this.physics, this.flags,
            (x, z) => this.island.getHeightAt(x, z),
            this.eventBus
        );
        this.vehicleManager.setImpactVFX(this.impactVFX);
        this.aiManager.vehicleManager = this.vehicleManager;

        this._threatVisState = 0; // 0=off, 1=teamA, 2=teamB
        this._intelVisState = 0; // 0=off, 1=teamA, 2=teamB

        // KD stats for scoreboard
        this._kdStats = new Map(); // key: name ("A-0","B-5","You"), value: {kills,deaths,team,weapon}

        // FPS stats panel
        this.stats = new Stats();
        this.stats.showPanel(0); // 0 = FPS
        document.body.appendChild(this.stats.dom);

        // HUD elements
        this._createAllHUD();
        // Hide player-specific HUD until game starts (spectator not ready yet)
        this.ammoHUD.style.display = 'none';
        this.healthHUD.style.display = 'none';
        this.crosshair.style.display = 'none';
        this.minimap = new Minimap(this.island.width, this.island.depth);
        this.killFeed = new KillFeed();

        // Events
        this.eventBus.on('gameOver', (data) => this._onGameOver(data));
        this.eventBus.on('playerDied', () => this._onPlayerDied());
        this.eventBus.on('playerHit', (hit) => this._onPlayerHit(hit));
        this.eventBus.on('kill', (data) => this._onKill(data));
        this.eventBus.on('aiFired', (data) => this._onAIFired(data));
        this.eventBus.on('aiHit', (data) => this._onAIHit(data));
        this.eventBus.on('grenadeDamage', (data) => this._onGrenadeDamage(data));
        this.eventBus.on('vehicleDestroyed', (data) => this._onVehicleDestroyed(data));

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
                // Only show blocker in playing mode (spectator doesn't need pointer lock)
                if (!this.paused && this.gameMode === 'playing') {
                    this.blocker.classList.remove('hidden');
                }
            }
        });

        // Key listeners for mode switching
        document.addEventListener('keydown', (e) => this._onGlobalKey(e));
        document.addEventListener('keyup', (e) => {
            if (e.code === 'Tab' && this.scoreboard) {
                this.scoreboard.style.display = 'none';
            }
        });

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
        sun.shadow.mapSize.width = 1024;
        sun.shadow.mapSize.height = 1024;
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
        this.aiManager.setNavGrid(navGrid, heightGrid, this.island.obstacleBounds);
        this.aiManager.spawnAll();

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

        // Scoreboard (hold TAB) — works in any mode
        if (e.code === 'Tab') {
            e.preventDefault();
            if (this.scoreboard) {
                this._updateScoreboard();
                this.scoreboard.style.display = 'flex';
            }
            return;
        }

        // Threat map visualization toggle (works in any mode)
        if (e.code === 'KeyT') {
            this._threatVisState = (this._threatVisState + 1) % 3;
            this.aiManager.threatMapA.setVisible(this._threatVisState === 1);
            this.aiManager.threatMapB.setVisible(this._threatVisState === 2);
        }

        // Debug arc toggle
        if (e.code === 'KeyP') {
            AIController.debugArcs = !AIController.debugArcs;
            if (!AIController.debugArcs) {
                for (const ctrl of [...this.aiManager.teamA.controllers, ...this.aiManager.teamB.controllers]) {
                    if (ctrl._debugArc) ctrl._debugArc.visible = false;
                }
            }
        }

        // Intel contacts visualization toggle
        if (e.code === 'KeyI') {
            this._intelVisState = (this._intelVisState + 1) % 3;
            this.aiManager.intelA.setVisualization(this.scene, this._intelVisState === 1);
            this.aiManager.intelB.setVisualization(this.scene, this._intelVisState === 2);
        }

        // NavGrid blocked-cell visualization toggle
        if (e.code === 'KeyB' && this.island.navGrid) {
            const vis = this.island.navGrid._blockedVis;
            if (vis) vis.visible = !vis.visible;
        }

        // Tactical labels toggle
        if (e.code === 'KeyN') {
            AIController.showTacLabels = !AIController.showTacLabels;
        }

        if (this.gameMode === 'spectator') {
            if (e.code === 'KeyQ') {
                this.spectator.nextTarget();
            } else if (e.code === 'KeyV') {
                this.spectator.toggleView();
            } else if (e.code === 'Digit1') {
                this._showJoinScreen('teamA');
            } else if (e.code === 'Digit2') {
                this._showJoinScreen('teamB');
            }
        } else if (this.gameMode === 'joining') {
            // Weapon selection
            if (e.code === 'Digit1') this._pendingWeapon = 'AR15';
            else if (e.code === 'Digit2') this._pendingWeapon = 'SMG';
            else if (e.code === 'Digit3') this._pendingWeapon = 'LMG';
            else if (e.code === 'Digit4') this._pendingWeapon = 'BOLT';
            else if (e.code === 'Space') {
                this._joinTeam(this._pendingTeam, this._pendingWeapon);
            } else if (e.code === 'Escape') {
                this._cancelJoin();
            }
        } else if (this.gameMode === 'playing') {
            if (e.code === 'KeyE' && this.player && this.player.alive) {
                if (this.player.vehicle) {
                    // Exit vehicle
                    const v = this.player.vehicle;
                    // Helicopter: only allow exit near ground
                    if (v.type === 'helicopter' && !v.canExitSafely((x, z) => this.island.getHeightAt(x, z))) {
                        return; // too high to exit
                    }
                    const exitPos = this.vehicleManager.exitVehicle(this.player);
                    if (exitPos) {
                        this.player.exitVehicle(exitPos);
                    }
                } else {
                    // Try enter vehicle
                    const v = this.vehicleManager.tryEnterVehicle(this.player);
                    if (v) {
                        this.player.enterVehicle(v);
                    }
                }
            } else if (e.code === 'Escape') {
                // Only leave team if pointer lock is already released (second Esc)
                // First Esc releases pointer lock (browser default), second Esc returns to spectator
                if (!this.input.isPointerLocked) {
                    e.preventDefault();
                    this._leaveTeam();
                }
            }
        } else if (this.gameMode === 'dead') {
            if (e.code === 'Escape') {
                e.preventDefault();
                this._leaveTeam();
            }
        }
    }

    _showJoinScreen(team) {
        this._pendingTeam = team;
        this._pendingWeapon = 'AR15';
        this.gameMode = 'joining';
        this._applyUIState('joining');
        const label = document.getElementById('join-team-label');
        const color = team === 'teamA' ? '#4488ff' : '#ff4444';
        const name = team === 'teamA' ? 'TEAM A' : 'TEAM B';
        label.innerHTML = `Joining <span style="color:${color}">${name}</span>`;
    }

    _cancelJoin() {
        this.gameMode = 'spectator';
        this._pendingTeam = null;
        this._applyUIState('spectator');
        this._updateBlockerText();
    }

    _updateJoinScreen() {
        if (this.gameMode !== 'joining') return;
        const sel = this._pendingWeapon;
        const ids = [
            ['join-wp-ar', 'AR15'], ['join-wp-smg', 'SMG'],
            ['join-wp-lmg', 'LMG'], ['join-wp-bolt', 'BOLT'],
        ];
        for (const [id, wep] of ids) {
            const el = document.getElementById(id);
            el.style.borderColor = sel === wep ? '#4488ff' : '#888';
            el.style.background = sel === wep ? 'rgba(68,136,255,0.15)' : 'transparent';
        }
    }

    _joinTeam(team, weaponId) {
        // Create player if first time
        if (!this.player) {
            this.player = new Player(this.scene, this.camera, this.physics, this.input, this.eventBus);
            this.player.getHeightAt = (x, z) => this.island.getHeightAt(x, z);
            this.player.navGrid = this.island.navGrid;
            this.player.weapon.tracerSystem = this.tracerSystem;
            this.player.weapon.impactVFX = this.impactVFX;
            this.player.grenadeManager = this.grenadeManager;
        }

        this.player.selectedWeaponId = weaponId || 'AR15';
        this.player.team = team;
        this.player.alive = true;
        this.player.hp = this.player.maxHP;
        this.player.mesh.visible = false; // FPS: own mesh hidden

        // Always rebuild weapon to ensure correct arm color for team
        this.player.switchWeapon(this.player.selectedWeaponId);
        this.player.weapon.currentAmmo = this.player.weapon.magazineSize;
        this.player.weapon.isReloading = false;
        // Apply move speed
        const mult = WeaponDefs[this.player.selectedWeaponId].moveSpeedMult || 1.0;
        this.player.moveSpeed = 6 * mult;

        // Spawn at a safe position (owned flag + walkability check)
        const spawnPos = this.aiManager.findSafeSpawn(team);
        if (spawnPos) {
            this.player.body.position.set(spawnPos.x, spawnPos.y + 1, spawnPos.z);
        } else {
            const spawnFlag = team === 'teamA' ? this.flags[0] : this.flags[this.flags.length - 1];
            const sy = this.island.getHeightAt(spawnFlag.position.x, spawnFlag.position.z) + 2;
            this.player.body.position.set(spawnFlag.position.x, sy, spawnFlag.position.z);
        }
        this.player.body.velocity.set(0, 0, 0);
        this.player._prevSpace = true; // suppress jump from Space used to join

        // Register with AI
        this.aiManager.setPlayer(this.player);

        // Switch mode
        this.gameMode = 'playing';
        this.spectator.deactivate();
        this._applyUIState('playing');
        this._updateBlockerText();

        // Request pointer lock
        this.input.requestPointerLock();
    }

    _leaveTeam() {
        if (!this.player) return;

        // Exit vehicle if in one
        if (this.player.vehicle) {
            const exitPos = this.vehicleManager.exitVehicle(this.player);
            if (exitPos) this.player.exitVehicle(exitPos);
        }

        // Unscope before leaving
        if (this.player.weapon && this.player.weapon.isScoped) {
            this.player.weapon.setScoped(false);
        }

        // Save position before removing
        const lastX = this.player.body.position.x;
        const lastZ = this.player.body.position.z;

        // Remove player from game world
        this.player.alive = false;
        this.player.mesh.visible = false;
        // Move physics body far away to avoid interactions
        this.player.body.position.set(0, -100, 0);
        this.player.body.velocity.set(0, 0, 0);

        // Unregister from AI
        this.aiManager.removePlayer();

        // Switch mode — always start in overhead view at player's last position
        this.gameMode = 'spectator';
        this.spectator.mode = 'overhead';
        this.spectator.overheadPos.set(lastX, this.spectator.overheadZoom, lastZ);
        this.spectator.hud.setOverheadMode();
        this.spectator.activate();
        this._applyUIState('spectator');
        this._updateBlockerText();
        this.blocker.classList.add('hidden');
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

    _applyUIState(state) {
        // state: 'spectator' | 'joining' | 'playing' | 'dead'
        const hide = el => { if (el) el.style.display = 'none'; };
        const show = (el, display = 'block') => { if (el) el.style.display = display; };

        switch (state) {
            case 'spectator':
                hide(this.joinScreen);
                hide(this.deathScreen);
                hide(this.scoreboard);
                hide(this.healthHUD);
                hide(this.scopeVignette);
                this._lastScoped = false;
                this.camera.fov = 75;
                this.camera.updateProjectionMatrix();
                this.damageIndicator.style.background = 'none';
                if (this.spectator) this.spectator.hud.show();
                show(this.keyHints);
                // blocker managed by callers (_cancelJoin, _leaveTeam)
                // ammoHUD/crosshair managed dynamically in _updateHUD/_updateReloadIndicator
                // gun model hidden
                if (this.player && this.player.weapon) {
                    this.player.weapon.gunGroup.visible = false;
                    this.player.weapon.muzzleFlash.visible = false;
                }
                break;

            case 'joining':
                this.blocker.classList.add('hidden');
                hide(this.deathScreen);
                hide(this.scoreboard);
                if (this.spectator) this.spectator.hud.hide();
                hide(this.ammoHUD);
                hide(this.healthHUD);
                hide(this.crosshair);
                hide(this.reloadIndicator);
                this.damageIndicator.style.background = 'none';
                hide(this.keyHints);
                show(this.joinScreen, 'flex');
                if (this.player && this.player.weapon) {
                    this.player.weapon.gunGroup.visible = false;
                    this.player.weapon.muzzleFlash.visible = false;
                }
                break;

            case 'playing':
                this.blocker.classList.add('hidden');
                hide(this.joinScreen);
                hide(this.deathScreen);
                hide(this.scoreboard);
                hide(this.scopeVignette);
                this._lastScoped = false;
                // Restore default FOV (in case spectating a scoped COM before joining)
                this.camera.fov = 75;
                this.camera.updateProjectionMatrix();
                if (this.spectator) this.spectator.hud.hide();
                hide(this.keyHints);
                show(this.ammoHUD);
                show(this.healthHUD);
                // crosshair managed by _updateReloadIndicator
                // gun model visible
                if (this.player && this.player.weapon) {
                    this.player.weapon.gunGroup.visible = true;
                }
                break;

            case 'dead':
                this.blocker.classList.add('hidden');
                hide(this.joinScreen);
                hide(this.scoreboard);
                if (this.spectator) this.spectator.hud.hide();
                hide(this.ammoHUD);
                hide(this.healthHUD);
                hide(this.crosshair);
                hide(this.reloadIndicator);
                hide(this.keyHints);
                hide(this.scopeVignette);
                this._lastScoped = false;
                this.damageIndicator.style.background = 'none';
                show(this.deathScreen, 'flex');
                if (this.player && this.player.weapon) {
                    this.player.weapon.gunGroup.visible = false;
                    this.player.weapon.muzzleFlash.visible = false;
                }
                break;
        }
    }

    // ───── HUD ─────

    _createAllHUD() {
        this._createCrosshair();
        this._createReloadIndicator();
        this._createAmmoHUD();
        this._createHealthHUD();
        this._createScoreHUD();
        this._createDamageIndicator();
        this._createScopeVignette();
        this._createJoinScreen();
        this._createDeathScreen();
        this._createGameOverScreen();
        this._createKeyHints();
        this._createScoreboard();
        this._createVehicleHUD();
    }

    _createCrosshair() {
        const el = document.createElement('div');
        el.id = 'crosshair';
        el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            width:30px;height:30px;pointer-events:none;z-index:100;`;
        el.innerHTML = `<svg width="30" height="30" viewBox="0 0 20 20">
            <line x1="10" y1="3" x2="10" y2="8" stroke="white" stroke-width="1.2" opacity="0.8"/>
            <line x1="10" y1="12" x2="10" y2="17" stroke="white" stroke-width="1.2" opacity="0.8"/>
            <line x1="3" y1="10" x2="8" y2="10" stroke="white" stroke-width="1.2" opacity="0.8"/>
            <line x1="12" y1="10" x2="17" y2="10" stroke="white" stroke-width="1.2" opacity="0.8"/>
            <circle cx="10" cy="10" r="0.8" fill="white" opacity="0.6"/></svg>`;
        document.body.appendChild(el);
        this.crosshair = el;

        // Hit marker (X shape, 45° rotated crosshair)
        const hm = document.createElement('div');
        hm.id = 'hit-marker';
        hm.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(45deg);
            width:30px;height:30px;pointer-events:none;z-index:101;display:none;`;
        hm.innerHTML = `<svg width="30" height="30" viewBox="0 0 20 20">
            <line x1="10" y1="2" x2="10" y2="7" stroke="white" stroke-width="1.5"/>
            <line x1="10" y1="13" x2="10" y2="18" stroke="white" stroke-width="1.5"/>
            <line x1="2" y1="10" x2="7" y2="10" stroke="white" stroke-width="1.5"/>
            <line x1="13" y1="10" x2="18" y2="10" stroke="white" stroke-width="1.5"/></svg>`;
        document.body.appendChild(hm);
        this.hitMarker = hm;
        this._hitMarkerTimer = 0;
    }

    _createReloadIndicator() {
        const el = document.createElement('div');
        el.id = 'reload-indicator';
        el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            width:40px;height:40px;pointer-events:none;z-index:100;display:none;`;
        // SVG circle: radius=16, circumference=2*PI*16≈100.53
        el.innerHTML = `<svg width="40" height="40" viewBox="0 0 40 40" style="transform:rotate(-90deg)">
            <circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="3"/>
            <circle id="reload-arc" cx="20" cy="20" r="16" fill="none" stroke="white" stroke-width="3"
                stroke-dasharray="100.53" stroke-dashoffset="100.53" stroke-linecap="round" opacity="0.85"/>
        </svg>`;
        document.body.appendChild(el);
        this.reloadIndicator = el;
        this.reloadArc = null; // lazy-cached
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

    _createScopeVignette() {
        const el = document.createElement('div');
        el.id = 'scope-vignette';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            pointer-events:none;z-index:98;display:none;
            background:radial-gradient(circle, transparent 30%, rgba(0,0,0,0.9) 70%);`;
        // Full-screen crosshair lines
        el.innerHTML = `
            <div style="position:absolute;top:50%;left:0;width:100%;height:1px;background:rgba(255,255,255,0.5);"></div>
            <div style="position:absolute;top:0;left:50%;width:1px;height:100%;background:rgba(255,255,255,0.5);"></div>
            <div style="position:absolute;top:50%;left:50%;width:6px;height:6px;transform:translate(-50%,-50%);
                border:1px solid rgba(255,255,255,0.6);border-radius:50%;"></div>`;
        document.body.appendChild(el);
        this.scopeVignette = el;
    }

    _weaponStatBars(weaponId) {
        const def = WeaponDefs[weaponId];
        // Derive max values from all gun-type weapons
        let maxDmg = 0, maxRof = 0, maxRng = 0, maxSpread = 0, maxMob = 0;
        for (const k in WeaponDefs) {
            const w = WeaponDefs[k];
            if (!w.fireRate) continue; // skip GRENADE etc.
            if (w.damage > maxDmg) maxDmg = w.damage;
            if (w.fireRate > maxRof) maxRof = w.fireRate;
            if (w.maxRange > maxRng) maxRng = w.maxRange;
            if (w.baseSpread > maxSpread) maxSpread = w.baseSpread;
            if ((w.moveSpeedMult || 1) > maxMob) maxMob = w.moveSpeedMult || 1;
        }
        const stats = [
            ['DMG', def.damage / maxDmg],
            ['ROF', def.fireRate / maxRof],
            ['RNG', def.maxRange / maxRng],
            ['ACC', 1 - def.baseSpread / (maxSpread * 1.25)],
            ['MOB', (def.moveSpeedMult || 1) / maxMob],
        ];
        const barW = 64;
        return stats.map(([label, ratio]) => {
            const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
            return `<div style="display:flex;align-items:center;gap:5px;margin-top:3px;">
                <span style="font-size:9px;color:#888;width:24px;text-align:right;">${label}</span>
                <div style="width:${barW}px;height:5px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;">
                    <div style="width:${pct}%;height:100%;background:rgba(255,255,255,0.6);border-radius:2px;"></div>
                </div>
                <span style="font-size:9px;color:#aaa;width:20px;text-align:right;">${pct}</span>
            </div>`;
        }).join('');
    }

    _weaponCardHTML(idPrefix, num, weaponId, shortId, selected) {
        const def = WeaponDefs[weaponId];
        const border = selected ? '#4488ff' : '#888';
        const bg = selected ? 'rgba(68,136,255,0.15)' : 'transparent';
        return `<div id="${idPrefix}-${shortId}" style="border:2px solid ${border};border-radius:8px;padding:10px 14px;
            background:${bg};cursor:default;min-width:140px;">
            <div style="font-size:16px;font-weight:bold;">[${num}] ${def.name}</div>
            <div style="font-size:11px;color:#aaa;margin-top:3px;">${def.fireRate} RPM &middot; ${def.magazineSize} rds</div>
            ${this._weaponStatBars(weaponId)}
        </div>`;
    }

    _createJoinScreen() {
        const el = document.createElement('div');
        el.id = 'join-screen';
        el.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;
            flex-direction:column;pointer-events:none;z-index:101;`;
        el.innerHTML = `
            <div style="color:white;font-family:Arial,sans-serif;text-align:center;">
                <div id="join-team-label" style="font-size:28px;font-weight:bold;margin-bottom:16px;"></div>
                <div style="font-size:14px;color:#aaa;margin-bottom:8px;">Select weapon:</div>
                <div style="display:flex;gap:12px;justify-content:center;">
                    ${this._weaponCardHTML('join-wp', 1, 'AR15', 'ar', true)}
                    ${this._weaponCardHTML('join-wp', 2, 'SMG', 'smg', false)}
                    ${this._weaponCardHTML('join-wp', 3, 'LMG', 'lmg', false)}
                    ${this._weaponCardHTML('join-wp', 4, 'BOLT', 'bolt', false)}
                </div>
                <div style="font-size:16px;color:#aaa;margin-top:14px;">
                    Press <b>SPACE</b> to deploy &nbsp; | &nbsp; <b>ESC</b> to cancel
                </div>
            </div>`;
        document.body.appendChild(el);
        this.joinScreen = el;
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
                <div id="weapon-select" style="display:none;margin-top:18px;">
                    <div style="font-size:14px;color:#aaa;margin-bottom:8px;">Select weapon:</div>
                    <div style="display:flex;gap:12px;justify-content:center;">
                        ${this._weaponCardHTML('weapon', 1, 'AR15', 'ar', true)}
                        ${this._weaponCardHTML('weapon', 2, 'SMG', 'smg', false)}
                        ${this._weaponCardHTML('weapon', 3, 'LMG', 'lmg', false)}
                        ${this._weaponCardHTML('weapon', 4, 'BOLT', 'bolt', false)}
                    </div>
                </div>
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
            '<span style="color:#fff">P</span> A* paths',
            '<span style="color:#fff">I</span> Intel contacts',
            '<span style="color:#fff">N</span> Tactic labels',
            '<span style="color:#fff">Q</span> Next COM',
            '<span style="color:#fff">V</span> Camera mode',
            '<span style="color:#fff">E</span> Enter/exit vehicle',
            '<span style="color:#fff">1/2</span> Join team',
            '<span style="color:#fff">Esc</span> Leave team',
        ].join('<br>');
        document.body.appendChild(el);
        this.keyHints = el;
    }


    _createScoreboard() {
        const el = document.createElement('div');
        el.id = 'scoreboard';
        el.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            background:rgba(0,0,0,0.8);border-radius:10px;padding:20px 28px;
            display:none;align-items:flex-start;gap:32px;
            pointer-events:none;z-index:150;font-family:Consolas,monospace;
            min-width:600px;backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,0.1);`;
        el.innerHTML = `
            <div id="sb-teamA" style="flex:1;min-width:260px;"></div>
            <div style="width:1px;background:rgba(255,255,255,0.15);align-self:stretch;"></div>
            <div id="sb-teamB" style="flex:1;min-width:260px;"></div>`;
        document.body.appendChild(el);
        this.scoreboard = el;
    }

    _createVehicleHUD() {
        const el = document.createElement('div');
        el.id = 'vehicle-hud';
        el.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
            color:white;font-family:Consolas,monospace;background:rgba(0,0,0,0.5);
            padding:10px 20px;border-radius:6px;pointer-events:none;z-index:100;
            text-align:center;display:none;`;
        document.body.appendChild(el);
        this.vehicleHUD = el;
    }

    _updateVehicleHUD() {
        if (!this.player || !this.player.vehicle || this.gameMode !== 'playing') {
            this.vehicleHUD.style.display = 'none';
            return;
        }

        const v = this.player.vehicle;
        this.vehicleHUD.style.display = 'block';

        const hpPct = Math.max(0, v.hp / v.maxHP * 100);
        const hpColor = hpPct > 50 ? '#4f4' : hpPct > 25 ? '#ff4' : '#f44';
        const isPilot = v.driver === this.player;
        const occ = v.occupantCount || 1;
        const typeName = `HELICOPTER [${occ}/4]` + (isPilot ? ' PILOT' : ' GUNNER');
        const controls = isPilot
            ? 'WASD Move | Space Up | Shift Down | E Exit'
            : 'Mouse Aim | LMB Fire | E Exit';

        this.vehicleHUD.innerHTML = `
            <div style="font-size:14px;font-weight:bold;margin-bottom:4px">${typeName}</div>
            <div style="width:200px;height:8px;background:#333;border-radius:4px;margin:4px auto;">
                <div style="width:${hpPct}%;height:100%;background:${hpColor};border-radius:4px;"></div>
            </div>
            <div style="font-size:11px;color:#aaa;margin-top:4px">${controls}</div>`;
    }

    _updateScoreboard() {
        // Ensure every soldier has an entry
        const ensureEntry = (name, team) => {
            if (!this._kdStats.has(name))
                this._kdStats.set(name, { kills: 0, deaths: 0, team, weapon: '' });
        };

        // Register all AI soldiers
        if (this.aiManager.teamA) {
            for (const s of this.aiManager.teamA.soldiers) {
                const name = `A-${s.id}`;
                ensureEntry(name, 'teamA');
                // Update weapon from controller
                if (s.controller) this._kdStats.get(name).weapon = s.controller.weaponId || '';
            }
        }
        if (this.aiManager.teamB) {
            for (const s of this.aiManager.teamB.soldiers) {
                const name = `B-${s.id}`;
                ensureEntry(name, 'teamB');
                if (s.controller) this._kdStats.get(name).weapon = s.controller.weaponId || '';
            }
        }
        // Register player
        if (this.player && this.player.team) {
            ensureEntry('You', this.player.team);
            this._kdStats.get('You').team = this.player.team;
            this._kdStats.get('You').weapon = this.player.weapon ? this.player.weapon.weaponId : '';
        }

        // Split into teams and sort by kills desc
        const teamA = [];
        const teamB = [];
        for (const [name, stat] of this._kdStats) {
            const entry = { name, ...stat };
            if (stat.team === 'teamA') teamA.push(entry);
            else teamB.push(entry);
        }
        teamA.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        teamB.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);

        const renderTeam = (entries, teamColor, teamLabel) => {
            let totalK = 0, totalD = 0;
            for (const e of entries) { totalK += e.kills; totalD += e.deaths; }
            let html = `<div style="color:${teamColor};font-weight:bold;font-size:16px;margin-bottom:8px;text-align:center;">${teamLabel}</div>`;
            html += `<div style="display:flex;color:#888;font-size:11px;padding:2px 6px;border-bottom:1px solid rgba(255,255,255,0.1);margin-bottom:2px;">
                <span style="flex:1">Name</span><span style="width:30px;text-align:center">K</span>
                <span style="width:30px;text-align:center">D</span><span style="width:50px;text-align:right">Wpn</span></div>`;
            for (const e of entries) {
                const isPlayer = e.name === 'You';
                const bg = isPlayer ? 'rgba(255,255,255,0.1)' : 'transparent';
                const nameColor = isPlayer ? '#fff' : 'rgba(255,255,255,0.75)';
                const wpn = e.weapon || '-';
                html += `<div style="display:flex;font-size:12px;padding:2px 6px;background:${bg};border-radius:2px;">
                    <span style="flex:1;color:${nameColor};font-weight:${isPlayer ? 'bold' : 'normal'}">${e.name}</span>
                    <span style="width:30px;text-align:center;color:#ccc">${e.kills}</span>
                    <span style="width:30px;text-align:center;color:#ccc">${e.deaths}</span>
                    <span style="width:50px;text-align:right;color:#888;font-size:11px">${wpn}</span></div>`;
            }
            html += `<div style="display:flex;font-size:12px;padding:4px 6px;margin-top:4px;border-top:1px solid rgba(255,255,255,0.1);color:#aaa;">
                <span style="flex:1;font-weight:bold">Total</span>
                <span style="width:30px;text-align:center">${totalK}</span>
                <span style="width:30px;text-align:center">${totalD}</span>
                <span style="width:50px"></span></div>`;
            return html;
        };

        document.getElementById('sb-teamA').innerHTML = renderTeam(teamA, '#4488ff', 'TEAM A');
        document.getElementById('sb-teamB').innerHTML = renderTeam(teamB, '#ff4444', 'TEAM B');
    }

    _updateReloadIndicator() {
        let isReloading = false;
        let progress = 0;

        if (this.gameMode === 'playing' && this.player && this.player.alive) {
            const w = this.player.weapon;
            if (w.isReloading) {
                isReloading = true;
                progress = 1 - w.reloadTimer / w.reloadTime;
            } else if (w.isBolting && w.def.boltTime) {
                isReloading = true;
                progress = 1 - w.boltTimer / w.def.boltTime;
            }
        } else if (this.gameMode === 'spectator' && this.spectator && this.spectator.mode === 'follow') {
            const target = this.spectator.getCurrentTarget();
            if (target) {
                const ctrl = target.controller;
                if (ctrl.isReloading) {
                    isReloading = true;
                    progress = 1 - ctrl.reloadTimer / ctrl.reloadTime;
                } else if (ctrl.boltTimer > 0 && ctrl.weaponDef.boltTime) {
                    isReloading = true;
                    progress = 1 - ctrl.boltTimer / ctrl.weaponDef.boltTime;
                }
            }
        }

        // Check if scoped (hide crosshair — scope overlay has its own crosshair)
        let isAnyScoped = false;
        if (this.gameMode === 'playing' && this.player && this.player.weapon) {
            isAnyScoped = this.player.weapon.isScoped;
        } else if (this.gameMode === 'spectator' && this.spectator && this.spectator.mode === 'follow') {
            const target = this.spectator.getCurrentTarget();
            if (target) isAnyScoped = target.controller.isScoped;
        }

        if (isReloading) {
            // Hide normal crosshair, show reload ring
            this.crosshair.style.display = 'none';
            this.reloadIndicator.style.display = 'block';
            if (!this.reloadArc) this.reloadArc = document.getElementById('reload-arc');
            // circumference = 2 * PI * 16 ≈ 100.53
            const circ = 100.53;
            this.reloadArc.setAttribute('stroke-dashoffset', circ * (1 - progress));
        } else {
            this.reloadIndicator.style.display = 'none';
            // Restore crosshair in playing mode, or spectator follow mode (hidden when scoped)
            const showCrosshair = !isAnyScoped && (
                this.gameMode === 'playing'
                || (this.gameMode === 'spectator' && this.spectator && this.spectator.mode === 'follow'));
            this.crosshair.style.display = showCrosshair ? 'block' : 'none';
        }
    }

    _updateHUD() {
        // ── Spectator follow mode: show observed soldier's ammo HUD ──
        if (this.gameMode === 'spectator') {
            const isFollow = this.spectator && this.spectator.mode === 'follow';
            if (isFollow) {
                const target = this.spectator.getCurrentTarget();
                if (target) {
                    this.ammoHUD.style.display = 'block';
                    const ctrl = target.controller;
                    const curAmmo = ctrl.currentAmmo;
                    const curReloading = ctrl.isReloading;
                    const curBolting = ctrl.boltTimer > 0;
                    const curWeaponId = ctrl.weaponId;
                    const curGrenades = ctrl.grenadeCount;
                    if (curAmmo !== this._lastAmmo || curReloading !== this._lastReloading
                        || curBolting !== this._lastBolting
                        || curWeaponId !== this._lastWeaponId || curGrenades !== this._lastGrenades) {
                        this._lastAmmo = curAmmo;
                        this._lastReloading = curReloading;
                        this._lastBolting = curBolting;
                        this._lastWeaponId = curWeaponId;
                        this._lastGrenades = curGrenades;
                        const statusText = curReloading ? `<span style="color:#ffaa00">RELOADING...</span>`
                            : curBolting ? `<span style="color:#ffaa00">BOLTING...</span>` : '';
                        const grenadeText = `<div style="font-size:13px;color:#aaa;margin-top:6px">&#x1F4A3; ${curGrenades}</div>`;
                        this.ammoHUD.innerHTML = `
                            <div style="font-size:12px;color:#aaa;margin-bottom:4px">${ctrl.weaponDef.name}</div>
                            <div style="font-size:28px;font-weight:bold">
                                ${curAmmo}<span style="font-size:16px;color:#888"> / ${ctrl.magazineSize}</span>
                            </div>${statusText}${grenadeText}`;
                    }
                } else {
                    this.ammoHUD.style.display = 'none';
                }
            } else {
                this.ammoHUD.style.display = 'none';
            }
            // Scope vignette + FOV for spectated BOLT COM
            // Wait until camera has settled on target before showing scope
            if (isFollow && this.spectator._initialized) {
                const target = this.spectator.getCurrentTarget();
                const comScoped = target && target.controller.isScoped;
                if (comScoped !== this._lastScoped) {
                    this._lastScoped = comScoped;
                    this.scopeVignette.style.display = comScoped ? 'block' : 'none';
                    this.camera.fov = comScoped ? (target.controller.weaponDef.scopeFOV || 20) : 75;
                    this.camera.updateProjectionMatrix();
                }
            } else if (this._lastScoped) {
                this._lastScoped = false;
                this.scopeVignette.style.display = 'none';
                this.camera.fov = 75;
                this.camera.updateProjectionMatrix();
            }

            // Clear cached values when switching away
            this._lastAmmo = undefined;
            this._updateDamageIndicator();
            return;
        }

        if (!this.player) return;

        // Death screen check (works in both 'playing' and 'dead' states)
        this._updateDeathScreen();

        // Skip ammo/health updates when dead
        if (this.gameMode === 'dead') return;

        const p = this.player;
        const w = p.weapon;

        // Ammo + grenade — only update DOM when values change
        const curAmmo = w.currentAmmo;
        const curReloading = w.isReloading;
        const curBolting = w.isBolting;
        const curWeaponId = w.weaponId;
        const curGrenades = p.grenadeCount;
        if (curAmmo !== this._lastAmmo || curReloading !== this._lastReloading
            || curBolting !== this._lastBolting
            || curWeaponId !== this._lastWeaponId || curGrenades !== this._lastGrenades) {
            this._lastAmmo = curAmmo;
            this._lastReloading = curReloading;
            this._lastBolting = curBolting;
            this._lastWeaponId = curWeaponId;
            this._lastGrenades = curGrenades;
            const statusText = curReloading ? `<span style="color:#ffaa00">RELOADING...</span>`
                : curBolting ? `<span style="color:#ffaa00">BOLTING...</span>` : '';
            const grenadeText = `<div style="font-size:13px;color:#aaa;margin-top:6px">&#x1F4A3; ${curGrenades}</div>`;
            this.ammoHUD.innerHTML = `
                <div style="font-size:12px;color:#aaa;margin-bottom:4px">${w.def.name}</div>
                <div style="font-size:28px;font-weight:bold">
                    ${curAmmo}<span style="font-size:16px;color:#888"> / ${w.magazineSize}</span>
                </div>${statusText}${grenadeText}`;
        }

        // Health — only update DOM when value changes
        const curHP = Math.round(p.hp);
        if (curHP !== this._lastHP) {
            this._lastHP = curHP;
            const hpColor = curHP > 60 ? '#4f4' : curHP > 30 ? '#ff4' : '#f44';
            const barWidth = Math.max(0, p.hp / p.maxHP * 100);
            this.healthHUD.innerHTML = `
                <div style="font-size:12px;color:#aaa;margin-bottom:4px">HEALTH</div>
                <div style="font-size:28px;font-weight:bold;color:${hpColor}">${curHP}</div>
                <div style="width:120px;height:6px;background:#333;border-radius:3px;margin-top:4px;">
                    <div style="width:${barWidth}%;height:100%;background:${hpColor};border-radius:3px;"></div>
                </div>`;
        }

        // Scope vignette
        const isScoped = w.isScoped;
        if (isScoped !== this._lastScoped) {
            this._lastScoped = isScoped;
            this.scopeVignette.style.display = isScoped ? 'block' : 'none';
        }

        // Damage direction indicator
        this._updateDamageIndicator();
    }

    _updateScoreHUD() {
        const s = this.scoreManager.scores;
        let aFlagCount = 0, bFlagCount = 0;
        for (const f of this.flags) {
            if (f.owner === 'teamA') aFlagCount++;
            else if (f.owner === 'teamB') bFlagCount++;
        }
        if (s.teamA === this._lastScoreA && s.teamB === this._lastScoreB &&
            aFlagCount === this._lastFlagsA && bFlagCount === this._lastFlagsB) return;
        this._lastScoreA = s.teamA;
        this._lastScoreB = s.teamB;
        this._lastFlagsA = aFlagCount;
        this._lastFlagsB = bFlagCount;
        this.scoreHUD.innerHTML = `
            <span style="color:#4488ff;font-weight:bold">${s.teamA}</span>
            <span style="color:#aaa;font-size:14px;margin:0 6px">
                Team A [${aFlagCount}] &mdash; [${bFlagCount}] Team B
            </span>
            <span style="color:#ff4444;font-weight:bold">${s.teamB}</span>`;
    }

    _updateDamageIndicator() {
        let timer = 0;
        let dmgDir = null;
        let camYaw = 0;

        if (this.gameMode === 'playing' && this.player) {
            timer = this.player.damageIndicatorTimer;
            dmgDir = this.player.lastDamageDirection;
            camYaw = this.player.yaw;
        } else if ((this.gameMode === 'spectator' || this.gameMode === 'joining') &&
                   this.spectator.mode === 'follow') {
            const target = this.spectator.getCurrentTarget();
            if (target) {
                timer = target.soldier.damageIndicatorTimer;
                dmgDir = target.soldier.lastDamageDirection;
                camYaw = this.spectator._lerpYaw;
            }
        }

        if (timer > 0 && dmgDir) {
            const opacity = Math.min(1, timer) * 0.6;

            _gDmgFwd.set(0, 0, -1);
            _gDmgQuat.setFromAxisAngle(_gYAxis, camYaw);
            const forward = _gDmgFwd.applyQuaternion(_gDmgQuat);

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
        if (!this.player || (this.gameMode !== 'playing' && this.gameMode !== 'dead')) return;
        const p = this.player;
        if (!p.alive) {
            // Transition to dead state once
            if (this.gameMode !== 'dead') {
                this.gameMode = 'dead';
                this._applyUIState('dead');
            }
            const timer = document.getElementById('respawn-timer');
            const prompt = document.getElementById('respawn-prompt');
            const weaponSelect = document.getElementById('weapon-select');
            if (p.canRespawn()) {
                timer.textContent = '';
                prompt.style.display = 'block';
                weaponSelect.style.display = 'block';

                // Weapon selection via keys
                if (this.input.isKeyDown('Digit1')) p.selectedWeaponId = 'AR15';
                if (this.input.isKeyDown('Digit2')) p.selectedWeaponId = 'SMG';
                if (this.input.isKeyDown('Digit3')) p.selectedWeaponId = 'LMG';
                if (this.input.isKeyDown('Digit4')) p.selectedWeaponId = 'BOLT';

                // Highlight selected weapon
                const sel = p.selectedWeaponId;
                const wepIds = [
                    ['weapon-ar', 'AR15'], ['weapon-smg', 'SMG'],
                    ['weapon-lmg', 'LMG'], ['weapon-bolt', 'BOLT'],
                ];
                for (const [id, wep] of wepIds) {
                    const el = document.getElementById(id);
                    el.style.borderColor = sel === wep ? '#4488ff' : '#888';
                    el.style.background = sel === wep ? 'rgba(68,136,255,0.15)' : 'transparent';
                }

                if (this.input.isKeyDown('Space')) {
                    const spawnPos = this.aiManager.findSafeSpawn(p.team);
                    if (spawnPos) {
                        p.respawn(spawnPos);
                        // Transition back to playing
                        this.gameMode = 'playing';
                        this._applyUIState('playing');
                        this.input.requestPointerLock();
                    }
                }
            } else {
                timer.textContent = `Respawn in ${Math.ceil(p.deathTimer)}s`;
                prompt.style.display = 'none';
                weaponSelect.style.display = 'none';
            }
        }
    }

    // ───── Events ─────

    _onPlayerDied() {
        // Drop the player's gun
        if (this.player && this.droppedGunManager) {
            const pos = this.player.getPosition();
            pos.y += this.player.cameraHeight * 0.8; // gun height
            const vel = this.player.lastMoveVelocity.clone();
            let impulseDir = null;
            if (this.player.lastDamageDirection) {
                impulseDir = this.player.lastDamageDirection.clone().negate();
            }
            this.droppedGunManager.spawnFromWeaponId(
                this.player.selectedWeaponId, pos, vel, impulseDir
            );
        }
    }

    _onPlayerHit(hit) {
        if (!this.player) return;
        let obj = hit.target;
        while (obj) {
            // Vehicle hit
            if (obj.userData && obj.userData.vehicle) {
                const vehicle = obj.userData.vehicle;
                if (!vehicle.alive) return;
                // No friendly fire on vehicles
                if (vehicle.team === this.player.team) return;
                if (this.impactVFX) {
                    this.impactVFX.spawn('rock', hit.point, null);
                }
                const result = vehicle.takeDamage(hit.damage);
                this._showHitMarker();
                if (result.destroyed) {
                    this.eventBus.emit('vehicleDestroyed', {
                        destroyerName: 'You',
                        destroyerTeam: this.player.team,
                        vehicleTeam: vehicle.team,
                        vehicleType: vehicle.type,
                    });
                }
                return;
            }
            // Soldier hit
            if (obj.userData && obj.userData.soldier) {
                const soldier = obj.userData.soldier;
                if (!soldier.alive) return;
                if (soldier.team === this.player.team) return;
                if (this.impactVFX) {
                    this.impactVFX.spawn('blood', hit.point, null);
                }
                const result = soldier.takeDamage(hit.damage, this.player.getPosition(), hit.point.y);
                this._showHitMarker();
                if (result.killed) {
                    this.eventBus.emit('kill', {
                        killerName: 'You',
                        killerTeam: this.player.team,
                        victimName: `${soldier.team === 'teamA' ? 'A' : 'B'}-${soldier.id}`,
                        victimTeam: soldier.team,
                        headshot: result.headshot,
                        weapon: this.player.weapon.weaponId,
                    });
                }
                return;
            }
            obj = obj.parent;
        }
    }

    _onKill(data) {
        this.killFeed.addKill(data.killerName, data.killerTeam, data.victimName, data.victimTeam, data.headshot, data.weapon);
        // Track KD stats
        if (!this._kdStats.has(data.killerName))
            this._kdStats.set(data.killerName, { kills: 0, deaths: 0, team: data.killerTeam, weapon: data.weapon });
        if (!this._kdStats.has(data.victimName))
            this._kdStats.set(data.victimName, { kills: 0, deaths: 0, team: data.victimTeam, weapon: '' });
        this._kdStats.get(data.killerName).kills++;
        this._kdStats.get(data.killerName).weapon = data.weapon;
        this._kdStats.get(data.victimName).deaths++;
    }

    _onAIHit(data) {
        // Show hit marker when spectating the COM that scored the hit
        if (this.gameMode === 'spectator' && this.spectator && this.spectator.mode === 'follow') {
            const target = this.spectator.getCurrentTarget();
            if (target && target.soldier === data.soldier) {
                this._showHitMarker();
            }
        }
    }

    _onGrenadeDamage(data) {
        // Player's grenade hit
        if (this.gameMode === 'playing' && data.throwerName === 'You') {
            this._showHitMarker();
            return;
        }
        // Spectated COM's grenade hit
        if (this.gameMode === 'spectator' && this.spectator && this.spectator.mode === 'follow') {
            const target = this.spectator.getCurrentTarget();
            if (target) {
                const comName = `${target.soldier.team === 'teamA' ? 'A' : 'B'}-${target.soldier.id}`;
                if (data.throwerName === comName) {
                    this._showHitMarker();
                }
            }
        }
    }

    _onVehicleDestroyed(data) {
        const typeName = 'Helicopter';
        const teamName = data.vehicleTeam === 'teamA' ? 'A' : 'B';
        this.killFeed.addKill(
            data.destroyerName, data.destroyerTeam,
            `${teamName}-${typeName}`, data.vehicleTeam,
            false, 'VEHICLE'
        );
    }

    _showHitMarker() {
        this._hitMarkerTimer = 0.15;
        this.hitMarker.style.display = 'block';
        this.hitMarker.style.opacity = '1';
    }

    _updateHitMarker(dt) {
        if (this._hitMarkerTimer > 0) {
            this._hitMarkerTimer -= dt;
            if (this._hitMarkerTimer <= 0) {
                this.hitMarker.style.display = 'none';
            } else {
                this.hitMarker.style.opacity = String(Math.min(1, this._hitMarkerTimer / 0.08));
            }
        }
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
        if (!this._shootTargets) this._shootTargets = [];
        const buf = this._shootTargets;
        buf.length = 0;
        for (const c of this.island.collidables) buf.push(c);
        for (const m of enemyMeshes) buf.push(m);
        // Include vehicle meshes as hitscan targets (skip own vehicle)
        const ownVehicleMesh = this.player.vehicle ? this.player.vehicle.mesh : null;
        for (const m of this.vehicleManager.getVehicleMeshes()) {
            if (m !== ownVehicleMesh) buf.push(m);
        }
        this.player.shootTargets = buf;
    }

    _onResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    // ───── Game Loop ─────

    _animate() {
        requestAnimationFrame(() => this._animate());
        this.stats.begin();
        if (this.paused) { this.stats.end(); return; }

        const dt = Math.min(this.clock.getDelta(), 0.1);

        this.physics.step(dt);

        // Update tracers
        this.tracerSystem.update(dt);

        // Update impact particles
        this.impactVFX.update(dt);

        // Update vehicles FIRST so AI passengers read current helicopter position
        this.vehicleManager.update(dt);

        // Update AI — vehicle meshes added by AIController at fire time via vehicleManager
        this.aiManager.update(dt, this.island.collidables);

        // Update intel visualization
        if (this._intelVisState === 1) this.aiManager.intelA.updateVisualization();
        else if (this._intelVisState === 2) this.aiManager.intelB.updateVisualization();

        // Update grenades
        if (!this._allSoldiersBuf) this._allSoldiersBuf = [];
        const allSoldiersBuf = this._allSoldiersBuf;
        allSoldiersBuf.length = 0;
        for (const s of this.aiManager.teamA.soldiers) allSoldiersBuf.push(s);
        for (const s of this.aiManager.teamB.soldiers) allSoldiersBuf.push(s);
        this.grenadeManager.update(dt, allSoldiersBuf, this.player);

        // Update dropped guns
        this.droppedGunManager.update(dt);

        if (this.gameMode === 'spectator' || this.gameMode === 'joining') {
            // Spectator camera
            this.spectator.update(dt);
        } else if ((this.gameMode === 'playing' || this.gameMode === 'dead') && this.player) {
            // Player update — always run (ESC only releases pointer, game continues)
            this.player.update(dt);
            // Refresh shoot targets
            this._updateShootTargets();
        }

        // Update flags — include AI + player positions (buffers reused by AIManager)
        const teamAPositions = this.aiManager.getTeamPositions('teamA');
        const teamBPositions = this.aiManager.getTeamPositions('teamB');
        if (this.player && this.player.alive && this.player.team) {
            const playerPos = this.player.getPosition();
            if (this.player.team === 'teamA') teamAPositions.push(playerPos);
            else teamBPositions.push(playerPos);
        }
        for (const flag of this.flags) {
            flag.update(teamAPositions, teamBPositions, dt, this.camera);
        }

        // Update scores
        this.scoreManager.update(this.flags, dt);

        // Update HUD
        this._updateScoreHUD();
        this._updateHUD();
        this._updateReloadIndicator();
        this._updateHitMarker(dt);
        this._updateJoinScreen();
        this._updateVehicleHUD();

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
            vehicles: this.vehicleManager.vehicles,
            dt,
        });

        // Update kill feed
        this.killFeed.update(dt);

        this.renderer.render(this.scene, this.camera);
        this.stats.end();
    }
}
