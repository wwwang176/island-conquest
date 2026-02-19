import * as THREE from 'three';
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
import { HUDController } from '../ui/HUDController.js';
import Stats from 'three/addons/libs/stats.module.js';

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
            this.eventBus,
            this.island.heliSpawnPositions
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

        // HUD
        this.hud = new HUDController(this);
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
            if (!this._ready || this.paused) return;
            if (this.gameMode === 'playing') {
                this.input.requestPointerLock();
            } else {
                this.blocker.classList.add('hidden');
            }
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
            if (e.code === 'Tab' && this.hud.scoreboard) {
                this.hud.scoreboard.style.display = 'none';
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

        // Pre-capture base flags so spawn anchors exist from the start
        const first = this.flags[0];
        first.owner = 'teamA';
        first.captureProgress = 1;
        first.capturingTeam = 'teamA';

        const last = this.flags[this.flags.length - 1];
        last.owner = 'teamB';
        last.captureProgress = 1;
        last.capturingTeam = 'teamB';
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
        this.hud.updateBlockerText();
        this._animate();
    }

    // ───── Mode Switching ─────

    _onGlobalKey(e) {
        if (this.paused || !this._ready) return;

        // Scoreboard (hold TAB) — works in any mode
        if (e.code === 'Tab') {
            e.preventDefault();
            if (this.hud.scoreboard) {
                this.hud.updateScoreboard();
                this.hud.scoreboard.style.display = 'flex';
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
        this.hud.applyUIState('joining');
        const label = document.getElementById('join-team-label');
        const color = team === 'teamA' ? '#4488ff' : '#ff4444';
        const name = team === 'teamA' ? 'TEAM A' : 'TEAM B';
        label.innerHTML = `Joining <span style="color:${color}">${name}</span>`;
    }

    _cancelJoin() {
        this.gameMode = 'spectator';
        this._pendingTeam = null;
        this.hud.applyUIState('spectator');
        this.hud.updateBlockerText();
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
        this.hud.applyUIState('playing');
        this.hud.updateBlockerText();

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
        this.hud.applyUIState('spectator');
        this.hud.updateBlockerText();
        this.blocker.classList.add('hidden');
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
                this.hud.showHitMarker();
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
                this.hud.showHitMarker();
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
                this.hud.showHitMarker();
            }
        }
    }

    _onGrenadeDamage(data) {
        // Player's grenade hit
        if (this.gameMode === 'playing' && data.throwerName === 'You') {
            this.hud.showHitMarker();
            return;
        }
        // Spectated COM's grenade hit
        if (this.gameMode === 'spectator' && this.spectator && this.spectator.mode === 'follow') {
            const target = this.spectator.getCurrentTarget();
            if (target) {
                const comName = `${target.soldier.team === 'teamA' ? 'A' : 'B'}-${target.soldier.id}`;
                if (data.throwerName === comName) {
                    this.hud.showHitMarker();
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

    _onAIFired(data) {
        this.minimap.onEnemyFired(data.soldierId);
    }

    _onGameOver(data) {
        this.paused = true;
        this.input.exitPointerLock();
        this.hud.gameOverScreen.style.display = 'flex';
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
        this.hud.update(dt);

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
