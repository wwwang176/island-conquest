/**
 * AI Vehicle logic — extracted from AIController.
 * Function-bag pattern: each function takes `ctx` (AIController instance).
 */
import * as THREE from 'three';
import { BTState } from './BehaviorTree.js';

const _heliInput = { thrust: 0, brake: 0, steerLeft: false, steerRight: false, ascend: false, descend: false, ascendScale: 1, descendScale: 1 };

/** Find a helicopter that a squad mate is already in (with room left). */
export function findSquadHelicopter(ctx) {
    if (!ctx.squad || !ctx.vehicleManager) return null;
    for (const ctrl of ctx.squad.controllers) {
        if (ctrl === ctx) continue;
        if (!ctrl.vehicle) continue;
        const v = ctrl.vehicle;
        if (!v.alive) continue;
        if (v.team !== null && v.team !== ctx.team) continue;
        if (v.type === 'helicopter' && v.occupantCount >= 5) continue;
        return v;
    }
    return null;
}

/** Should the AI use a vehicle to reach its target? */
export function shouldUseVehicle(ctx) {
    if (ctx.vehicle) return false; // already driving
    if (!ctx.vehicleManager) return false;

    // Don't board if there's a close enemy
    if (ctx.targetEnemy && ctx.targetEnemy.alive) {
        const myPos = ctx.soldier.getPosition();
        const eDist = myPos.distanceTo(ctx.targetEnemy.getPosition());
        if (eDist < 40) return false;
    }

    // Priority: if a squad mate is already in a helicopter, join them
    const squadHeli = findSquadHelicopter(ctx);
    if (squadHeli) {
        const hPos = squadHeli.mesh.position;
        const hGround = ctx.getHeightAt(hPos.x, hPos.z);
        if (hPos.y - hGround > squadHeli.enterRadius) return false;

        ctx._vehicleBoardTarget = squadHeli;
        ctx._vehicleMoveTarget = ctx.targetFlag ? ctx.targetFlag.position.clone() : null;
        return true;
    }

    // Check if target flag is far enough to warrant a vehicle
    if (ctx.targetFlag) {
        const myPos = ctx.soldier.getPosition();
        const dist = myPos.distanceTo(ctx.targetFlag.position);
        const needsVehicle = dist > 60 || ctx._noPathFound;
        if (!needsVehicle) return false;
    } else {
        return false;
    }

    // Check for available vehicle
    const v = ctx.vehicleManager.findNearestVehicle(ctx.soldier, 80);
    if (!v) return false;

    ctx._vehicleBoardTarget = v;
    ctx._vehicleMoveTarget = ctx.targetFlag.position.clone();
    return true;
}

/** BT action: walk toward and board a vehicle. */
export function actionBoardVehicle(ctx) {
    const bt = ctx._vehicleBoardTarget;
    if (!bt || !bt.alive) {
        ctx._vehicleBoardTarget = null;
        return BTState.FAILURE;
    }
    // Reject if vehicle is full
    const maxOcc = bt.type === 'helicopter' ? 5 : 1;
    if ((bt.occupantCount || (bt.driver ? 1 : 0)) >= maxOcc) {
        ctx._vehicleBoardTarget = null;
        return BTState.FAILURE;
    }
    // Abort if helicopter took off while we were walking toward it
    if (bt.type === 'helicopter') {
        const bPos = bt.mesh.position;
        if (bPos.y - ctx.getHeightAt(bPos.x, bPos.z) > bt.enterRadius) {
            ctx._vehicleBoardTarget = null;
            return BTState.FAILURE;
        }
    }

    const myPos = ctx.soldier.getPosition();
    const vPos = ctx._vehicleBoardTarget.mesh.position;
    const dx = vPos.x - myPos.x;
    const dz = vPos.z - myPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < ctx._vehicleBoardTarget.enterRadius) {
        // Close enough — enter the vehicle
        ctx._releaseCover();
        ctx._vehicleBoardTarget.enter(ctx.soldier);
        ctx.vehicle = ctx._vehicleBoardTarget;
        ctx.soldier.mesh.visible = true;
        // Pilot: start waiting for passengers immediately on boarding
        if (ctx.vehicle.driver === ctx.soldier && ctx.vehicle.type === 'helicopter') {
            ctx._heliWaitingForPassengers = true;
            ctx._heliWaitTimer = 10;
        }
        ctx._vehicleBoardTarget = null;
        return BTState.SUCCESS;
    }

    ctx.moveTarget = new THREE.Vector3(vPos.x, 0, vPos.z);
    ctx.missionPressure = 0.5;
    return BTState.RUNNING;
}

/** BT action: drive the current vehicle toward destination. */
export function actionDriveVehicle(ctx) {
    const v = ctx.vehicle;
    if (!v || !v.alive) {
        exitVehicle(ctx);
        return BTState.FAILURE;
    }

    // Helicopter: air fire support, return to base when passengers all dead
    if (v.type === 'helicopter') {
        if (v.driver === ctx.soldier) {
            // Track whether we ever had passengers
            const alivePassengers = v.passengers.length;
            if (alivePassengers > 0) {
                ctx._heliHadPassengers = true;
            }
            // All passengers lost — return to nearest friendly flag
            if (alivePassengers === 0 && ctx._heliHadPassengers &&
                !ctx._heliWaitingForPassengers && !ctx._heliReturning) {
                ctx._heliReturning = true;
                ctx._heliHadPassengers = false; // reset for next cycle
                const nearestFlag = findNearestFriendlyFlag(ctx);
                if (nearestFlag) {
                    ctx._vehicleMoveTarget = nearestFlag.position.clone();
                }
            }
            // Cancel return if new passengers boarded mid-flight
            if (alivePassengers > 0 && ctx._heliReturning) {
                ctx._heliReturning = false;
            }

            if (!ctx._heliReturning && ctx.targetFlag) {
                ctx._vehicleMoveTarget = ctx.targetFlag.position.clone();
            }

            // Pilot wait logic
            if (v.passengers.length >= v.maxPassengers) {
                ctx._heliWaitingForPassengers = true;
                ctx._heliWaitTimer = Math.min(ctx._heliWaitTimer, 0.5);
            } else if (ctx._heliWaitTimer > 0) {
                ctx._heliWaitingForPassengers = true;
            } else {
                ctx._heliWaitingForPassengers = false;
            }
        }
        ctx.missionPressure = 0.3;
        return BTState.RUNNING;
    }

    // Unknown vehicle type — exit
    exitVehicle(ctx);
    return BTState.FAILURE;
}

/** Continuous vehicle driving — called every frame from updateContinuous(). */
export function updateVehicleDriving(ctx, dt) {
    const v = ctx.vehicle;
    if (!v || !v.alive) return;

    if (v.type === 'helicopter') {
        updateHelicopterOrbit(ctx, dt);
    }
}

/** Find the nearest flag owned by the pilot's team. */
function findNearestFriendlyFlag(ctx) {
    if (!ctx.flags) return null;
    const vPos = ctx.vehicle.mesh.position;
    let best = null, bestDist = Infinity;
    for (const flag of ctx.flags) {
        if (flag.owner !== ctx.team) continue;
        const d = vPos.distanceTo(flag.position);
        if (d < bestDist) { bestDist = d; best = flag; }
    }
    // Fallback: any flag if none owned
    if (!best) {
        for (const flag of ctx.flags) {
            const d = vPos.distanceTo(flag.position);
            if (d < bestDist) { bestDist = d; best = flag; }
        }
    }
    return best;
}

/** Helicopter orbit AI — fly in circles around target, maintaining altitude. */
export function updateHelicopterOrbit(ctx, dt) {
    const v = ctx.vehicle;
    const vPos = v.mesh.position;
    const target = ctx._vehicleMoveTarget || (ctx.targetFlag ? ctx.targetFlag.position : null);
    if (!target) return;

    // Reset scales each frame
    _heliInput.ascendScale = 1;
    _heliInput.descendScale = 1;

    // Wait on ground until passengers board + grace period expires
    if (ctx._heliWaitingForPassengers) {
        if (v.passengers.length >= v.maxPassengers) {
            ctx._heliWaitTimer = Math.min(ctx._heliWaitTimer, 0.5);
        }
        ctx._heliWaitTimer -= dt;
        if (ctx._heliWaitTimer <= 0) {
            ctx._heliWaitingForPassengers = false;
            ctx._heliReturning = false;
        }
        if (ctx._heliWaitingForPassengers) return;
    }

    // ── Returning mode: fly to target overhead, then descend and land ──
    if (ctx._heliReturning) {
        updateHelicopterReturn(ctx, dt, target);
        return;
    }

    const orbitRadius = 35;
    const desiredAlt = 22;
    const orbitSpeed = 0.3;

    ctx._vehicleOrbitAngle += orbitSpeed * dt;

    // Compute orbit waypoint — clamp within map bounds
    const MAP_HW = 145, MAP_HD = 55;
    let waypointX = target.x + Math.sin(ctx._vehicleOrbitAngle) * orbitRadius;
    let waypointZ = target.z + Math.cos(ctx._vehicleOrbitAngle) * orbitRadius;
    waypointX = Math.max(-MAP_HW, Math.min(MAP_HW, waypointX));
    waypointZ = Math.max(-MAP_HD, Math.min(MAP_HD, waypointZ));

    const dx = waypointX - vPos.x;
    const dz = waypointZ - vPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    const waypointAngle = Math.atan2(dx, dz);
    let angleDiff = waypointAngle - v.rotationY;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

    _heliInput.thrust = Math.min(0.7, dist / 20);
    _heliInput.brake = 0;
    _heliInput.steerLeft = angleDiff > 0.1;
    _heliInput.steerRight = angleDiff < -0.1;
    _heliInput.ascend = vPos.y < desiredAlt;
    _heliInput.descend = vPos.y > desiredAlt + 5;

    // Terrain clearance
    const groundBelow = ctx.getHeightAt(vPos.x, vPos.z);
    const minClearance = 12;
    if (vPos.y < groundBelow + minClearance) {
        _heliInput.ascend = true;
        _heliInput.descend = false;
    }
    const aheadX = vPos.x + Math.sin(v.rotationY) * 20;
    const aheadZ = vPos.z + Math.cos(v.rotationY) * 20;
    const aheadGround = ctx.getHeightAt(aheadX, aheadZ);
    if (vPos.y < aheadGround + minClearance) {
        _heliInput.ascend = true;
        _heliInput.descend = false;
    }

    v.applyInput(_heliInput, dt);
}

/** Return flight: fly to target position at altitude, then descend to land. */
function updateHelicopterReturn(ctx, dt, target) {
    const v = ctx.vehicle;
    const vPos = v.mesh.position;
    const cruiseAlt = 22;
    const landingThreshold = 15; // horizontal distance to start descent

    const dx = target.x - vPos.x;
    const dz = target.z - vPos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);

    const waypointAngle = Math.atan2(dx, dz);
    let angleDiff = waypointAngle - v.rotationY;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

    const groundBelow = ctx.getHeightAt(vPos.x, vPos.z);

    if (horizDist > landingThreshold) {
        // Phase 1: Fly toward target at cruise altitude
        _heliInput.thrust = Math.min(0.7, horizDist / 20);
        _heliInput.brake = 0;
        _heliInput.steerLeft = angleDiff > 0.1;
        _heliInput.steerRight = angleDiff < -0.1;
        _heliInput.ascend = vPos.y < cruiseAlt;
        _heliInput.descend = vPos.y > cruiseAlt + 5;

        // Terrain clearance during transit
        const minClearance = 12;
        if (vPos.y < groundBelow + minClearance) {
            _heliInput.ascend = true;
            _heliInput.descend = false;
        }
        const aheadX = vPos.x + Math.sin(v.rotationY) * 20;
        const aheadZ = vPos.z + Math.cos(v.rotationY) * 20;
        const aheadGround = ctx.getHeightAt(aheadX, aheadZ);
        if (vPos.y < aheadGround + minClearance) {
            _heliInput.ascend = true;
            _heliInput.descend = false;
        }
    } else {
        // Phase 2: Over target — gradual descent based on altitude above ground
        const altAboveGround = vPos.y - groundBelow;

        _heliInput.thrust = Math.min(0.3, horizDist / 10); // slow drift to center
        _heliInput.brake = 0;
        _heliInput.steerLeft = angleDiff > 0.1;
        _heliInput.steerRight = angleDiff < -0.1;

        // Desired sink rate scales with altitude: fast high up, slow near ground
        const vy = v.body.velocity.y; // negative = falling
        const maxSinkRate = -Math.min(altAboveGround * 0.5, 8); // e.g. at 4m → -2 m/s, at 20m → -8 m/s

        if (vy < maxSinkRate) {
            // Falling too fast — brake with ascend
            _heliInput.ascend = true;
            _heliInput.descend = false;
            _heliInput.ascendScale = altAboveGround < 5 ? 0.5 : 1;
        } else {
            // Sink rate OK — keep descending
            _heliInput.ascend = false;
            _heliInput.descend = altAboveGround > 2;
            _heliInput.descendScale = altAboveGround < 8 ? 0.4 : 1;
        }

        // Landed — switch to waiting for passengers
        if (altAboveGround < 2) {
            ctx._heliReturning = false;
            ctx._heliWaitingForPassengers = true;
            ctx._heliWaitTimer = 10;
            _heliInput.thrust = 0;
            _heliInput.descend = false;
            _heliInput.ascend = false;
        }
    }

    v.applyInput(_heliInput, dt);
}

/** Exit the current vehicle. */
export function exitVehicle(ctx) {
    if (!ctx.vehicle) return;
    const v = ctx.vehicle;
    const exitPos = v.exit(ctx.soldier);
    ctx.vehicle = null;
    ctx._vehicleMoveTarget = null;
    ctx.soldier.mesh.visible = true;
    if (exitPos) {
        const h = ctx.getHeightAt(exitPos.x, exitPos.z);
        ctx.soldier.body.position.set(exitPos.x, Math.max(h + 0.1, exitPos.y), exitPos.z);
    }
}
