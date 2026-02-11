import * as THREE from 'three';
import { Soldier } from '../entities/Soldier.js';
import { AIController } from './AIController.js';
import { SquadTemplates } from './Personality.js';
import { TeamIntel } from './TeamIntel.js';
import { SquadCoordinator } from './SquadCoordinator.js';
import { ThreatMap } from './ThreatMap.js';

/**
 * Manages all AI soldiers for both teams.
 * Creates 12 COMs per team (4 squads × 3), assigns personalities.
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

                // Spawn near team's base flag
                const angle = Math.random() * Math.PI * 2;
                const dist = 5 + Math.random() * 10;
                const sx = spawnFlag.position.x + Math.cos(angle) * dist;
                const sz = spawnFlag.position.z + Math.sin(angle) * dist;
                const sy = this.getHeightAt(sx, sz) + 2;
                soldier.body.position.set(sx, sy, sz);

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
                squad.name, squadControllers, teamIntel, this.flags, team
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
    setNavGrid(grid, heightGrid) {
        for (const ctrl of [...this.teamA.controllers, ...this.teamB.controllers]) {
            ctrl.navGrid = grid;
        }
        // Share navGrid with threat maps for LOS checks
        this.threatMapA.navGrid = grid;
        this.threatMapB.navGrid = grid;
        this._navGrid = grid;
        // Use prebuilt height grid or compute on main thread
        if (heightGrid) {
            this.threatMapA.heightGrid = heightGrid;
            this.threatMapB.heightGrid = heightGrid;
        } else {
            this.threatMapA.buildHeightGrid(this.getHeightAt);
            this.threatMapB.buildHeightGrid(this.getHeightAt);
        }
    }

    // Keep setter for backward compatibility
    set navGrid(grid) {
        this.setNavGrid(grid, null);
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
        const data = team === 'teamA' ? this.teamA : this.teamB;
        return data.soldiers.filter(s => s.alive).map(s => s.getPosition());
    }

    /**
     * Get all collidable meshes (soldier bodies for hitscan).
     */
    getAllSoldierMeshes() {
        const meshes = [];
        for (const s of [...this.teamA.soldiers, ...this.teamB.soldiers]) {
            if (s.alive) meshes.push(s.mesh);
        }
        return meshes;
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

        // Update squad coordinators
        for (const squad of this.teamA.squads) squad.update(dt);
        for (const squad of this.teamB.squads) squad.update(dt);

        // Add player to appropriate enemy list
        const playerAsEnemy = this.player && this.player.alive && this.player.team
            ? {
                alive: this.player.alive,
                hp: this.player.hp,
                maxHP: this.player.maxHP,
                mesh: this.player.mesh,
                headMesh: null,
                body: this.player.body,
                getPosition: () => this.player.getPosition(),
                takeDamage: (amt, from, hs) => this.player.takeDamage(amt, from, hs),
            }
            : null;

        // Build enemy/ally lists
        const teamAEnemies = [...allB];
        const teamBEnemies = [...allA];
        if (playerAsEnemy && this.player.team === 'teamA') {
            teamBEnemies.push(playerAsEnemy);
        } else if (playerAsEnemy && this.player.team === 'teamB') {
            teamAEnemies.push(playerAsEnemy);
        }

        // Update all soldiers base (health regen, mesh sync)
        for (const s of [...allA, ...allB]) {
            s.update(dt);
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

        // Respawn dead soldiers
        this._handleRespawns(allA, 'teamA');
        this._handleRespawns(allB, 'teamB');
    }

    _handleRespawns(soldiers, team) {
        const spawnFlag = team === 'teamA' ? this.flags[0] : this.flags[this.flags.length - 1];
        const threatMap = team === 'teamA' ? this.threatMapA : this.threatMapB;
        const teamData = team === 'teamA' ? this.teamA : this.teamB;

        for (const soldier of soldiers) {
            if (!soldier.canRespawn()) continue;

            // Find the most forward owned flag (for fallback)
            let forwardFlagPos = spawnFlag.position.clone();
            const basePos = spawnFlag.position;
            let bestDist = 0;
            for (const flag of this.flags) {
                if (flag.owner === team) {
                    const d = flag.position.distanceTo(basePos);
                    if (d > bestDist) {
                        bestDist = d;
                        forwardFlagPos = flag.position.clone();
                    }
                }
            }

            let spawnPoint = null;

            // ── Priority 1: Safe teammate spawn ──
            const now = performance.now();
            const allySoldiers = teamData.soldiers;
            let bestAlly = null;
            let bestAllyFrontDist = -1;

            for (const ally of allySoldiers) {
                if (!ally.alive || ally === soldier) continue;
                const allyPos = ally.getPosition();
                // Must be in low-threat area
                const threat = threatMap.getThreat(allyPos.x, allyPos.z);
                if (threat >= 0.3) continue;
                // Must not have been damaged in last 10 seconds
                if (now - ally.lastDamagedTime < 10000) continue;
                // Prefer allies closer to front line (farther from base)
                const frontDist = allyPos.distanceTo(basePos);
                if (frontDist > bestAllyFrontDist) {
                    bestAllyFrontDist = frontDist;
                    bestAlly = ally;
                }
            }

            if (bestAlly) {
                const allyPos = bestAlly.getPosition();
                const angle = Math.random() * Math.PI * 2;
                const dist = 5 + Math.random() * 3; // 5-8m
                spawnPoint = new THREE.Vector3(
                    allyPos.x + Math.cos(angle) * dist,
                    0,
                    allyPos.z + Math.sin(angle) * dist
                );
                spawnPoint.y = this.getHeightAt(spawnPoint.x, spawnPoint.z);
            }

            // ── Priority 2: ThreatMap safe zone near flag ──
            if (!spawnPoint) {
                const safePos = threatMap.findSafePosition(forwardFlagPos, 30);
                if (safePos) {
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 3 + Math.random() * 2; // 3-5m
                    spawnPoint = new THREE.Vector3(
                        safePos.x + Math.cos(angle) * dist,
                        0,
                        safePos.z + Math.sin(angle) * dist
                    );
                    spawnPoint.y = this.getHeightAt(spawnPoint.x, spawnPoint.z);
                }
            }

            // ── Priority 3: Fallback — farther from flag center (15-25m) ──
            if (!spawnPoint) {
                const angle = Math.random() * Math.PI * 2;
                const dist = 15 + Math.random() * 10; // 15-25m
                spawnPoint = new THREE.Vector3(
                    forwardFlagPos.x + Math.cos(angle) * dist,
                    0,
                    forwardFlagPos.z + Math.sin(angle) * dist
                );
                spawnPoint.y = this.getHeightAt(spawnPoint.x, spawnPoint.z);
            }

            soldier.respawn(new THREE.Vector3(spawnPoint.x, Math.max(spawnPoint.y, 1), spawnPoint.z));
        }
    }
}
