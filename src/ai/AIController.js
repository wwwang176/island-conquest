import * as THREE from 'three';
import { BTState, Selector, Sequence, Condition, Action } from './BehaviorTree.js';
import { PersonalityTypes } from './Personality.js';
import { findFlankPosition, computePreAimPoint, computeSuppressionTarget } from './TacticalActions.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();

/**
 * AI Controller for a single COM soldier.
 * Manages behavior tree, movement, aiming, shooting, and tactical decisions.
 */
export class AIController {
    constructor(soldier, personality, team, flags, getHeightAt, coverSystem, teamIntel, eventBus) {
        this.soldier = soldier;
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
        this.targetFlag = null;
        this.moveTarget = null;

        // Suppression state (set by SquadCoordinator)
        this.suppressionTarget = null;  // TeamIntel contact
        this.suppressionTimer = 0;

        // Mission pressure: 0.0 capturing, 0.5 moving, 1.0 idle
        this.missionPressure = 0.5;

        // Aim state
        this.aimPoint = new THREE.Vector3();
        this.aimOffset = new THREE.Vector3();
        this.reactionTimer = 0;
        this.hasReacted = false;
        this.aimCorrectionSpeed = 2 + this.personality.aimSkill * 3;

        // Firing state
        this.fireTimer = 0;
        this.fireInterval = 0.10; // ~600 RPM for AI
        this.burstCount = 0;
        this.burstMax = 8 + Math.floor(Math.random() * 8);
        this.burstCooldown = 0;

        // Magazine / reload
        this.magazineSize = 30;
        this.currentAmmo = 30;
        this.isReloading = false;
        this.reloadTimer = 0;
        this.reloadTime = 2.5; // seconds

        // Movement
        this.moveSpeed = 5.5;
        this.moveDir = new THREE.Vector3();
        this.facingDir = new THREE.Vector3(0, 0, -1);
        this.avoidDir = new THREE.Vector3();
        this.stuckTimer = 0;
        this.lastPos = new THREE.Vector3();
        this.jumpVelY = 0;      // manual Y velocity for kinematic jumping
        this.isJumping = false;

        // ThreatMap (set by AIManager)
        this.threatMap = null;

        // Pathfinding
        this.navGrid = null;         // set by AIManager
        this.currentPath = [];       // [{x, z}, ...]
        this.pathIndex = 0;
        this.lastPathTarget = null;  // THREE.Vector3
        this._pathCooldown = 0;      // seconds until next A* allowed
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

        // Behavior tree update throttle
        this.btTimer = 0;
        this.btInterval = 0.15 + Math.random() * 0.1;

        // Build behavior tree
        this.behaviorTree = this._buildBehaviorTree();

        // Debug: movement arc visualization
        this._debugArc = this._createDebugArc();
        this.soldier.scene.add(this._debugArc);
    }

    _buildBehaviorTree() {
        const ctx = this;
        return new Selector([
            // 1. Dead — wait for respawn
            new Sequence([
                new Condition(() => !ctx.soldier.alive),
                new Action(() => BTState.SUCCESS),
            ]),

            // 2. Under heavy threat — seek cover
            new Sequence([
                new Condition(() => ctx.riskLevel > ctx.personality.riskThreshold),
                new Action(() => ctx._actionSeekCover()),
            ]),

            // 3. Suppression fire (assigned by squad)
            new Sequence([
                new Condition(() => ctx.suppressionTarget !== null && ctx.suppressionTimer > 0),
                new Action(() => ctx._actionSuppress()),
            ]),

            // 4. Investigate intel contact (nearby suspected enemy, no direct visual)
            new Sequence([
                new Condition(() => ctx.targetEnemy === null && ctx._hasNearbyIntelContact()),
                new Action(() => ctx._actionInvestigate()),
            ]),

            // 5. Has visible enemy — engage
            new Sequence([
                new Condition(() => ctx.targetEnemy !== null),
                new Action(() => ctx._actionEngage()),
            ]),

            // 6. Has flag target — move to capture
            new Sequence([
                new Condition(() => ctx.targetFlag !== null),
                new Action(() => ctx._actionCaptureFlag()),
            ]),

            // 7. Default — find something to do
            new Action(() => ctx._actionPatrol()),
        ]);
    }

    /**
     * Staggered update — called for a subset of AIs each frame.
     * Handles BT decisions, threat scanning, movement.
     */
    update(dt, enemies, allies, collidables) {
        if (!this.soldier.alive) {
            this._onDeath();
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

        // Behavior tree (throttled)
        this.btTimer += dt;
        if (this.btTimer >= this.btInterval) {
            this.btTimer = 0;
            this._updateThreatScan();
            this._updateRisk(dt);
            this._chooseFlagTarget();
            this.behaviorTree.tick(this);
        }

        // Movement + visual moved to updateContinuous for smooth motion
    }

    /**
     * Continuous update — called EVERY frame for ALL alive AIs.
     * Handles aiming + shooting so fire rate is not throttled by stagger.
     */
    updateContinuous(dt) {
        if (!this.soldier.alive) return;

        // Decay path cooldown
        if (this._pathCooldown > 0) this._pathCooldown -= dt;

        // Detect risk spike (under attack) → force path recompute
        if (this.riskLevel > this._lastRiskLevel + 0.15 && this._pathCooldown <= 0) {
            this.currentPath = [];
            this.pathIndex = 0;
            this.lastPathTarget = null;
        }
        this._lastRiskLevel = this.riskLevel;

        this._updateMovement(dt);
        this._updateSoldierVisual();
        this._updateDebugArc();
        this._updateAiming(dt);
        this._updateShooting(dt);
    }

    // ───── Threat Scanning ─────

    _updateThreatScan() {
        const myPos = this.soldier.getPosition();
        let closestDist = Infinity;
        let closestEnemy = null;
        const currentlyVisible = new Set();

        for (const enemy of this.enemies) {
            if (!enemy.alive) continue;
            const ePos = enemy.getPosition();
            const dist = myPos.distanceTo(ePos);

            if (dist > 80) continue; // max vision range

            // FOV check (120°)
            _v1.subVectors(ePos, myPos).normalize();
            const dot = this.facingDir.dot(_v1);
            if (dot < -0.2) continue; // behind us (~120° FOV)

            // Line of sight check
            _raycaster.set(
                myPos.clone().add(new THREE.Vector3(0, 1.5, 0)),
                _v1
            );
            _raycaster.far = dist;
            const hits = _raycaster.intersectObjects(this.collidables, true);
            if (hits.length > 0 && hits[0].distance < dist - 1) continue; // blocked

            currentlyVisible.add(enemy);

            // Report sighting to TeamIntel
            if (this.teamIntel) {
                this.teamIntel.reportSighting(enemy, ePos, enemy.body.velocity);
            }

            if (dist < closestDist) {
                closestDist = dist;
                closestEnemy = enemy;
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
        this._previouslyVisible = currentlyVisible;

        // Target switching: only switch if new target is significantly closer
        if (closestEnemy) {
            if (this.targetEnemy !== closestEnemy) {
                this.targetEnemy = closestEnemy;
                this.hasReacted = false;
                this.reactionTimer = this.personality.reactionTime / 1000 +
                    (Math.random() * 0.15);
                // Initial aim offset
                this.aimOffset.set(
                    (Math.random() - 0.5) * 2,
                    (Math.random() - 0.5) * 1.5,
                    (Math.random() - 0.5) * 2
                );
            }
        } else {
            this.targetEnemy = null;
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
            0.20 * exposure +
            0.20 * incomingThreat +
            0.15 * healthRisk +
            0.15 * spatialThreat +
            0.10 * outnumbered +
            0.15 * reloadRisk +
            0.05 * this.missionPressure;
    }

    _chooseFlagTarget() {
        if (this.targetEnemy) return; // don't change flag target during combat

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

    // ───── Intel Helpers ─────

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

        // Fire at predicted cover edge / last known position
        const target = computeSuppressionTarget(this.suppressionTarget);
        this.aimPoint.copy(target);
        this.aimOffset.set(0, 0, 0);
        this.hasReacted = true; // allow shooting

        // Hold position while suppressing
        this.seekingCover = false;
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
        const preAim = computePreAimPoint(nearest);
        this.aimPoint.copy(preAim);

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
            this.targetEnemy = null;
            return BTState.FAILURE;
        }

        const myPos = this.soldier.getPosition();
        const enemyPos = this.targetEnemy.getPosition();
        const dist = myPos.distanceTo(enemyPos);

        // Flanker personality: request suppression + move to flank
        // Also: Rusher flanks during deep-flank missions (uses opposite side)
        const isFlanker = this.personality.name === 'Flanker';
        const isDeepFlankRusher = this.personality.name === 'Rusher' && this.squad?.isDeepFlank;

        if ((isFlanker || isDeepFlankRusher) && this.squad && this.teamIntel) {
            const contact = this.teamIntel.getContactFor(this.targetEnemy);
            if (contact) {
                this.squad.requestSuppression(contact);
                const side = isDeepFlankRusher ? -this.flankSide : this.flankSide;
                const flankPos = findFlankPosition(
                    myPos, enemyPos, this.coverSystem, side
                );
                this.moveTarget = flankPos;
                this._validateMoveTarget();
                this.seekingCover = false;
                this.missionPressure = 0.5;
                return BTState.RUNNING;
            }
        }

        // Strafe while shooting (move perpendicular to enemy)
        const toEnemy = _v1.subVectors(enemyPos, myPos).normalize();
        const strafeDir = new THREE.Vector3(toEnemy.z, 0, -toEnemy.x);
        let strafeSide = Math.sin(Date.now() * 0.002 + this.soldier.id * 7) > 0 ? 1 : -1;

        // Ally-aware strafe: if an ally is already on the chosen side, flip
        if (this.allies) {
            let alliesOnSide = 0;
            for (const a of this.allies) {
                if (!a.alive || a === this.soldier) continue;
                const aPos = a.getPosition();
                if (myPos.distanceTo(aPos) > 15) continue;
                const toAlly = new THREE.Vector3(aPos.x - myPos.x, 0, aPos.z - myPos.z);
                const dot = strafeDir.x * toAlly.x + strafeDir.z * toAlly.z;
                if (dot * strafeSide > 0) alliesOnSide++;
            }
            if (alliesOnSide >= 2) strafeSide *= -1;
        }

        if (dist > 35) {
            // Far away: move toward enemy position directly — let A* handle routing
            this.moveTarget = enemyPos.clone();
        } else if (dist < 10) {
            this.moveTarget = myPos.clone()
                .add(toEnemy.clone().multiplyScalar(-3))
                .add(strafeDir.clone().multiplyScalar(strafeSide * 4));
        } else {
            // Medium range: strafe but use a longer offset so A* can route properly
            this.moveTarget = enemyPos.clone()
                .add(strafeDir.clone().multiplyScalar(strafeSide * 8));
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
            const formationPos = this.squad.getDesiredPosition(this);
            if (formationPos) {
                this.moveTarget = formationPos;
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
            const radius = 6 + Math.random() * 4; // 6-10m from flag
            this.moveTarget = flagPos.clone().add(
                new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius)
            );
            this.missionPressure = 0.0;
        } else {
            this.moveTarget = flagPos.clone();
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

        const myPos = this.soldier.getPosition();

        if (!forceAStar) {
            // Path is "sticky" — don't recompute while still following a valid path
            const hasActivePath = this.currentPath.length > 0 &&
                this.pathIndex < this.currentPath.length;

            if (hasActivePath) {
                // Only allow recompute if target moved drastically (mission change)
                const targetShift = this.lastPathTarget ?
                    this.moveTarget.distanceTo(this.lastPathTarget) : Infinity;
                if (targetShift < 15) return; // keep current path
            } else {
                // No active path — only skip if target is identical (< 1m)
                // to avoid blocking valid new targets
                if (this.lastPathTarget &&
                    this.moveTarget.distanceTo(this.lastPathTarget) < 1) {
                    return;
                }
            }

            // Cooldown: don't recompute more than once per second
            if (this._pathCooldown > 0) return;
        }

        const path = this.navGrid.findPath(myPos.x, myPos.z, this.moveTarget.x, this.moveTarget.z);
        if (path && path.length > 0) {
            this.currentPath = path;
            this.pathIndex = 0;
            this.lastPathTarget = this.moveTarget.clone();
            this._pathCooldown = 1.0;
            this._noPathFound = false;
        } else {
            // No path found — stay put, wait for BT to pick a new target
            this.currentPath = [];
            this.pathIndex = 0;
            this.lastPathTarget = null;
            this._pathCooldown = 0.5;  // retry after 0.5s
            this._noPathFound = true;
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

        if (!this.moveTarget) return;

        // Request A* path if available
        this._requestPath();

        // If A* failed, don't move — trigger BT to pick a new target
        if (this._noPathFound) {
            this.btTimer = this.btInterval; // force BT re-tick
            this.seekingCover = false;      // allow BT to try different action
            this.lastPos.copy(myPos);
            return;
        }

        // Determine immediate steering target: next waypoint or direct moveTarget
        let steerTarget = this.moveTarget;
        if (this.currentPath.length > 0 && this.pathIndex < this.currentPath.length) {
            const wp = this.currentPath[this.pathIndex];
            steerTarget = new THREE.Vector3(wp.x, 0, wp.z);
            // Advance waypoint when close enough
            const wpDist = Math.sqrt(
                (myPos.x - wp.x) ** 2 + (myPos.z - wp.z) ** 2
            );
            if (wpDist < 1.5) {
                this.pathIndex++;
                if (this.pathIndex >= this.currentPath.length) {
                    // Path completed — clear for immediate re-pathfind
                    this._pathCooldown = 0;
                    this.lastPathTarget = null;
                    steerTarget = this.moveTarget;
                } else {
                    const nextWp = this.currentPath[this.pathIndex];
                    steerTarget = new THREE.Vector3(nextWp.x, 0, nextWp.z);
                }
            }
        }

        _v1.subVectors(steerTarget, myPos);
        _v1.y = 0;
        const dist = _v1.length();

        if (dist < 1) {
            // If following path, advance; otherwise trigger BT re-tick
            if (this.currentPath.length > 0 && this.pathIndex < this.currentPath.length) {
                this.pathIndex++;
            } else {
                this.btTimer = this.btInterval;
            }
            return;
        }

        _v1.normalize();

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

        // Wall sliding disabled — A* handles obstacle avoidance
        let movementBlocked = false;

        const speed = this.seekingCover ? this.moveSpeed * 1.2 : this.moveSpeed;

        // Move horizontally (direct position update)
        const dx = _v1.x * speed * dt;
        const dz = _v1.z * speed * dt;
        const newX = body.position.x + dx;
        const newZ = body.position.z + dz;

        // Effective ground height = max(terrain, obstacle top) at new position
        const newTerrainY = this.getHeightAt(newX, newZ);
        let newGroundY = newTerrainY;
        const downOrigin = new THREE.Vector3(newX, myPos.y + 2.0, newZ);
        _raycaster.set(downOrigin, _v2.set(0, -1, 0));
        _raycaster.far = 4.0;
        const downHits = _raycaster.intersectObjects(this.collidables, true);
        for (const hit of downHits) {
            if (hit.point.y <= newTerrainY + 0.3) continue;
            if (hit.point.y > newGroundY) {
                newGroundY = hit.point.y;
            }
        }

        const currentFootY = body.position.y;
        const currentTerrainY = this.getHeightAt(myPos.x, myPos.z);
        const alreadyOnObstacle = currentFootY > currentTerrainY + 0.3;
        const slopeRise = newGroundY - currentFootY;
        const slopeRun = Math.sqrt(dx * dx + dz * dz);
        const slopeAngle = slopeRun > 0.001 ? Math.atan2(slopeRise, slopeRun) : 0;
        const maxClimbAngle = Math.PI * 0.42; // ~75°
        const isObstacle = newGroundY > newTerrainY + 0.3;

        if (isObstacle && newGroundY > currentFootY + 0.3) {
            // Allow movement only if already on obstacle AND moving downhill (escaping)
            if (alreadyOnObstacle && newGroundY <= currentFootY) {
                // Downhill escape — allow
                body.position.x = newX;
                body.position.z = newZ;
                if (!this.isJumping) body.position.y = newGroundY + 0.05;
            } else {
                movementBlocked = true;
            }
        } else if (slopeAngle < maxClimbAngle) {
            body.position.x = newX;
            body.position.z = newZ;
            if (!this.isJumping) {
                body.position.y = newGroundY + 0.05;
            }
        } else if (isObstacle) {
            movementBlocked = true;
        } else {
            // Steep terrain — trigger jump
            if (!this.isJumping) {
                this.isJumping = true;
                this.jumpVelY = 2.5;
                body.position.x += _v1.x * speed * 0.3 * dt;
                body.position.z += _v1.z * speed * 0.3 * dt;
            }
        }

        // Update facing direction
        if (this.targetEnemy && this.targetEnemy.alive) {
            _v2.subVectors(this.targetEnemy.getPosition(), myPos).normalize();
            _v2.y = 0;
            // Fast turn when aiming (reacted) so body faces where bullets go
            const turnRate = this.hasReacted ? 0.45 : 0.15;
            this.facingDir.lerp(_v2, turnRate).normalize();
        } else {
            this.facingDir.lerp(_v1, 0.1).normalize();
        }

        // Stuck detection
        const barelyMoved = myPos.distanceTo(this.lastPos) < 0.1 * dt;
        if (movementBlocked || barelyMoved) {
            this.stuckTimer += dt;
            if (this.stuckTimer > 0.6) {
                // Force BT to recalculate target on next tick
                this.seekingCover = false;
                this.btTimer = this.btInterval; // trigger BT next frame
                this.stuckTimer = 0;
                // Force A* recompute from current position
                this.currentPath = [];
                this.pathIndex = 0;
                this.lastPathTarget = null;
                this._pathCooldown = 0; // allow immediate recompute
                this._requestPath(true);
            }
        } else {
            this.stuckTimer = 0;
        }
        this.lastPos.copy(myPos);
    }

    // ───── Aiming ─────

    _updateAiming(dt) {
        // For suppression, aim point is already set by _actionSuppress
        if (this.suppressionTarget && this.suppressionTimer > 0) return;

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

        // Aim at enemy center mass with offset
        const enemyPos = this.targetEnemy.getPosition();
        this.aimPoint.copy(enemyPos).add(new THREE.Vector3(0, 1.2, 0));

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

        // Handle reload
        if (this.isReloading) {
            this.reloadTimer -= dt;
            if (this.reloadTimer <= 0) {
                this.currentAmmo = this.magazineSize;
                this.isReloading = false;
            }
            return; // can't shoot while reloading
        }

        // Auto-reload when empty
        if (this.currentAmmo <= 0) {
            this.isReloading = true;
            this.reloadTimer = this.reloadTime;
            return;
        }

        // Allow shooting during suppression
        const isSuppressing = this.suppressionTarget && this.suppressionTimer > 0;

        if (!isSuppressing) {
            if (!this.targetEnemy || !this.targetEnemy.alive || !this.hasReacted) return;
        }
        if (this.burstCooldown > 0) return;

        if (this.fireTimer <= 0) {
            this.fireTimer = this.fireInterval;
            this._fireShot();
            this.currentAmmo--;
            this.burstCount++;

            if (this.burstCount >= this.burstMax) {
                this.burstCount = 0;
                this.burstMax = 6 + Math.floor(Math.random() * 8);
                this.burstCooldown = 0.08 + Math.random() * 0.2;
            }
        }
    }

    _fireShot() {
        const myPos = this.soldier.getPosition();
        const origin = myPos.clone().add(new THREE.Vector3(0, 1.5, 0));

        // Direction to aim point + offset + random spread
        const target = this.aimPoint.clone().add(this.aimOffset);
        const dir = _v1.subVectors(target, origin).normalize();

        // Add weapon spread
        const spread = 0.02 + (1 - this.personality.aimSkill) * 0.03;
        dir.x += (Math.random() - 0.5) * spread;
        dir.y += (Math.random() - 0.5) * spread;
        dir.z += (Math.random() - 0.5) * spread;
        dir.normalize();

        // Hitscan
        _raycaster.set(origin, dir);
        _raycaster.far = 200;

        // Check against all enemies
        const targetMeshes = [];
        for (const e of this.enemies) {
            if (e.alive && e.mesh) targetMeshes.push(e.mesh);
        }
        if (this._playerMesh) targetMeshes.push(this._playerMesh);

        const envHits = _raycaster.intersectObjects(this.collidables, true);
        const charHits = _raycaster.intersectObjects(targetMeshes, true);

        let hitChar = charHits.length > 0 ? charHits[0] : null;
        let hitEnv = envHits.length > 0 ? envHits[0] : null;

        // Determine closest hit distance for tracer length
        let tracerDist = 200;
        if (hitChar && (!hitEnv || hitChar.distance < hitEnv.distance)) {
            tracerDist = hitChar.distance;
        } else if (hitEnv) {
            tracerDist = hitEnv.distance;
        }

        // Spawn tracer VFX
        if (this.tracerSystem) {
            this.tracerSystem.fire(origin, dir.clone(), tracerDist);
        }

        // Notify minimap that this AI fired
        if (this.eventBus) {
            this.eventBus.emit('aiFired', { team: this.team, soldierId: `${this.team}_${this.soldier.id}` });
        }

        const myName = `${this.team === 'teamA' ? 'A' : 'B'}-${this.soldier.id}`;

        if (hitChar && (!hitEnv || hitChar.distance < hitEnv.distance)) {
            for (const enemy of this.enemies) {
                if (!enemy.alive) continue;
                if (this._isChildOf(hitChar.object, enemy.mesh)) {
                    const headshot = hitChar.object === enemy.headMesh;
                    const result = enemy.takeDamage(25, myPos, headshot);
                    if (result.killed && this.eventBus) {
                        const vTeam = enemy.team || (this.team === 'teamA' ? 'teamB' : 'teamA');
                        this.eventBus.emit('kill', {
                            killerName: myName,
                            killerTeam: this.team,
                            victimName: `${vTeam === 'teamA' ? 'A' : 'B'}-${enemy.id}`,
                            victimTeam: vTeam,
                            headshot,
                        });
                    }
                    return;
                }
            }
            if (this._playerRef && this._isChildOf(hitChar.object, this._playerMesh)) {
                const result = this._playerRef.takeDamage(25, myPos, false);
                if (result.killed && this.eventBus) {
                    this.eventBus.emit('kill', {
                        killerName: myName,
                        killerTeam: this.team,
                        victimName: 'You',
                        victimTeam: this._playerRef.team,
                        headshot: false,
                    });
                }
            }
        }
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

    _onDeath() {
        this._releaseCover();
        this.targetEnemy = null;
        this.suppressionTarget = null;
        this.suppressionTimer = 0;
        this._previouslyVisible.clear();
        // Reset ammo on respawn
        this.currentAmmo = this.magazineSize;
        this.isReloading = false;
        this.reloadTimer = 0;
        // Reset jump state
        this.isJumping = false;
        this.jumpVelY = 0;
        // Reset path state
        this.currentPath = [];
        this.pathIndex = 0;
        this.lastPathTarget = null;
        this._pathCooldown = 0;
        this._lastRiskLevel = 0;
        this._noPathFound = false;
    }

    // ───── Debug Arc ─────

    _createDebugArc() {
        const segments = 20;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(segments * 3), 3));
        const color = this.team === 'teamA' ? 0x4488ff : 0xff4444;
        const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 });
        const line = new THREE.Line(geo, mat);
        line.frustumCulled = false;
        return line;
    }

    _updateDebugArc() {
        const arc = this._debugArc;
        if (!this.soldier.alive || !this.moveTarget) {
            arc.visible = false;
            return;
        }
        arc.visible = true;

        const start = this.soldier.getPosition();
        const end = this.moveTarget;
        const dist = start.distanceTo(end);
        const peakHeight = Math.min(dist * 0.3, 8); // arc height proportional to distance

        const positions = arc.geometry.attributes.position;
        const segments = positions.count;
        for (let i = 0; i < segments; i++) {
            const t = i / (segments - 1);
            const x = start.x + (end.x - start.x) * t;
            const z = start.z + (end.z - start.z) * t;
            const baseY = start.y + (end.y - start.y) * t;
            // Parabola: 4*t*(1-t) peaks at t=0.5
            const arcY = baseY + peakHeight * 4 * t * (1 - t);
            positions.setXYZ(i, x, arcY + 1.5, z);
        }
        positions.needsUpdate = true;
    }

    // ───── Visual Sync ─────

    _updateSoldierVisual() {
        if (!this.soldier.alive) return;
        // Mesh default forward is -Z, so negate to align with facingDir
        const angle = Math.atan2(-this.facingDir.x, -this.facingDir.z);
        this.soldier.mesh.rotation.y = angle;

        if (this.soldier.gunMesh && this.targetEnemy && this.hasReacted) {
            const myPos = this.soldier.getPosition();
            const targetPos = this.targetEnemy.getPosition();
            const gunAngle = Math.atan2(
                targetPos.x - myPos.x,
                targetPos.z - myPos.z
            ) - angle;
            this.soldier.gunMesh.rotation.y = gunAngle;
        }
    }

    /** Set references for player damage. */
    setPlayerRef(player) {
        this._playerRef = player;
        this._playerMesh = player.mesh;
    }
}
