/**
 * AI Movement logic — extracted from AIController.
 * Function-bag pattern: each function takes `ctx` (AIController instance).
 */
import * as THREE from 'three';
import { findRidgelineAimPoint } from './TacticalActions.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();

/** Ensure moveTarget is on a walkable NavGrid cell. */
export function validateMoveTarget(ctx) {
    if (!ctx.moveTarget || !ctx.navGrid) return;
    const g = ctx.navGrid.worldToGrid(ctx.moveTarget.x, ctx.moveTarget.z);
    if (!ctx.navGrid.isWalkable(g.col, g.row)) {
        const nearest = ctx.navGrid._findNearestWalkable(g.col, g.row);
        if (nearest) {
            const w = ctx.navGrid.gridToWorld(nearest.col, nearest.row);
            ctx.moveTarget.x = w.x;
            ctx.moveTarget.z = w.z;
        }
    }
}

/** Request A* path from current position to moveTarget (async via Worker). */
export function requestPath(ctx, forceAStar = false) {
    if (!ctx.navGrid || !ctx.moveTarget) return;

    if (!forceAStar) {
        if (ctx._pathCooldown > 0) return;
    }
    if (ctx._waitingForPath) return; // prevent duplicate requests

    const myPos = ctx.soldier.getPosition();

    // Pass threat grid directly (avoid per-neighbour callback overhead)
    const tm = ctx.threatMap;

    ctx._waitingForPath = true;
    ctx._pathCooldown = 99; // lock until callback sets real cooldown

    ctx.navGrid.findPathAsync(
        myPos.x, myPos.z, ctx.moveTarget.x, ctx.moveTarget.z,
        tm ? tm.threat : null, tm ? tm.cols : 0,
        (path) => {
            ctx._waitingForPath = false;

            // Adaptive cooldown: 0.5s near obstacles/stuck, 1.5s open terrain
            // Jitter ±0.2s to spread A* calls across frames
            const jitter = (Math.random() - 0.5) * 0.4;
            let cooldown = 1.5;

            if (path === null) {
                ctx.currentPath = [];
                ctx.pathIndex = 0;
                ctx._pathCooldown = 0.5 + jitter;
                ctx._noPathFound = true;
            } else {
                // Near obstacles → shorten cooldown
                if (path.length > 0 && ctx.stuckTimer <= 0) {
                    const ng = ctx.navGrid;
                    for (let i = 0, len = Math.min(path.length, 6); i < len; i++) {
                        const g = ng.worldToGrid(path[i].x, path[i].z);
                        if (ng.proxCost[g.row * ng.cols + g.col] > 1) {
                            cooldown = 0.5; break;
                        }
                    }
                }
                if (ctx.stuckTimer > 0) cooldown = 0.5;

                ctx.currentPath = path;
                ctx.pathIndex = 0;
                ctx._pathCooldown = cooldown + jitter;
                ctx._noPathFound = false;
            }
        }
    );
}

/** Main movement update — kinematic terrain-snapping + inertia + A* path following. */
export function updateMovement(ctx, dt) {
    const body = ctx.soldier.body;
    const myPos = ctx.soldier.getPosition();
    const groundY = ctx.getHeightAt(myPos.x, myPos.z);

    // Handle jumping (manual parabola)
    if (ctx.isJumping) {
        ctx.jumpVelY -= 9.8 * dt; // gravity
        body.position.y += ctx.jumpVelY * dt;
        if (body.position.y <= groundY + 0.05) {
            body.position.y = groundY + 0.05;
            ctx.isJumping = false;
            ctx.jumpVelY = 0;
        }
    }

    // Ground snap — unconditional (fixes floating after respawn)
    if (!ctx.isJumping) {
        body.position.y = groundY + 0.05;
    }

    // Facing direction — suppression takes priority (body must face where bullets go)
    if (ctx.suppressionTarget && ctx.suppressionTimer > 0) {
        _v2.subVectors(ctx.aimPoint, myPos).normalize();
        _v2.y = 0;
        ctx.facingDir.lerp(_v2, 0.3).normalize();
    } else if (ctx.targetEnemy && ctx.targetEnemy.alive) {
        _v2.subVectors(ctx.targetEnemy.getPosition(), myPos).normalize();
        _v2.y = 0;
        const turnRate = ctx.hasReacted ? 0.45 : 0.15;
        ctx.facingDir.lerp(_v2, turnRate).normalize();
    }

    // Reflex dodge: lateral movement even without moveTarget
    if (ctx._reflexDodgeTimer > 0 && !ctx.moveTarget) {
        const speed = ctx.moveSpeed;
        const rdx = ctx._reflexDodgeDirX * speed * dt;
        const rdz = ctx._reflexDodgeDirZ * speed * dt;
        let nx = body.position.x + rdx;
        let nz = body.position.z + rdz;
        // NavGrid check
        let blocked = false;
        if (ctx.navGrid) {
            const g = ctx.navGrid.worldToGrid(nx, nz);
            if (!ctx.navGrid.isWalkable(g.col, g.row)) blocked = true;
        }
        if (!blocked) {
            const gy = ctx.getHeightAt(nx, nz);
            body.position.x = nx;
            body.position.z = nz;
            if (!ctx.isJumping) body.position.y = gy + 0.05;
        }
        ctx.lastPos.copy(myPos);
        return;
    }

    if (!ctx.moveTarget) {
        // No destination — decelerate to zero (inertia slide)
        const decelRate = 12;
        const td = Math.min(1, decelRate * dt);
        ctx._velX += (0 - ctx._velX) * td;
        ctx._velZ += (0 - ctx._velZ) * td;
        if (ctx._velX * ctx._velX + ctx._velZ * ctx._velZ < 0.01) {
            ctx._velX = 0;
            ctx._velZ = 0;
        } else {
            const nx2 = body.position.x + ctx._velX * dt;
            const nz2 = body.position.z + ctx._velZ * dt;
            let slideBlocked = false;
            if (ctx.navGrid) {
                const g = ctx.navGrid.worldToGrid(nx2, nz2);
                if (!ctx.navGrid.isWalkable(g.col, g.row)) slideBlocked = true;
            }
            if (!slideBlocked) {
                body.position.x = nx2;
                body.position.z = nz2;
                if (!ctx.isJumping) body.position.y = ctx.getHeightAt(nx2, nz2) + 0.05;
            }
        }
        ctx.lastPos.copy(myPos);
        return;
    }

    // Request A* path if available
    requestPath(ctx);

    // If A* failed, don't move — but allow recovery after timeout
    if (ctx._noPathFound) {
        ctx.btTimer = ctx.btInterval; // force BT re-tick
        ctx.seekingCover = false;      // allow BT to try different action
        ctx.stuckTimer += dt;
        if (ctx.stuckTimer > 1.0) {
            // Recovery: clear failure, invalidate target so BT picks fresh
            ctx._noPathFound = false;
            ctx.stuckTimer = 0;
            ctx.moveTarget = null;
            ctx.currentPath = [];
            ctx.pathIndex = 0;
            ctx._pathCooldown = 0;
        }
        ctx.lastPos.copy(myPos);
        return;
    }

    // Determine immediate steering target: next waypoint or direct moveTarget
    let steerTarget = ctx.moveTarget;
    if (ctx.currentPath.length > 0 && ctx.pathIndex < ctx.currentPath.length) {
        const wp = ctx.currentPath[ctx.pathIndex];
        _tmpVec.set(wp.x, 0, wp.z);
        steerTarget = _tmpVec;
        // Advance waypoint when close enough
        const wpDist = Math.sqrt(
            (myPos.x - wp.x) ** 2 + (myPos.z - wp.z) ** 2
        );
        if (wpDist < 1.5) {
            ctx.pathIndex++;
            if (ctx.pathIndex >= ctx.currentPath.length) {
                // Path completed — will recompute on next cooldown
                ctx._pathCooldown = 0;
                steerTarget = ctx.moveTarget;
            } else {
                const nextWp = ctx.currentPath[ctx.pathIndex];
                _tmpVec.set(nextWp.x, 0, nextWp.z);
                steerTarget = _tmpVec;
            }
        }
    } else {
        // No A* path — only allow direct movement when close to target
        const directDist = myPos.distanceTo(ctx.moveTarget);
        if (directDist > 5) {
            ctx.lastPos.copy(myPos);
            return; // wait for A* path before moving
        }
    }

    _v1.subVectors(steerTarget, myPos);
    _v1.y = 0;
    const dist = _v1.length();

    if (dist < 1) {
        // If following path, advance to next waypoint
        if (ctx.currentPath.length > 0 && ctx.pathIndex < ctx.currentPath.length) {
            ctx.pathIndex++;
        } else {
            // Arrived at final destination — clear moveTarget so BT assigns fresh
            ctx.moveTarget = null;
            ctx.btTimer = ctx.btInterval;
        }
        ctx.lastPos.copy(myPos);
        return;
    }

    _v1.normalize();

    // ── Reflex dodge blend: inject lateral offset while dodging ──
    if (ctx._reflexDodgeTimer > 0) {
        const dodgeWeight = 0.5; // blend 50% dodge into movement
        _v1.x = _v1.x * (1 - dodgeWeight) + ctx._reflexDodgeDirX * dodgeWeight;
        _v1.z = _v1.z * (1 - dodgeWeight) + ctx._reflexDodgeDirZ * dodgeWeight;
        const rLen = Math.sqrt(_v1.x * _v1.x + _v1.z * _v1.z);
        if (rLen > 0.001) { _v1.x /= rLen; _v1.z /= rLen; }
    }

    // ── Ally separation force ──
    let sepWeight;
    if (ctx.riskLevel > 0.5)         sepWeight = 0.30;
    else if (ctx.targetEnemy !== null) sepWeight = 0.20;
    else                               sepWeight = 0.08;

    const minSepDist = 3;
    const maxSepRange = 12;
    let sepX = 0, sepZ = 0;

    if (ctx.allies) {
        for (const a of ctx.allies) {
            if (!a.alive || a === ctx.soldier) continue;
            const aPos = a.getPosition();
            const adx = myPos.x - aPos.x;
            const adz = myPos.z - aPos.z;
            const aDist = Math.sqrt(adx * adx + adz * adz);
            if (aDist > maxSepRange || aDist < 0.01) continue;
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
        const rLen = Math.sqrt(_v1.x * _v1.x + _v1.z * _v1.z);
        if (rLen > 0.001) { _v1.x /= rLen; _v1.z /= rLen; }
    }

    let movementBlocked = false;

    const speed = ctx.seekingCover ? ctx.moveSpeed * 1.2 : ctx.moveSpeed;

    // Target velocity from direction
    const targetVX = _v1.x * speed;
    const targetVZ = _v1.z * speed;

    // Lerp current velocity toward target (inertia)
    const accelRate = 20;
    const ta = Math.min(1, accelRate * dt);
    ctx._velX += (targetVX - ctx._velX) * ta;
    ctx._velZ += (targetVZ - ctx._velZ) * ta;

    // Move horizontally using smoothed velocity
    const dx = ctx._velX * dt;
    const dz = ctx._velZ * dt;
    const newX = body.position.x + dx;
    const newZ = body.position.z + dz;

    // NavGrid obstacle check with axis-separated sliding
    let finalX = newX;
    let finalZ = newZ;
    if (ctx.navGrid) {
        let g = ctx.navGrid.worldToGrid(newX, newZ);
        if (!ctx.navGrid.isWalkable(g.col, g.row)) {
            const gX = ctx.navGrid.worldToGrid(newX, body.position.z);
            const gZ = ctx.navGrid.worldToGrid(body.position.x, newZ);
            if (ctx.navGrid.isWalkable(gX.col, gX.row)) {
                finalX = newX; finalZ = body.position.z;
            } else if (ctx.navGrid.isWalkable(gZ.col, gZ.row)) {
                finalX = body.position.x; finalZ = newZ;
            } else {
                movementBlocked = true;
            }
        }
    }

    if (!movementBlocked) {
        const newGroundY = ctx.getHeightAt(finalX, finalZ);
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
            if (!ctx.isJumping) {
                body.position.y = newGroundY + 0.05;
            }
        } else {
            // Steep terrain — trigger jump
            if (!ctx.isJumping) {
                ctx.isJumping = true;
                ctx.jumpVelY = 2.5;
                body.position.x += _v1.x * speed * 0.3 * dt;
                body.position.z += _v1.z * speed * 0.3 * dt;
            } else {
                movementBlocked = true;
            }
        }
    }

    // Update facing: pre-aim nearest intel contact, or fall back to movement direction
    ctx._preAimActive = false;
    if (ctx._grenadeThrowTimer > 0) {
        // During grenade throw, keep aimPoint on the throw arc — skip pre-aim
    } else if (!ctx.targetEnemy || !ctx.targetEnemy.alive || !ctx.hasReacted) {
        let preAimed = false;
        if (ctx.teamIntel) {
            // Re-evaluate intel target only when cooldown expires or current contact is stale
            let nearest = ctx._preAimContact;
            if (nearest && nearest.confidence <= 0) {
                nearest = null; // contact expired
            }
            if (!nearest || ctx._preAimCooldown <= 0) {
                nearest = null;
                let nearestDist = Infinity;
                for (const contact of ctx.teamIntel.contacts.values()) {
                    const d = myPos.distanceTo(contact.lastSeenPos);
                    if (d < ctx.weaponDef.maxRange && d < nearestDist) {
                        nearestDist = d;
                        nearest = contact;
                    }
                }
                if (nearest && nearest !== ctx._preAimContact) {
                    ctx._preAimCooldown = 0.5;
                }
                ctx._preAimContact = nearest;
            }
            if (nearest) {
                _v2.subVectors(nearest.lastSeenPos, myPos).normalize();
                _v2.y = 0;
                ctx.facingDir.lerp(_v2, 0.12).normalize();
                // Set aimPoint — aim at ridgeline if hill blocks view
                const eyeY = myPos.y + 1.5;
                _v2.set(myPos.x, eyeY, myPos.z);
                findRidgelineAimPoint(_v2, nearest.lastSeenPos, ctx.getHeightAt, ctx.aimPoint);
                ctx._preAimActive = true;
                preAimed = true;
            }
        }
        if (!preAimed) {
            ctx.facingDir.lerp(_v1, 0.1).normalize();
        }
    }

    // Stuck detection
    const barelyMoved = myPos.distanceTo(ctx.lastPos) < 0.1 * dt;
    if (movementBlocked || barelyMoved) {
        ctx.stuckTimer += dt;
        if (ctx.stuckTimer > 0.6) {
            ctx.seekingCover = false;
            ctx.btTimer = ctx.btInterval;
            ctx.stuckTimer = 0;
            ctx.currentPath = [];
            ctx.pathIndex = 0;
            ctx._pathCooldown = 0;
        }
    } else {
        ctx.stuckTimer = 0;
    }
    // Record velocity for death momentum inheritance
    const invDt = dt > 0.001 ? 1 / dt : 0;
    ctx.soldier.lastMoveVelocity.set(
        (myPos.x - ctx.lastPos.x) * invDt,
        0,
        (myPos.z - ctx.lastPos.z) * invDt
    );

    ctx.lastPos.copy(myPos);
}
