/**
 * AI Shooting & Aiming logic — extracted from AIController.
 * Function-bag pattern: each function takes `ctx` (AIController instance).
 */
import * as THREE from 'three';
import { GunAnim } from '../entities/WeaponDefs.js';
import { applyFalloff } from '../shared/DamageFalloff.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _target = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();
const _targetMeshes = [];
const _allTargets = [];
let _cachedCollidables = null;
const _aiFiredPayload = { team: '', soldierId: '' };
const _aiHitPayload = { soldier: null, killed: false, headshot: false, victimName: '', victimTeam: '' };

function _isChildOf(obj, parent) {
    let current = obj;
    while (current) {
        if (current === parent) return true;
        current = current.parent;
    }
    return false;
}

/** Walk up parent chain to find the soldierRef userData tag. */
function _findSoldierRef(obj) {
    let current = obj;
    while (current) {
        if (current.userData && current.userData.soldierRef) {
            return current.userData.soldierRef;
        }
        current = current.parent;
    }
    return null;
}

function _getWorldNormal(hit) {
    if (!hit.face) return null;
    _tmpVec.copy(hit.face.normal);
    _tmpVec.transformDirection(hit.object.matrixWorld);
    return _tmpVec;
}

function _getSurfaceType(obj) {
    let current = obj;
    while (current) {
        if (current.userData && current.userData.surfaceType) {
            return current.userData.surfaceType;
        }
        current = current.parent;
    }
    return 'terrain';
}

/** Update aim point toward current target. */
export function updateAiming(ctx, dt) {
    // During grenade throw, aimPoint is set to the throw arc — don't overwrite
    if (ctx._grenadeThrowTimer > 0) return;

    // For suppression with no visible enemy, aim point is set by _actionSuppress
    const isSuppressingBlind = ctx.suppressionTarget && ctx.suppressionTimer > 0
        && (!ctx.targetEnemy || !ctx.targetEnemy.alive);
    if (isSuppressingBlind) return;

    if (!ctx.targetEnemy || !ctx.targetEnemy.alive || !ctx.hasReacted) {
        // Reaction delay
        if (ctx.targetEnemy && !ctx.hasReacted) {
            ctx.reactionTimer -= dt;
            if (ctx.reactionTimer <= 0) {
                ctx.hasReacted = true;
            }
        }
        return;
    }

    // Aim at enemy — head-only if only head is exposed, otherwise center mass
    const enemyPos = ctx.targetEnemy.getPosition();
    ctx.aimPoint.copy(enemyPos);
    const aimH = ctx._targetLOSLevel === 2 ? 1.6 : 1.2;
    const heli = ctx.targetEnemy.vehicle;
    if (heli && heli.type === 'helicopter' && heli._cachedWorldQuat) {
        // Offset along helicopter's local up axis (accounts for pitch/roll)
        _tmpVec.set(0, aimH, 0).applyQuaternion(heli._cachedWorldQuat);
        ctx.aimPoint.x += _tmpVec.x;
        ctx.aimPoint.y += _tmpVec.y;
        ctx.aimPoint.z += _tmpVec.z;
    } else {
        ctx.aimPoint.y += aimH;
    }

    // Gradually reduce aim offset
    ctx.aimOffset.multiplyScalar(1 - ctx.aimCorrectionSpeed * dt);

    // Add tracking lag for moving targets
    const enemyVel = ctx.targetEnemy.body.velocity;
    const lagAmount = (1 - ctx.personality.aimSkill) * 0.15;
    ctx.aimOffset.x += enemyVel.x * lagAmount * dt;
    ctx.aimOffset.z += enemyVel.z * lagAmount * dt;
}

/** Update shooting state — burst management, reloading, firing. */
export function updateShooting(ctx, dt) {
    ctx.fireTimer -= dt;
    ctx.burstCooldown -= dt;

    // Bolt cycling timer
    if (ctx.boltTimer > 0) {
        ctx.boltTimer -= dt;
        if (ctx.boltTimer <= 0) ctx.boltTimer = 0;
    }

    // BOLT aim delay: must aim at target for aiAimDelay seconds before firing
    if (ctx.weaponDef.aiAimDelay) {
        // Unscope during bolt cycling, reloading, or grenade throw — reset aim timer
        if (ctx.boltTimer > 0 || ctx.isReloading || ctx._grenadeThrowTimer > 0) {
            ctx._boltAimTimer = 0;
            ctx.isScoped = false;
        } else if (ctx.targetEnemy && ctx.targetEnemy.alive && ctx.hasReacted) {
            if (ctx.targetEnemy !== ctx._lastAimTarget) {
                ctx.isScoped = false;
                ctx._boltAimTimer = 0;
                ctx._lastAimTarget = ctx.targetEnemy;
            }
            ctx._boltAimTimer += dt;
            ctx.isScoped = true;
        } else {
            ctx._boltAimTimer = 0;
            ctx._lastAimTarget = null;
            ctx.isScoped = false;
        }
    }

    // Spread recovery during burst cooldown or when not shooting
    if (ctx.burstCooldown > 0 || !ctx.targetEnemy) {
        if (ctx.currentSpread > ctx.baseSpread) {
            ctx.currentSpread = Math.max(ctx.baseSpread, ctx.currentSpread - ctx.spreadRecoveryRate * dt);
        } else if (ctx.currentSpread < ctx.baseSpread) {
            ctx.currentSpread = Math.min(ctx.baseSpread, ctx.currentSpread + ctx.spreadRecoveryRate * dt);
        }
    }

    // Handle reload
    if (ctx.isReloading) {
        ctx.reloadTimer -= dt;
        if (ctx.reloadTimer <= 0) {
            ctx.currentAmmo = ctx.magazineSize;
            ctx.isReloading = false;
        }
        ctx.fireTimer = 0;
        return;
    }

    // Auto-reload when empty
    if (ctx.currentAmmo <= 0) {
        ctx.isReloading = true;
        ctx.reloadTimer = ctx.reloadTime;
        ctx.fireTimer = 0;
        return;
    }

    // Tactical reload: proactively reload when safe and ammo below personality threshold
    const ammoRatio = ctx.currentAmmo / ctx.magazineSize;
    if (ammoRatio < ctx.personality.tacticalReloadThreshold &&
        (!ctx.targetEnemy || !ctx.targetEnemy.alive)) {
        if (!ctx.squad || ctx.squad.canReload(ctx)) {
            ctx.isReloading = true;
            ctx.reloadTimer = ctx.reloadTime;
            ctx.fireTimer = 0;
            return;
        }
    }

    // Allow shooting during suppression
    const isSuppressing = ctx.suppressionTarget && ctx.suppressionTimer > 0;

    if (!isSuppressing) {
        if (!ctx.targetEnemy || !ctx.targetEnemy.alive || !ctx.hasReacted) {
            ctx.fireTimer = 0;
            return;
        }
    }
    if (ctx.burstCooldown > 0) {
        ctx.fireTimer = 0;
        return;
    }

    // Block firing during grenade throw
    if (ctx._grenadeThrowTimer > 0) return;

    // Block firing during bolt cycling
    if (ctx.boltTimer > 0) return;

    // Block firing during BOLT aim delay
    if (ctx.weaponDef.aiAimDelay && ctx._boltAimTimer < ctx.weaponDef.aiAimDelay) return;

    if (ctx.fireTimer <= 0) {
        if (ctx.vehicle && ctx._vehicleFireBlocked) {
            ctx.fireTimer = 0;
            return;
        }
        ctx.fireTimer += ctx.fireInterval;
        fireShot(ctx);
        ctx.currentAmmo--;
        ctx.burstCount++;

        // Start bolt cycling after firing (BOLT only)
        if (ctx.weaponDef.boltTime) {
            ctx.boltTimer = ctx.weaponDef.boltTime;
        }

        if (ctx.burstCount >= ctx.burstMax) {
            ctx.burstCount = 0;
            ctx.burstMax = ctx.weaponId === 'BOLT' ? 1
                : ctx.weaponId === 'LMG'
                    ? 20 + Math.floor(Math.random() * 10)
                    : 6 + Math.floor(Math.random() * 8);
            ctx.burstCooldown = ctx.weaponId === 'BOLT' ? 0 : 0.08 + Math.random() * 0.2;
        }
    }
}

/** Execute a single hitscan shot. */
export function fireShot(ctx) {
    const myPos = ctx.soldier.getPosition();
    _origin.copy(myPos);
    const myHeli = ctx.soldier.vehicle;
    if (myHeli && myHeli.type === 'helicopter' && myHeli._cachedWorldQuat) {
        // Eye offset along helicopter's local up (accounts for pitch/roll)
        _tmpVec.set(0, 1.5, 0).applyQuaternion(myHeli._cachedWorldQuat);
        _origin.add(_tmpVec);
    } else {
        _origin.y += 1.5;
    }

    // Direction to aim point + offset + random spread
    _target.copy(ctx.aimPoint).add(ctx.aimOffset);
    const dir = _v1.subVectors(_target, _origin).normalize();

    // Apply current dynamic spread (same model as Player)
    dir.x += (Math.random() - 0.5) * 2 * ctx.currentSpread;
    dir.y += (Math.random() - 0.5) * 2 * ctx.currentSpread;
    dir.z += (Math.random() - 0.5) * 2 * ctx.currentSpread;
    dir.normalize();

    // Increase spread per shot — negative means sustained fire tightens
    if (ctx.spreadIncreasePerShot >= 0) {
        ctx.currentSpread = Math.min(ctx.maxSpread, ctx.currentSpread + ctx.spreadIncreasePerShot);
    } else {
        ctx.currentSpread = Math.max(ctx.weaponDef.minSpread || 0.001, ctx.currentSpread + ctx.spreadIncreasePerShot);
    }

    // Hitscan
    _raycaster.set(_origin, dir);
    _raycaster.far = ctx.weaponDef.maxRange;

    // Collect live enemy meshes (must rebuild — enemies die)
    _targetMeshes.length = 0;
    for (const e of ctx.enemies) {
        if (e.alive && e.mesh && e.mesh !== ctx._playerMesh) _targetMeshes.push(e.mesh);
    }
    if (ctx._playerMesh && ctx._playerRef && ctx._playerRef.team !== ctx.team) _targetMeshes.push(ctx._playerMesh);

    // Cache static collidables (terrain + vehicles) — built once
    if (!_cachedCollidables) {
        _cachedCollidables = [];
        for (let i = 0; i < ctx.collidables.length; i++) _cachedCollidables.push(ctx.collidables[i]);
        if (ctx.vehicleManager) {
            const vMeshes = ctx.vehicleManager.getVehicleMeshes();
            for (let i = 0; i < vMeshes.length; i++) _cachedCollidables.push(vMeshes[i]);
        }
    }

    // Merge into single target array for one raycast
    _allTargets.length = 0;
    for (let i = 0; i < _cachedCollidables.length; i++) _allTargets.push(_cachedCollidables[i]);
    for (let i = 0; i < _targetMeshes.length; i++) _allTargets.push(_targetMeshes[i]);

    const allHits = _raycaster.intersectObjects(_allTargets, true);

    // Classify hits: first character hit and first environment hit (sorted by distance)
    let hitChar = null;
    let hitEnv = null;
    const ownVehicleMesh = ctx.vehicle ? ctx.vehicle.mesh : null;

    for (let i = 0; i < allHits.length; i++) {
        const hit = allHits[i];
        const soldierRef = _findSoldierRef(hit.object);
        if (soldierRef && soldierRef !== ctx.soldier) {
            if (!hitChar) { hitChar = hit; hitChar._soldierRef = soldierRef; }
        } else if (!soldierRef) {
            if (ownVehicleMesh && _isChildOf(hit.object, ownVehicleMesh)) continue;
            if (!hitEnv) hitEnv = hit;
        }
        if (hitChar && hitEnv) break;
    }

    // Determine closest hit distance for tracer length
    let tracerDist = ctx.weaponDef.maxRange;
    if (hitChar && (!hitEnv || hitChar.distance < hitEnv.distance)) {
        tracerDist = hitChar.distance;
    } else if (hitEnv) {
        tracerDist = hitEnv.distance;
    }

    // Spawn tracer VFX — skip past body so line starts in front of character
    const TRACER_SKIP = 1.5;
    if (ctx.tracerSystem && tracerDist > TRACER_SKIP) {
        _v2.copy(_origin).addScaledVector(dir, TRACER_SKIP);
        ctx.tracerSystem.fire(_v2, dir, tracerDist - TRACER_SKIP);
    }

    // Visual recoil kick on gun mesh
    ctx.soldier._gunRecoilZ = GunAnim.recoilOffset;
    ctx.soldier.showMuzzleFlash();

    // Notify minimap that this AI fired
    if (ctx.eventBus) {
        _aiFiredPayload.team = ctx.team;
        _aiFiredPayload.soldierId = `${ctx.team}_${ctx.soldier.id}`;
        ctx.eventBus.emit('aiFired', _aiFiredPayload);
    }

    const myName = `${ctx.team === 'teamA' ? 'A' : 'B'}-${ctx.soldier.id}`;

    if (hitChar && (!hitEnv || hitChar.distance < hitEnv.distance)) {
        const dmg = applyFalloff(ctx.weaponDef.damage, hitChar.distance, ctx.weaponDef.falloffStart, ctx.weaponDef.falloffEnd, ctx.weaponDef.falloffMinScale);
        const hitSoldier = hitChar._soldierRef;

        if (hitSoldier && hitSoldier.team !== ctx.team) {
            if (ctx.impactVFX) {
                ctx.impactVFX.spawn('blood', hitChar.point, _v1.copy(dir).negate());
            }
            const result = hitSoldier.takeDamage(dmg, myPos, hitChar.point.y, ctx.soldier);
            if (ctx.eventBus) {
                const isPlayer = ctx._playerRef && hitSoldier === ctx._playerRef;
                const vTeam = hitSoldier.team || (ctx.team === 'teamA' ? 'teamB' : 'teamA');
                _aiHitPayload.soldier = ctx.soldier;
                _aiHitPayload.killed = result.killed;
                _aiHitPayload.headshot = result.headshot || false;
                _aiHitPayload.victimName = isPlayer ? 'You' : `${vTeam === 'teamA' ? 'A' : 'B'}-${hitSoldier.id}`;
                _aiHitPayload.victimTeam = vTeam;
                ctx.eventBus.emit('aiHit', _aiHitPayload);
            }
            if (result.killed && ctx.eventBus) {
                const isPlayer = ctx._playerRef && hitSoldier === ctx._playerRef;
                const vTeam = hitSoldier.team || (ctx.team === 'teamA' ? 'teamB' : 'teamA');
                ctx.eventBus.emit('kill', {
                    killerName: myName,
                    killerTeam: ctx.team,
                    victimName: isPlayer ? 'You' : `${vTeam === 'teamA' ? 'A' : 'B'}-${hitSoldier.id}`,
                    victimTeam: vTeam,
                    headshot: result.headshot,
                    weapon: ctx.weaponId,
                });
            }
        }
    } else if (hitEnv) {
        // Check if we hit a vehicle
        let hitObj = hitEnv.object;
        while (hitObj) {
            if (hitObj.userData && hitObj.userData.vehicle) {
                const vehicle = hitObj.userData.vehicle;
                if (vehicle.alive && vehicle.team !== null && vehicle.team !== ctx.team) {
                    const dmg = applyFalloff(ctx.weaponDef.damage, hitEnv.distance, ctx.weaponDef.falloffStart, ctx.weaponDef.falloffEnd, ctx.weaponDef.falloffMinScale);
                    vehicle.takeDamage(dmg);
                    if (ctx.impactVFX) {
                        ctx.impactVFX.spawn('spark', hitEnv.point, _v1.copy(dir).negate());
                    }
                    return;
                }
                break;
            }
            hitObj = hitObj.parent;
        }
        // No vehicle hit — spawn normal impact particles on environment
        if (ctx.impactVFX) {
            const surfaceType = _getSurfaceType(hitEnv.object);
            const impactType = surfaceType === 'water' ? 'water'
                : (surfaceType === 'rock' ? 'spark' : 'dirt');
            const worldNormal = _getWorldNormal(hitEnv);
            ctx.impactVFX.spawn(impactType, hitEnv.point, worldNormal);
        }
    }
}
