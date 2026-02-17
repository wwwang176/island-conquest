import * as THREE from 'three';
import { BTState, Selector, Sequence, Condition, Action } from './BehaviorTree.js';
import { PersonalityTypes } from './Personality.js';
import { findFlankPosition, computePreAimPoint, computeSuppressionTarget, findRidgelineAimPoint } from './TacticalActions.js';
import { WeaponDefs, GunAnim } from '../entities/WeaponDefs.js';

const _grenadeOrigin = new THREE.Vector3();
const _grenadeDir = new THREE.Vector3();

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _target = new THREE.Vector3();
const _strafeDir = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();
const _targetMeshes = [];

const EYE_HEIGHT = 1.5;
const HEAD_TOP_HEIGHT = 1.7;

/** Bresenham walk: returns true if ray from eyeY0 to targetY1 is unblocked. */
function _bresenhamClear(tm, c0, r0, eyeY0, c1, r1, targetY1) {
    let nc = c0, nr = r0;
    const dc = Math.abs(c1 - c0), dr = Math.abs(r1 - r0);
    const sc = c0 < c1 ? 1 : -1, sr = r0 < r1 ? 1 : -1;
    let err = dc - dr;
    const totalSteps = Math.max(dc, dr);
    let step = 0;
    while (true) {
        if (!(nc === c0 && nr === r0)) {
            if (totalSteps > 0) {
                const t = step / totalSteps;
                const expectedY = eyeY0 + (targetY1 - eyeY0) * t;
                const cellY = tm.heightGrid[nr * tm.cols + nc];
                if (cellY > expectedY) return false;
            }
        }
        if (nc === c1 && nr === r1) return true;
        step++;
        const e2 = 2 * err;
        if (e2 > -dr) { err -= dr; nc += sc; }
        if (e2 < dc) { err += dc; nr += sr; }
    }
}

/**
 * Grid-based Bresenham LOS check using ThreatMap heightGrid.
 * Dual-ray: first eye→eye, if blocked try eye→head-top.
 * Returns: 0 = not visible, 1 = body visible, 2 = head-only visible.
 */
function _hasGridLOS(tm, c0, r0, eyeY0, c1, r1) {
    const baseY1 = tm.heightGrid[r1 * tm.cols + c1];
    if (_bresenhamClear(tm, c0, r0, eyeY0, c1, r1, baseY1 + EYE_HEIGHT)) return 1;
    if (_bresenhamClear(tm, c0, r0, eyeY0, c1, r1, baseY1 + HEAD_TOP_HEIGHT)) return 2;
    return 0;
}

/** Lerp between two angles handling wraparound. */
function _lerpAngle(a, b, t) {
    let diff = b - a;
    // Wrap to [-PI, PI]
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
}

/**
 * AI Controller for a single COM soldier.
 * Manages behavior tree, movement, aiming, shooting, and tactical decisions.
 */
export class AIController {
    static debugArcs = false;
    static showTacLabels = false;

    constructor(soldier, personality, team, flags, getHeightAt, coverSystem, teamIntel, eventBus) {
        this.soldier = soldier;
        soldier.controller = this;
        this.personality = PersonalityTypes[personality] || PersonalityTypes.SUPPORT;
        this.team = team;
        this.flags = flags;
        this.getHeightAt = getHeightAt;
        this.coverSystem = coverSystem || null;
        this.teamIntel = teamIntel || null;
        this.eventBus = eventBus || null;

        // Squad (set externally by AIManager)
        this.squad = null;
        this.flankSide = 1;

        // Target management
        this.targetEnemy = null;
        this._targetLOSLevel = 1; // 1=body visible, 2=head-only
        this.targetFlag = null;
        this.moveTarget = null;

        // Suppression state (set by SquadCoordinator)
        this.suppressionTarget = null;  // TeamIntel contact
        this.suppressionTimer = 0;
        this._suppressBlockedCount = 0; // consecutive frames where own cover blocks fire

        // Tactical state (set by SquadCoordinator)
        this.fallbackTarget = null;   // Vector3 | null
        this.rushTarget = null;        // Vector3 | null
        this.rushReady = false;
        this.crossfirePos = null;      // Vector3 | null

        // Tactical label sprite (above head)
        this._tacLabel = null;
        this._tacLabelText = '';

        // Mission pressure: 0.0 capturing, 0.5 moving, 1.0 idle
        this.missionPressure = 0.5;

        // Aim state
        this.aimPoint = new THREE.Vector3();
        this.aimOffset = new THREE.Vector3();
        this._preAimActive = false;
        this.reactionTimer = 0;
        this.hasReacted = false;
        this.aimCorrectionSpeed = 2 + this.personality.aimSkill * 3;

        // Weapon definition — personality-weighted random
        this.weaponId = this._pickWeapon();
        const def = WeaponDefs[this.weaponId];
        this.weaponDef = def;
        this.soldier.setWeaponModel(this.weaponId);

        // Firing state
        this.fireTimer = 0;
        this.fireInterval = 60 / def.fireRate;
        this.burstCount = 0;
        this.burstMax = this.weaponId === 'BOLT' ? 1
            : this.weaponId === 'LMG'
                ? 20 + Math.floor(Math.random() * 10)
                : 8 + Math.floor(Math.random() * 8);
        this.burstCooldown = 0;

        // Bolt-action state
        this.boltTimer = 0;
        this._boltAimTimer = 0;
        this._lastAimTarget = null; // track target changes for aim delay reset
        this.isScoped = false;      // visual scope state (for spectator)

        // Magazine / reload
        this.magazineSize = def.magazineSize;
        this.currentAmmo = def.magazineSize;
        this.isReloading = false;
        this.reloadTimer = 0;
        this.reloadTime = def.reloadTime;

        // Spread state (dynamic, same model as Player)
        this.baseSpread = def.baseSpread;
        this.maxSpread = def.maxSpread;
        this.spreadIncreasePerShot = def.spreadIncreasePerShot;
        this.spreadRecoveryRate = def.spreadRecoveryRate;
        this.currentSpread = def.baseSpread;

        // Movement
        this.moveSpeed = 4.125 * (def.moveSpeedMult || 1.0);
        this.moveDir = new THREE.Vector3();
        this.facingDir = new THREE.Vector3(0, 0, -1);
        this.avoidDir = new THREE.Vector3();
        this.stuckTimer = 0;
        this.lastPos = new THREE.Vector3();
        this.jumpVelY = 0;      // manual Y velocity for kinematic jumping
        this.isJumping = false;
        this._velX = 0;         // movement inertia
        this._velZ = 0;

        // Reflex dodge — immediate lateral movement when first targeted
        this._reflexDodgeTimer = 0;
        this._reflexDodgeDirX = 0;
        this._reflexDodgeDirZ = 0;
        this._prevTargetedByCount = 0;

        // Combat strafe — random interval direction changes
        this._strafeTimer = 0;
        this._strafeInterval = 0.4 + Math.random() * 0.4;
        this._strafeSide = Math.random() > 0.5 ? 1 : -1;

        // ThreatMap (set by AIManager)
        this.threatMap = null;
        // Pathfinding
        this.navGrid = null;         // set by AIManager
        this.currentPath = [];       // [{x, z}, ...]
        this.pathIndex = 0;
        this._pathCooldown = Math.random() * 0.5; // stagger initial A* across COMs
        this._lastRiskLevel = 0;     // for detecting risk spikes (under attack)
        this._noPathFound = false;   // true when A* fails — blocks direct movement

        // Tactical state
        this.riskLevel = 0;
        this.riskTimer = 0;
        this.seekingCover = false;
        this.coverTarget = null;
        this.occupiedCover = null; // actual cover object from CoverSystem

        // Previously seen enemies (for intel lost reporting)
        this._previouslyVisible = new Set();
        this._visSetA = new Set();
        this._visSetB = new Set();
        this._useSetA = true;

        // Behavior tree update throttle
        this.btTimer = 0;
        this.btInterval = 0.15 + Math.random() * 0.1;

        // Threat scan throttle (independent of BT, runs in updateContinuous)
        this._scanTimer = Math.random() * 0.05; // stagger initial scans
        this._targetSwitchCooldown = 0;
        this._preAimContact = null;
        this._preAimCooldown = 0;

        // Grenade state
        this.grenadeCount = WeaponDefs.GRENADE.maxPerLife;
        this.grenadeCooldown = 0;
        this._engageTimer = 0;        // time engaging same enemy
        this._lastEngageEnemy = null;  // track which enemy we're timing
        this._grenadeTargetPos = null; // set by _shouldThrowGrenade, used by _actionThrowGrenade
        this._grenadeThrowTimer = 0;   // visual look-up timer after throwing
        this._grenadeThrowPitch = 0;   // pitch angle to look at during throw
        this.grenadeManager = null;    // set by AIManager

        // Flag deficit (positive = behind, set by AIManager each frame)
        this.flagDeficit = 0;

        // Build behavior tree
        this.behaviorTree = this._buildBehaviorTree();
    }

    /**
     * Pick weapon based on personality weights.
     * Sniper: 60% BOLT, 20% AR, 20% SMG.
     * Support/Defender: 60% LMG, 20% AR, 20% SMG.
     * Others: 5% BOLT, 10% LMG, 42.5% AR, 42.5% SMG.
     */
    _pickWeapon() {
        const role = this.personality.name;
        const r = Math.random();
        if (role === 'Sniper') {
            if (r < 0.6) return 'BOLT';
            if (r < 0.8) return 'AR15';
            return 'SMG';
        }
        if (role === 'Support' || role === 'Defender') {
            if (r < 0.6) return 'LMG';
            if (r < 0.8) return 'AR15';
            return 'SMG';
        }
        if (r < 0.05) return 'BOLT';
        if (r < 0.15) return 'LMG';
        if (r < 0.575) return 'AR15';
        return 'SMG';
    }

    _buildBehaviorTree() {
        const ctx = this;
        return new Selector([
            // 1. Dead — wait for respawn
            new Sequence([
                new Condition(() => !ctx.soldier.alive),
                new Action(() => BTState.SUCCESS),
            ]),

            // 2. Reloading with nearby threats — seek cover
            new Sequence([
                new Condition(() => {
                    if (!ctx.isReloading) return false;
                    if (!ctx.teamIntel) return false;
                    const pos = ctx.soldier.getPosition();
                    for (const contact of ctx.teamIntel.contacts.values()) {
                        if (pos.distanceTo(contact.lastSeenPos) < ctx.weaponDef.maxRange) return true;
                    }
                    return false;
                }),
                new Action(() => ctx._actionSeekCover()),
            ]),

            // 3. Under heavy threat — seek cover (threshold raised during rush or underdog)
            new Sequence([
                new Condition(() => {
                    const rushing = ctx.rushTarget && ctx.squad && ctx.squad.rushActive;
                    let threshold = ctx.personality.riskThreshold;
                    if (rushing) threshold = 0.95;
                    else if (ctx.flagDeficit >= 2) threshold = Math.min(threshold + 0.15, 0.9);
                    return ctx.riskLevel > threshold;
                }),
                new Action(() => ctx._actionSeekCover()),
            ]),

            // 4. Spatial threat — seek cover (skipped during active rush)
            new Sequence([
                new Condition(() => {
                    if (ctx.rushTarget && ctx.squad && ctx.squad.rushActive) return false;
                    if (!ctx.threatMap) return false;
                    const pos = ctx.soldier.getPosition();
                    const threat = ctx.threatMap.getThreat(pos.x, pos.z);
                    return threat > ctx.personality.spatialCaution;
                }),
                new Action(() => ctx._actionSeekCover()),
            ]),

            // ── Squad tactics (mutually exclusive via SquadCoordinator) ──

            // 5. Fallback — retreat to friendly flag
            new Sequence([
                new Condition(() => ctx.fallbackTarget !== null),
                new Action(() => ctx._actionFallback()),
            ]),

            // 6. Rush — coordinated assault on flag
            new Sequence([
                new Condition(() => ctx.rushTarget !== null),
                new Action(() => ctx._actionRush()),
            ]),

            // 7. Suppression fire
            new Sequence([
                new Condition(() => ctx.suppressionTarget !== null && ctx.suppressionTimer > 0),
                new Action(() => ctx._actionSuppress()),
            ]),

            // 8. Crossfire — spread to flanking positions
            new Sequence([
                new Condition(() => ctx.crossfirePos !== null),
                new Action(() => ctx._actionCrossfire()),
            ]),

            // ── Individual combat ──

            // 9. Throw grenade (checked before engage so it can interrupt close combat)
            new Sequence([
                new Condition(() => ctx.grenadeCount > 0 && ctx.grenadeCooldown <= 0),
                new Condition(() => ctx._shouldThrowGrenade()),
                new Action(() => ctx._actionThrowGrenade()),
            ]),

            // 9.5. Close-range enemy (< 20m) — must engage
            new Sequence([
                new Condition(() => ctx.targetEnemy !== null && ctx._enemyDist() < 20),
                new Action(() => ctx._actionEngage()),
            ]),

            // 10. Uncaptured flag exists — go capture (flanking is part of approach)
            new Sequence([
                new Condition(() => ctx.targetFlag !== null && ctx.targetFlag.owner !== ctx.team),
                new Action(() => ctx._actionCaptureFlag()),
            ]),

            // 11. Investigate intel contact (nearby suspected enemy, no direct visual)
            new Sequence([
                new Condition(() => ctx.targetEnemy === null && ctx._hasNearbyIntelContact()),
                new Action(() => ctx._actionInvestigate()),
            ]),

            // 12. Has visible enemy (long range) — engage
            new Sequence([
                new Condition(() => ctx.targetEnemy !== null),
                new Action(() => ctx._actionEngage()),
            ]),

            // 13. Has owned flag target — defend / patrol near it
            new Sequence([
                new Condition(() => ctx.targetFlag !== null),
                new Action(() => ctx._actionCaptureFlag()),
            ]),

            // 14. Default — find something to do
            new Action(() => ctx._actionPatrol()),
        ]);
    }

    /**
     * Staggered update — called for a subset of AIs each frame.
     * Handles BT decisions, threat scanning, movement.
     */
    update(dt, enemies, allies, collidables) {
        this._dt = dt; // store for BT actions that need delta time
        if (!this.soldier.alive) return;

        this.enemies = enemies;
        this.allies = allies;
        this.collidables = collidables;

        // Decay suppression timer
        if (this.suppressionTimer > 0) {
            this.suppressionTimer -= dt;
            if (this.suppressionTimer <= 0) {
                this.suppressionTarget = null;
            }
        }

        // Behavior tree (throttled) — threat scan moved to updateContinuous
        // Skip BT during grenade throw so aimPoint stays on the throw arc
        this.btTimer += dt;
        if (this._grenadeThrowTimer > 0) return;
        if (this.btTimer >= this.btInterval) {
            this.btTimer = 0;
            this._updateRisk(dt);
            this._chooseFlagTarget();
            this.behaviorTree.tick(this);
        }

        // Movement + visual moved to updateContinuous for smooth motion
    }

    /**
     * Centralized target setter — maintains targetedByCount on soldiers.
     */
    _setTargetEnemy(enemy) {
        if (this.targetEnemy === enemy) return;
        if (this.targetEnemy) this.targetEnemy.targetedByCount--;
        this.targetEnemy = enemy;
        if (enemy) enemy.targetedByCount++;
    }

    /**
     * Called by Soldier.takeDamage() — force immediate BT re-tick next frame
     * so the COM reacts to being hit without waiting 150-550ms.
     */
    onDamaged() {
        this.btTimer = this.btInterval; // triggers BT on next update()
        // Clear current path so cover-seek recalculates from current position
        if (!this.seekingCover) {
            this.currentPath = [];
            this.pathIndex = 0;
            this._pathCooldown *= 0.5;
        }
    }

    /**
     * Continuous update — called EVERY frame for ALL alive AIs.
     * Handles aiming + shooting so fire rate is not throttled by stagger.
     */
    updateContinuous(dt) {
        if (!this.soldier.alive) {
            if (this._tacLabel && this._tacLabel.visible) {
                this._tacLabel.visible = false;
                this._tacLabelText = '';
            }
            return;
        }

        // Target switch cooldowns
        if (this._targetSwitchCooldown > 0) this._targetSwitchCooldown -= dt;
        if (this._preAimCooldown > 0) this._preAimCooldown -= dt;

        // Threat scan — 50ms throttle, independent of BT stagger
        this._scanTimer += dt;
        if (this._scanTimer >= 0.05) {
            this._scanTimer = 0;
            this._updateThreatScan();
        }

        // Decay path cooldown
        if (this._pathCooldown > 0) this._pathCooldown -= dt;

        // Decay grenade cooldown
        if (this.grenadeCooldown > 0) this.grenadeCooldown -= dt;
        if (this._grenadeThrowTimer > 0) this._grenadeThrowTimer -= dt;

        // Track engage timer (how long fighting the same enemy)
        if (this.targetEnemy && this.targetEnemy.alive && this.hasReacted) {
            if (this.targetEnemy === this._lastEngageEnemy) {
                this._engageTimer += dt;
            } else {
                this._lastEngageEnemy = this.targetEnemy;
                this._engageTimer = 0;
            }
        } else {
            this._engageTimer = 0;
            this._lastEngageEnemy = null;
        }

        // Detect risk spike (under attack) → force path recompute
        if (this.riskLevel > this._lastRiskLevel + 0.15 && this._pathCooldown <= 0) {
            this.currentPath = [];
            this.pathIndex = 0;
            this._pathCooldown = 0;
        }
        this._lastRiskLevel = this.riskLevel;

        // Being targeted by enemy — force BT re-tick to seek cover
        if (this.soldier.targetedByCount > 0 && !this.occupiedCover && !this.seekingCover) {
            this.btTimer = this.btInterval;
        }

        // Reflex dodge: first frame being targeted → pick best dodge direction
        const targeted = this.soldier.targetedByCount;
        if (targeted > 0 && this._prevTargetedByCount === 0 && !this.occupiedCover) {
            const myPos = this.soldier.getPosition();
            if (this.targetEnemy && this.targetEnemy.alive) {
                const ePos = this.targetEnemy.getPosition();
                const toEX = ePos.x - myPos.x;
                const toEZ = ePos.z - myPos.z;
                const eLen = Math.sqrt(toEX * toEX + toEZ * toEZ);
                const nX = eLen > 0.001 ? toEX / eLen : 0;
                const nZ = eLen > 0.001 ? toEZ / eLen : 1;

                // Three candidates: left, right, backward
                const candidates = [
                    { x:  nZ, z: -nX },  // left perpendicular
                    { x: -nZ, z:  nX },  // right perpendicular
                    { x: -nX, z: -nZ },  // backward (away from enemy)
                ];

                // Pick safest direction via ThreatMap, fallback to random
                const checkDist = 3;
                let bestDir = candidates[Math.floor(Math.random() * 3)];
                if (this.threatMap) {
                    let bestThreat = Infinity;
                    for (const c of candidates) {
                        const t = this.threatMap.getThreat(
                            myPos.x + c.x * checkDist, myPos.z + c.z * checkDist);
                        if (t < bestThreat) { bestThreat = t; bestDir = c; }
                    }
                }
                this._reflexDodgeDirX = bestDir.x;
                this._reflexDodgeDirZ = bestDir.z;
            } else {
                // No known enemy — random direction
                const angle = Math.random() * Math.PI * 2;
                this._reflexDodgeDirX = Math.cos(angle);
                this._reflexDodgeDirZ = Math.sin(angle);
            }
            this._reflexDodgeTimer = 0.4;
        }
        this._prevTargetedByCount = targeted;

        // Decay reflex dodge timer
        if (this._reflexDodgeTimer > 0) this._reflexDodgeTimer -= dt;

        this._updateMovement(dt);
        this._updateSoldierVisual(dt);
        this._updateDebugArc();
        this._updateAiming(dt);
        this._updateShooting(dt);
    }

    // ───── Threat Scanning ─────

    _updateThreatScan() {
        const myPos = this.soldier.getPosition();
        let closestDist = Infinity;
        let closestEnemy = null;
        const currentlyVisible = this._useSetA ? this._visSetA : this._visSetB;
        currentlyVisible.clear();

        // Pre-compute grid coordinates for Bresenham LOS
        const tm = this.threatMap;
        const useGridLOS = tm && tm.heightGrid;
        let myGrid, myEyeY;
        if (useGridLOS) {
            myGrid = tm._worldToGrid(myPos.x, myPos.z);
            myEyeY = tm.heightGrid[myGrid.row * tm.cols + myGrid.col] + EYE_HEIGHT;
        }

        for (const enemy of this.enemies) {
            if (!enemy.alive) continue;
            const ePos = enemy.getPosition();
            const dist = myPos.distanceTo(ePos);

            if (dist > 80) continue; // max vision range

            // FOV check (120°)
            _v1.subVectors(ePos, myPos).normalize();
            const dot = this.facingDir.dot(_v1);
            if (dot < -0.2) continue; // behind us (~120° FOV)

            // Line of sight check — use fast grid Bresenham instead of raycaster
            let losLevel = 1; // default: fully visible (no grid LOS available)
            if (useGridLOS) {
                const eGrid = tm._worldToGrid(ePos.x, ePos.z);
                losLevel = _hasGridLOS(tm, myGrid.col, myGrid.row, myEyeY, eGrid.col, eGrid.row);
                if (losLevel === 0) continue;
            }

            currentlyVisible.add(enemy);

            // Report sighting to TeamIntel
            if (this.teamIntel) {
                this.teamIntel.reportSighting(enemy, ePos, enemy.body.velocity);
            }

            if (dist < closestDist) {
                closestDist = dist;
                closestEnemy = enemy;
                this._targetLOSLevel = losLevel;
            }
        }

        // Report lost contacts to TeamIntel
        if (this.teamIntel) {
            for (const prev of this._previouslyVisible) {
                if (!currentlyVisible.has(prev)) {
                    this.teamIntel.reportLost(prev);
                }
            }
        }
        const prevVisible = this._previouslyVisible;
        this._previouslyVisible = currentlyVisible;
        this._useSetA = !this._useSetA;

        // Target switching with stickiness
        if (closestEnemy) {
            if (this.targetEnemy !== closestEnemy) {
                const isNewThreat = !prevVisible.has(closestEnemy);
                const currentLost = !this.targetEnemy || !this.targetEnemy.alive
                    || !currentlyVisible.has(this.targetEnemy);
                const canSwitch = isNewThreat || currentLost
                    || this._targetSwitchCooldown <= 0;

                if (canSwitch) {
                    this._setTargetEnemy(closestEnemy);
                    this.hasReacted = false;
                    this._targetSwitchCooldown = 0.4;
                    // Per-personality distance curve: lerp(nearReaction, farReaction, t)
                    const t = Math.max(0, Math.min(1, closestDist / 60));
                    const p = this.personality;
                    const distFactor = p.nearReaction + (p.farReaction - p.nearReaction) * t;
                    // Exposure penalty: head-only target is harder to identify
                    const losFactor = losLevel === 2 ? 1.4 : 1.0;
                    this.reactionTimer = p.reactionTime / 1000 * distFactor * losFactor +
                        (Math.random() * 0.15);
                    // Initial aim offset — smaller at close range (target fills FOV)
                    const aimSpread = Math.max(0.3, Math.min(1.0, closestDist / 25));
                    this.aimOffset.set(
                        (Math.random() - 0.5) * 2 * aimSpread,
                        (Math.random() - 0.5) * 1.5 * aimSpread,
                        (Math.random() - 0.5) * 2 * aimSpread
                    );
                }
            }
        } else {
            // Lost all visual targets — hand off to intel pre-aim
            if (this.targetEnemy && this.teamIntel) {
                const contact = this.teamIntel.contacts.get(this.targetEnemy);
                if (contact) {
                    this._preAimContact = contact;
                    this._preAimCooldown = 0.5;
                }
            }
            this._targetLOSLevel = 1;
            this._setTargetEnemy(null);
            this.hasReacted = false;
        }
    }

    _updateRisk() {
        const myPos = this.soldier.getPosition();
        let threatScore = 0;
        let nearEnemies = 0;
        let nearAllies = 0;

        // Count directly visible enemies
        for (const e of this.enemies) {
            if (!e.alive) continue;
            const d = myPos.distanceTo(e.getPosition());
            if (d > 60) continue;
            nearEnemies++;
            const distFactor = d < 15 ? 1 : d < 40 ? 0.7 : 0.4;
            threatScore += distFactor;
        }

        // Also count intel contacts for better outnumbered estimate
        if (this.teamIntel) {
            const intelThreats = this.teamIntel.getKnownEnemies({
                minConfidence: 0.6,
                maxDist: 50,
                fromPos: myPos,
            });
            // Only count intel contacts not already counted from direct vision
            for (const contact of intelThreats) {
                if (!this._previouslyVisible.has(contact.enemy)) {
                    nearEnemies += 0.5; // partial weight for non-visual intel
                }
            }
        }

        for (const a of this.allies) {
            if (!a.alive || a === this.soldier) continue;
            if (myPos.distanceTo(a.getPosition()) < 40) nearAllies++;
        }

        const exposure = this.occupiedCover ? 0.3 : 0.7;

        const incomingThreat = Math.min(1, threatScore * 0.35);
        const healthRisk = 1 - this.soldier.hp / this.soldier.maxHP;
        const outnumbered = Math.min(1, Math.max(0, (nearEnemies - nearAllies) / 4));
        const reloadRisk = this.isReloading ? 1.0 : (this.currentAmmo <= 5 ? 0.5 : 0);

        // Spatial threat from ThreatMap: are we standing in enemy LOS?
        const spatialThreat = this.threatMap
            ? Math.min(1, this.threatMap.getThreat(myPos.x, myPos.z))
            : 0;

        this.riskLevel =
            0.15 * exposure +
            0.20 * incomingThreat +
            0.15 * healthRisk +
            0.25 * spatialThreat +
            0.10 * outnumbered +
            0.10 * reloadRisk +
            0.05 * this.missionPressure;
    }

    _chooseFlagTarget() {
        // Defer to squad objective first
        if (this.squad) {
            const squadObj = this.squad.getSquadObjective();
            if (squadObj) {
                this.targetFlag = squadObj;
                return;
            }
        }

        // Fallback: individual flag selection
        const myPos = this.soldier.getPosition();
        let bestScore = -Infinity;
        let bestFlag = null;

        for (const flag of this.flags) {
            let score = 0;
            const dist = myPos.distanceTo(flag.position);

            if (flag.owner !== this.team) {
                score += this.personality.attack * 10;
            } else {
                score += this.personality.defend * 6;
            }

            score -= dist * 0.05;
            score += (Math.random() - 0.5) * 3;

            if (score > bestScore) {
                bestScore = score;
                bestFlag = flag;
            }
        }

        this.targetFlag = bestFlag;
    }

    // ───── Helpers ─────

    _enemyDist() {
        if (!this.targetEnemy || !this.targetEnemy.alive) return Infinity;
        return this.soldier.getPosition().distanceTo(this.targetEnemy.getPosition());
    }

    _hasNearbyIntelContact() {
        if (!this.teamIntel) return false;
        const myPos = this.soldier.getPosition();
        const contacts = this.teamIntel.getKnownEnemies({
            minConfidence: 0.4,
            maxDist: 40,
            fromPos: myPos,
        });
        return contacts.length > 0;
    }

    // ───── Grenade Logic ─────

    _shouldThrowGrenade() {
        if (!this.grenadeManager) return false;

        // Safety: don't throw if nearest enemy is too close (blast would hit self)
        if (this.targetEnemy && this.targetEnemy.alive && this._enemyDist() < 8) return false;

        const myPos = this.soldier.getPosition();

        // Scenario 1: Rush — rushing toward flag
        if (this.rushTarget && this.squad && this.squad.rushActive) {
            const distToFlag = myPos.distanceTo(this.rushTarget);
            if (distToFlag >= 8 && distToFlag <= 40) {
                this._grenadeTargetPos = this.rushTarget;
                return true;
            }
        }

        // Scenario 2: Enemy holding a flag we're attacking
        if (this.targetFlag && this.targetFlag.owner !== this.team && this.targetFlag.owner !== null) {
            const flagPos = this.targetFlag.position;
            const distToFlag = myPos.distanceTo(flagPos);
            if (distToFlag >= 8 && distToFlag <= 45 && this.teamIntel) {
                const threats = this.teamIntel.getKnownEnemies({
                    minConfidence: 0.15,
                    maxDist: 18,
                    fromPos: flagPos,
                });
                if (threats.length > 0) {
                    this._grenadeTargetPos = flagPos;
                    return true;
                }
            }
        }

        // Scenario 3: Visible enemy in range
        if (this.targetEnemy && this.targetEnemy.alive) {
            const dist = this._enemyDist();
            if (dist >= 8 && dist <= 40) {
                this._grenadeTargetPos = this.targetEnemy.getPosition();
                return true;
            }
        }

        // Scenario 4: Multiple enemies clustered — 2+ enemies within blast radius
        if (this.teamIntel) {
            const nearby = this.teamIntel.getKnownEnemies({
                minConfidence: 0.2,
                maxDist: 40,
                fromPos: myPos,
            });
            if (nearby.length >= 2) {
                for (let i = 0; i < nearby.length - 1; i++) {
                    const pi = nearby[i].lastSeenPos;
                    const di = myPos.distanceTo(pi);
                    if (di < 8) continue;
                    for (let j = i + 1; j < nearby.length; j++) {
                        if (pi.distanceTo(nearby[j].lastSeenPos) < 8) {
                            // Aim at midpoint between the clustered enemies
                            this._grenadeTargetPos = pi.clone().add(nearby[j].lastSeenPos).multiplyScalar(0.5);
                            return true;
                        }
                    }
                }
            }
        }

        return false;
    }

    /**
     * Solve ballistic launch for horizDist/dy at fixed speed v.
     * Returns { vHoriz, vy, flightTime }.
     */
    _solveGrenadeBallistic(horizDist, dy, v, fuseTime) {
        const g = 9.8;
        const v2 = v * v;
        const d2 = horizDist * horizDist;
        const disc = v2 * v2 - g * (g * d2 + 2 * dy * v2);

        let vHoriz, vy;
        if (disc >= 0) {
            const sqrtDisc = Math.sqrt(disc);
            const gd = g * horizDist;

            // High-angle solution (preferred — arcs over obstacles)
            const tanHi = (v2 + sqrtDisc) / gd;
            const cosHi = 1 / Math.sqrt(1 + tanHi * tanHi);
            const vHorizHi = v * cosHi;
            const flightTimeHi = horizDist / vHorizHi;

            if (flightTimeHi <= fuseTime) {
                const sinHi = tanHi * cosHi;
                vHoriz = vHorizHi;
                vy = v * sinHi;
            } else {
                const tanLo = (v2 - sqrtDisc) / gd;
                const cosLo = 1 / Math.sqrt(1 + tanLo * tanLo);
                const sinLo = tanLo * cosLo;
                vHoriz = v * cosLo;
                vy = v * sinLo;
            }
        } else {
            // Out of range — throw at 45° (maximum range)
            vHoriz = v * 0.707;
            vy = v * 0.707;
        }
        return { vHoriz, vy, flightTime: horizDist / vHoriz };
    }

    _actionThrowGrenade() {
        const myPos = this.soldier.getPosition();
        const def = WeaponDefs.GRENADE;

        // Use the target decided by _shouldThrowGrenade
        const targetPos = this._grenadeTargetPos;
        if (!targetPos) return BTState.FAILURE;
        this._grenadeTargetPos = null;

        // Face the target before throwing
        _grenadeDir.set(targetPos.x - myPos.x, 0, targetPos.z - myPos.z).normalize();
        this.facingDir.copy(_grenadeDir);

        // Origin: shoulder height
        _grenadeOrigin.set(myPos.x, myPos.y + 1.5, myPos.z);

        // Soldier's horizontal movement velocity
        const vs = this.soldier.lastMoveVelocity;
        const v = def.throwSpeed;
        const dy = (targetPos.y != null ? targetPos.y : myPos.y) - _grenadeOrigin.y;

        // Two-iteration correction for soldier movement velocity.
        // effectiveTarget = realTarget - vs * flightTime
        // Iteration 1: estimate flight time from real distance (45° guess)
        // Iteration 2: re-estimate using actual flight time from ballistic solve
        let effTargetX = targetPos.x;
        let effTargetZ = targetPos.z;

        const realDx = targetPos.x - _grenadeOrigin.x;
        const realDz = targetPos.z - _grenadeOrigin.z;
        const realHorizDist = Math.sqrt(realDx * realDx + realDz * realDz);

        if (realHorizDist > 0.1) {
            // Iteration 1: rough t from 45° assumption
            let t = realHorizDist / (v * 0.707);
            effTargetX = targetPos.x - vs.x * t;
            effTargetZ = targetPos.z - vs.z * t;

            let edx = effTargetX - _grenadeOrigin.x;
            let edz = effTargetZ - _grenadeOrigin.z;
            let effDist = Math.sqrt(edx * edx + edz * edz);
            if (effDist > 0.1) {
                // Iteration 2: solve ballistics for iteration-1 distance, get real flight time
                const sol = this._solveGrenadeBallistic(effDist, dy, v, def.fuseTime);
                t = sol.flightTime;
                effTargetX = targetPos.x - vs.x * t;
                effTargetZ = targetPos.z - vs.z * t;
            }
        }

        // Horizontal direction and distance to effective target
        _grenadeDir.set(effTargetX - _grenadeOrigin.x, 0, effTargetZ - _grenadeOrigin.z);
        const horizDist = _grenadeDir.length();
        if (horizDist < 0.1) {
            _grenadeDir.set(this.facingDir.x, 0, this.facingDir.z);
        }
        _grenadeDir.normalize();

        // Final ballistic solve for the corrected effective target
        const { vHoriz, vy } = this._solveGrenadeBallistic(horizDist, dy, v, def.fuseTime);

        // Final world velocity = throw velocity + soldier movement velocity
        const velocity = new THREE.Vector3(
            _grenadeDir.x * vHoriz + vs.x,
            vy,
            _grenadeDir.z * vHoriz + vs.z
        );

        const myName = `${this.team === 'teamA' ? 'A' : 'B'}-${this.soldier.id}`;
        this.grenadeManager.spawn(_grenadeOrigin, velocity, def.fuseTime, this.team, myName);

        this.grenadeCount--;
        this.grenadeCooldown = def.cooldown;

        // Visual: look up toward throw angle
        this._grenadeThrowPitch = Math.atan2(vy, vHoriz);
        this._grenadeThrowTimer = 0.5;
        // Set aimPoint for spectator camera
        const throwDist = 8;
        this.aimPoint.set(
            myPos.x + _grenadeDir.x * throwDist,
            myPos.y + 1.5 + Math.tan(this._grenadeThrowPitch) * throwDist,
            myPos.z + _grenadeDir.z * throwDist
        );

        // Brief pause after throwing (don't shoot for 0.5s)
        this.fireTimer = 0.5;

        return BTState.SUCCESS;
    }

    // ───── Actions ─────

    _actionSeekCover() {
        const myPos = this.soldier.getPosition();

        // If already seeking cover and still moving toward target, keep going
        // But if stuck (stuckTimer >= 0.5), force recalculation
        if (this.seekingCover && this.moveTarget) {
            const distToTarget = myPos.distanceTo(this.moveTarget);
            if (distToTarget > 3 && this.stuckTimer < 0.3) {
                return BTState.RUNNING; // still en route, don't recalculate
            }
            // If stuck, fall through to recalculate a new safe position
        }

        // Primary: use ThreatMap to find a safe position
        if (this.threatMap) {
            const safePos = this.threatMap.findSafePosition(myPos, 25);
            if (safePos) {
                this._releaseCover();
                this.moveTarget = safePos;
                this._validateMoveTarget();
                this.seekingCover = true;
                return BTState.RUNNING;
            }
        }

        // Fallback: CoverSystem (legacy — if ThreatMap unavailable)
        if (this.coverSystem && this.targetEnemy) {
            const enemyPos = this.targetEnemy.getPosition();
            const threatDir = _v1.subVectors(enemyPos, myPos).normalize();

            const covers = this.coverSystem.findCover(myPos, threatDir, 30, 3);
            if (covers.length > 0) {
                const chosen = covers[0].cover;
                this._releaseCover();
                this.coverSystem.occupy(chosen, this.soldier.id);
                this.occupiedCover = chosen;
                // Move to safe side of cover: 5m behind obstacle away from enemy
                const behindOffset = threatDir.clone().multiplyScalar(-5);
                this.moveTarget = chosen.position.clone().add(behindOffset);
                this._validateMoveTarget();
                this.seekingCover = true;
                return BTState.RUNNING;
            }
        }

        // Last resort: move away from enemy
        if (this.targetEnemy) {
            const enemyPos = this.targetEnemy.getPosition();
            _v1.subVectors(myPos, enemyPos).normalize();
            this.moveTarget = myPos.clone().add(
                _v1.multiplyScalar(8).add(
                    new THREE.Vector3(_v1.z, 0, -_v1.x).multiplyScalar(5 * (Math.random() > 0.5 ? 1 : -1))
                )
            );
            this._validateMoveTarget();
        }
        this.seekingCover = true;
        return BTState.RUNNING;
    }

    _actionSuppress() {
        if (!this.suppressionTarget) return BTState.FAILURE;

        // Abort if contact is stale: enemy dead or pruned from intel
        const contact = this.suppressionTarget;
        if (!contact.enemy.alive ||
            (this.teamIntel && !this.teamIntel.contacts.has(contact.enemy))) {
            this.suppressionTarget = null;
            this.suppressionTimer = 0;
            return BTState.FAILURE;
        }

        // Opportunistic grenade: suppression target is a known position — lob one in
        if (this.grenadeCount > 0 && this.grenadeCooldown <= 0) {
            const myPos = this.soldier.getPosition();
            const d = myPos.distanceTo(contact.lastSeenPos);
            if (d >= 8 && d <= 40) {
                this._grenadeTargetPos = contact.lastSeenPos;
                this._actionThrowGrenade();
                return BTState.RUNNING; // keep aimPoint on the throw arc
            }
        }

        // If a live enemy is visible, let _updateAiming handle aimPoint (engage)
        if (this.targetEnemy && this.targetEnemy.alive) {
            // hasReacted is managed by _updateThreatScan / _updateAiming
            return BTState.RUNNING;
        }

        // No visible enemy — fire at ridgeline or last known position (with scatter)
        computeSuppressionTarget(contact, this.aimPoint);
        // Adjust to ridgeline if hill blocks view
        const myPos2 = this.soldier.getPosition();
        _v2.set(myPos2.x, myPos2.y + 1.5, myPos2.z);
        findRidgelineAimPoint(_v2, contact.lastSeenPos, this.getHeightAt, _v1);
        // If ridgeline is closer than target, aim at ridge + scatter
        if (_v1.distanceTo(_v2) < this.aimPoint.distanceTo(_v2)) {
            this.aimPoint.copy(_v1);
            this.aimPoint.x += (Math.random() - 0.5) * 3;
            this.aimPoint.z += (Math.random() - 0.5) * 3;
        }

        // LOS clearance check — make sure own cover doesn't block the shot
        const aimDir = _v1.subVectors(this.aimPoint, _v2).normalize();
        _raycaster.set(_v2, aimDir);
        _raycaster.far = _v2.distanceTo(this.aimPoint);
        const blockHits = _raycaster.intersectObjects(this.collidables, true);
        if (blockHits.length > 0 && blockHits[0].distance < _raycaster.far * 0.8) {
            // Shot blocked by nearby obstacle (own cover) — don't fire
            this._suppressBlockedCount++;
            if (this._suppressBlockedCount >= 3) {
                // Give up suppression after 3 consecutive blocked attempts
                this.suppressionTarget = null;
                this.suppressionTimer = 0;
                this._suppressBlockedCount = 0;
                return BTState.FAILURE;
            }
            this.hasReacted = false;
            return BTState.RUNNING;
        }
        this._suppressBlockedCount = 0;

        this.aimOffset.set(0, 0, 0);
        this.hasReacted = true; // allow shooting

        return BTState.RUNNING;
    }

    _actionFallback() {
        const myPos = this.soldier.getPosition();
        const dist = myPos.distanceTo(this.fallbackTarget);
        if (dist > 8) {
            // Still far — run toward friendly flag
            this.moveTarget = this.fallbackTarget;
            this._validateMoveTarget();
            this.seekingCover = false;
        } else {
            // Arrived — find nearby cover and hold
            return this._actionSeekCover();
        }
        this.missionPressure = 0.0;
        return BTState.RUNNING;
    }

    _actionRush() {
        if (!this.squad) return BTState.FAILURE;

        const myPos = this.soldier.getPosition();
        const dist = myPos.distanceTo(this.rushTarget);

        if (!this.squad.rushActive) {
            // Rally phase: move toward flag but don't charge in
            if (dist > 20) {
                this.moveTarget = this.rushTarget.clone();
                this._validateMoveTarget();
            }
            return BTState.RUNNING;
        }

        if (dist > 8) {
            // Opportunistic grenade: lob toward flag if enemies are defending it
            if (this.grenadeCount > 0 && this.grenadeCooldown <= 0 && dist >= 8 && dist <= 40 && this.teamIntel) {
                const threats = this.teamIntel.getKnownEnemies({
                    minConfidence: 0.15, maxDist: 18, fromPos: this.rushTarget,
                });
                if (threats.length > 0) {
                    this._grenadeTargetPos = this.rushTarget;
                    this._actionThrowGrenade();
                }
            }

            // Rush active — charge the flag
            this.moveTarget = this.rushTarget.clone();
            this._validateMoveTarget();
            this.seekingCover = false;
            this.missionPressure = 0.0;
        } else {
            // Arrived at flag — hold position from cover
            return this._actionSeekCover();
        }
        return BTState.RUNNING;
    }

    _actionCrossfire() {
        this.moveTarget = this.crossfirePos;
        this._validateMoveTarget();
        this.seekingCover = false;
        this.missionPressure = 0.5;
        return BTState.RUNNING;
    }

    _actionInvestigate() {
        if (!this.teamIntel) return BTState.FAILURE;

        const myPos = this.soldier.getPosition();
        const contacts = this.teamIntel.getKnownEnemies({
            minConfidence: 0.4,
            maxDist: 40,
            fromPos: myPos,
        });

        if (contacts.length === 0) return BTState.FAILURE;

        // Move toward nearest intel contact
        let nearest = contacts[0];
        let nearestDist = myPos.distanceTo(nearest.lastSeenPos);
        for (let i = 1; i < contacts.length; i++) {
            const d = myPos.distanceTo(contacts[i].lastSeenPos);
            if (d < nearestDist) {
                nearestDist = d;
                nearest = contacts[i];
            }
        }

        // Move toward the contact's last known position
        this.moveTarget = nearest.lastSeenPos.clone();
        this._validateMoveTarget();

        // Pre-aim at predicted position
        computePreAimPoint(nearest, this.aimPoint);

        // Update facing toward threat
        _v1.subVectors(nearest.lastSeenPos, myPos).normalize();
        _v1.y = 0;
        this.facingDir.lerp(_v1, 0.15).normalize();

        // Update mission pressure
        this.missionPressure = 0.5;
        this.seekingCover = false;
        return BTState.RUNNING;
    }

    _actionEngage() {
        // Move and shoot
        if (!this.targetEnemy || !this.targetEnemy.alive) {
            this._setTargetEnemy(null);
            return BTState.FAILURE;
        }

        const myPos = this.soldier.getPosition();
        const enemyPos = this.targetEnemy.getPosition();
        const dist = myPos.distanceTo(enemyPos);

        // Flanker personality: request suppression + move to flank
        const isFlanker = this.personality.name === 'Flanker';

        if (isFlanker && this.squad && this.teamIntel) {
            const contact = this.teamIntel.getContactFor(this.targetEnemy);
            if (contact) {
                this.squad.requestSuppression(contact);
                findFlankPosition(
                    myPos, enemyPos, this.coverSystem, this.flankSide, this.navGrid, _tmpVec
                );
                this.moveTarget = _tmpVec.clone();
                this._validateMoveTarget();
                this.seekingCover = false;
                this.missionPressure = 0.5;
                return BTState.RUNNING;
            }
        }

        // Strafe while shooting (move perpendicular to enemy)
        const toEnemy = _v1.subVectors(enemyPos, myPos).normalize();
        _strafeDir.set(toEnemy.z, 0, -toEnemy.x);

        // Random-interval strafe direction changes (replaces predictable sine wave)
        this._strafeTimer -= this._dt;
        if (this._strafeTimer <= 0) {
            // When targeted, change direction more frequently
            const baseInterval = this.soldier.targetedByCount > 0 ? 0.25 : 0.4;
            this._strafeInterval = baseInterval + Math.random() * 0.4;
            this._strafeTimer = this._strafeInterval;
            // Flip direction, with 20% chance of a fake-out (stay same side)
            this._strafeSide = Math.random() > 0.2 ? -this._strafeSide : this._strafeSide;
        }
        let strafeSide = this._strafeSide;

        // Ally-aware strafe: if an ally is already on the chosen side, flip
        if (this.allies) {
            let alliesOnSide = 0;
            for (const a of this.allies) {
                if (!a.alive || a === this.soldier) continue;
                const aPos = a.getPosition();
                if (myPos.distanceTo(aPos) > 15) continue;
                _tmpVec.set(aPos.x - myPos.x, 0, aPos.z - myPos.z);
                const dot = _strafeDir.x * _tmpVec.x + _strafeDir.z * _tmpVec.z;
                if (dot * strafeSide > 0) alliesOnSide++;
            }
            if (alliesOnSide >= 2) strafeSide *= -1;
        }

        const isBolt = this.weaponId === 'BOLT';

        if (isBolt) {
            // BOLT: stay at back-line (~40-60m), retreat if too close, hold if in sweet spot
            const idealMin = 40;
            const idealMax = 60;
            if (dist < idealMin) {
                // Too close — back away while strafing
                _tmpVec.copy(myPos);
                _tmpVec.x += toEnemy.x * -10 + _strafeDir.x * strafeSide * 6;
                _tmpVec.z += toEnemy.z * -10 + _strafeDir.z * strafeSide * 6;
                this.moveTarget = _tmpVec.clone();
            } else if (dist > idealMax) {
                // Too far — close distance slightly
                _tmpVec.copy(enemyPos);
                _tmpVec.x += toEnemy.x * -idealMin + _strafeDir.x * strafeSide * 8;
                _tmpVec.z += toEnemy.z * -idealMin + _strafeDir.z * strafeSide * 8;
                this.moveTarget = _tmpVec.clone();
            } else {
                // Sweet spot — strafe only, maintain range
                _tmpVec.copy(myPos);
                _tmpVec.x += _strafeDir.x * strafeSide * 8;
                _tmpVec.z += _strafeDir.z * strafeSide * 8;
                this.moveTarget = _tmpVec.clone();
            }
        } else if (dist > 35) {
            // Far away: move toward enemy position directly — let A* handle routing
            _tmpVec.copy(enemyPos);
            this.moveTarget = _tmpVec.clone();
        } else if (dist < 10) {
            _tmpVec.copy(myPos);
            _tmpVec.x += toEnemy.x * -3 + _strafeDir.x * strafeSide * 4;
            _tmpVec.z += toEnemy.z * -3 + _strafeDir.z * strafeSide * 4;
            this.moveTarget = _tmpVec.clone();
        } else {
            // Medium range: strafe but use a longer offset so A* can route properly
            _tmpVec.copy(enemyPos);
            _tmpVec.x += _strafeDir.x * strafeSide * 8;
            _tmpVec.z += _strafeDir.z * strafeSide * 8;
            this.moveTarget = _tmpVec.clone();
        }
        this._validateMoveTarget();

        this.missionPressure = 1.0;
        this.seekingCover = false;
        return BTState.RUNNING;
    }

    _actionCaptureFlag() {
        if (!this.targetFlag) return BTState.FAILURE;

        const myPos = this.soldier.getPosition();
        const flagPos = this.targetFlag.position;
        const dist = myPos.distanceTo(flagPos);

        // Use squad formation position if available
        if (this.squad && dist > this.targetFlag.captureRadius * 0.7) {
            const formationPos = this.squad.getDesiredPosition(this, this.navGrid);
            if (formationPos) {
                // Already at formation — add jitter so COM patrols nearby
                const distToFormation = myPos.distanceTo(formationPos);
                if (distToFormation < 3) {
                    const jAngle = Math.random() * Math.PI * 2;
                    const jDist = 3 + Math.random() * 2; // 3-5m
                    formationPos.x += Math.cos(jAngle) * jDist;
                    formationPos.z += Math.sin(jAngle) * jDist;
                }
                this.moveTarget = formationPos.clone();
                this._validateMoveTarget();
                this.missionPressure = 0.5;
                this.seekingCover = false;
                return BTState.RUNNING;
            }
        }

        if (dist < this.targetFlag.captureRadius * 0.7) {
            // Inside capture zone — spread around flag by soldier index
            const baseAngle = (this.soldier.id / 12) * Math.PI * 2;
            const jitter = (Math.random() - 0.5) * 0.6;
            const angle = baseAngle + jitter;
            // BOLT COMs sit at outer edge (~20-25m) as overwatch; others 6-10m
            const radius = this.weaponId === 'BOLT'
                ? 20 + Math.random() * 5
                : 6 + Math.random() * 4;
            this.moveTarget = flagPos.clone().add(
                new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
            );
            this.missionPressure = 0.0;
        } else {
            // BOLT COMs don't rush to the flag center — stop at overwatch range
            if (this.weaponId === 'BOLT' && dist < 25) {
                const baseAngle = (this.soldier.id / 12) * Math.PI * 2;
                const radius = 20 + Math.random() * 5;
                this.moveTarget = flagPos.clone().add(
                    new THREE.Vector3(Math.cos(baseAngle) * radius, 0, Math.sin(baseAngle) * radius)
                );
            } else {
                this.moveTarget = flagPos.clone();
            }
            this.missionPressure = 0.5;
        }
        this._validateMoveTarget();

        this.seekingCover = false;
        return BTState.RUNNING;
    }

    _actionPatrol() {
        const myPos = this.soldier.getPosition();
        if (!this.moveTarget || myPos.distanceTo(this.moveTarget) < 3) {
            const flag = this.targetFlag || this.flags[0];
            this.moveTarget = flag.position.clone().add(
                new THREE.Vector3(
                    (Math.random() - 0.5) * 30,
                    0,
                    (Math.random() - 0.5) * 20
                )
            );
            this._validateMoveTarget();
        }
        this.missionPressure = 1.0;
        return BTState.RUNNING;
    }

    // ───── Move Target Validation ─────

    /**
     * Ensure moveTarget is on a walkable NavGrid cell.
     * If not, snap to the nearest walkable cell.
     */
    _validateMoveTarget() {
        if (!this.moveTarget || !this.navGrid) return;
        const g = this.navGrid.worldToGrid(this.moveTarget.x, this.moveTarget.z);
        if (!this.navGrid.isWalkable(g.col, g.row)) {
            const nearest = this.navGrid._findNearestWalkable(g.col, g.row);
            if (nearest) {
                const w = this.navGrid.gridToWorld(nearest.col, nearest.row);
                this.moveTarget.x = w.x;
                this.moveTarget.z = w.z;
            }
        }
    }

    // ───── Pathfinding ─────

    _requestPath(forceAStar = false) {
        if (!this.navGrid || !this.moveTarget) return;

        if (!forceAStar) {
            if (this._pathCooldown > 0) return;
        }

        const myPos = this.soldier.getPosition();

        // Pass threat grid directly (avoid per-neighbour callback overhead)
        const tm = this.threatMap;
        const threatGrid = tm ? tm.threat : null;
        const threatCols = tm ? tm.cols : 0;
        const path = this.navGrid.findPath(
            myPos.x, myPos.z, this.moveTarget.x, this.moveTarget.z,
            threatGrid, threatCols,
        );

        // Adaptive cooldown: 0.5s near obstacles/stuck, 1.5s open terrain
        // Jitter ±0.2s to spread A* calls across frames
        const jitter = (Math.random() - 0.5) * 0.4;
        let cooldown = 1.5;
        if (this.stuckTimer > 0) {
            cooldown = 0.5;
        } else if (path && path.length > 0) {
            const ng = this.navGrid;
            for (let i = 0, len = Math.min(path.length, 6); i < len; i++) {
                const g = ng.worldToGrid(path[i].x, path[i].z);
                const idx = g.row * ng.cols + g.col;
                if (ng.proxCost[idx] > 1) { cooldown = 0.5; break; }
            }
        }

        if (path === null) {
            this.currentPath = [];
            this.pathIndex = 0;
            this._pathCooldown = 0.5 + jitter;
            this._noPathFound = true;
        } else if (path.length === 0) {
            this.currentPath = [];
            this.pathIndex = 0;
            this._pathCooldown = cooldown + jitter;
            this._noPathFound = false;
        } else {
            this.currentPath = path;
            this.pathIndex = 0;
            this._pathCooldown = cooldown + jitter;
            this._noPathFound = false;
        }
    }

    // ───── Movement ─────

    _updateMovement(dt) {
        const body = this.soldier.body;
        const myPos = this.soldier.getPosition();
        const groundY = this.getHeightAt(myPos.x, myPos.z);

        // Handle jumping (manual parabola)
        if (this.isJumping) {
            this.jumpVelY -= 9.8 * dt; // gravity
            body.position.y += this.jumpVelY * dt;
            if (body.position.y <= groundY + 0.05) {
                body.position.y = groundY + 0.05;
                this.isJumping = false;
                this.jumpVelY = 0;
            }
        }

        // Ground snap — unconditional (fixes floating after respawn)
        if (!this.isJumping) {
            body.position.y = groundY + 0.05;
        }

        // Facing direction — suppression takes priority (body must face where bullets go)
        if (this.suppressionTarget && this.suppressionTimer > 0) {
            _v2.subVectors(this.aimPoint, myPos).normalize();
            _v2.y = 0;
            this.facingDir.lerp(_v2, 0.3).normalize();
        } else if (this.targetEnemy && this.targetEnemy.alive) {
            _v2.subVectors(this.targetEnemy.getPosition(), myPos).normalize();
            _v2.y = 0;
            const turnRate = this.hasReacted ? 0.45 : 0.15;
            this.facingDir.lerp(_v2, turnRate).normalize();
        }

        // Reflex dodge: lateral movement even without moveTarget
        if (this._reflexDodgeTimer > 0 && !this.moveTarget) {
            const speed = this.moveSpeed;
            const rdx = this._reflexDodgeDirX * speed * dt;
            const rdz = this._reflexDodgeDirZ * speed * dt;
            let nx = body.position.x + rdx;
            let nz = body.position.z + rdz;
            // NavGrid check
            let blocked = false;
            if (this.navGrid) {
                const g = this.navGrid.worldToGrid(nx, nz);
                if (!this.navGrid.isWalkable(g.col, g.row)) blocked = true;
            }
            if (!blocked) {
                const gy = this.getHeightAt(nx, nz);
                body.position.x = nx;
                body.position.z = nz;
                if (!this.isJumping) body.position.y = gy + 0.05;
            }
            this.lastPos.copy(myPos);
            return;
        }

        if (!this.moveTarget) {
            // No destination — decelerate to zero (inertia slide)
            const decelRate = 12;
            const td = Math.min(1, decelRate * dt);
            this._velX += (0 - this._velX) * td;
            this._velZ += (0 - this._velZ) * td;
            if (this._velX * this._velX + this._velZ * this._velZ < 0.01) {
                this._velX = 0;
                this._velZ = 0;
            } else {
                const nx2 = body.position.x + this._velX * dt;
                const nz2 = body.position.z + this._velZ * dt;
                let slideBlocked = false;
                if (this.navGrid) {
                    const g = this.navGrid.worldToGrid(nx2, nz2);
                    if (!this.navGrid.isWalkable(g.col, g.row)) slideBlocked = true;
                }
                if (!slideBlocked) {
                    body.position.x = nx2;
                    body.position.z = nz2;
                    if (!this.isJumping) body.position.y = this.getHeightAt(nx2, nz2) + 0.05;
                }
            }
            this.lastPos.copy(myPos);
            return;
        }

        // Request A* path if available
        this._requestPath();

        // If A* failed, don't move — but allow recovery after timeout
        if (this._noPathFound) {
            this.btTimer = this.btInterval; // force BT re-tick
            this.seekingCover = false;      // allow BT to try different action
            this.stuckTimer += dt;
            if (this.stuckTimer > 1.0) {
                // Recovery: clear failure, invalidate target so BT picks fresh
                this._noPathFound = false;
                this.stuckTimer = 0;
                this.moveTarget = null;
                this.currentPath = [];
                this.pathIndex = 0;
                this._pathCooldown = 0;
            }
            this.lastPos.copy(myPos);
            return;
        }

        // Determine immediate steering target: next waypoint or direct moveTarget
        let steerTarget = this.moveTarget;
        if (this.currentPath.length > 0 && this.pathIndex < this.currentPath.length) {
            const wp = this.currentPath[this.pathIndex];
            _tmpVec.set(wp.x, 0, wp.z);
            steerTarget = _tmpVec;
            // Advance waypoint when close enough
            const wpDist = Math.sqrt(
                (myPos.x - wp.x) ** 2 + (myPos.z - wp.z) ** 2
            );
            if (wpDist < 1.5) {
                this.pathIndex++;
                if (this.pathIndex >= this.currentPath.length) {
                    // Path completed — will recompute on next cooldown
                    this._pathCooldown = 0;
                    steerTarget = this.moveTarget;
                } else {
                    const nextWp = this.currentPath[this.pathIndex];
                    _tmpVec.set(nextWp.x, 0, nextWp.z);
                    steerTarget = _tmpVec;
                }
            }
        } else {
            // No A* path — only allow direct movement when close to target
            const directDist = myPos.distanceTo(this.moveTarget);
            if (directDist > 5) {
                this.lastPos.copy(myPos);
                return; // wait for A* path before moving
            }
        }

        _v1.subVectors(steerTarget, myPos);
        _v1.y = 0;
        const dist = _v1.length();

        if (dist < 1) {
            // If following path, advance to next waypoint
            if (this.currentPath.length > 0 && this.pathIndex < this.currentPath.length) {
                this.pathIndex++;
            } else {
                // Arrived at final destination — clear moveTarget so BT assigns fresh
                this.moveTarget = null;
                this.btTimer = this.btInterval;
            }
            this.lastPos.copy(myPos);
            return;
        }

        _v1.normalize();

        // ── Reflex dodge blend: inject lateral offset while dodging ──
        if (this._reflexDodgeTimer > 0) {
            const dodgeWeight = 0.5; // blend 50% dodge into movement
            _v1.x = _v1.x * (1 - dodgeWeight) + this._reflexDodgeDirX * dodgeWeight;
            _v1.z = _v1.z * (1 - dodgeWeight) + this._reflexDodgeDirZ * dodgeWeight;
            const rLen = Math.sqrt(_v1.x * _v1.x + _v1.z * _v1.z);
            if (rLen > 0.001) { _v1.x /= rLen; _v1.z /= rLen; }
        }

        // ── Ally separation force ──
        // Strength scales with context: high risk → strong, combat → moderate, idle → mild
        let sepWeight;
        if (this.riskLevel > 0.5)         sepWeight = 0.30;
        else if (this.targetEnemy !== null) sepWeight = 0.20;
        else                               sepWeight = 0.08;

        const minSepDist = 3;   // below this distance, repulsion spikes
        const maxSepRange = 12; // ignore allies farther than this
        let sepX = 0, sepZ = 0;

        if (this.allies) {
            for (const a of this.allies) {
                if (!a.alive || a === this.soldier) continue;
                const aPos = a.getPosition();
                const adx = myPos.x - aPos.x;
                const adz = myPos.z - aPos.z;
                const aDist = Math.sqrt(adx * adx + adz * adz);
                if (aDist > maxSepRange || aDist < 0.01) continue;
                // Weight: 1/dist² — very strong when close
                const strength = 1 / (Math.max(aDist, minSepDist) * Math.max(aDist, minSepDist));
                sepX += (adx / aDist) * strength;
                sepZ += (adz / aDist) * strength;
            }
        }
        const sepLen = Math.sqrt(sepX * sepX + sepZ * sepZ);
        if (sepLen > 0.001) {
            sepX /= sepLen;
            sepZ /= sepLen;
            _v1.x = _v1.x * (1 - sepWeight) + sepX * sepWeight;
            _v1.z = _v1.z * (1 - sepWeight) + sepZ * sepWeight;
            // Re-normalize
            const rLen = Math.sqrt(_v1.x * _v1.x + _v1.z * _v1.z);
            if (rLen > 0.001) { _v1.x /= rLen; _v1.z /= rLen; }
        }

        let movementBlocked = false;

        const speed = this.seekingCover ? this.moveSpeed * 1.2 : this.moveSpeed;

        // Target velocity from direction
        const targetVX = _v1.x * speed;
        const targetVZ = _v1.z * speed;

        // Lerp current velocity toward target (inertia)
        const accelRate = 20;
        const ta = Math.min(1, accelRate * dt);
        this._velX += (targetVX - this._velX) * ta;
        this._velZ += (targetVZ - this._velZ) * ta;

        // Move horizontally using smoothed velocity
        const dx = this._velX * dt;
        const dz = this._velZ * dt;
        const newX = body.position.x + dx;
        const newZ = body.position.z + dz;

        // NavGrid obstacle check with axis-separated sliding
        let finalX = newX;
        let finalZ = newZ;
        if (this.navGrid) {
            let g = this.navGrid.worldToGrid(newX, newZ);
            if (!this.navGrid.isWalkable(g.col, g.row)) {
                // Try sliding along each axis individually
                const gX = this.navGrid.worldToGrid(newX, body.position.z);
                const gZ = this.navGrid.worldToGrid(body.position.x, newZ);
                if (this.navGrid.isWalkable(gX.col, gX.row)) {
                    finalX = newX; finalZ = body.position.z;
                } else if (this.navGrid.isWalkable(gZ.col, gZ.row)) {
                    finalX = body.position.x; finalZ = newZ;
                } else {
                    movementBlocked = true;
                }
            }
        }

        if (!movementBlocked) {
            const newGroundY = this.getHeightAt(finalX, finalZ);
            const currentFootY = body.position.y;
            const slopeRise = newGroundY - currentFootY;
            const stepX = finalX - body.position.x;
            const stepZ = finalZ - body.position.z;
            const slopeRun = Math.sqrt(stepX * stepX + stepZ * stepZ);
            const slopeAngle = slopeRun > 0.001 ? Math.atan2(slopeRise, slopeRun) : 0;
            const maxClimbAngle = Math.PI * 0.42; // ~75°

            if (slopeAngle < maxClimbAngle) {
                body.position.x = finalX;
                body.position.z = finalZ;
                if (!this.isJumping) {
                    body.position.y = newGroundY + 0.05;
                }
            } else {
                // Steep terrain — trigger jump
                if (!this.isJumping) {
                    this.isJumping = true;
                    this.jumpVelY = 2.5;
                    body.position.x += _v1.x * speed * 0.3 * dt;
                    body.position.z += _v1.z * speed * 0.3 * dt;
                } else {
                    movementBlocked = true;
                }
            }
        }

        // Update facing: pre-aim nearest intel contact, or fall back to movement direction
        this._preAimActive = false;
        if (this._grenadeThrowTimer > 0) {
            // During grenade throw, keep aimPoint on the throw arc — skip pre-aim
        } else if (!this.targetEnemy || !this.targetEnemy.alive) {
            let preAimed = false;
            if (this.teamIntel) {
                // Re-evaluate intel target only when cooldown expires or current contact is stale
                let nearest = this._preAimContact;
                if (nearest && nearest.confidence <= 0) {
                    nearest = null; // contact expired
                }
                if (!nearest || this._preAimCooldown <= 0) {
                    nearest = null;
                    let nearestDist = Infinity;
                    for (const contact of this.teamIntel.contacts.values()) {
                        if (contact.status === 'visible') continue;
                        const d = myPos.distanceTo(contact.lastSeenPos);
                        if (d < this.weaponDef.maxRange && d < nearestDist) {
                            nearestDist = d;
                            nearest = contact;
                        }
                    }
                    if (nearest && nearest !== this._preAimContact) {
                        this._preAimCooldown = 0.5;
                    }
                    this._preAimContact = nearest;
                }
                if (nearest) {
                    _v2.subVectors(nearest.lastSeenPos, myPos).normalize();
                    _v2.y = 0;
                    this.facingDir.lerp(_v2, 0.12).normalize();
                    // Set aimPoint — aim at ridgeline if hill blocks view
                    const eyeY = myPos.y + 1.5;
                    _v2.set(myPos.x, eyeY, myPos.z);
                    findRidgelineAimPoint(_v2, nearest.lastSeenPos, this.getHeightAt, this.aimPoint);
                    this._preAimActive = true;
                    preAimed = true;
                }
            }
            if (!preAimed) {
                this.facingDir.lerp(_v1, 0.1).normalize();
            }
        }

        // Stuck detection
        const barelyMoved = myPos.distanceTo(this.lastPos) < 0.1 * dt;
        if (movementBlocked || barelyMoved) {
            this.stuckTimer += dt;
            if (this.stuckTimer > 0.6) {
                // Force BT to recalculate target on next tick
                this.seekingCover = false;
                this.btTimer = this.btInterval;
                this.stuckTimer = 0;
                // Clear path — next 0.5s cooldown will recompute from current pos
                this.currentPath = [];
                this.pathIndex = 0;
                this._pathCooldown = 0;
            }
        } else {
            this.stuckTimer = 0;
        }
        // Record velocity for death momentum inheritance
        const invDt = dt > 0.001 ? 1 / dt : 0;
        this.soldier.lastMoveVelocity.set(
            (myPos.x - this.lastPos.x) * invDt,
            0,
            (myPos.z - this.lastPos.z) * invDt
        );

        this.lastPos.copy(myPos);
    }

    // ───── Aiming ─────

    _updateAiming(dt) {
        // During grenade throw, aimPoint is set to the throw arc — don't overwrite
        if (this._grenadeThrowTimer > 0) return;

        // For suppression with no visible enemy, aim point is set by _actionSuppress
        const isSuppressingBlind = this.suppressionTarget && this.suppressionTimer > 0
            && (!this.targetEnemy || !this.targetEnemy.alive);
        if (isSuppressingBlind) return;

        if (!this.targetEnemy || !this.targetEnemy.alive || !this.hasReacted) {
            // Reaction delay
            if (this.targetEnemy && !this.hasReacted) {
                this.reactionTimer -= dt;
                if (this.reactionTimer <= 0) {
                    this.hasReacted = true;
                }
            }
            return;
        }

        // Aim at enemy — head-only if only head is exposed, otherwise center mass
        const enemyPos = this.targetEnemy.getPosition();
        this.aimPoint.copy(enemyPos);
        this.aimPoint.y += this._targetLOSLevel === 2 ? 1.6 : 1.2;

        // Gradually reduce aim offset
        this.aimOffset.multiplyScalar(1 - this.aimCorrectionSpeed * dt);

        // Add tracking lag for moving targets
        const enemyVel = this.targetEnemy.body.velocity;
        const lagAmount = (1 - this.personality.aimSkill) * 0.15;
        this.aimOffset.x += enemyVel.x * lagAmount * dt;
        this.aimOffset.z += enemyVel.z * lagAmount * dt;
    }

    // ───── Shooting ─────

    _updateShooting(dt) {
        this.fireTimer -= dt;
        this.burstCooldown -= dt;

        // Bolt cycling timer
        if (this.boltTimer > 0) {
            this.boltTimer -= dt;
            if (this.boltTimer <= 0) this.boltTimer = 0;
        }

        // BOLT aim delay: must aim at target for aiAimDelay seconds before firing
        if (this.weaponDef.aiAimDelay) {
            // Unscope during bolt cycling, reloading, or grenade throw
            if (this.boltTimer > 0 || this.isReloading || this._grenadeThrowTimer > 0) {
                this.isScoped = false;
            } else if (this.targetEnemy && this.targetEnemy.alive && this.hasReacted) {
                if (this.targetEnemy !== this._lastAimTarget) {
                    // Target changed → unscope and restart full aim delay
                    this.isScoped = false;
                    this._boltAimTimer = 0;
                    this._lastAimTarget = this.targetEnemy;
                }
                this._boltAimTimer += dt;
                // Scope in while aiming
                this.isScoped = true;
            } else {
                this._boltAimTimer = 0;
                this._lastAimTarget = null;
                this.isScoped = false;
            }
        }

        // Spread recovery during burst cooldown or when not shooting
        // Recovery moves toward baseSpread (up for LMG after sustained fire, down for others)
        if (this.burstCooldown > 0 || !this.targetEnemy) {
            if (this.currentSpread > this.baseSpread) {
                this.currentSpread = Math.max(this.baseSpread, this.currentSpread - this.spreadRecoveryRate * dt);
            } else if (this.currentSpread < this.baseSpread) {
                this.currentSpread = Math.min(this.baseSpread, this.currentSpread + this.spreadRecoveryRate * dt);
            }
        }

        // Handle reload
        if (this.isReloading) {
            this.reloadTimer -= dt;
            if (this.reloadTimer <= 0) {
                this.currentAmmo = this.magazineSize;
                this.isReloading = false;
            }
            this.fireTimer = 0;
            return;
        }

        // Auto-reload when empty (immediate — no stagger, can't fight with 0 ammo)
        if (this.currentAmmo <= 0) {
            this.isReloading = true;
            this.reloadTimer = this.reloadTime;
            this.fireTimer = 0;
            return;
        }

        // Tactical reload: proactively reload when safe and ammo below personality threshold
        const ammoRatio = this.currentAmmo / this.magazineSize;
        if (ammoRatio < this.personality.tacticalReloadThreshold &&
            (!this.targetEnemy || !this.targetEnemy.alive)) {
            if (!this.squad || this.squad.canReload(this)) {
                this.isReloading = true;
                this.reloadTimer = this.reloadTime;
                this.fireTimer = 0;
                return;
            }
        }

        // Allow shooting during suppression
        const isSuppressing = this.suppressionTarget && this.suppressionTimer > 0;

        if (!isSuppressing) {
            if (!this.targetEnemy || !this.targetEnemy.alive || !this.hasReacted) {
                this.fireTimer = 0;
                return;
            }
        }
        if (this.burstCooldown > 0) {
            this.fireTimer = 0;
            return;
        }

        // Block firing during grenade throw
        if (this._grenadeThrowTimer > 0) return;

        // Block firing during bolt cycling
        if (this.boltTimer > 0) return;

        // Block firing during BOLT aim delay
        if (this.weaponDef.aiAimDelay && this._boltAimTimer < this.weaponDef.aiAimDelay) return;

        if (this.fireTimer <= 0) {
            this.fireTimer += this.fireInterval;
            this._fireShot();
            this.currentAmmo--;
            this.burstCount++;

            // Start bolt cycling after firing (BOLT only)
            if (this.weaponDef.boltTime) {
                this.boltTimer = this.weaponDef.boltTime;
            }

            if (this.burstCount >= this.burstMax) {
                this.burstCount = 0;
                this.burstMax = this.weaponId === 'BOLT' ? 1
                    : this.weaponId === 'LMG'
                        ? 20 + Math.floor(Math.random() * 10)
                        : 6 + Math.floor(Math.random() * 8);
                this.burstCooldown = this.weaponId === 'BOLT' ? 0 : 0.08 + Math.random() * 0.2;
            }
        }
    }

    _fireShot() {
        const myPos = this.soldier.getPosition();
        _origin.copy(myPos);
        _origin.y += 1.5;

        // Direction to aim point + offset + random spread
        _target.copy(this.aimPoint).add(this.aimOffset);
        const dir = _v1.subVectors(_target, _origin).normalize();

        // Apply current dynamic spread (same model as Player)
        dir.x += (Math.random() - 0.5) * 2 * this.currentSpread;
        dir.y += (Math.random() - 0.5) * 2 * this.currentSpread;
        dir.z += (Math.random() - 0.5) * 2 * this.currentSpread;
        dir.normalize();

        // Increase spread per shot — negative means sustained fire tightens
        if (this.spreadIncreasePerShot >= 0) {
            this.currentSpread = Math.min(this.maxSpread, this.currentSpread + this.spreadIncreasePerShot);
        } else {
            this.currentSpread = Math.max(this.weaponDef.minSpread || 0.001, this.currentSpread + this.spreadIncreasePerShot);
        }

        // Hitscan
        _raycaster.set(_origin, dir);
        _raycaster.far = this.weaponDef.maxRange;

        // Check against all enemies
        _targetMeshes.length = 0;
        for (const e of this.enemies) {
            if (e.alive && e.mesh) _targetMeshes.push(e.mesh);
        }
        if (this._playerMesh) _targetMeshes.push(this._playerMesh);

        const envHits = _raycaster.intersectObjects(this.collidables, true);
        const charHits = _raycaster.intersectObjects(_targetMeshes, true);

        let hitChar = charHits.length > 0 ? charHits[0] : null;
        let hitEnv = envHits.length > 0 ? envHits[0] : null;

        // Determine closest hit distance for tracer length
        let tracerDist = this.weaponDef.maxRange;
        if (hitChar && (!hitEnv || hitChar.distance < hitEnv.distance)) {
            tracerDist = hitChar.distance;
        } else if (hitEnv) {
            tracerDist = hitEnv.distance;
        }

        // Spawn tracer VFX
        if (this.tracerSystem) {
            this.tracerSystem.fire(_origin, dir, tracerDist);
        }

        // Visual recoil kick on gun mesh
        this.soldier._gunRecoilZ = GunAnim.recoilOffset;

        // Notify minimap that this AI fired
        if (this.eventBus) {
            this.eventBus.emit('aiFired', { team: this.team, soldierId: `${this.team}_${this.soldier.id}` });
        }

        const myName = `${this.team === 'teamA' ? 'A' : 'B'}-${this.soldier.id}`;

        if (hitChar && (!hitEnv || hitChar.distance < hitEnv.distance)) {
            // Calculate damage with falloff (same formula as Player)
            let dmg = this.weaponDef.damage;
            if (hitChar.distance > this.weaponDef.falloffStart) {
                const t = Math.min((hitChar.distance - this.weaponDef.falloffStart) / (this.weaponDef.falloffEnd - this.weaponDef.falloffStart), 1);
                dmg *= (1 - t * (1 - this.weaponDef.falloffMinScale));
            }

            for (const enemy of this.enemies) {
                if (!enemy.alive) continue;
                if (this._playerMesh && enemy.mesh === this._playerMesh) continue;
                if (this._isChildOf(hitChar.object, enemy.mesh)) {
                    if (this.impactVFX) {
                        this.impactVFX.spawn('blood', hitChar.point, _v1.copy(dir).negate());
                    }
                    const result = enemy.takeDamage(dmg, myPos, hitChar.point.y);
                    if (this.eventBus) {
                        this.eventBus.emit('aiHit', { soldier: this.soldier, killed: result.killed });
                    }
                    if (result.killed && this.eventBus) {
                        const vTeam = enemy.team || (this.team === 'teamA' ? 'teamB' : 'teamA');
                        this.eventBus.emit('kill', {
                            killerName: myName,
                            killerTeam: this.team,
                            victimName: `${vTeam === 'teamA' ? 'A' : 'B'}-${enemy.id}`,
                            victimTeam: vTeam,
                            headshot: result.headshot,
                            weapon: this.weaponId,
                        });
                    }
                    return;
                }
            }
            if (this._playerRef && this._isChildOf(hitChar.object, this._playerMesh)) {
                if (this.impactVFX) {
                    this.impactVFX.spawn('blood', hitChar.point, _v1.copy(dir).negate());
                }
                const result = this._playerRef.takeDamage(dmg, myPos, hitChar.point.y);
                if (result.killed && this.eventBus) {
                    this.eventBus.emit('kill', {
                        killerName: myName,
                        killerTeam: this.team,
                        victimName: 'You',
                        victimTeam: this._playerRef.team,
                        headshot: result.headshot,
                        weapon: this.weaponId,
                    });
                }
            }
        } else if (hitEnv && this.impactVFX) {
            // No character hit — spawn impact particles on environment
            const surfaceType = this._getSurfaceType(hitEnv.object);
            const impactType = surfaceType === 'water' ? 'water'
                : (surfaceType === 'rock' ? 'spark' : 'dirt');
            const worldNormal = this._getWorldNormal(hitEnv);
            this.impactVFX.spawn(impactType, hitEnv.point, worldNormal);
        }
    }

    _getWorldNormal(hit) {
        if (!hit.face) return null;
        const normal = hit.face.normal.clone();
        normal.transformDirection(hit.object.matrixWorld);
        return normal;
    }

    _getSurfaceType(obj) {
        let current = obj;
        while (current) {
            if (current.userData && current.userData.surfaceType) {
                return current.userData.surfaceType;
            }
            current = current.parent;
        }
        return 'terrain';
    }

    _isChildOf(obj, parent) {
        let current = obj;
        while (current) {
            if (current === parent) return true;
            current = current.parent;
        }
        return false;
    }

    // ───── Cover Management ─────

    _releaseCover() {
        if (this.occupiedCover && this.coverSystem) {
            this.coverSystem.release(this.occupiedCover, this.soldier.id);
            this.occupiedCover = null;
        }
    }

    onRespawn() {
        this._releaseCover();
        this._setTargetEnemy(null);
        this.suppressionTarget = null;
        this.suppressionTimer = 0;
        this._suppressBlockedCount = 0;
        this.fallbackTarget = null;
        this.rushTarget = null;
        this.rushReady = false;
        this.crossfirePos = null;
        this._reflexDodgeTimer = 0;
        this._prevTargetedByCount = 0;
        if (this._tacLabel) this._tacLabel.visible = false;
        this._tacLabelText = '';
        this._previouslyVisible.clear();
        // Reset timers and cooldowns
        this.btTimer = 0;
        this.reactionTimer = 0;
        this.hasReacted = false;
        this._targetSwitchCooldown = 0;
        this._scanTimer = 0;
        this._strafeTimer = 0;
        this.stuckTimer = 0;
        this.fireTimer = 0;
        this.burstCount = 0;
        this.burstCooldown = 0;
        this.riskLevel = 0;
        this.riskTimer = 0;
        this.seekingCover = false;
        this.coverTarget = null;
        this.moveTarget = null;
        this.missionPressure = 0.5;
        // Personality-weighted weapon on respawn
        this.weaponId = this._pickWeapon();
        const def = WeaponDefs[this.weaponId];
        this.weaponDef = def;
        this.soldier.setWeaponModel(this.weaponId);
        this.fireInterval = 60 / def.fireRate;
        this.magazineSize = def.magazineSize;
        this.reloadTime = def.reloadTime;
        this.baseSpread = def.baseSpread;
        this.maxSpread = def.maxSpread;
        this.spreadIncreasePerShot = def.spreadIncreasePerShot;
        this.spreadRecoveryRate = def.spreadRecoveryRate;
        this.moveSpeed = 4.125 * (def.moveSpeedMult || 1.0);
        this.burstMax = this.weaponId === 'BOLT' ? 1
            : this.weaponId === 'LMG'
                ? 20 + Math.floor(Math.random() * 10)
                : 8 + Math.floor(Math.random() * 8);
        // Reset bolt state
        this.boltTimer = 0;
        this._boltAimTimer = 0;
        this._lastAimTarget = null;
        this.isScoped = false;
        // Reset ammo and spread on respawn
        this.currentAmmo = this.magazineSize;
        this.isReloading = false;
        this.reloadTimer = 0;
        this.currentSpread = this.baseSpread;
        // Reset grenade state
        this.grenadeCount = WeaponDefs.GRENADE.maxPerLife;
        this.grenadeCooldown = 0;
        this._engageTimer = 0;
        this._lastEngageEnemy = null;
        this._grenadeTargetPos = null;
        this._grenadeThrowTimer = 0;
        this._grenadeThrowPitch = 0;
        // Reset visual state
        this._smoothAimPitch = 0;
        // Reset jump and inertia state
        this.isJumping = false;
        this.jumpVelY = 0;
        this._velX = 0;
        this._velZ = 0;
        // Reset path state
        this.currentPath = [];
        this.pathIndex = 0;
        this._pathCooldown = 0;
        this._lastRiskLevel = 0;
        this._noPathFound = false;
    }

    // ───── Debug Path Line ─────

    _ensureDebugPath(pointCount) {
        if (this._debugArc && this._debugArcSize >= pointCount) {
            return this._debugArc;
        }
        // (Re)create with enough capacity
        if (this._debugArc) {
            this._debugArc.geometry.dispose();
            this._debugArc.material.dispose();
            this.soldier.scene.remove(this._debugArc);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(pointCount * 3), 3));
        const mat = new THREE.LineBasicMaterial({ color: 0xffdd00, transparent: true, opacity: 0.7 });
        const line = new THREE.Line(geo, mat);
        line.frustumCulled = false;
        this.soldier.scene.add(line);
        this._debugArc = line;
        this._debugArcSize = pointCount;
        return line;
    }

    _updateDebugArc() {
        if (!AIController.debugArcs) {
            if (this._debugArc) this._debugArc.visible = false;
            return;
        }

        if (!this.soldier.alive || !this.moveTarget) {
            if (this._debugArc) this._debugArc.visible = false;
            return;
        }

        // Build key-point list: soldier → remaining waypoints → moveTarget
        const myPos = this.soldier.getPosition();
        const keys = [{ x: myPos.x, z: myPos.z }];

        if (this.currentPath.length > 0 && this.pathIndex < this.currentPath.length) {
            for (let i = this.pathIndex; i < this.currentPath.length; i++) {
                keys.push(this.currentPath[i]);
            }
        }
        keys.push({ x: this.moveTarget.x, z: this.moveTarget.z });

        // Subdivide each segment so the line hugs terrain (~1.5m steps)
        const SUB_STEP = 1.5;
        const groundOffset = 0.3;
        const verts = [];

        for (let k = 0; k < keys.length - 1; k++) {
            const ax = keys[k].x, az = keys[k].z;
            const bx = keys[k + 1].x, bz = keys[k + 1].z;
            const dx = bx - ax, dz = bz - az;
            const segLen = Math.sqrt(dx * dx + dz * dz);
            const steps = Math.max(1, Math.ceil(segLen / SUB_STEP));

            for (let s = 0; s < steps; s++) {
                const t = s / steps;
                const px = ax + dx * t;
                const pz = az + dz * t;
                verts.push(px, this.getHeightAt(px, pz) + groundOffset, pz);
            }
        }
        // Final point
        const last = keys[keys.length - 1];
        verts.push(last.x, this.getHeightAt(last.x, last.z) + groundOffset, last.z);

        const totalPts = verts.length / 3;
        const line = this._ensureDebugPath(totalPts);
        line.visible = true;

        const positions = line.geometry.attributes.position;
        for (let i = 0; i < totalPts; i++) {
            positions.setXYZ(i, verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
        }
        // Collapse unused
        for (let i = totalPts; i < this._debugArcSize; i++) {
            positions.setXYZ(i, verts[verts.length - 3], verts[verts.length - 2], verts[verts.length - 1]);
        }
        positions.needsUpdate = true;
        line.geometry.setDrawRange(0, totalPts);
    }

    // ───── Tactical Label ─────

    _getTacticText() {
        if (this.fallbackTarget) return 'FALLBACK';
        if (this.rushTarget) return this.squad && this.squad.rushActive ? 'RUSH!' : 'RALLY';
        if (this.suppressionTarget && this.suppressionTimer > 0) return 'SUPPRESS';
        if (this.crossfirePos) return 'CROSSFIRE';
        if (this.isReloading) return null; // normal, no label
        if (this.currentAmmo <= 0 && this.squad && !this.squad.canReload(this)) return 'HOLD';
        return null;
    }

    _createTacLabel(text) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const c = canvas.getContext('2d');
        c.clearRect(0, 0, 256, 64);
        c.fillStyle = 'rgba(0,0,0,0.5)';
        c.roundRect(8, 4, 240, 56, 8);
        c.fill();
        c.fillStyle = '#ffffff';
        c.font = 'bold 36px Arial';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(text, 128, 32);

        const tex = new THREE.CanvasTexture(canvas);
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(2.7, 0.675, 1);
        sprite.position.set(0, 2.2, 0);
        sprite.renderOrder = 999;
        return sprite;
    }

    _updateTacLabel() {
        if (!AIController.showTacLabels) {
            if (this._tacLabel) this._tacLabel.visible = false;
            return;
        }

        const text = this._getTacticText();

        if (!text) {
            if (this._tacLabel) {
                this._tacLabel.visible = false;
                this._tacLabelText = '';
            }
            return;
        }

        if (text === this._tacLabelText && this._tacLabel) {
            this._tacLabel.visible = true;
            return;
        }

        // Create or re-create sprite with new text
        if (this._tacLabel) {
            this._tacLabel.material.map.dispose();
            this._tacLabel.material.dispose();
            this.soldier.mesh.remove(this._tacLabel);
        }
        this._tacLabel = this._createTacLabel(text);
        this._tacLabel.raycast = () => {}; // exclude from hitscan raycaster
        this.soldier.mesh.add(this._tacLabel);
        this._tacLabelText = text;
    }

    // ───── Visual Sync ─────

    _updateSoldierVisual(dt) {
        if (!this.soldier.alive) return;

        const soldier = this.soldier;
        const myPos = soldier.getPosition();

        // Upper body faces aiming direction (facingDir) + pitch
        const aimAngle = Math.atan2(-this.facingDir.x, -this.facingDir.z);
        if (soldier.upperBody) {
            soldier.upperBody.rotation.y = aimAngle;
            // Compute pitch toward aimPoint when engaging or pre-aiming
            // Pitch only the shoulder pivot (arms + gun), torso stays upright
            if (soldier.shoulderPivot) {
                let targetPitch = 0;
                if (this._grenadeThrowTimer > 0) {
                    targetPitch = this._grenadeThrowPitch;
                } else if ((this.targetEnemy && this.targetEnemy.alive && this.hasReacted) || this._preAimActive) {
                    const dx = this.aimPoint.x - myPos.x;
                    const dy = this.aimPoint.y - (myPos.y + 1.35);
                    const dz = this.aimPoint.z - myPos.z;
                    const hDist = Math.sqrt(dx * dx + dz * dz);
                    if (hDist > 0.1) targetPitch = Math.atan2(dy, hDist);
                }
                // Smooth aim pitch independently, then add reload tilt
                if (this._smoothAimPitch === undefined) this._smoothAimPitch = 0;
                this._smoothAimPitch += (targetPitch - this._smoothAimPitch) * 0.15;
                soldier.shoulderPivot.rotation.x = this._smoothAimPitch + (soldier._gunReloadTilt || 0);
            }
        }

        // Lower body faces movement direction
        if (soldier.lowerBody) {
            // Compute movement direction from lastPos → currentPos
            const dx = myPos.x - this.lastPos.x;
            const dz = myPos.z - this.lastPos.z;
            const moveSpeed = Math.sqrt(dx * dx + dz * dz) / Math.max(dt, 0.001);

            if (moveSpeed > 0.3) {
                const moveAngle = Math.atan2(-dx, -dz);
                soldier.lowerBody.rotation.y = _lerpAngle(soldier.lowerBody.rotation.y, moveAngle, 1 - Math.exp(-10 * dt));
            } else {
                // Idle: gradually align lower body to upper body
                soldier.lowerBody.rotation.y = _lerpAngle(soldier.lowerBody.rotation.y, aimAngle, 1 - Math.exp(-5 * dt));
            }

            // Drive walk animation
            soldier.animateWalk(dt, moveSpeed);
        }

        // No need to rotate the root mesh — upper/lower body handle it
        soldier.mesh.rotation.y = 0;

        // Tactical label above head
        this._updateTacLabel();
    }

    /** Set references for player damage. */
    setPlayerRef(player) {
        this._playerRef = player;
        this._playerMesh = player.mesh;
    }
}
