import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Grenade } from '../entities/Grenade.js';
import { WeaponDefs } from '../entities/WeaponDefs.js';

const _up = new THREE.Vector3(0, 1, 0);
const _diff = new THREE.Vector3();

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
     */
    spawn(origin, velocity, fuseTime, throwerTeam) {
        const grenade = new Grenade(
            this.scene, this.physics, origin, velocity, fuseTime, throwerTeam
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

            if (result) {
                // Exploded
                this._handleExplosion(result.position, allSoldiers, player, grenade.throwerTeam);
                this.grenades.splice(i, 1);
            } else if (!grenade.alive) {
                this.grenades.splice(i, 1);
            }
        }
    }

    _handleExplosion(pos, allSoldiers, player, throwerTeam) {
        const def = WeaponDefs.GRENADE;

        // VFX
        if (this.impactVFX) {
            this.impactVFX.spawn('explosion', pos, _up);
        }

        // Damage living soldiers + push ragdolls (skip friendly team)
        for (const soldier of allSoldiers) {
            if (soldier.team === throwerTeam) continue;
            if (soldier.alive) {
                this._applyBlastDamage(pos, soldier, def);
            } else if (soldier.ragdollActive) {
                this._applyBlastImpulse(pos, soldier, def);
            }
        }

        // Damage player (skip if same team)
        if (player && player.alive && player.team !== throwerTeam) {
            this._applyBlastDamage(pos, player, def);
        }

        if (this.eventBus) {
            this.eventBus.emit('grenadeExploded', { position: pos, team: throwerTeam });
        }
    }

    _applyBlastDamage(pos, target, def) {
        const targetPos = target.getPosition();
        _diff.subVectors(targetPos, pos);
        const dist = _diff.length();

        if (dist >= def.blastRadius) return;

        // Distance-attenuated damage (may trigger die() → ragdoll)
        const dmg = def.damageCenter * (1 - dist / def.blastRadius);
        target.takeDamage(dmg, pos, false);

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
        const strength = 250 * falloff;
        _diff.normalize();
        target.body.applyImpulse(
            new CANNON.Vec3(
                _diff.x * strength,
                strength * 0.7,
                _diff.z * strength
            )
        );
    }
}
