/**
 * Shared weapon definitions used by both Player (Weapon.js) and AI (AIController.js).
 * Add new weapon types (SMG, SHOTGUN, etc.) as additional keys.
 */
export const WeaponDefs = {
    AR15: {
        name: 'AR-15',
        magazineSize: 30,
        fireRate: 600,               // RPM
        reloadTime: 2.5,             // seconds
        damage: 25,
        headshotMultiplier: 2,
        maxRange: 200,
        // Damage falloff
        falloffStart: 50,
        falloffEnd: 150,
        falloffMinScale: 0.3,        // min damage multiplier at max range
        // Spread
        baseSpread: 0.003,
        maxSpread: 0.075,
        spreadIncreasePerShot: 0.004,
        spreadRecoveryRate: 0.4,
    },
};
