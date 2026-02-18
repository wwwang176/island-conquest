import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Vehicle } from './Vehicle.js';

const WATER_Y = -0.3;
const MAP_HALF_W = 150;
const MAP_HALF_D = 60;

const PILOT_OFFSET = { x: 0, y: 0.5, z: 0.7 };

const PASSENGER_SLOTS = [
    { x: -0.9, y: 0.5, z: -1.2, facingOffset:  Math.PI / 2 },  // port rear (left)
    { x:  0.9, y: 0.5, z: -1.2, facingOffset: -Math.PI / 2 },  // starboard rear (right)
];

export { PILOT_OFFSET as BOAT_PILOT_OFFSET, PASSENGER_SLOTS as BOAT_PASSENGER_SLOTS };

/**
 * Speedboat vehicle — fast water surface transport.
 * Kinematic: constrained to Y = WATER_Y, yaw steering only.
 * Seats: 1 pilot + 2 passengers (passengers can fire outward).
 */
export class Speedboat extends Vehicle {
    constructor(scene, team, spawnPosition) {
        super(scene, team, 'speedboat', spawnPosition);

        this.maxSpeed = 25;      // m/s — fastest surface vehicle
        this.acceleration = 18;  // m/s²
        this.turnSpeed = 1.8;    // rad/s
        this.drag = 1.0;         // deceleration coefficient (no-occupant)
        this.enterRadius = 7;    // wider radius for 1.5× hull
        this.maxHP = 1500;
        this.hp = this.maxHP;

        // Inertial velocity vector (replaces scalar speed)
        this.velX = 0;
        this.velZ = 0;
        this.hDrag = 1.0;       // low drag → fast acceleration, long coast
        this.speed = 0; // derived: forward component of velocity
        this._yawRate = 0; // smoothed yaw angular velocity

        // Multi-passenger
        this.passengers = [];
        this.maxPassengers = 2;

        // getHeightAt — set by VehicleManager after construction
        this.getHeightAt = null;

        // Build mesh (scaled 1.5×)
        this.mesh = this._createMesh();
        this.mesh.scale.set(1.5, 1.5, 1.5);
        this.mesh.userData.vehicle = this;
        this.mesh.userData.surfaceType = 'rock'; // spark particles on bullet hit
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

    // ───── Multi-passenger overrides ─────

    get occupantCount() {
        return (this.driver ? 1 : 0) + this.passengers.length;
    }

    canEnter(entity) {
        if (!this.alive) return false;
        if (entity.team !== this.team) return false;
        if (this.occupantCount >= 3) return false; // 1 pilot + 2 passengers
        const pos = entity.getPosition();
        const vp = this.mesh ? this.mesh.position : this.spawnPosition;
        const dx = pos.x - vp.x;
        const dz = pos.z - vp.z;
        return (dx * dx + dz * dz) < this.enterRadius * this.enterRadius;
    }

    enter(entity) {
        if (!this.driver) {
            this.driver = entity;
        } else {
            this.passengers.push(entity);
        }
    }

    exit(entity) {
        if (this.driver === entity) {
            this.driver = null;
            // Promote first passenger to pilot
            if (this.passengers.length > 0) {
                this.driver = this.passengers.shift();
            }
        } else {
            const idx = this.passengers.indexOf(entity);
            if (idx >= 0) this.passengers.splice(idx, 1);
        }
        // Return exit position
        const exitPos = this.mesh.position.clone();
        const sideAngle = this.rotationY + Math.PI / 2;
        exitPos.x += Math.cos(sideAngle) * 2.5;
        exitPos.z += Math.sin(sideAngle) * 2.5;
        return exitPos;
    }

    getAllOccupants() {
        const list = [];
        if (this.driver) list.push(this.driver);
        list.push(...this.passengers);
        return list;
    }

    /**
     * Transform a local-space offset to world position using yaw rotation.
     * @param {THREE.Vector3} out - output vector (modified in place)
     * @param {{x:number,y:number,z:number}} offset - local offset
     */
    getWorldSeatPos(out, offset) {
        const c = Math.cos(this.rotationY);
        const s = Math.sin(this.rotationY);
        const vp = this.mesh.position;
        out.x = vp.x + offset.x * c + offset.z * s;
        out.y = vp.y + offset.y;
        out.z = vp.z - offset.x * s + offset.z * c;
    }

    // ───── Physics ─────

    update(dt) {
        super.update(dt);
        if (!this.alive) return;

        // Drag when no occupants
        if (!this.driver && this.passengers.length === 0) {
            const hDragFactor = Math.max(0, 1 - this.hDrag * dt);
            this.velX *= hDragFactor;
            this.velZ *= hDragFactor;
        }

        // Derive scalar speed (forward component along heading)
        const fwdX = Math.sin(this.rotationY);
        const fwdZ = Math.cos(this.rotationY);
        this.speed = this.velX * fwdX + this.velZ * fwdZ;

        // Apply velocity vector
        if (this.velX * this.velX + this.velZ * this.velZ > 0.0001) {
            this.mesh.position.x += this.velX * dt;
            this.mesh.position.z += this.velZ * dt;
        }

        // Terrain collision — bounce off shoreline
        if (this.getHeightAt) {
            const hSpd = Math.sqrt(this.velX * this.velX + this.velZ * this.velZ);
            if (hSpd > 0.1) {
                const h = this.getHeightAt(this.mesh.position.x, this.mesh.position.z);
                if (h > -0.15) {
                    // Push back
                    this.mesh.position.x -= this.velX * dt;
                    this.mesh.position.z -= this.velZ * dt;
                    // Reflect velocity off shore normal (approximate: reverse forward component)
                    const dot = this.velX * fwdX + this.velZ * fwdZ;
                    this.velX -= 1.5 * dot * fwdX;
                    this.velZ -= 1.5 * dot * fwdZ;
                    // Dampen
                    this.velX *= 0.4;
                    this.velZ *= 0.4;
                }
            }
        }

        // Map boundary — clamp + kill velocity into wall
        const px = this.mesh.position.x;
        const pz = this.mesh.position.z;
        if (px < -MAP_HALF_W) { this.mesh.position.x = -MAP_HALF_W; if (this.velX < 0) this.velX = 0; }
        if (px >  MAP_HALF_W) { this.mesh.position.x =  MAP_HALF_W; if (this.velX > 0) this.velX = 0; }
        if (pz < -MAP_HALF_D) { this.mesh.position.z = -MAP_HALF_D; if (this.velZ < 0) this.velZ = 0; }
        if (pz >  MAP_HALF_D) { this.mesh.position.z =  MAP_HALF_D; if (this.velZ > 0) this.velZ = 0; }

        // Constrain to water surface
        this.mesh.position.y = WATER_Y + 0.3;
        this.mesh.rotation.y = this.rotationY;

        // Gentle bob
        this.mesh.position.y += Math.sin(performance.now() * 0.002) * 0.05;
    }

    applyInput(input, dt) {
        if (!this.alive) return;

        const fwdX = Math.sin(this.rotationY);
        const fwdZ = Math.cos(this.rotationY);

        // Thrust: add force along current heading
        if (input.thrust > 0) {
            this.velX += fwdX * this.acceleration * input.thrust * dt;
            this.velZ += fwdZ * this.acceleration * input.thrust * dt;
        }
        // Brake: add force opposite to current heading
        if (input.brake > 0) {
            this.velX -= fwdX * this.acceleration * input.brake * dt;
            this.velZ -= fwdZ * this.acceleration * input.brake * dt;
        }

        // Water drag (applied to velocity vector)
        const hDragFactor = Math.max(0, 1 - this.hDrag * 0.3 * dt);
        this.velX *= hDragFactor;
        this.velZ *= hDragFactor;

        // Clamp horizontal speed
        const hSpd = Math.sqrt(this.velX * this.velX + this.velZ * this.velZ);
        if (hSpd > this.maxSpeed) {
            const scale = this.maxSpeed / hSpd;
            this.velX *= scale;
            this.velZ *= scale;
        }

        // Steering — smooth yaw rate (only when moving)
        let targetYaw = 0;
        if (hSpd > 0.5) {
            const steerFactor = Math.min(1, hSpd / 5);
            if (input.steerLeft) targetYaw = this.turnSpeed * steerFactor;
            if (input.steerRight) targetYaw = -this.turnSpeed * steerFactor;
        }
        const yawLerp = 1 - Math.exp(-5 * dt);
        this._yawRate += (targetYaw - this._yawRate) * yawLerp;
        this.rotationY += this._yawRate * dt;
    }

    // ───── Destroy & Respawn ─────

    destroy() {
        // Explosion VFX at current position
        if (this.impactVFX && this.mesh) {
            this.impactVFX.spawn('explosion', this.mesh.position, null);
        }

        // Kill all occupants
        this._killAllOccupants();

        this.alive = false;
        this.hp = 0;
        this.velX = 0;
        this.velZ = 0;
        this.speed = 0;
        this._yawRate = 0;
        this.respawnTimer = this.respawnDelay;
        if (this.mesh) this.mesh.visible = false;
    }

    _killAllOccupants() {
        const occupants = this.getAllOccupants();
        for (const occ of occupants) {
            if (occ.vehicle !== undefined) occ.vehicle = null;
            if (occ.controller) {
                occ.controller.vehicle = null;
                occ.controller._vehicleMoveTarget = null;
            }
            if (occ.takeDamage) occ.takeDamage(9999);
        }
        this.driver = null;
        this.passengers = [];
    }

    respawn() {
        this.alive = true;
        this.hp = this.maxHP;
        this.speed = 0;
        this.velX = 0;
        this.velZ = 0;
        this._yawRate = 0;
        this.rotationY = this.spawnRotationY;
        this.passengers = [];

        if (this.mesh) {
            this.mesh.visible = true;
            this.mesh.position.copy(this.spawnPosition);
            this.mesh.position.y = WATER_Y + 0.3;
            this.mesh.rotation.y = this.rotationY;
        }
    }
}
