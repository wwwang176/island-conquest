import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Vehicle } from './Vehicle.js';

const WATER_Y = -0.3;
const MAP_HALF_W = 150;  // island.width / 2
const MAP_HALF_D = 60;   // island.depth / 2
const _cannonYAxis = new CANNON.Vec3(0, 1, 0);
const _euler = new THREE.Euler();
const _threeQuat = new THREE.Quaternion();

/**
 * World-space offsets from helicopter mesh center (rotY=0, facing +Z).
 * Hull is rotated PI internally, so hull-local (x,y,z) → world (-x,y,-z).
 * Cabin sides at world x≈±0.9, cabin floor at y≈-0.55, cabin z from -1.3 to +1.3.
 */
const PILOT_OFFSET = { x: 0, y: -1.15, z: 1.4 }; // cockpit (nose area, sunk into seat)

const PASSENGER_SLOTS = [
    { x: -0.75, y: -1.2, z:  0.2, facingOffset:  Math.PI / 2 },  // left front  → face -X (outward)
    { x:  0.75, y: -1.2, z:  0.2, facingOffset: -Math.PI / 2 },  // right front → face +X (outward)
    { x: -0.75, y: -1.2, z: -0.7, facingOffset:  Math.PI / 2 },  // left rear   → face -X (outward)
    { x:  0.75, y: -1.2, z: -0.7, facingOffset: -Math.PI / 2 },  // right rear  → face +X (outward)
];

/**
 * Helicopter vehicle — force-driven flight model.
 * Dynamic body with anti-gravity; collision feedback via body.velocity.
 * Seats: 1 pilot + 4 passengers (all can fire).
 */
export { PASSENGER_SLOTS as HELI_PASSENGER_SLOTS, PILOT_OFFSET as HELI_PILOT_OFFSET };

export class Helicopter extends Vehicle {
    constructor(scene, team, spawnPosition) {
        super(scene, team, 'helicopter', spawnPosition);

        this.maxHP = 6000;
        this.hp = this.maxHP;

        // Helicopters are large, loud, and unobstructed in the sky
        this.detectionRange = 120;   // aerial view → see further
        this.visibilityRange = 120;  // easy to spot from ground

        // Multi-passenger
        this.passengers = [];
        this.maxPassengers = 4;

        // Flight parameters
        this.maxHSpeed = 45;    // horizontal m/s
        this.maxVSpeed = 8;     // vertical m/s
        this.hAccel = 14;       // horizontal acceleration
        this.vAccel = 14;       // vertical acceleration
        this.hDrag = 2.2;       // horizontal drag
        this.vDrag = 4;         // vertical drag
        this.turnSpeed = 2.2;   // rad/s
        this.minAltitude = WATER_Y + 1;
        this.maxAltitude = 30;

        // Velocity vector (inertial flight model)
        this.velX = 0;
        this.velZ = 0;
        this.velocityY = 0;
        this.speed = 0;             // derived: magnitude of (velX, velZ)
        this.altitude = spawnPosition.y;

        // Visual attitude (smoothed)
        this._visualPitch = 0;   // rotation.x — nose down/up
        this._visualRoll = 0;    // rotation.z — bank left/right
        this._yawRate = 0;       // smoothed yaw angular velocity (rad/s)
        this._inputThrust = 0;   // cached for visual pitch anticipation
        this._inputBrake = 0;

        // Crash state
        this._crashing = false;
        this._wreckageTimer = 0; // time wreckage stays on ground before vanishing

        // getHeightAt — set by VehicleManager after construction
        this.getHeightAt = null;
        this._groundY = 0; // cached terrain height for idle check

        // Spawn flag — set by VehicleManager; used to switch team on respawn
        this.spawnFlag = null;

        // Physics collision body — created by initPhysicsBody()
        this.body = null;
        this._physics = null;

        // Rotor animation
        this._rotorAngle = 0;
        this._rotorMesh = null;
        this._tailRotorMesh = null;

        // Cached world quaternion for passengers/pilot (updated once per frame in update())
        this._cachedWorldQuat = new THREE.Quaternion();

        // Build mesh
        this.mesh = this._createMesh();
        this.mesh.userData.vehicle = this;
        this.mesh.userData.surfaceType = 'rock'; // spark particles on bullet hit
        scene.add(this.mesh);

        // Position
        this.mesh.position.copy(spawnPosition);
        this.mesh.position.y = spawnPosition.y + 1.1;
    }

    /**
     * Create CANNON collision body. Called by VehicleManager after construction.
     * @param {import('../systems/PhysicsWorld.js').PhysicsWorld} physics
     */
    initPhysicsBody(physics) {
        this._physics = physics;

        this.body = new CANNON.Body({
            mass: 300,
            type: CANNON.Body.DYNAMIC,
            collisionFilterGroup: 4,
            collisionFilterMask: 5,  // 1(terrain)|4(helicopters) — excludes soldiers(2)
            linearDamping: 0.5,
            angularDamping: 0.0,   // yaw damping handled manually
            allowSleep: false,     // helicopter must never sleep
        });

        // Main fuselage box (cabin + nose area)
        this.body.addShape(
            new CANNON.Box(new CANNON.Vec3(0.9, 0.7, 2.5)),
            new CANNON.Vec3(0, -0.15, 0)
        );
        // Nose cone
        this.body.addShape(
            new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)),
            new CANNON.Vec3(0, -0.2, 2.8)
        );
        // Tail boom
        this.body.addShape(
            new CANNON.Box(new CANNON.Vec3(0.2, 0.2, 1.8)),
            new CANNON.Vec3(0, 0.1, -3.2) // behind center (world -Z = hull +Z tail)
        );

        this._syncBody();
        physics.addBody(this.body);

        // Anti-gravity: runs per sub-step so it perfectly cancels world gravity
        this._preStepListener = () => {
            if (!this.body || !this.alive || this._crashing) return;
            this.body.force.y += this.body.mass * 9.82;
        };
        physics.world.addEventListener('preStep', this._preStepListener);
    }

    /**
     * Transform a local-space offset to world position using the mesh's full rotation
     * (yaw + pitch + roll). Used for AI soldier positioning.
     * @param {THREE.Vector3} out - output vector (modified in place)
     * @param {{x:number,y:number,z:number}} offset - local offset
     */
    getWorldSeatPos(out, offset) {
        out.set(offset.x, offset.y, offset.z);
        // Cache world matrix once per frame — avoid repeated ancestor traversal
        const frame = this._matrixFrame || 0;
        const now = this._frameCounter || 0;
        if (frame !== now) {
            this._attitudeGroup.updateWorldMatrix(true, false);
            this._matrixFrame = now;
        }
        this._attitudeGroup.localToWorld(out);
    }

    /**
     * Transform a local-space offset using yaw-only rotation (ignores pitch/roll).
     * Used for player camera to avoid jitter from attitude changes.
     * @param {THREE.Vector3} out - output vector (modified in place)
     * @param {{x:number,y:number,z:number}} offset - local offset
     */
    getYawSeatPos(out, offset) {
        const c = Math.cos(this.rotationY);
        const s = Math.sin(this.rotationY);
        const vp = this.mesh.position;
        out.x = vp.x + offset.x * c + offset.z * s;
        out.y = vp.y + offset.y;
        out.z = vp.z - offset.x * s + offset.z * c;
    }

    /** Sync CANNON body position/rotation to mesh. */
    _syncBody() {
        if (!this.body) return;
        const p = this.mesh.position;
        this.body.position.set(p.x, p.y, p.z);
        this.body.quaternion.setFromAxisAngle(_cannonYAxis, this.rotationY);
    }

    _createMesh() {
        const teamColor = this.team === 'teamA' ? 0x3366cc : 0xcc3333;
        const OD = 0x4a5a2a;  // olive drab
        const DK = 0x333333;  // dark grey
        const mat = (c, opts) => new THREE.MeshLambertMaterial({ color: c, flatShading: true, ...opts });

        const group = new THREE.Group();
        // Attitude group: pitch + roll (nested under yaw mesh)
        this._attitudeGroup = new THREE.Group();
        group.add(this._attitudeGroup);

        // Hull rotation matrix (PI around Y): -Z local = nose → +Z world
        const hullRot = new THREE.Matrix4().makeRotationY(Math.PI);
        // Helper: bake hull rotation + local position into geometry
        const place = (geo, x, y, z) => {
            const m = new THREE.Matrix4().makeTranslation(x, y, z);
            m.premultiply(hullRot);
            return geo.applyMatrix4(m);
        };

        // ── Collect geometries by material ──
        const odGeos = [];  // olive drab
        const dkGeos = [];  // dark grey

        // Cabin: floor, roof, back wall
        odGeos.push(place(new THREE.BoxGeometry(1.8, 0.12, 2.6), 0, -0.55, 0));
        odGeos.push(place(new THREE.BoxGeometry(1.8, 0.12, 2.6), 0, 0.65, 0));
        odGeos.push(place(new THREE.BoxGeometry(1.8, 1.2, 0.12), 0, 0.05, 1.3));

        // Door-frame pillars
        odGeos.push(place(new THREE.BoxGeometry(0.08, 1.2, 0.08), -0.9, 0.05, -1.25));
        odGeos.push(place(new THREE.BoxGeometry(0.08, 1.2, 0.08), 0.9, 0.05, -1.25));

        // ── Nose: glass cockpit with metal frame ──
        // Tapered extension of cabin (flush at junction, narrows toward front).
        // Surface is mostly glass; metal = horizontal band + vertical keel.
        const noseLen = 1.5;
        const noseCZ = -2.05; // center Z in hull-local (-1.3 to -2.8)
        const noseCenterY = 0.0;
        const TAPER = 0.4;

        // Metal frame (outline only, not solid)
        // edgeStrip: thin bar at xPos that follows the nose taper
        const edgeStrip = (stripW, h, centerY, xPos) => {
            const geo = new THREE.BoxGeometry(stripW, h, noseLen);
            const pos = geo.attributes.position;
            const halfD = noseLen / 2;
            const relY = noseCenterY - centerY;
            for (let i = 0; i < pos.count; i++) {
                const z = pos.getZ(i);
                const t = (halfD - z) / noseLen;
                const s = 1 - t * TAPER;
                pos.setX(i, xPos * s + pos.getX(i) * s);
                const y = pos.getY(i);
                pos.setY(i, y + (relY - y) * t * TAPER);
            }
            pos.needsUpdate = true;
            geo.computeVertexNormals();
            return geo;
        };
        // Horizontal belt: left + right side strips (5cm outside glass surface)
        odGeos.push(place(edgeStrip(0.10, 0.10, 0.0, -0.90), 0, 0.0, noseCZ));
        odGeos.push(place(edgeStrip(0.10, 0.10, 0.0,  0.90), 0, 0.0, noseCZ));
        // Horizontal belt: front connecting bar
        const frontW = 1.7 * (1 - TAPER);
        odGeos.push(place(new THREE.BoxGeometry(frontW, 0.10, 0.10), 0, 0.0, -2.80));
        // Vertical keel: front bar at nose tip
        odGeos.push(place(new THREE.BoxGeometry(0.10, 0.29, 0.10), 0, -0.145, -2.80));
        // Vertical keel: bottom bar (5cm below glass bottom surface)
        // Glass bottom: y=-0.49 at back → y=-0.294 at front
        const kbGeo = new THREE.BoxGeometry(0.15, 0.06, noseLen);
        kbGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(
            Math.atan2(0.196, noseLen)));
        odGeos.push(place(kbGeo, 0, -0.442, noseCZ));

        // Tail boom
        odGeos.push(place(new THREE.BoxGeometry(0.35, 0.35, 3.5), 0, 0.1, 3.2));
        // Vertical tail fin
        odGeos.push(place(new THREE.BoxGeometry(0.1, 1.0, 0.7), 0, 0.7, 4.9));
        // Horizontal stabilizer
        odGeos.push(place(new THREE.BoxGeometry(1.4, 0.08, 0.5), 0, 0.15, 4.9));
        // Rotor mast
        odGeos.push(place(new THREE.CylinderGeometry(0.06, 0.06, 0.35, 6), 0, 0.8, 0));

        // Landing skids + struts
        for (const side of [-1, 1]) {
            dkGeos.push(place(new THREE.BoxGeometry(0.08, 0.08, 3.0), side * 0.95, -1.0, -0.2));
            for (const zOff of [-0.8, 0.6]) {
                dkGeos.push(place(new THREE.BoxGeometry(0.06, 0.45, 0.06), side * 0.95, -0.75, zOff));
            }
        }

        // ── Merged static hull (OD + DK) ──
        const odMerged = mergeGeometries(odGeos);
        const odMesh = new THREE.Mesh(odMerged, mat(OD));
        odMesh.castShadow = true;
        this._attitudeGroup.add(odMesh);

        const dkMerged = mergeGeometries(dkGeos);
        const dkMesh = new THREE.Mesh(dkMerged, mat(DK));
        this._attitudeGroup.add(dkMesh);

        // ── Team stripe (separate — color changes on flag capture) ──
        const stripeGeo = new THREE.BoxGeometry(0.36, 0.36, 0.8);
        place(stripeGeo, 0, 0.1, 4.0);
        this._stripeMat = mat(teamColor);
        this._attitudeGroup.add(new THREE.Mesh(stripeGeo, this._stripeMat));

        // ── Nose glass: truncated pyramid, 5 faces (no back face at cabin) ──
        const halfLen = noseLen / 2;
        const bx = 0.9, bTop = 0.59, bBot = -0.49;       // back (cabin junction)
        const fx = bx * (1 - TAPER);                       // front X  (0.54)
        const fTop = bTop * (1 - TAPER);                    // front top (0.354)
        const fBot = bBot * (1 - TAPER);                    // front bot (-0.294)
        const glassGeo = new THREE.BufferGeometry();
        glassGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
            -bx, bBot,  halfLen,   // 0: back-left-bottom
             bx, bBot,  halfLen,   // 1: back-right-bottom
            -bx, bTop,  halfLen,   // 2: back-left-top
             bx, bTop,  halfLen,   // 3: back-right-top
            -fx, fBot, -halfLen,   // 4: front-left-bottom
             fx, fBot, -halfLen,   // 5: front-right-bottom
            -fx, fTop, -halfLen,   // 6: front-left-top
             fx, fTop, -halfLen,   // 7: front-right-top
        ]), 3));
        glassGeo.setIndex([
            2, 7, 6,  2, 3, 7,    // top
            0, 4, 5,  0, 5, 1,    // bottom
            0, 2, 6,  0, 6, 4,    // left
            3, 1, 5,  3, 5, 7,    // right
            6, 7, 5,  6, 5, 4,    // front
        ]);
        glassGeo.computeVertexNormals();
        place(glassGeo, 0, 0, noseCZ);
        this._attitudeGroup.add(new THREE.Mesh(glassGeo,
            mat(0x111111, { transparent: true, opacity: 0.5 })));

        // ── Main rotor (animated — stays separate) ──
        const rotorMat = mat(0x444444, { side: THREE.DoubleSide });
        const rotorGeo = new THREE.PlaneGeometry(7, 0.25);
        rotorGeo.rotateX(-Math.PI / 2); // XY plane → XZ plane (horizontal)
        this._rotorMesh = new THREE.Mesh(rotorGeo, rotorMat);
        this._rotorMesh.position.y = 0.95;
        this._attitudeGroup.add(this._rotorMesh);
        const rotor2Geo = new THREE.PlaneGeometry(0.25, 7);
        rotor2Geo.rotateX(-Math.PI / 2);
        const rotor2 = new THREE.Mesh(rotor2Geo, rotorMat);
        this._rotorMesh.add(rotor2);

        // ── Tail rotor (animated — stays separate) ──
        // Hull-local (0.22, 0.7, 4.9) → after PI rotation: (-0.22, 0.7, -4.9)
        const trGeo = new THREE.PlaneGeometry(0.15, 1.8);
        trGeo.rotateY(-Math.PI / 2); // XY plane → YZ plane (perpendicular to tail boom)
        this._tailRotorMesh = new THREE.Mesh(trGeo, rotorMat);
        this._tailRotorMesh.position.set(-0.22, 0.7, -4.9);
        this._attitudeGroup.add(this._tailRotorMesh);

        // Exclude rotors from raycasting (thin spinning blades shouldn't block bullets)
        this._rotorMesh.raycast = () => {};
        rotor2.raycast = () => {};
        this._tailRotorMesh.raycast = () => {};

        return group;
    }

    // ───── Multi-passenger overrides ─────

    /**
     * Total occupants (driver + passengers).
     */
    get occupantCount() {
        return (this.driver ? 1 : 0) + this.passengers.length;
    }

    canEnter(entity) {
        if (!this.alive || this._crashing) return false;
        if (entity.team !== this.team) return false;
        if (this.occupantCount >= 5) return false;
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
        entity.vehicle = this;
        // Disable occupant's collision so their body doesn't push the helicopter
        if (entity.body) {
            entity.body.collisionResponse = false;
        }
    }

    exit(entity) {
        entity.vehicle = null;
        // Re-enable occupant's collision before removing them
        if (entity.body) {
            entity.body.collisionResponse = true;
        }
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

    /**
     * Get all occupants (driver + passengers).
     */
    getAllOccupants() {
        const list = [];
        if (this.driver) list.push(this.driver);
        list.push(...this.passengers);
        return list;
    }

    // ───── Crash & Destroy ─────

    destroy() {
        this.alive = false;
        this.hp = 0;
        this._crashing = true;
        this._wreckageTimer = 0;

        // Explosion VFX at current position
        if (this.impactVFX && this.mesh) {
            this.impactVFX.spawn('explosion', this.mesh.position, null);
        }

        // Adjust damping for crash — velocity already in body from flight
        if (this.body) {
            this.body.linearDamping = 0.1;
            this.body.angularDamping = 0.3;
            // Add random tumble on top of existing angular velocity
            this.body.angularVelocity.set(
                (Math.random() - 0.5) * 3,
                this.body.angularVelocity.y + (Math.random() - 0.5) * 2,
                (Math.random() - 0.5) * 3
            );
        }

        // Kill all occupants
        this._killAllOccupants();
    }

    _killAllOccupants() {
        const occupants = this.getAllOccupants();
        for (const occ of occupants) {
            // Re-enable collision before ejecting
            if (occ.body) occ.body.collisionResponse = true;
            // Clear vehicle reference on entity
            if (occ.vehicle !== undefined) occ.vehicle = null;
            // Clear vehicle reference on AI controller
            if (occ.controller) {
                occ.controller.vehicle = null;
                occ.controller._vehicleMoveTarget = null;
                occ.controller._vehicleOrbitAngle = 0;
            }
            // Kill them (deal lethal damage — vehicle ref already cleared above)
            if (occ.takeDamage) {
                occ.takeDamage(9999);
            }
        }
        this.driver = null;
        this.passengers = [];
    }

    _updateCrash(dt) {
        // Sync mesh FROM physics body (CANNON handles gravity, collision, friction)
        if (this.body) {
            const p = this.body.position;
            const q = this.body.quaternion;
            this.mesh.position.set(p.x, p.y, p.z);
            this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
        }
        // Reset attitude group — full rotation is on mesh from CANNON
        this._attitudeGroup.rotation.set(0, 0, 0);

        // Slow rotor
        this._rotorAngle += 3 * dt;
        if (this._rotorMesh) this._rotorMesh.rotation.y = this._rotorAngle;
        if (this._tailRotorMesh) this._tailRotorMesh.rotation.x = this._rotorAngle;

        // Wreckage timer
        this._wreckageTimer += dt;
        if (this._wreckageTimer >= 10) {
            this.mesh.visible = false;
            this._crashing = false;
            this.respawnTimer = this.respawnDelay;
            // Move body out of the way
            if (this.body) {
                this.body.velocity.set(0, 0, 0);
                this.body.angularVelocity.set(0, 0, 0);
                this.body.force.set(0, 0, 0);
                this.body.torque.set(0, 0, 0);
                this.body.position.set(0, -999, 0);
            }
        }
    }

    // ───── Update ─────

    update(dt) {
        // Increment frame counter for matrix cache
        this._frameCounter = (this._frameCounter || 0) + 1;

        // Crash animation takes priority
        if (this._crashing) {
            this._updateCrash(dt);
            return;
        }

        // Base handles respawn countdown when !alive
        if (!this.alive) {
            this.respawnTimer -= dt;
            if (this.respawnTimer <= 0) {
                this.respawn();
            }
            return;
        }

        // ── Read position from physics body (includes collision resolution) ──
        if (this.body) {
            const bp = this.body.position;
            this.mesh.position.set(bp.x, bp.y, bp.z);
            // Clear accumulated forces — prevents stacking when frame rate > physics rate
            this.body.force.set(0, 0, 0);
            this.body.torque.set(0, 0, 0);
        }

        // Unoccupied: apply downward force + higher damping + decay yaw
        if (!this.driver && this.passengers.length === 0) {
            if (this.body) {
                this.body.linearDamping = 0.8;
                this.body.force.y -= this.body.mass * 3;
            }
            this._yawRate *= Math.max(0, 1 - 5 * dt);
        } else {
            if (this.body) {
                this.body.linearDamping = 0.5;
            }
        }

        // Sync local velocity variables from body (for visual attitude, AI, etc.)
        if (this.body) {
            this.velX = this.body.velocity.x;
            this.velZ = this.body.velocity.z;
            this.velocityY = this.body.velocity.y;
        }

        // Derive scalar speed (forward component along heading)
        const fwdX = Math.sin(this.rotationY);
        const fwdZ = Math.cos(this.rotationY);
        this.speed = this.velX * fwdX + this.velZ * fwdZ; // signed forward speed

        // Altitude constraints — respect actual terrain height (safety net)
        let floorY = this.minAltitude;
        if (this.getHeightAt) {
            this._groundY = this.getHeightAt(this.mesh.position.x, this.mesh.position.z);
            floorY = Math.max(floorY, this._groundY + 1.1);
        }
        if (this.mesh.position.y <= floorY) {
            this.mesh.position.y = floorY;
            if (this.body && this.body.velocity.y < 0) this.body.velocity.y = 0;
        }
        if (this.mesh.position.y >= this.maxAltitude) {
            this.mesh.position.y = this.maxAltitude;
            if (this.body && this.body.velocity.y > 0) this.body.velocity.y = 0;
        }

        // Map boundary clamp
        const px = this.mesh.position.x;
        const pz = this.mesh.position.z;
        if (px < -MAP_HALF_W) { this.mesh.position.x = -MAP_HALF_W; if (this.body && this.body.velocity.x < 0) this.body.velocity.x = 0; }
        if (px >  MAP_HALF_W) { this.mesh.position.x =  MAP_HALF_W; if (this.body && this.body.velocity.x > 0) this.body.velocity.x = 0; }
        if (pz < -MAP_HALF_D) { this.mesh.position.z = -MAP_HALF_D; if (this.body && this.body.velocity.z < 0) this.body.velocity.z = 0; }
        if (pz >  MAP_HALF_D) { this.mesh.position.z =  MAP_HALF_D; if (this.body && this.body.velocity.z > 0) this.body.velocity.z = 0; }

        // Store altitude
        this.altitude = this.mesh.position.y;

        // ── Sync body back; constrain to Y-only rotation ──
        if (this.body) {
            this.body.position.set(this.mesh.position.x, this.mesh.position.y, this.mesh.position.z);
            // Lock X/Z angular velocity — helicopter stays upright
            this.body.angularVelocity.x = 0;
            this.body.angularVelocity.z = 0;
            this.body.angularVelocity.y = this._yawRate;
            // Sync quaternion to full visual attitude (yaw + pitch + roll)
            _euler.set(this._visualPitch, this.rotationY, this._visualRoll, 'YXZ');
            _threeQuat.setFromEuler(_euler);
            this.body.quaternion.set(_threeQuat.x, _threeQuat.y, _threeQuat.z, _threeQuat.w);
        }
        this.mesh.rotation.y = this.rotationY;

        // ── Visual attitude ──
        // Pitch: based on forward speed component (dot product with heading)
        const pitchMax = 0.90;  // ~52°
        const speedPitch = (this.speed / this.maxHSpeed) * pitchMax * 0.7;
        const inputPitch = (this._inputThrust - this._inputBrake) * pitchMax * 0.3;
        const targetPitch = speedPitch + inputPitch
            - (this.velocityY / this.maxVSpeed) * 0.08; // slight nose-up on ascend

        // Roll: bank from yaw rate + lateral drift
        // Lateral speed = cross product of heading × velocity
        const lateralSpeed = -this.velX * fwdZ + this.velZ * fwdX;
        const rollMax = Math.PI / 3;  // 60°
        const hSpeedMag = Math.sqrt(this.velX * this.velX + this.velZ * this.velZ);
        const speedFactor = Math.min(1, hSpeedMag / (this.maxHSpeed * 0.25));
        const yawNorm = Math.min(Math.max(this._yawRate / this.turnSpeed, -1), 1);
        const driftRoll = (lateralSpeed / this.maxHSpeed) * rollMax * 0.5;
        const targetRoll = -yawNorm * speedFactor * rollMax + driftRoll;

        // Smooth interpolation (faster to tilt, slower to recover → natural sway)
        const tiltLerp = 1 - Math.exp(-6 * dt);
        const recoverLerp = 1 - Math.exp(-3 * dt);
        const pitchLerp = Math.abs(targetPitch) > Math.abs(this._visualPitch) ? tiltLerp : recoverLerp;
        const rollLerp = Math.abs(targetRoll) > Math.abs(this._visualRoll) ? tiltLerp : recoverLerp;
        this._visualPitch += (targetPitch - this._visualPitch) * pitchLerp;
        this._visualRoll += (targetRoll - this._visualRoll) * rollLerp;

        this._attitudeGroup.rotation.x = this._visualPitch;
        this._attitudeGroup.rotation.z = this._visualRoll;

        // Rotor animation
        const rotorSpeed = this.driver ? 25 : 8; // faster when piloted
        this._rotorAngle = (this._rotorAngle + rotorSpeed * dt) % (Math.PI * 2);
        if (this._rotorMesh) {
            this._rotorMesh.rotation.y = this._rotorAngle;
        }
        if (this._tailRotorMesh) {
            this._tailRotorMesh.rotation.x = this._rotorAngle * 1.5;
        }

        // Cache world quaternion for passengers/pilot (avoids repeated matrix traversal)
        this._attitudeGroup.updateWorldMatrix(true, false);
        this._cachedWorldQuat.setFromRotationMatrix(this._attitudeGroup.matrixWorld);
    }

    applyInput(input, dt) {
        if (!this.alive || !this.body) return;

        const mass = this.body.mass;
        const fwdX = Math.sin(this.rotationY);
        const fwdZ = Math.cos(this.rotationY);

        // Cache input for visual pitch anticipation
        this._inputThrust = input.thrust || 0;
        this._inputBrake = input.brake || 0;

        // Thrust along current heading
        if (input.thrust > 0) {
            this.body.force.x += fwdX * mass * this.hAccel * input.thrust;
            this.body.force.z += fwdZ * mass * this.hAccel * input.thrust;
        }
        // Brake opposite to heading
        if (input.brake > 0) {
            this.body.force.x -= fwdX * mass * this.hAccel * input.brake;
            this.body.force.z -= fwdZ * mass * this.hAccel * input.brake;
        }

        // Horizontal speed soft cap (extra drag when exceeding max)
        const hSpd = Math.sqrt(this.body.velocity.x ** 2 + this.body.velocity.z ** 2);
        if (hSpd > this.maxHSpeed) {
            const excess = (hSpd - this.maxHSpeed) / hSpd;
            this.body.force.x -= this.body.velocity.x * excess * mass * 10;
            this.body.force.z -= this.body.velocity.z * excess * mass * 10;
        }

        // Steering — smooth yaw rate (direct control, not torque)
        let targetYaw = 0;
        if (input.steerLeft) targetYaw = this.turnSpeed;
        if (input.steerRight) targetYaw = -this.turnSpeed;
        const yawLerp = 1 - Math.exp(-5 * dt);
        this._yawRate += (targetYaw - this._yawRate) * yawLerp;
        // rotationY integrated by CANNON via body.angularVelocity.y (set in update)
        this.rotationY += this._yawRate * dt;

        // Vertical thrust
        if (input.ascend) {
            this.body.force.y += mass * this.vAccel;
        } else if (input.descend) {
            this.body.force.y -= mass * this.vAccel;
        }
        // Anti-gravity is in preStep callback (per sub-step), not here
    }

    /**
     * Check if helicopter is close enough to ground for safe exit.
     * @param {Function} getHeightAtFn
     * @returns {boolean}
     */
    canExitSafely(getHeightAtFn) {
        if (!this.mesh) return false;
        const groundY = getHeightAtFn(this.mesh.position.x, this.mesh.position.z);
        const altAboveGround = this.mesh.position.y - groundY;
        return altAboveGround < 5;
    }

    respawn() {
        // Switch team based on spawn flag ownership
        if (this.spawnFlag && this.spawnFlag.owner !== 'neutral' && this.spawnFlag.owner !== this.team) {
            this.team = this.spawnFlag.owner;
            // Update team stripe color
            if (this._stripeMat) {
                const teamColor = this.team === 'teamA' ? 0x3366cc : 0xcc3333;
                this._stripeMat.color.setHex(teamColor);
            }
        }

        this.alive = true;
        this.hp = this.maxHP;
        this.speed = 0;
        this.velX = 0;
        this.velZ = 0;
        this.velocityY = 0;
        this.altitude = this.spawnPosition.y;
        this.rotationY = this.spawnRotationY;
        this._crashing = false;
        this._wreckageTimer = 0;
        this._visualPitch = 0;
        this._visualRoll = 0;
        this._yawRate = 0;
        this.passengers = [];

        if (this.mesh) {
            this.mesh.visible = true;
            this.mesh.position.copy(this.spawnPosition);
            this.mesh.position.y = this.spawnPosition.y + 1.1;
            this.mesh.rotation.set(0, this.rotationY, 0);
            this._attitudeGroup.rotation.set(0, 0, 0);
        }

        // Reset body to flight-ready state
        if (this.body) {
            this.body.linearDamping = 0.5;
            this.body.angularDamping = 0.0;
            this.body.velocity.set(0, 0, 0);
            this.body.angularVelocity.set(0, 0, 0);
            this.body.force.set(0, 0, 0);
            this.body.torque.set(0, 0, 0);
            this.body.position.set(this.mesh.position.x, this.mesh.position.y, this.mesh.position.z);
            this.body.quaternion.setFromAxisAngle(_cannonYAxis, this.rotationY);
        }
    }
}
