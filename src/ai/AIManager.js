import * as THREE from 'three';
import { Soldier } from '../entities/Soldier.js';
import { AIController } from './AIController.js';
import { SquadTemplates } from './Personality.js';
import { TeamIntel } from './TeamIntel.js';
import { SquadCoordinator } from './SquadCoordinator.js';
import { ThreatMap } from './ThreatMap.js';


/**
 * Manages all AI soldiers for both teams.
 * Creates 15 COMs per team (5 squads × 3), assigns personalities.
 */
export class AIManager {
    constructor(scene, physicsWorld, flags, coverSystem, getHeightAt, eventBus) {
        this.scene = scene;
        this.physics = physicsWorld;
        this.flags = flags;
        this.coverSystem = coverSystem;
        this.getHeightAt = getHeightAt;
        this.eventBus = eventBus;

        // Shared intel boards — one per team
        this.intelA = new TeamIntel('teamA');
        this.intelB = new TeamIntel('teamB');

        // Threat maps — one per team (enemies of that team)
        this.threatMapA = new ThreatMap();
        this.threatMapB = new ThreatMap();

        this.teamA = { soldiers: [], controllers: [], squads: [] };
        this.teamB = { soldiers: [], controllers: [], squads: [] };

        this._createTeam('teamA', this.teamA);
        this._createTeam('teamB', this.teamB);

        // Staggered updates: split AI updates across frames
        this.updateIndex = 0;
        this.totalAI = this.teamA.soldiers.length + this.teamB.soldiers.length;

        // Pre-allocated buffers for per-frame lists
        this._teamAEnemies = [];
        this._teamBEnemies = [];
        this._meshBuf = [];
        this._posABuf = [];
        this._posBBuf = [];

        // Soldiers are created but not yet positioned — call spawnAll() after NavGrid is ready
        this._spawned = false;
    }

    _createTeam(team, teamData) {
        const spawnFlag = team === 'teamA' ? this.flags[0] : this.flags[this.flags.length - 1];
        const teamIntel = team === 'teamA' ? this.intelA : this.intelB;
        let id = 0;

        for (const squad of SquadTemplates) {
            const squadControllers = [];

            for (const role of squad.roles) {
                // Create soldier
                const soldier = new Soldier(this.scene, this.physics, team, id, true);

                // Position off-screen until spawnAll() places them properly
                soldier.body.position.set(0, -100, 0);

                // Create AI controller with coverSystem and teamIntel
                const controller = new AIController(
                    soldier, role, team, this.flags, this.getHeightAt,
                    this.coverSystem, teamIntel, this.eventBus
                );

                // Assign threat map: teamA controllers use threatMapA (enemies = teamB)
                controller.threatMap = team === 'teamA' ? this.threatMapA : this.threatMapB;

                squadControllers.push(controller);
                teamData.soldiers.push(soldier);
                teamData.controllers.push(controller);
                id++;
            }

            // Create squad coordinator
            const coordinator = new SquadCoordinator(
                squad.name, squadControllers, teamIntel, this.flags, team,
                squad.strategy || 'secure'
            );

            // Assign squad reference and flank sides to controllers
            let flankSide = 1;
            for (const ctrl of squadControllers) {
                ctrl.squad = coordinator;
                ctrl.flankSide = flankSide;
                flankSide *= -1; // alternate sides
            }

            teamData.squads.push(coordinator);
        }
    }

    /**
     * Set the navigation grid so AI can pathfind around obstacles.
     */
    /**
     * Set navigation grid. If prebuilt heightGrid is provided (from Worker),
     * uses it directly instead of recomputing on main thread.
     */
    setNavGrid(grid, heightGrid, obstacleBounds) {
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl.navGrid = grid;
        }
        // Share navGrid with threat maps for LOS checks
        this.threatMapA.navGrid = grid;
        this.threatMapB.navGrid = grid;
        this._navGrid = grid;
        // Build height grid with per-obstacle bounding boxes for accurate LOS
        this.threatMapA.buildHeightGrid(this.getHeightAt, obstacleBounds);
        // Share the same height data but init a separate worker for team B
        this.threatMapB.heightGrid = this.threatMapA.heightGrid;
        this.threatMapB._initWorker();
    }

    // Keep setter for backward compatibility
    set navGrid(grid) {
        this.setNavGrid(grid, null, null);
    }

    /**
     * Place all soldiers at safe initial positions.
     * Must be called after NavGrid + ThreatMap are ready.
     */
    spawnAll() {
        if (this._spawned) return;
        this._spawned = true;

        const spawnTeam = (teamData, team) => {
            const spawnFlag = team === 'teamA' ? this.flags[0] : this.flags[this.flags.length - 1];
            const threatMap = team === 'teamA' ? this.threatMapA : this.threatMapB;
            for (const soldier of teamData.soldiers) {
                const angle = Math.random() * Math.PI * 2;
                const dist = 5 + Math.random() * 10;
                const cx = spawnFlag.position.x + Math.cos(angle) * dist;
                const cz = spawnFlag.position.z + Math.sin(angle) * dist;
                const safe = this._findSafeCell(cx, cz, threatMap, 30);
                if (safe) {
                    soldier.body.position.set(safe.x, safe.y + 1, safe.z);
                } else {
                    // Fallback: flag position directly
                    const h = this.getHeightAt(spawnFlag.position.x, spawnFlag.position.z);
                    soldier.body.position.set(spawnFlag.position.x, h + 1, spawnFlag.position.z);
                }
            }
        };

        spawnTeam(this.teamA, 'teamA');
        spawnTeam(this.teamB, 'teamB');
    }

    /**
     * Set the tracer VFX system so AI shots produce visible tracers.
     */
    set tracerSystem(sys) {
        this._tracerSystem = sys;
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl.tracerSystem = sys;
        }
    }

    /**
     * Set the grenade manager so AI can throw grenades.
     */
    set grenadeManager(mgr) {
        this._grenadeManager = mgr;
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl.grenadeManager = mgr;
        }
    }

    /**
     * Set the impact VFX system so AI shots produce hit particles.
     */
    set impactVFX(sys) {
        this._impactVFX = sys;
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl.impactVFX = sys;
        }
    }

    /**
     * Set player reference so AI can target/avoid player.
     */
    setPlayer(player) {
        this.player = player;
        // Give all controllers player reference
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl.setPlayerRef(player);
        }
    }

    /**
     * Remove player reference (when returning to spectator mode).
     */
    removePlayer() {
        this.player = null;
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl._playerRef = null;
            ctrl._playerMesh = null;
        }
    }

    /**
     * Get all soldier positions for a team (for flag capture detection).
     */
    getTeamPositions(team) {
        const buf = team === 'teamA' ? this._posABuf : this._posBBuf;
        buf.length = 0;
        const data = team === 'teamA' ? this.teamA : this.teamB;
        for (const s of data.soldiers) {
            if (s.alive) buf.push(s.getPosition());
        }
        return buf;
    }

    /**
     * Get all collidable meshes (soldier bodies for hitscan).
     */
    getAllSoldierMeshes() {
        const buf = this._meshBuf;
        buf.length = 0;
        for (const s of this.teamA.soldiers) {
            if (s.alive) buf.push(s.mesh);
        }
        for (const s of this.teamB.soldiers) {
            if (s.alive) buf.push(s.mesh);
        }
        return buf;
    }

    /**
     * Main update — staggered across frames.
     */
    update(dt, collidables) {
        const allA = this.teamA.soldiers;
        const allB = this.teamB.soldiers;

        // Update intel boards
        this.intelA.update(dt);
        this.intelB.update(dt);

        // Update threat maps: teamA's threats come from teamB soldiers and vice versa
        this.threatMapA.update(dt, allB);
        this.threatMapB.update(dt, allA);

        // Calculate flag deficit per team (positive = behind)
        const aFlags = this.flags.filter(f => f.owner === 'teamA').length;
        const bFlags = this.flags.filter(f => f.owner === 'teamB').length;

        // Pass deficit to controllers
        for (const ctrl of this.teamA.controllers) ctrl.flagDeficit = bFlags - aFlags;
        for (const ctrl of this.teamB.controllers) ctrl.flagDeficit = aFlags - bFlags;

        // Update squad coordinators with deficit
        for (const squad of this.teamA.squads) squad.update(dt, bFlags - aFlags);
        for (const squad of this.teamB.squads) squad.update(dt, aFlags - bFlags);

        // Add player to appropriate enemy list
        const playerAsEnemy = this.player && this.player.alive && this.player.team
            ? {
                alive: this.player.alive,
                hp: this.player.hp,
                maxHP: this.player.maxHP,
                mesh: this.player.mesh,
                body: this.player.body,
                getPosition: () => this.player.getPosition(),
                takeDamage: (amt, from, hitY) => this.player.takeDamage(amt, from, hitY),
            }
            : null;

        // Build enemy/ally lists (reuse pre-allocated buffers)
        const teamAEnemies = this._teamAEnemies;
        teamAEnemies.length = 0;
        for (const s of allB) teamAEnemies.push(s);

        const teamBEnemies = this._teamBEnemies;
        teamBEnemies.length = 0;
        for (const s of allA) teamBEnemies.push(s);

        if (playerAsEnemy && this.player.team === 'teamA') {
            teamBEnemies.push(playerAsEnemy);
        } else if (playerAsEnemy && this.player.team === 'teamB') {
            teamAEnemies.push(playerAsEnemy);
        }

        // Staggered AI controller updates: update 8 AIs per frame (BT + movement)
        const updatesPerFrame = 8;
        for (let i = 0; i < updatesPerFrame; i++) {
            const idx = (this.updateIndex + i) % this.totalAI;

            if (idx < this.teamA.controllers.length) {
                const ctrl = this.teamA.controllers[idx];
                const soldier = this.teamA.soldiers[idx];
                if (soldier.alive) {
                    ctrl.update(dt, teamAEnemies, allA, collidables);
                }
            } else {
                const bIdx = idx - this.teamA.controllers.length;
                const ctrl = this.teamB.controllers[bIdx];
                const soldier = this.teamB.soldiers[bIdx];
                if (soldier.alive) {
                    ctrl.update(dt, teamBEnemies, allB, collidables);
                }
            }
        }
        this.updateIndex = (this.updateIndex + updatesPerFrame) % this.totalAI;

        // Continuous updates for ALL AIs every frame (aiming + shooting)
        for (const ctrl of this.teamA.controllers) ctrl.updateContinuous(dt);
        for (const ctrl of this.teamB.controllers) ctrl.updateContinuous(dt);

        // Update all soldiers base (health regen, mesh sync) — AFTER movement
        // so mesh position matches body position for spectator camera
        for (const s of allA) s.update(dt);
        for (const s of allB) s.update(dt);

        // Respawn dead soldiers
        this._handleRespawns(allA, 'teamA');
        this._handleRespawns(allB, 'teamB');
    }

    /**
     * Snap a spawn point to the nearest walkable NavGrid cell.
     * Returns the corrected Vector3, or the original if no NavGrid.
     */
    /**
     * Search outward from a grid cell for a safe spawn cell.
     * Returns {x, y, z} or null if nothing found within radius.
     */
    _findSafeCell(centerX, centerZ, threatMap, searchRadius = 30, teamIntel = null) {
        if (!this._navGrid) return null;
        const nav = this._navGrid;
        const g = nav.worldToGrid(centerX, centerZ);
        const maxThreat = 0.3;
        const intelMinDist = 30; // reject cells within 30m of any intel contact

        const _isSafe = (wx, wz, h) => {
            if (h < 0.3) return false;
            if (threatMap.getThreat(wx, wz) >= maxThreat) return false;
            if (teamIntel) {
                for (const contact of teamIntel.contacts.values()) {
                    const dx = wx - contact.lastSeenPos.x;
                    const dz = wz - contact.lastSeenPos.z;
                    if (dx * dx + dz * dz < intelMinDist * intelMinDist) return false;
                }
            }
            return true;
        };

        // Check center first
        if (nav.isWalkable(g.col, g.row)) {
            const h = this.getHeightAt(centerX, centerZ);
            if (_isSafe(centerX, centerZ, h)) {
                return { x: centerX, y: h, z: centerZ };
            }
        }
        // Spiral outward
        for (let r = 1; r <= searchRadius; r++) {
            for (let dr = -r; dr <= r; dr++) {
                for (let dc = -r; dc <= r; dc++) {
                    if (Math.abs(dr) !== r && Math.abs(dc) !== r) continue;
                    const nc = g.col + dc, nr = g.row + dr;
                    if (!nav.isWalkable(nc, nr)) continue;
                    const w = nav.gridToWorld(nc, nr);
                    const h = this.getHeightAt(w.x, w.z);
                    if (_isSafe(w.x, w.z, h)) {
                        return { x: w.x, y: h, z: w.z };
                    }
                }
            }
        }
        return null;
    }

    /**
     * Find a safe spawn point for a given team (used by player respawn).
     * Same logic as COM respawn: anchors → safe cell → random fallback.
     * @param {string} team
     * @returns {THREE.Vector3|null}
     */
    findSafeSpawn(team) {
        const spawnFlag = team === 'teamA' ? this.flags[0] : this.flags[this.flags.length - 1];
        const threatMap = team === 'teamA' ? this.threatMapA : this.threatMapB;
        const intel = team === 'teamA' ? this.intelA : this.intelB;
        const teamData = team === 'teamA' ? this.teamA : this.teamB;

        const anchors = [];
        const basePos = spawnFlag.position;
        const now = performance.now();

        // Owned flags (most forward first)
        const ownedFlags = this.flags
            .filter(f => f.owner === team)
            .sort((a, b) => b.position.distanceTo(basePos) - a.position.distanceTo(basePos));
        for (const flag of ownedFlags) anchors.push(flag.position);

        // Safe allies
        for (const ally of teamData.soldiers) {
            if (!ally.alive) continue;
            const allyPos = ally.getPosition();
            if (threatMap.getThreat(allyPos.x, allyPos.z) >= 0.3) continue;
            if (now - ally.lastDamagedTime < 10000) continue;
            anchors.push(allyPos);
        }

        // Try each anchor
        for (const anchor of anchors) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 5 + Math.random() * 5;
            const cx = anchor.x + Math.cos(angle) * dist;
            const cz = anchor.z + Math.sin(angle) * dist;
            const safe = this._findSafeCell(cx, cz, threatMap, 20, intel);
            if (safe) return new THREE.Vector3(safe.x, safe.y, safe.z);
        }

        // Random safe spot
        if (this._navGrid) {
            for (let attempt = 0; attempt < 10; attempt++) {
                const rx = (Math.random() - 0.5) * this._navGrid.width;
                const rz = (Math.random() - 0.5) * this._navGrid.depth;
                const safe = this._findSafeCell(rx, rz, threatMap, 15, intel);
                if (safe) return new THREE.Vector3(safe.x, safe.y, safe.z);
            }
        }

        // Last resort: base flag area
        const angle = Math.random() * Math.PI * 2;
        const dist = 10 + Math.random() * 5;
        const x = spawnFlag.position.x + Math.cos(angle) * dist;
        const z = spawnFlag.position.z + Math.sin(angle) * dist;
        const y = this.getHeightAt(x, z);
        return new THREE.Vector3(x, Math.max(y, 1), z);
    }

    _handleRespawns(soldiers, team) {
        const spawnFlag = team === 'teamA' ? this.flags[0] : this.flags[this.flags.length - 1];
        const threatMap = team === 'teamA' ? this.threatMapA : this.threatMapB;
        const intel = team === 'teamA' ? this.intelA : this.intelB;
        const teamData = team === 'teamA' ? this.teamA : this.teamB;

        for (const soldier of soldiers) {
            if (!soldier.canRespawn()) continue;

            // Collect anchors: owned flags + safe allies
            const anchors = [];
            const basePos = spawnFlag.position;
            const now = performance.now();

            // Owned flags (sorted by distance from base — most forward first)
            const ownedFlags = this.flags
                .filter(f => f.owner === team)
                .sort((a, b) => b.position.distanceTo(basePos) - a.position.distanceTo(basePos));
            for (const flag of ownedFlags) {
                anchors.push(flag.position);
            }

            // Safe allies
            for (const ally of teamData.soldiers) {
                if (!ally.alive || ally === soldier) continue;
                const allyPos = ally.getPosition();
                if (threatMap.getThreat(allyPos.x, allyPos.z) >= 0.3) continue;
                if (now - ally.lastDamagedTime < 10000) continue;
                anchors.push(allyPos);
            }

            let spawnPoint = null;

            // ── Try each anchor: find safe cell nearby ──
            for (const anchor of anchors) {
                const angle = Math.random() * Math.PI * 2;
                const dist = 5 + Math.random() * 5; // 5-10m offset
                const cx = anchor.x + Math.cos(angle) * dist;
                const cz = anchor.z + Math.sin(angle) * dist;
                const safe = this._findSafeCell(cx, cz, threatMap, 20, intel);
                if (safe) {
                    spawnPoint = new THREE.Vector3(safe.x, safe.y, safe.z);
                    break;
                }
            }

            // ── No flag, no ally — random safe spot on map ──
            if (!spawnPoint) {
                for (let attempt = 0; attempt < 10; attempt++) {
                    const rx = (Math.random() - 0.5) * this._navGrid.width;
                    const rz = (Math.random() - 0.5) * this._navGrid.depth;
                    const safe = this._findSafeCell(rx, rz, threatMap, 15, intel);
                    if (safe) {
                        spawnPoint = new THREE.Vector3(safe.x, safe.y, safe.z);
                        break;
                    }
                }
            }

            // Still nothing — skip this frame, try next frame
            if (!spawnPoint) continue;

            soldier.respawn(spawnPoint);
            if (soldier.controller) soldier.controller.onRespawn();
        }
    }
}
