import * as THREE from 'three';
import { Speedboat } from '../entities/Speedboat.js';
import { Helicopter } from '../entities/Helicopter.js';

const WATER_Y = -0.3;

/**
 * Creates, tracks, and updates all vehicles.
 * Handles enter/exit logic for both players and AI.
 */
export class VehicleManager {
    /**
     * @param {THREE.Scene} scene
     * @param {object} physics - PhysicsWorld
     * @param {import('../world/FlagPoint.js').FlagPoint[]} flags
     * @param {Function} getHeightAt
     * @param {import('../core/EventBus.js').EventBus} eventBus
     */
    constructor(scene, physics, flags, getHeightAt, eventBus) {
        this.scene = scene;
        this.physics = physics;
        this.flags = flags;
        this.getHeightAt = getHeightAt;
        this.eventBus = eventBus;

        /** @type {import('../entities/Vehicle.js').Vehicle[]} */
        this.vehicles = [];

        /** @type {import('../vfx/ImpactVFX.js').ImpactVFX|null} */
        this.impactVFX = null; // set by Game after construction

        this._spawnInitialVehicles();
    }

    _spawnInitialVehicles() {
        const flagA = this.flags[0];
        const flagB = this.flags[this.flags.length - 1];

        // Team A: 2 speedboats + 1 helicopter near flag 0
        this._spawnTeamVehicles('teamA', flagA.position);
        // Team B: 2 speedboats + 1 helicopter near last flag
        this._spawnTeamVehicles('teamB', flagB.position);
    }

    _spawnTeamVehicles(team, basePos) {
        const baseFlag = team === 'teamA' ? this.flags[0] : this.flags[this.flags.length - 1];

        // Speedboats: find water near the base flag
        for (let i = 0; i < 2; i++) {
            const angle = (team === 'teamA' ? Math.PI * 0.7 : Math.PI * 0.3) + (i - 0.5) * 0.6;
            const pos = this._findWaterSpawn(basePos, angle, 15 + i * 8);
            if (pos) {
                const boat = new Speedboat(this.scene, team, pos);
                // Face toward map center
                boat.rotationY = team === 'teamA' ? -Math.PI * 0.3 : Math.PI * 0.3;
                boat.spawnRotationY = boat.rotationY;
                boat.mesh.rotation.y = boat.rotationY;
                boat.getHeightAt = this.getHeightAt;
                this.vehicles.push(boat);
            }
        }

        // Helicopter: on land near base flag
        const heliPos = this._findLandSpawn(basePos, 8);
        if (heliPos) {
            const heli = new Helicopter(this.scene, team, heliPos);
            heli.rotationY = team === 'teamA' ? 0 : Math.PI;
            heli.spawnRotationY = heli.rotationY;
            heli.mesh.rotation.y = heli.rotationY;
            heli.getHeightAt = this.getHeightAt;
            heli.spawnFlag = baseFlag;
            heli.initPhysicsBody(this.physics);
            this.vehicles.push(heli);
        }
    }

    _findWaterSpawn(basePos, angle, radius) {
        // Search outward from base to find water
        for (let r = radius; r < radius + 40; r += 3) {
            const x = basePos.x + Math.cos(angle) * r;
            const z = basePos.z + Math.sin(angle) * r;
            const h = this.getHeightAt(x, z);
            if (h < 0) {
                return new THREE.Vector3(x, WATER_Y + 0.3, z);
            }
        }
        // Fallback: just place at edge of map in water
        const x = basePos.x + Math.cos(angle) * 50;
        const z = basePos.z + Math.sin(angle) * 50;
        return new THREE.Vector3(x, WATER_Y + 0.3, z);
    }

    _findLandSpawn(basePos, radius) {
        // Find a flat land spot near the base
        for (let attempt = 0; attempt < 12; attempt++) {
            const angle = attempt * (Math.PI * 2 / 12);
            const x = basePos.x + Math.cos(angle) * radius;
            const z = basePos.z + Math.sin(angle) * radius;
            const h = this.getHeightAt(x, z);
            if (h > 0.5 && h < 6) {
                return new THREE.Vector3(x, h, z);
            }
        }
        // Fallback: on the flag itself
        const h = this.getHeightAt(basePos.x, basePos.z);
        return new THREE.Vector3(basePos.x, Math.max(h, 1), basePos.z);
    }

    /**
     * Propagate impactVFX reference to all vehicles.
     * @param {import('../vfx/ImpactVFX.js').ImpactVFX} vfx
     */
    setImpactVFX(vfx) {
        this.impactVFX = vfx;
        for (const v of this.vehicles) {
            v.impactVFX = vfx;
        }
    }

    /**
     * Per-frame update: update all vehicles.
     * @param {number} dt
     */
    update(dt) {
        for (const v of this.vehicles) {
            v.update(dt);
        }
    }

    /**
     * Try to enter the nearest available vehicle.
     * @param {object} entity - Player or Soldier
     * @returns {import('../entities/Vehicle.js').Vehicle|null}
     */
    tryEnterVehicle(entity) {
        let closest = null;
        let closestDist = Infinity;

        for (const v of this.vehicles) {
            if (!v.canEnter(entity)) continue;
            const pos = entity.getPosition();
            const vp = v.mesh.position;
            const dist = (pos.x - vp.x) ** 2 + (pos.z - vp.z) ** 2;
            if (dist < closestDist) {
                closestDist = dist;
                closest = v;
            }
        }

        if (closest) {
            return closest;
        }
        return null;
    }

    /**
     * Exit the driver from their current vehicle.
     * @param {object} entity - Player or Soldier
     * @returns {THREE.Vector3|null} exit position
     */
    exitVehicle(entity) {
        for (const v of this.vehicles) {
            // Check driver or passengers (helicopter)
            const isOccupant = v.driver === entity ||
                (v.passengers && v.passengers.includes(entity));
            if (!isOccupant) continue;

            const exitPos = v.exit(entity);
            if (v.type === 'speedboat') {
                // For speedboats, find nearest shore to place the exiting entity
                const shore = this.findNearestShore(v.mesh.position.x, v.mesh.position.z, 15);
                if (shore) {
                    exitPos.x = shore.x;
                    exitPos.z = shore.z;
                    exitPos.y = shore.y + 0.1;
                    return exitPos;
                }
            }
            // Non-speedboat or no shore found: use terrain height
            const h = this.getHeightAt(exitPos.x, exitPos.z);
            exitPos.y = Math.max(h + 0.1, WATER_Y + 0.5);
            return exitPos;
        }
        return null;
    }

    /**
     * Find the nearest available vehicle for an AI soldier.
     * @param {object} entity - Soldier
     * @param {number} maxDist - Maximum search distance
     * @returns {import('../entities/Vehicle.js').Vehicle|null}
     */
    findNearestVehicle(entity, maxDist = 80) {
        let closest = null;
        let closestDist = maxDist * maxDist;

        for (const v of this.vehicles) {
            if (!v.alive) continue;
            if (v.team !== entity.team) continue;
            // Check if vehicle has room
            if (v.type === 'helicopter') {
                if (v.occupantCount >= 5) continue;
            } else {
                if (v.driver) continue;
            }
            const pos = entity.getPosition();
            const vp = v.mesh.position;
            const dist = (pos.x - vp.x) ** 2 + (pos.z - vp.z) ** 2;
            if (dist < closestDist) {
                closestDist = dist;
                closest = v;
            }
        }
        return closest;
    }

    /**
     * Find the nearest land point (height > 0.1) near a water position.
     * Used for shore approach / exit from speedboats.
     * @param {number} x
     * @param {number} z
     * @param {number} maxRadius
     * @returns {THREE.Vector3|null}
     */
    findNearestShore(x, z, maxRadius = 15) {
        const step = 2;
        for (let r = step; r <= maxRadius; r += step) {
            const samples = Math.max(8, Math.floor(r * 2));
            let bestH = -Infinity;
            let bestX = x, bestZ = z;
            let found = false;
            for (let i = 0; i < samples; i++) {
                const angle = (i / samples) * Math.PI * 2;
                const sx = x + Math.cos(angle) * r;
                const sz = z + Math.sin(angle) * r;
                const h = this.getHeightAt(sx, sz);
                if (h > 0.1 && h > bestH) {
                    bestH = h;
                    bestX = sx;
                    bestZ = sz;
                    found = true;
                }
            }
            if (found) {
                return new THREE.Vector3(bestX, bestH, bestZ);
            }
        }
        return null;
    }

    /**
     * Get all vehicle meshes (for hitscan target list).
     * @returns {THREE.Mesh[]}
     */
    getVehicleMeshes() {
        if (!this._meshBuf) this._meshBuf = [];
        const meshes = this._meshBuf;
        meshes.length = 0;
        for (const v of this.vehicles) {
            // Include alive vehicles and crashing helicopters (still collidable)
            const visible = v.alive || (v._crashing && v.mesh && v.mesh.visible);
            if (!visible || !v.mesh) continue;
            // Use collision proxy for helicopters (single box vs ~7 children)
            if (v._collisionProxy) {
                meshes.push(v._collisionProxy);
            } else {
                meshes.push(v.mesh);
            }
        }
        return meshes;
    }

    /**
     * Get all vehicles for a given team.
     * @param {string} team
     * @returns {import('../entities/Vehicle.js').Vehicle[]}
     */
    getTeamVehicles(team) {
        return this.vehicles.filter(v => v.team === team);
    }
}
