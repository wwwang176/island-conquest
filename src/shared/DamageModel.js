/**
 * Pure-function damage model shared by Player and AI Soldier.
 * No Three.js / cannon-es dependencies.
 */

const HEADSHOT_THRESHOLD = 1.45;  // offset from body base Y
const LEGSHOT_THRESHOLD = 0.7;
const HEADSHOT_MULT = 2;
const LEGSHOT_MULT = 0.5;

/**
 * Compute hit damage from a hitscan ray impact.
 * @param {number} baseDamage - Weapon base damage
 * @param {number|null} hitY - World Y of the hit (null for explosions)
 * @param {number} baseY - Feet Y of the target
 * @returns {{ actualDamage: number, headshot: boolean, legshot: boolean }}
 */
export function computeHitDamage(baseDamage, hitY, baseY) {
    if (hitY === null || hitY === undefined) {
        return { actualDamage: baseDamage, headshot: false, legshot: false };
    }
    const headshot = hitY >= baseY + HEADSHOT_THRESHOLD;
    const legshot = !headshot && hitY < baseY + LEGSHOT_THRESHOLD;
    const actualDamage = headshot ? baseDamage * HEADSHOT_MULT
        : legshot ? baseDamage * LEGSHOT_MULT
        : baseDamage;
    return { actualDamage, headshot, legshot };
}

/**
 * Tick health regen for an entity.
 * Mutates entity.hp and entity.timeSinceLastDamage.
 * @param {{ hp: number, maxHP: number, timeSinceLastDamage: number, regenDelay: number, regenRate: number }} entity
 * @param {number} dt - Delta time in seconds
 */
export function applyHealthRegen(entity, dt) {
    entity.timeSinceLastDamage += dt;
    if (entity.timeSinceLastDamage >= entity.regenDelay && entity.hp < entity.maxHP) {
        entity.hp = Math.min(entity.maxHP, entity.hp + entity.regenRate * dt);
    }
}
