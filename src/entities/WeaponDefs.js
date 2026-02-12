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
    GRENADE: {
        name: 'Grenade',
        throwSpeed: 14,
        fuseTime: 2.5,
        blastRadius: 6,
        damageCenter: 200,
        maxPerLife: 2,
        cooldown: 5,
    },
    SMG: {
        name: 'SMG',
        magazineSize: 35,
        fireRate: 900,
        reloadTime: 2.0,
        damage: 15,
        headshotMultiplier: 2,
        maxRange: 120,
        falloffStart: 25,
        falloffEnd: 80,
        falloffMinScale: 0.2,
        baseSpread: 0.005,
        maxSpread: 0.10,
        spreadIncreasePerShot: 0.003,
        spreadRecoveryRate: 0.6,
    },
};
