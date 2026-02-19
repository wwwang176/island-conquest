/**
 * Distance-based damage falloff, shared by Player Weapon and AI firing.
 * No Three.js / cannon-es dependencies.
 */

/**
 * Apply linear distance falloff to base damage.
 * @param {number} baseDmg - Weapon base damage
 * @param {number} dist - Hit distance
 * @param {number} falloffStart - Distance where falloff begins
 * @param {number} falloffEnd - Distance where falloff reaches minimum
 * @param {number} falloffMinScale - Minimum damage multiplier (0–1)
 * @returns {number} Scaled damage
 */
export function applyFalloff(baseDmg, dist, falloffStart, falloffEnd, falloffMinScale) {
    if (dist <= falloffStart) return baseDmg;
    const t = Math.min((dist - falloffStart) / (falloffEnd - falloffStart), 1);
    return baseDmg * (1 - t * (1 - falloffMinScale));
}
