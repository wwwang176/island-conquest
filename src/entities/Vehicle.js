import * as THREE from 'three';

/**
 * Base vehicle class.
 * Handles HP, damage, destroy/respawn cycle, enter/exit.
 */
export class Vehicle {
    /**
     * @param {THREE.Scene} scene
     * @param {string} team - 'teamA' | 'teamB'
     * @param {string} type - 'helicopter'
     * @param {THREE.Vector3} spawnPosition
     */
    constructor(scene, team, type, spawnPosition) {
        this.scene = scene;
        this.team = team;
        this.type = type;

        // Health
        this.maxHP = 250;
        this.hp = this.maxHP;
        this.alive = true;

        // Occupants
        this.driver = null; // Player | Soldier | null

        // Spawn / respawn
        this.spawnPosition = spawnPosition.clone();
        this.spawnRotationY = 0;
        this.respawnTimer = 0;
        this.respawnDelay = 45;
        this.enterRadius = 3;

        // Mesh (set by subclass)
        this.mesh = null;

        // VFX reference (set by VehicleManager)
        this.impactVFX = null;

        // Movement state
        this.velocityX = 0;
        this.velocityZ = 0;
        this.rotationY = 0;
        this.speed = 0;
    }

    /**
     * Per-frame update.
     * @param {number} dt
     */
    update(dt) {
        if (!this.alive) {
            this.respawnTimer -= dt;
            if (this.respawnTimer <= 0) {
                this.respawn();
            }
            return;
        }
    }

    /**
     * Process driving input (overridden by subclass).
     * @param {object} input - { thrust, brake, steerLeft, steerRight, ascend, descend }
     * @param {number} dt
     */
    applyInput(input, dt) {
        // Subclass implements
    }

    /**
     * Apply damage to the vehicle.
     * @param {number} amount
     * @returns {{ destroyed: boolean, damage: number }}
     */
    takeDamage(amount) {
        if (!this.alive) return { destroyed: false, damage: 0 };
        this.hp = Math.max(0, this.hp - amount);
        if (this.hp <= 0) {
            this.destroy();
            return { destroyed: true, damage: amount };
        }
        return { destroyed: false, damage: amount };
    }

    /**
     * Destroy the vehicle. Eject driver, start respawn timer.
     */
    destroy() {
        this.alive = false;
        this.hp = 0;
        this.respawnTimer = this.respawnDelay;

        // Eject driver — restore their state
        if (this.driver) {
            const driver = this.driver;
            this.driver = null;

            // Check if it's a Player (has .vehicle property)
            if (driver.vehicle !== undefined) {
                driver.vehicle = null;
            }
            // Check if it's an AI soldier with a controller
            if (driver.controller && driver.controller.vehicle) {
                driver.controller.vehicle = null;
                driver.controller._vehicleMoveTarget = null;
            }
            // Make driver mesh visible again
            if (driver.mesh) {
                // Player mesh stays hidden in FPS, but AI mesh should be visible
                if (driver.controller) {
                    driver.mesh.visible = true;
                }
            }
        }

        // Hide mesh
        if (this.mesh) {
            this.mesh.visible = false;
        }
    }

    /**
     * Respawn at original position.
     */
    respawn() {
        this.alive = true;
        this.hp = this.maxHP;
        this.speed = 0;
        this.velocityX = 0;
        this.velocityZ = 0;
        this.rotationY = this.spawnRotationY;

        if (this.mesh) {
            this.mesh.visible = true;
            this.mesh.position.copy(this.spawnPosition);
            this.mesh.rotation.y = this.rotationY;
        }
    }

    /**
     * Check if an entity can enter this vehicle.
     * @param {object} entity - Player or Soldier
     * @returns {boolean}
     */
    canEnter(entity) {
        if (!this.alive) return false;
        if (this.driver) return false;
        if (entity.team !== this.team) return false;
        const pos = entity.getPosition();
        const vp = this.mesh ? this.mesh.position : this.spawnPosition;
        const dx = pos.x - vp.x;
        const dz = pos.z - vp.z;
        return (dx * dx + dz * dz) < this.enterRadius * this.enterRadius;
    }

    /**
     * Enter the vehicle.
     * @param {object} entity - Player or Soldier
     */
    enter(entity) {
        this.driver = entity;
    }

    /**
     * Exit the vehicle. Returns the exit position.
     * @param {object} entity
     * @returns {THREE.Vector3} exit position
     */
    exit(entity) {
        if (this.driver === entity) {
            this.driver = null;
        }
        // Exit position: side of the vehicle
        const exitPos = this.mesh.position.clone();
        const sideAngle = this.rotationY + Math.PI / 2;
        exitPos.x += Math.cos(sideAngle) * 2.5;
        exitPos.z += Math.sin(sideAngle) * 2.5;
        return exitPos;
    }

    /**
     * Internal: eject driver during destruction.
     */
    _ejectDriver() {
        const driver = this.driver;
        this.driver = null;
        return driver;
    }

    /**
     * Get current world position.
     * @returns {THREE.Vector3}
     */
    getPosition() {
        return this.mesh ? this.mesh.position.clone() : this.spawnPosition.clone();
    }
}
