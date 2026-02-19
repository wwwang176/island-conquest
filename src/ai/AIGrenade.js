/**
 * AI Grenade logic — extracted from AIController.
 * Function-bag pattern: each function takes `ctx` (AIController instance).
 */
import * as THREE from 'three';
import { BTState } from './BehaviorTree.js';
import { WeaponDefs } from '../entities/WeaponDefs.js';

const _grenadeOrigin = new THREE.Vector3();
const _grenadeDir = new THREE.Vector3();

/**
 * Solve ballistic launch for horizDist/dy at fixed speed v.
 * Pure function — no dependencies, testable.
 * @param {number} horizDist - Horizontal distance to target
 * @param {number} dy - Vertical offset (target - origin)
 * @param {number} v - Launch speed
 * @param {number} fuseTime - Maximum flight time (fuse)
 * @returns {{ vHoriz: number, vy: number, flightTime: number }}
 */
export function solveGrenadeBallistic(horizDist, dy, v, fuseTime) {
    const g = 9.8;
    const v2 = v * v;
    const d2 = horizDist * horizDist;
    const disc = v2 * v2 - g * (g * d2 + 2 * dy * v2);

    let vHoriz, vy;
    if (disc >= 0) {
        const sqrtDisc = Math.sqrt(disc);
        const gd = g * horizDist;

        if (gd < 0.001) {
            // Nearly vertical throw
            vHoriz = 0.001;
            vy = v;
            return { vHoriz, vy, flightTime: horizDist / vHoriz };
        }

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

/** Check whether ctx should throw a grenade. */
export function shouldThrowGrenade(ctx) {
    if (!ctx.grenadeManager) return false;

    // Don't throw grenades at airborne targets (helicopter passengers — can't reach)
    if (!ctx.vehicle && ctx.targetEnemy && ctx.targetEnemy.alive) {
        const ePos = ctx.targetEnemy.getPosition();
        const groundY = ctx.getHeightAt(ePos.x, ePos.z);
        if (ePos.y - groundY > 5) return false;
    }

    // Safety: don't throw if nearest enemy is too close (blast would hit self)
    if (ctx.targetEnemy && ctx.targetEnemy.alive && ctx._enemyDist() < 8) return false;

    const myPos = ctx.soldier.getPosition();

    // Scenario 1: Rush — rushing toward flag
    if (ctx.rushTarget && ctx.squad && ctx.squad.rushActive) {
        const distToFlag = myPos.distanceTo(ctx.rushTarget);
        if (distToFlag >= 8 && distToFlag <= 40) {
            ctx._grenadeTargetPos = ctx.rushTarget;
            return true;
        }
    }

    // Scenario 2: Enemy holding a flag we're attacking
    if (ctx.targetFlag && ctx.targetFlag.owner !== ctx.team && ctx.targetFlag.owner !== null) {
        const flagPos = ctx.targetFlag.position;
        const distToFlag = myPos.distanceTo(flagPos);
        if (distToFlag >= 8 && distToFlag <= 45 && ctx.teamIntel) {
            const threats = ctx.teamIntel.getKnownEnemies({
                minConfidence: 0.15,
                maxDist: 18,
                fromPos: flagPos,
            });
            if (threats.length > 0) {
                ctx._grenadeTargetPos = flagPos;
                return true;
            }
        }
    }

    // Scenario 3: Visible enemy in range
    if (ctx.targetEnemy && ctx.targetEnemy.alive) {
        const dist = ctx._enemyDist();
        if (dist >= 8 && dist <= 40) {
            ctx._grenadeTargetPos = ctx.targetEnemy.getPosition();
            return true;
        }
    }

    // Scenario 4: Multiple enemies clustered — 2+ enemies within blast radius
    if (ctx.teamIntel) {
        const nearby = ctx.teamIntel.getKnownEnemies({
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
                        ctx._grenadeTargetPos = pi.clone().add(nearby[j].lastSeenPos).multiplyScalar(0.5);
                        return true;
                    }
                }
            }
        }
    }

    return false;
}

/** BT action: throw grenade toward ctx._grenadeTargetPos. */
export function actionThrowGrenade(ctx) {
    const myPos = ctx.soldier.getPosition();
    const def = WeaponDefs.GRENADE;

    // Use the target decided by shouldThrowGrenade
    const targetPos = ctx._grenadeTargetPos;
    if (!targetPos) return BTState.FAILURE;
    ctx._grenadeTargetPos = null;

    // Face the target before throwing
    _grenadeDir.set(targetPos.x - myPos.x, 0, targetPos.z - myPos.z).normalize();
    ctx.facingDir.copy(_grenadeDir);

    // Origin: shoulder height
    _grenadeOrigin.set(myPos.x, myPos.y + 1.5, myPos.z);

    // Soldier's horizontal movement velocity
    const vs = ctx.soldier.lastMoveVelocity;
    const v = def.throwSpeed;
    const dy = (targetPos.y != null ? targetPos.y : myPos.y) - _grenadeOrigin.y;

    // Two-iteration correction for soldier movement velocity.
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
            const sol = solveGrenadeBallistic(effDist, dy, v, def.fuseTime);
            t = sol.flightTime;
            effTargetX = targetPos.x - vs.x * t;
            effTargetZ = targetPos.z - vs.z * t;
        }
    }

    // Horizontal direction and distance to effective target
    _grenadeDir.set(effTargetX - _grenadeOrigin.x, 0, effTargetZ - _grenadeOrigin.z);
    const horizDist = _grenadeDir.length();
    if (horizDist < 0.1) {
        _grenadeDir.set(ctx.facingDir.x, 0, ctx.facingDir.z);
    }
    _grenadeDir.normalize();

    // Final ballistic solve for the corrected effective target
    const { vHoriz, vy } = solveGrenadeBallistic(horizDist, dy, v, def.fuseTime);

    // Final world velocity = throw velocity + soldier movement velocity
    const velocity = new THREE.Vector3(
        _grenadeDir.x * vHoriz + vs.x,
        vy,
        _grenadeDir.z * vHoriz + vs.z
    );

    const myName = `${ctx.team === 'teamA' ? 'A' : 'B'}-${ctx.soldier.id}`;
    ctx.grenadeManager.spawn(_grenadeOrigin, velocity, def.fuseTime, ctx.team, myName);

    ctx.grenadeCount--;
    ctx.grenadeCooldown = def.cooldown;

    // Visual: look up toward throw angle
    ctx._grenadeThrowPitch = Math.atan2(vy, vHoriz);
    ctx._grenadeThrowTimer = 0.5;
    // Set aimPoint for spectator camera
    const throwDist = 8;
    ctx.aimPoint.set(
        myPos.x + _grenadeDir.x * throwDist,
        myPos.y + 1.5 + Math.tan(ctx._grenadeThrowPitch) * throwDist,
        myPos.z + _grenadeDir.z * throwDist
    );

    // Brief pause after throwing (don't shoot for 0.5s)
    ctx.fireTimer = 0.5;

    return BTState.SUCCESS;
}
