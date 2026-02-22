import * as THREE from 'three';
import { BTState, Selector, Sequence, Condition, Action } from './BehaviorTree.js';
import { PersonalityTypes } from './Personality.js';
import { findFlankPosition, computePreAimPoint, computeSuppressionTarget, findRidgelineAimPoint } from './TacticalActions.js';
import { WeaponDefs } from '../entities/WeaponDefs.js';
import { HELI_PASSENGER_SLOTS, HELI_PILOT_OFFSET } from '../entities/Helicopter.js';
import { shouldThrowGrenade, actionThrowGrenade } from './AIGrenade.js';
import { updateMovement, validateMoveTarget } from './AIMovement.js';
import { updateAiming, updateShooting } from './AIShooter.js';
import { shouldUseVehicle, actionBoardVehicle, actionDriveVehicle, updateVehicleDriving, exitVehicle as exitVehicleFn } from './AIVehicleController.js';
import { updateSoldierVisual, updateUpperBodyAim, updateDebugArc } from './AIVisual.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _strafeDir = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();
const _aimDirVec = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _raycaster = new THREE.Raycaster();

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

        // Per-frame references (set by update(), used by updateContinuous())
        this.enemies = [];
        this.allies = [];
        this.collidables = [];

        // Squad (set externally by AIManager)
        this.squad = null;
        this.flankSide = 1;

        // Target management
        this.targetEnemy = null;
        this._targetLOSLevel = 1; // 1=body visible, 2=head-only
        this.targetFlag = null;
        this.moveTarget = null;
        this._moveTargetVec = new THREE.Vector3(); // pre-allocated for moveTarget assignments

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
        this._waitingForPath = false; // true while async A* request is in flight

        // Tactical state
        this.riskLevel = 0;
        this.riskTimer = 0;
        this.seekingCover = false;
        this.coverTarget = null;
        this.occupiedCover = null; // actual cover object from CoverSystem

        // Damage-awareness: attacker injected as visible for 0.5s
        this._damageSource = null;   // Soldier ref
        this._damageSourceTimer = 0;

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

        // Vehicle state
        this.vehicle = null;          // currently driving
        this._vehicleBoardTarget = null; // vehicle we're walking toward
        this._vehicleMoveTarget = null;  // where we're trying to go via vehicle
        this._vehicleOrbitAngle = 0;     // helicopter orbit angle
        this._heliWaitingForPassengers = false;
        this._heliWaitTimer = 0;      // countdown after first passenger boards
        this._vehicleFireBlocked = false;
        this.vehicleManager = null;   // set by AIManager

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

            // 1b. Currently driving a vehicle — drive toward destination
            new Sequence([
                new Condition(() => ctx.vehicle !== null),
                new Action(() => actionDriveVehicle(ctx)),
            ]),

            // 1c. Should board a vehicle — walk toward it
            new Sequence([
                new Condition(() => shouldUseVehicle(ctx)),
                new Action(() => actionBoardVehicle(ctx)),
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
                new Condition(() => shouldThrowGrenade(ctx)),
                new Action(() => actionThrowGrenade(ctx)),
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
        if (!this.soldier.alive) {
            // Eject from vehicle on death
            if (this.vehicle) exitVehicleFn(this);
            return;
        }

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
     * @param {Soldier|null} attacker - the soldier that dealt damage
     */
    onDamaged(attacker) {
        this.btTimer = this.btInterval; // triggers BT on next update()
        // Halve path cooldown so A* recomputes sooner for the new moveTarget
        // (don't clear currentPath — let COM keep moving until BT picks a new destination)
        this._pathCooldown *= 0.5;

        // Damage-awareness: remember attacker so scan results can inject them as visible.
        // Don't reportSighting here — applyScanResults handles it to keep seenByCount balanced.
        if (attacker && attacker.alive && attacker.team !== this.team) {
            this._damageSource = attacker;
            this._damageSourceTimer = 0.5;
        }
    }

    /**
     * Continuous update — called EVERY frame for ALL alive AIs.
     * Handles aiming + shooting so fire rate is not throttled by stagger.
     */
    updateContinuous(dt) {
        if (!this.soldier.alive) {
            // Flush tracked enemies as lost so contacts don't stay VISIBLE forever
            // (runs once — subsequent frames find size === 0)
            if (this._previouslyVisible.size > 0 && this.teamIntel) {
                for (const prev of this._previouslyVisible) {
                    this.teamIntel.reportLost(prev);
                }
                this._previouslyVisible.clear();
            }
            if (this._tacLabel && this._tacLabel.visible) {
                this._tacLabel.visible = false;
                this._tacLabelText = '';
            }
            return;
        }

        // Target switch cooldowns
        if (this._targetSwitchCooldown > 0) this._targetSwitchCooldown -= dt;
        if (this._preAimCooldown > 0) this._preAimCooldown -= dt;

        // Decay damage-awareness timer
        if (this._damageSourceTimer > 0) {
            this._damageSourceTimer -= dt;
            if (this._damageSourceTimer <= 0) this._damageSource = null;
        }

        // Threat scan is now handled by AIManager's Web Worker — see applyScanResults()

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

        // In vehicle — drive (if pilot) and/or shoot (if helicopter)
        if (this.vehicle) {
            // Only the pilot drives
            if (this.vehicle.driver === this.soldier) {
                updateVehicleDriving(this, dt);
            }
            // Sync soldier position to vehicle
            if (this.vehicle.mesh) {
                const vp = this.vehicle.mesh.position;
                const rotY = this.vehicle.rotationY;

                if (this.vehicle.type === 'helicopter') {
                    const heli = this.vehicle;
                    if (heli.driver === this.soldier) {
                        // Pilot: cockpit position (seated)
                        heli.getWorldSeatPos(_tmpVec, HELI_PILOT_OFFSET);
                        this.soldier.body.position.set(_tmpVec.x, _tmpVec.y, _tmpVec.z);
                        this.soldier.mesh.position.copy(_tmpVec);
                        // Tilt with helicopter (yaw+pitch+roll via cached quaternion)
                        this.soldier.mesh.quaternion.copy(heli._cachedWorldQuat);
                        // Body faces forward relative to helicopter
                        if (this.soldier.lowerBody) this.soldier.lowerBody.rotation.y = Math.PI;
                        if (this.soldier.upperBody) {
                            this.soldier.upperBody.rotation.y = Math.PI;
                            if (this.soldier.shoulderPivot) this.soldier.shoulderPivot.rotation.x = 0;
                        }
                        // Legs forward 90°
                        if (this.soldier.leftLeg) this.soldier.leftLeg.rotation.x = Math.PI / 2;
                        if (this.soldier.rightLeg) this.soldier.rightLeg.rotation.x = Math.PI / 2;
                    } else {
                        // Passenger: door slot (seated, legs face outward)
                        const slotIdx = heli.passengers.indexOf(this.soldier);
                        if (slotIdx >= 0 && slotIdx < HELI_PASSENGER_SLOTS.length) {
                            const slot = HELI_PASSENGER_SLOTS[slotIdx];
                            heli.getWorldSeatPos(_tmpVec, slot);
                            this.soldier.body.position.set(_tmpVec.x, _tmpVec.y, _tmpVec.z);
                            this.soldier.mesh.position.copy(_tmpVec);
                            // Update facingDir for upper body aiming (world space)
                            const outward = rotY + slot.facingOffset;
                            if (this.targetEnemy && this.targetEnemy.alive && this.hasReacted) {
                                const sp = this.soldier.getPosition();
                                const adx = this.aimPoint.x - sp.x;
                                const adz = this.aimPoint.z - sp.z;
                                const hd = Math.sqrt(adx * adx + adz * adz);
                                if (hd > 0.1) this.facingDir.set(adx / hd, 0, adz / hd);
                            } else {
                                this.facingDir.set(-Math.sin(outward), 0, -Math.cos(outward));
                            }
                            updateUpperBodyAim(this, dt);
                            // Tilt with helicopter (yaw+pitch+roll via cached quaternion)
                            this.soldier.mesh.quaternion.copy(heli._cachedWorldQuat);
                            // Lower body: outward relative to helicopter
                            if (this.soldier.lowerBody) {
                                this.soldier.lowerBody.rotation.y = slot.facingOffset;
                            }
                            // Convert world-space aim to helicopter-local space
                            // (accounts for yaw + pitch + roll simultaneously)
                            if (this.soldier.upperBody) {
                                const worldYaw = this.soldier.upperBody.rotation.y;
                                const worldPitch = this._aimPitch || 0;
                                const cp = Math.cos(worldPitch);
                                _aimDirVec.set(
                                    -Math.sin(worldYaw) * cp,
                                    Math.sin(worldPitch),
                                    -Math.cos(worldYaw) * cp
                                );
                                _tmpQuat.copy(heli._cachedWorldQuat).invert();
                                _aimDirVec.applyQuaternion(_tmpQuat);
                                this.soldier.upperBody.rotation.y =
                                    Math.atan2(-_aimDirVec.x, -_aimDirVec.z);
                                if (this.soldier.shoulderPivot) {
                                    const hd = Math.sqrt(
                                        _aimDirVec.x * _aimDirVec.x +
                                        _aimDirVec.z * _aimDirVec.z
                                    );
                                    this.soldier.shoulderPivot.rotation.x =
                                        Math.atan2(_aimDirVec.y, hd) +
                                        (this.soldier._gunReloadTilt || 0);
                                }
                            }
                            // Legs forward 45° (sitting pose)
                            if (this.soldier.leftLeg) this.soldier.leftLeg.rotation.x = Math.PI / 4;
                            if (this.soldier.rightLeg) this.soldier.rightLeg.rotation.x = Math.PI / 4;
                        }
                    }
                } else {
                    // Other vehicle types: center
                    this.soldier.body.position.set(vp.x, vp.y, vp.z);
                    this.soldier.mesh.position.set(vp.x, vp.y, vp.z);
                }
            }
            // Helicopter passengers (not pilot) can aim and shoot — only on their side
            const isPassenger = this.vehicle.driver !== this.soldier;
            if (this.vehicle.type === 'helicopter' && isPassenger) {
                let canFire = false;
                if (this.targetEnemy && this.targetEnemy.alive) {
                    const slotIdx = this.vehicle.passengers.indexOf(this.soldier);
                    const isLeftSeat = slotIdx >= 0 && slotIdx % 2 === 0;
                    const ep = this.targetEnemy.getPosition();
                    const hx = this.vehicle.mesh.position.x;
                    const hz = this.vehicle.mesh.position.z;
                    const rY = this.vehicle.rotationY;
                    const cross = Math.sin(rY) * (ep.z - hz) - Math.cos(rY) * (ep.x - hx);
                    canFire = isLeftSeat ? cross > 0 : cross < 0;
                }
                this._vehicleFireBlocked = !canFire;
                if (canFire) {
                    this.hasReacted = true;
                    updateAiming(this, dt);
                } else {
                    this.hasReacted = false;
                }
                updateShooting(this, dt);
            }
            return;
        }

        updateMovement(this, dt);
        updateSoldierVisual(this, dt);
        updateDebugArc(this);
        updateAiming(this, dt);
        updateShooting(this, dt);
    }

    /**
     * Apply scan results from the threat scan Web Worker.
     * Replaces the old per-frame _updateThreatScan() that ran on main thread.
     * @param {Array<{enemy, dist, losLevel}>} visibleEnemies — enemies this AI can see
     * @param {Soldier|null} closestEnemy — nearest visible enemy
     * @param {number} closestDist — distance to nearest
     * @param {number} closestLOS — LOS level of nearest (1=body, 2=head-only)
     */
    applyScanResults(visibleEnemies, closestEnemy, closestDist, closestLOS, closestDot = 1) {
        const currentlyVisible = this._useSetA ? this._visSetA : this._visSetB;
        currentlyVisible.clear();

        for (const ve of visibleEnemies) {
            currentlyVisible.add(ve.enemy);

            // Report to TeamIntel
            if (this.teamIntel) {
                const ePos = ve.enemy.getPosition();
                if (this._previouslyVisible.has(ve.enemy)) {
                    this.teamIntel.refreshContact(ve.enemy, ePos, ve.enemy.body.velocity, ve.enemy.vehicle !== null);
                } else {
                    this.teamIntel.reportSighting(ve.enemy, ePos, ve.enemy.body.velocity, ve.enemy.vehicle !== null);
                }
            }
        }

        // Report lost contacts
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
            this._targetLOSLevel = closestLOS;
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
                    const t = Math.max(0, Math.min(1, closestDist / 60));
                    const p = this.personality;
                    const distFactor = p.nearReaction + (p.farReaction - p.nearReaction) * t;
                    const losFactor = this._targetLOSLevel === 2 ? 1.4 : 1.0;
                    // angleFactor: baseline 0.933 so that 30° (dot≈0.866) yields 1.0 (unchanged),
                    // crosshair center is slightly faster, FOV edge (~102°) reaches ~1.53
                    const angleFactor = 0.933 + 0.5 * (1 - closestDot);
                    this.reactionTimer = p.reactionTime / 1000 * distFactor * losFactor * angleFactor +
                        (Math.random() * 0.15);
                    const aimSpread = Math.max(0.3, Math.min(1.0, closestDist / 25));
                    this.aimOffset.set(
                        (Math.random() - 0.5) * 2 * aimSpread,
                        (Math.random() - 0.5) * 1.5 * aimSpread,
                        (Math.random() - 0.5) * 2 * aimSpread
                    );
                }
            }
        } else {
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
                validateMoveTarget(this);
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
                this.moveTarget = this._moveTargetVec.copy(chosen.position).addScaledVector(threatDir, -5);
                validateMoveTarget(this);
                this.seekingCover = true;
                return BTState.RUNNING;
            }
        }

        // Last resort: move away from enemy
        if (this.targetEnemy) {
            const enemyPos = this.targetEnemy.getPosition();
            _v1.subVectors(myPos, enemyPos).normalize();
            const lateralSign = Math.random() > 0.5 ? 1 : -1;
            this.moveTarget = this._moveTargetVec.set(
                myPos.x + _v1.x * 8 + _v1.z * 5 * lateralSign,
                myPos.y,
                myPos.z + _v1.z * 8 + (-_v1.x) * 5 * lateralSign
            );
            validateMoveTarget(this);
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
                actionThrowGrenade(this);
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
            validateMoveTarget(this);
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
                this.moveTarget = this._moveTargetVec.copy(this.rushTarget);
                validateMoveTarget(this);
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
                    actionThrowGrenade(this);
                }
            }

            // Rush active — charge the flag
            this.moveTarget = this._moveTargetVec.copy(this.rushTarget);
            validateMoveTarget(this);
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
        validateMoveTarget(this);
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
        this.moveTarget = this._moveTargetVec.copy(nearest.lastSeenPos);
        validateMoveTarget(this);

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
                this.moveTarget = this._moveTargetVec.copy(_tmpVec);
                validateMoveTarget(this);
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
                this.moveTarget = this._moveTargetVec.copy(_tmpVec);
            } else if (dist > idealMax) {
                // Too far — close distance slightly
                _tmpVec.copy(enemyPos);
                _tmpVec.x += toEnemy.x * -idealMin + _strafeDir.x * strafeSide * 8;
                _tmpVec.z += toEnemy.z * -idealMin + _strafeDir.z * strafeSide * 8;
                this.moveTarget = this._moveTargetVec.copy(_tmpVec);
            } else {
                // Sweet spot — strafe only, maintain range
                _tmpVec.copy(myPos);
                _tmpVec.x += _strafeDir.x * strafeSide * 8;
                _tmpVec.z += _strafeDir.z * strafeSide * 8;
                this.moveTarget = this._moveTargetVec.copy(_tmpVec);
            }
        } else if (dist > 35) {
            // Far away: move toward enemy position directly — let A* handle routing
            _tmpVec.copy(enemyPos);
            this.moveTarget = this._moveTargetVec.copy(_tmpVec);
        } else if (dist < 10) {
            _tmpVec.copy(myPos);
            _tmpVec.x += toEnemy.x * -3 + _strafeDir.x * strafeSide * 4;
            _tmpVec.z += toEnemy.z * -3 + _strafeDir.z * strafeSide * 4;
            this.moveTarget = this._moveTargetVec.copy(_tmpVec);
        } else {
            // Medium range: strafe but use a longer offset so A* can route properly
            _tmpVec.copy(enemyPos);
            _tmpVec.x += _strafeDir.x * strafeSide * 8;
            _tmpVec.z += _strafeDir.z * strafeSide * 8;
            this.moveTarget = this._moveTargetVec.copy(_tmpVec);
        }
        validateMoveTarget(this);

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
                this.moveTarget = this._moveTargetVec.copy(formationPos);
                validateMoveTarget(this);
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
            this.moveTarget = this._moveTargetVec.set(
                flagPos.x + Math.cos(angle) * radius,
                flagPos.y,
                flagPos.z + Math.sin(angle) * radius
            );
            this.missionPressure = 0.0;
        } else {
            // BOLT COMs don't rush to the flag center — stop at overwatch range
            if (this.weaponId === 'BOLT' && dist < 25) {
                const baseAngle = (this.soldier.id / 12) * Math.PI * 2;
                const radius = 20 + Math.random() * 5;
                this.moveTarget = this._moveTargetVec.set(
                    flagPos.x + Math.cos(baseAngle) * radius,
                    flagPos.y,
                    flagPos.z + Math.sin(baseAngle) * radius
                );
            } else {
                this.moveTarget = this._moveTargetVec.copy(flagPos);
            }
            this.missionPressure = 0.5;
        }
        validateMoveTarget(this);

        this.seekingCover = false;
        return BTState.RUNNING;
    }

    _actionPatrol() {
        const myPos = this.soldier.getPosition();
        if (!this.moveTarget || myPos.distanceTo(this.moveTarget) < 3) {
            const flag = this.targetFlag || this.flags[0];
            const fp = flag.position;
            this.moveTarget = this._moveTargetVec.set(
                fp.x + (Math.random() - 0.5) * 30,
                fp.y,
                fp.z + (Math.random() - 0.5) * 20
            );
            validateMoveTarget(this);
        }
        this.missionPressure = 1.0;
        return BTState.RUNNING;
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
        // Flush observed enemies as lost so ref counts are decremented
        if (this._previouslyVisible.size > 0 && this.teamIntel) {
            for (const prev of this._previouslyVisible) {
                this.teamIntel.reportLost(prev);
            }
        }
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
        this._aimPitch = 0;
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
        this._waitingForPath = false;
    }

    /** Set references for player damage. */
    setPlayerRef(player) {
        this._playerRef = player;
        this._playerMesh = player.mesh;
    }
}
