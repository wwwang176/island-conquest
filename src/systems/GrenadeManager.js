import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Grenade } from '../entities/Grenade.js';
import { WeaponDefs } from '../entities/WeaponDefs.js';

const _up = new THREE.Vector3(0, 1, 0);
const _diff = new THREE.Vector3();
const _splashPos = new THREE.Vector3();
const _impulseVec = new CANNON.Vec3();
const WATER_Y = -0.3;

/**
 * Manages all active grenades — spawning, updating, and explosion handling.
 */
export class GrenadeManager {
    constructor(scene, physicsWorld, impactVFX, eventBus) {
        this.scene = scene;
        this.physics = physicsWorld;
        this.impactVFX = impactVFX;
        this.eventBus = eventBus;
        this.grenades = [];
    }

    /**
     * Spawn a new grenade.
     * @param {THREE.Vector3} origin — launch position
     * @param {THREE.Vector3} velocity — initial velocity vector
     * @param {number} fuseTime — seconds until detonation
     * @param {string} throwerTeam — 'teamA' or 'teamB'
     * @param {string} [throwerName] — display name for kill feed
     */
    spawn(origin, velocity, fuseTime, throwerTeam, throwerName = '') {
        const grenade = new Grenade(
            this.scene, this.physics, origin, velocity, fuseTime, throwerTeam, throwerName
        );
        this.grenades.push(grenade);
    }

    /**
     * Update all grenades. Handle explosions.
     * @param {number} dt
     * @param {Array} allSoldiers — all AI soldiers (both teams)
     * @param {object|null} player — player entity or null
     */
    update(dt, allSoldiers, player) {
        for (let i = this.grenades.length - 1; i >= 0; i--) {
            const grenade = this.grenades[i];
            const result = grenade.update(dt);

            // Water splash on entry
            if (!grenade._waterSplashed && grenade.body.position.y <= WATER_Y && this.impactVFX) {
                grenade._waterSplashed = true;
                _splashPos.set(grenade.body.position.x, WATER_Y, grenade.body.position.z);
                this.impactVFX.spawn('water', _splashPos, _up);
            }

            if (result) {
                // Exploded
                this._handleExplosion(result.position, allSoldiers, player, grenade.throwerTeam, grenade.throwerName);
                this.grenades.splice(i, 1);
            } else if (!grenade.alive) {
                this.grenades.splice(i, 1);
            }
        }
    }

    _handleExplosion(pos, allSoldiers, player, throwerTeam, throwerName) {
        const def = WeaponDefs.GRENADE;

        // VFX
        if (this.impactVFX) {
            this.impactVFX.spawn('explosion', pos, _up);
        }

        // Damage living enemies + push ALL ragdolls (both teams)
        let enemyHitCount = 0;
        for (const soldier of allSoldiers) {
            if (soldier.alive) {
                if (soldier.team !== throwerTeam) {
                    const hpBefore = soldier.hp;
                    const wasAlive = soldier.alive;
                    this._applyBlastDamage(pos, soldier, def);
                    if (soldier.hp < hpBefore) enemyHitCount++;
                    if (wasAlive && !soldier.alive && this.eventBus) {
                        const vTeam = soldier.team;
                        this.eventBus.emit('kill', {
                            killerName: throwerName,
                            killerTeam: throwerTeam,
                            victimName: `${vTeam === 'teamA' ? 'A' : 'B'}-${soldier.id}`,
                            victimTeam: vTeam,
                            headshot: false,
                            weapon: 'GRENADE',
                        });
                    }
                }
            } else if (soldier.ragdollActive) {
                this._applyBlastImpulse(pos, soldier, def);
            }
        }

        // Damage player (skip if same team)
        if (player && player.alive && player.team !== throwerTeam) {
            const wasAlive = player.alive;
            this._applyBlastDamage(pos, player, def);
            if (wasAlive && !player.alive && this.eventBus) {
                this.eventBus.emit('kill', {
                    killerName: throwerName,
                    killerTeam: throwerTeam,
                    victimName: 'You',
                    victimTeam: player.team,
                    headshot: false,
                    weapon: 'GRENADE',
                });
            }
        }

        // Push dropped guns
        if (this.droppedGunManager) {
            for (const gun of this.droppedGunManager.guns) {
                const bp = gun.body.position;
                _diff.set(bp.x - pos.x, bp.y - pos.y, bp.z - pos.z);
                const dist = _diff.length();
                if (dist < def.blastRadius) {
                    const falloff = 1 - dist / def.blastRadius;
                    const strength = 50 * falloff;
                    _diff.normalize();
                    _impulseVec.set(_diff.x * strength, strength * 0.7, _diff.z * strength);
                    gun.body.applyImpulse(_impulseVec);
                }
            }
        }

        if (this.eventBus) {
            this.eventBus.emit('grenadeExploded', { position: pos, team: throwerTeam });
            if (enemyHitCount > 0) {
                this.eventBus.emit('grenadeDamage', { throwerName, throwerTeam, hitCount: enemyHitCount });
            }
        }
    }

    _applyBlastDamage(pos, target, def) {
        const targetPos = target.getPosition();
        _diff.subVectors(targetPos, pos);
        const dist = _diff.length();

        if (dist >= def.blastRadius) return;

        // Distance-attenuated damage (may trigger die() → ragdoll)
        const dmg = def.damageCenter * (1 - dist / def.blastRadius);
        target.takeDamage(dmg, pos, null);

        // Impulse after damage — if killed, ragdoll body is already set up by die()
        this._applyBlastImpulse(pos, target, def);
    }

    _applyBlastImpulse(pos, target, def) {
        if (!target.body) return;
        const targetPos = target.getPosition();
        _diff.subVectors(targetPos, pos);
        const dist = _diff.length();

        if (dist >= def.blastRadius) return;

        const falloff = 1 - dist / def.blastRadius;
        const strength = 600 * falloff;
        _diff.normalize();
        _impulseVec.set(_diff.x * strength, strength * 0.7, _diff.z * strength);
        target.body.applyImpulse(_impulseVec);
    }
}
