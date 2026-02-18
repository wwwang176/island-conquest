import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Vehicle } from './Vehicle.js';

const WATER_Y = -0.3;
const MAP_HALF_W = 150;
const MAP_HALF_D = 60;

/**
 * Speedboat vehicle — water surface transport.
 * Kinematic: constrained to Y = WATER_Y, yaw steering only.
 */
export class Speedboat extends Vehicle {
    constructor(scene, team, spawnPosition) {
        super(scene, team, 'speedboat', spawnPosition);

        this.maxSpeed = 11;     // m/s
        this.acceleration = 10; // m/s²
        this.turnSpeed = 1.8;   // rad/s
        this.drag = 2.0;        // deceleration coefficient
        this.enterRadius = 5;   // wider radius so shore units can board

        // getHeightAt — set by VehicleManager after construction
        this.getHeightAt = null;

        // Build mesh
        this.mesh = this._createMesh();
        this.mesh.userData.vehicle = this;
        scene.add(this.mesh);

        // Set initial position
        this.mesh.position.copy(spawnPosition);
        this.mesh.position.y = WATER_Y + 0.3;
        this.rotationY = this.spawnRotationY;

        // Wake particles (simple trailing effect)
        this._wakeTimer = 0;
    }

    _createMesh() {
        const teamColor = this.team === 'teamA' ? 0x3366cc : 0xcc3333;
        const hullColor = 0x888888;

        // Hull: tapered box
        const hullGeo = new THREE.BoxGeometry(2, 0.6, 5);
        // Taper the front (narrow the bow)
        const hullPos = hullGeo.attributes.position;
        for (let i = 0; i < hullPos.count; i++) {
            const z = hullPos.getZ(i);
            if (z < 0) { // front half
                const t = Math.abs(z) / 2.5;
                const scale = 1 - t * 0.5;
                hullPos.setX(i, hullPos.getX(i) * scale);
            }
        }
        hullPos.needsUpdate = true;
        hullGeo.computeVertexNormals();

        // Cabin
        const cabinGeo = new THREE.BoxGeometry(1.2, 0.6, 1.5);
        cabinGeo.translate(0, 0.6, 0.5);

        // Team stripe
        const stripeGeo = new THREE.BoxGeometry(2.02, 0.15, 1);
        stripeGeo.translate(0, 0.2, -0.5);

        // Set vertex colors
        this._setGeometryColor(hullGeo, hullColor);
        this._setGeometryColor(cabinGeo, 0x666666);
        this._setGeometryColor(stripeGeo, teamColor);

        const merged = mergeGeometries([hullGeo, cabinGeo, stripeGeo]);
        merged.rotateY(Math.PI); // Bow faces +Z (movement forward direction)
        hullGeo.dispose();
        cabinGeo.dispose();
        stripeGeo.dispose();

        const mesh = new THREE.Mesh(
            merged,
            new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
        );
        mesh.castShadow = true;
        return mesh;
    }

    _setGeometryColor(geo, hex) {
        const color = new THREE.Color(hex);
        const count = geo.attributes.position.count;
        const colors = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    update(dt) {
        super.update(dt);
        if (!this.alive) return;

        // Apply drag when no driver
        if (!this.driver) {
            this.speed *= Math.max(0, 1 - this.drag * dt);
            if (Math.abs(this.speed) < 0.1) this.speed = 0;
        }

        // Move
        if (Math.abs(this.speed) > 0.01) {
            this.mesh.position.x += Math.sin(this.rotationY) * this.speed * dt;
            this.mesh.position.z += Math.cos(this.rotationY) * this.speed * dt;
        }

        // Terrain collision — stop at shoreline
        if (this.getHeightAt && Math.abs(this.speed) > 0.1) {
            const h = this.getHeightAt(this.mesh.position.x, this.mesh.position.z);
            if (h > -0.5) {
                // Push back to previous position and stop
                this.mesh.position.x -= Math.sin(this.rotationY) * this.speed * dt;
                this.mesh.position.z -= Math.cos(this.rotationY) * this.speed * dt;
                this.speed = 0;
            }
        }

        // Map boundary — reflect heading off walls
        const px = this.mesh.position.x;
        const pz = this.mesh.position.z;
        if (px < -MAP_HALF_W || px > MAP_HALF_W) {
            this.mesh.position.x = Math.max(-MAP_HALF_W, Math.min(MAP_HALF_W, px));
            this.rotationY = Math.PI - this.rotationY; // reflect across Z axis
            this.speed *= 0.6;
        }
        if (pz < -MAP_HALF_D || pz > MAP_HALF_D) {
            this.mesh.position.z = Math.max(-MAP_HALF_D, Math.min(MAP_HALF_D, pz));
            this.rotationY = -this.rotationY; // reflect across X axis
            this.speed *= 0.6;
        }

        // Constrain to water surface
        this.mesh.position.y = WATER_Y + 0.3;
        this.mesh.rotation.y = this.rotationY;

        // Gentle bob
        this.mesh.position.y += Math.sin(performance.now() * 0.002) * 0.05;
    }

    applyInput(input, dt) {
        if (!this.alive) return;

        // Thrust
        if (input.thrust > 0) {
            this.speed = Math.min(this.maxSpeed, this.speed + this.acceleration * input.thrust * dt);
        }
        if (input.brake > 0) {
            this.speed = Math.max(-this.maxSpeed * 0.3, this.speed - this.acceleration * input.brake * dt);
        }

        // Drag
        this.speed *= Math.max(0, 1 - this.drag * 0.3 * dt);

        // Steering (only when moving)
        if (Math.abs(this.speed) > 0.5) {
            const steerFactor = Math.min(1, Math.abs(this.speed) / 5);
            if (input.steerLeft) this.rotationY += this.turnSpeed * steerFactor * dt;
            if (input.steerRight) this.rotationY -= this.turnSpeed * steerFactor * dt;
        }
    }

    destroy() {
        // Kill the driver before ejecting
        if (this.driver) {
            const driver = this.driver;
            // Clear vehicle references first
            if (driver.vehicle !== undefined) driver.vehicle = null;
            if (driver.controller) {
                driver.controller.vehicle = null;
                driver.controller._vehicleMoveTarget = null;
            }
            this.driver = null;
            // Deal lethal damage
            if (driver.takeDamage) driver.takeDamage(999);
        }

        // Spawn explosion VFX
        if (this.impactVFX && this.mesh) {
            this.impactVFX.spawn('explosion', this.mesh.position, null);
        }

        this.alive = false;
        this.hp = 0;
        this.speed = 0;
        this.respawnTimer = this.respawnDelay;
        if (this.mesh) this.mesh.visible = false;
    }

    respawn() {
        super.respawn();
        if (this.mesh) {
            this.mesh.position.y = WATER_Y + 0.3;
        }
    }
}
