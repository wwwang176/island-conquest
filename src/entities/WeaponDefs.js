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
        moveSpeedMult: 1.0,
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
        damage: 18,
        headshotMultiplier: 2,
        maxRange: 120,
        falloffStart: 25,
        falloffEnd: 80,
        falloffMinScale: 0.2,
        baseSpread: 0.005,
        maxSpread: 0.10,
        spreadIncreasePerShot: 0.003,
        spreadRecoveryRate: 0.6,
        moveSpeedMult: 1.15,
    },
    LMG: {
        name: 'LMG',
        magazineSize: 120,
        fireRate: 450,
        reloadTime: 5.0,
        damage: 20,
        headshotMultiplier: 2,
        maxRange: 180,
        falloffStart: 40,
        falloffEnd: 130,
        falloffMinScale: 0.25,
        baseSpread: 0.024,
        maxSpread: 0.0975,
        spreadIncreasePerShot: -0.0003,  // negative: sustained fire tightens spread
        spreadRecoveryRate: 0.225,
        moveSpeedMult: 0.7,
        minSpread: 0.012,                // floor for sustained fire tightening
    },
};
