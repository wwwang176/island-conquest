import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WeaponDefs, GunAnim } from './WeaponDefs.js';

const WATER_Y = -0.3;
const _splashPos = new THREE.Vector3();
const _upDir = new THREE.Vector3(0, 1, 0);
const _sdmgPos = new THREE.Vector3();
const _sdmgDir = new THREE.Vector3();

/** Create a trapezoid stock from a BoxGeometry: flat top, bottom slopes down toward back. */
function trapezoidGeo(w, frontH, backH, depth, cx, topY, zFront) {
    const geo = new THREE.BoxGeometry(w, backH, depth);
    const pos = geo.attributes.position;
    const halfD = depth / 2, halfH = backH / 2;
    for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) < 0) {
            const t = (pos.getZ(i) + halfD) / depth;
            pos.setY(i, halfH - (frontH + (backH - frontH) * t));
        }
    }
    pos.needsUpdate = true;
    geo.translate(cx, topY - halfH, zFront + halfD);
    geo.computeVertexNormals();
    return geo;
}

/**
 * Base soldier entity with health, damage, death, and regen.
 * Used by both Player and AI COM.
 */
export class Soldier {
    constructor(scene, physicsWorld, team, id, kinematic = false) {
        this.scene = scene;
        this.physics = physicsWorld;
        this.team = team;       // 'teamA' or 'teamB'
        this.id = id;
        this.kinematic = kinematic;

        // Health
        this.maxHP = 100;
        this.hp = this.maxHP;
        this.regenDelay = 5;        // seconds before regen starts
        this.regenRate = 10;        // HP per second
        this.timeSinceLastDamage = Infinity;

        // Targeting awareness — how many enemy controllers are aiming at me
        this.targetedByCount = 0;

        // State
        this.alive = true;
        this.deathTimer = 0;
        this.respawnDelay = 5;      // seconds

        // Visual
        this.cameraHeight = 1.6;
        this.teamColor = team === 'teamA' ? 0x4488ff : 0xff4444;
        this.mesh = this._createMesh();
        this.mesh.userData.soldier = this;
        scene.add(this.mesh);

        // Physics body
        this.body = this._createPhysicsBody();
        this._inWorld = true;
        physicsWorld.addBody(this.body);

        // Kinematic AI soldiers don't need physics simulation — remove immediately
        if (this.kinematic) {
            this.removeFromPhysics();
        }

        // Damage direction tracking (for HUD indicator)
        this.lastDamageDirection = null;
        this.damageIndicatorTimer = 0;

        // Last time this soldier took damage (for safe-respawn checks)
        this.lastDamagedTime = 0;

        // Ragdoll death effect
        this.ragdollActive = false;
        this._waterSplashed = false;

        // VFX reference (set by AIManager/Game)
        this.impactVFX = null;

        // Dropped gun manager (set by Game)
        this.droppedGunManager = null;

        // Last movement velocity (for death momentum inheritance)
        this.lastMoveVelocity = new THREE.Vector3();

        // Cached position vector (avoids new Vector3 per getPosition call)
        this._posCache = new THREE.Vector3();

        // Muzzle flash timer (COM)
        this._muzzleFlashTimer = 0;
    }

    _createMesh() {
        const group = new THREE.Group();

        const tc = new THREE.Color(this.teamColor);
        const limbColor = tc.clone().multiplyScalar(0.7);
        const hipColor = tc.clone().multiplyScalar(0.5);

        // ── Lower body ──
        const lowerBody = new THREE.Group();

        // Hips
        const hips = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.15, 0.3),
            new THREE.MeshLambertMaterial({ color: hipColor })
        );
        hips.position.y = 0.75;
        hips.castShadow = false;
        lowerBody.add(hips);

        // Left leg
        const leftLeg = new THREE.Group();
        leftLeg.position.set(-0.13, 0.7, 0);
        const leftLegMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.18, 0.70, 0.18),
            new THREE.MeshLambertMaterial({ color: limbColor })
        );
        leftLegMesh.position.y = -0.35;
        leftLegMesh.castShadow = false;
        leftLeg.add(leftLegMesh);
        lowerBody.add(leftLeg);

        // Right leg
        const rightLeg = new THREE.Group();
        rightLeg.position.set(0.13, 0.7, 0);
        const rightLegMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.18, 0.70, 0.18),
            new THREE.MeshLambertMaterial({ color: limbColor })
        );
        rightLegMesh.position.y = -0.35;
        rightLegMesh.castShadow = false;
        rightLeg.add(rightLegMesh);
        lowerBody.add(rightLeg);

        group.add(lowerBody);

        // ── Upper body (torso + head merged, arms separate for pitch) ──
        const upperBody = new THREE.Group();

        // Build individual geometries, bake transforms, assign vertex colors
        const skinColor = new THREE.Color(0xddbb99);

        // Torso
        const torsoGeo = new THREE.BoxGeometry(0.5, 0.6, 0.3);
        torsoGeo.translate(0, 1.125, 0);
        this._setGeometryVertexColor(torsoGeo, tc);

        // Head
        const headGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
        headGeo.translate(0, 1.575, 0);
        this._setGeometryVertexColor(headGeo, skinColor);

        // Merge torso + head
        const torsoHeadGeo = mergeGeometries([torsoGeo, headGeo]);
        torsoGeo.dispose(); headGeo.dispose();

        const torsoHeadMesh = new THREE.Mesh(
            torsoHeadGeo,
            new THREE.MeshLambertMaterial({ vertexColors: true })
        );
        torsoHeadMesh.castShadow = true;
        upperBody.add(torsoHeadMesh);

        // ── Shoulder pivot (arms + gun pitch here) ──
        const shoulderPivot = new THREE.Group();
        shoulderPivot.position.y = 1.35; // shoulder height
        upperBody.add(shoulderPivot);

        // Right arm — positions relative to shoulder pivot
        const limbMat = new THREE.MeshLambertMaterial({ color: limbColor });
        const rightArmGeo = new THREE.BoxGeometry(0.15, 0.4, 0.15);
        rightArmGeo.translate(0, -0.2, 0); // pivot at shoulder
        const rightArm = new THREE.Mesh(rightArmGeo, limbMat);
        rightArm.position.set(0.2, 0, 0);
        rightArm.rotation.set(1.1, 0, 0);
        rightArm.castShadow = true;
        shoulderPivot.add(rightArm);

        // Left arm (rotation.x adjustable per weapon via WeaponDefs.tpLeftArmRotX)
        const leftArmGeo = new THREE.BoxGeometry(0.15, 0.55, 0.15);
        leftArmGeo.translate(0, -0.275, 0); // pivot at shoulder
        this._leftArmMesh = new THREE.Mesh(leftArmGeo, limbMat);
        this._leftArmMesh.position.set(-0.2, 0, 0);
        this._leftArmMesh.rotation.set(1.2, 0, 0.5);
        this._leftArmMesh.castShadow = true;
        shoulderPivot.add(this._leftArmMesh);

        // Gun — placeholder, replaced by setWeaponModel()
        this.gunMesh = null;
        this._gunParent = shoulderPivot;
        this._gunReloadTilt = 0;
        this._gunRecoilZ = 0;
        this._createGunMesh('AR15');

        group.add(upperBody);

        // Store references for animation
        this.upperBody = upperBody;
        this.shoulderPivot = shoulderPivot;
        this.lowerBody = lowerBody;
        this.leftLeg = leftLeg;
        this.rightLeg = rightLeg;
        this._walkPhase = 0;

        return group;
    }

    _setGeometryVertexColor(geo, color) {
        const count = geo.attributes.position.count;
        const colors = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    /** Create a four-pointed-star muzzle flash mesh (shared geometry+material). */
    static createMuzzleFlashMesh() {
        const outerR = 0.27, innerR = 0.0675;
        const pts = [];
        for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
            const r = i % 2 === 0 ? outerR : innerR;
            pts.push(Math.cos(a) * r, Math.sin(a) * r, 0);
        }
        const verts = [];
        for (let i = 0; i < 8; i++) {
            const j = (i + 1) % 8;
            verts.push(0, 0, 0, pts[i * 3], pts[i * 3 + 1], 0, pts[j * 3], pts[j * 3 + 1], 0);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffcc44, transparent: true, opacity: 0.9,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        });
        return new THREE.Mesh(geo, mat);
    }

    /**
     * Build a shared gun mesh for the given weapon ID (centered at origin).
     * Used by third-person view, first-person view, and dropped guns.
     */
    static buildGunMesh(weaponId) {
        const geos = [];

        if (weaponId === 'LMG') {
            const bodyGeo = new THREE.BoxGeometry(0.10, 0.10, 0.50);
            geos.push(bodyGeo);
            const barrelGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.35, 6);
            barrelGeo.rotateX(Math.PI / 2);
            barrelGeo.translate(0, 0.01, -0.42);
            geos.push(barrelGeo);
            const drumGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.08, 8);
            drumGeo.translate(0, -0.10, 0.05);
            geos.push(drumGeo);
            // Trapezoid stock
            geos.push(trapezoidGeo(0.06, 0.06, 0.12, 0.25, 0, 0.03, 0.22));
        } else if (weaponId === 'SMG') {
            const bodyGeo = new THREE.BoxGeometry(0.08, 0.08, 0.30);
            bodyGeo.translate(0, 0, 0.10);
            geos.push(bodyGeo);
            const barrelGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.15, 6);
            barrelGeo.rotateX(Math.PI / 2);
            barrelGeo.translate(0, 0.01, -0.15);
            geos.push(barrelGeo);
            // Long magazine
            const magGeo = new THREE.BoxGeometry(0.04, 0.18, 0.04);
            magGeo.translate(0, -0.13, 0.10);
            geos.push(magGeo);
            // Compact trapezoid stock
            geos.push(trapezoidGeo(0.05, 0.05, 0.10, 0.20, 0, 0.02, 0.22));
        } else if (weaponId === 'BOLT') {
            const bodyGeo = new THREE.BoxGeometry(0.07, 0.07, 0.50);
            geos.push(bodyGeo);
            const barrelGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.55, 6);
            barrelGeo.rotateX(Math.PI / 2);
            barrelGeo.translate(0, 0.01, -0.52);
            geos.push(barrelGeo);
            const scopeGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.30, 8);
            scopeGeo.rotateX(Math.PI / 2);
            scopeGeo.translate(0, 0.07, -0.05);
            geos.push(scopeGeo);
            // Trapezoid stock
            geos.push(trapezoidGeo(0.06, 0.06, 0.14, 0.30, 0, 0.025, 0.22));
        } else {
            const bodyGeo = new THREE.BoxGeometry(0.08, 0.08, 0.50);
            geos.push(bodyGeo);
            const barrelGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.35, 6);
            barrelGeo.rotateX(Math.PI / 2);
            barrelGeo.translate(0, 0.01, -0.42);
            geos.push(barrelGeo);
            // Magazine
            const magGeo = new THREE.BoxGeometry(0.04, 0.12, 0.05);
            magGeo.translate(0, -0.10, 0);
            geos.push(magGeo);
            // Trapezoid stock
            geos.push(trapezoidGeo(0.06, 0.06, 0.12, 0.25, 0, 0.03, 0.22));
        }

        const merged = mergeGeometries(geos);
        for (const g of geos) g.dispose();
        return new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: 0x333333 }));
    }

    _createGunMesh(weaponId) {
        if (this.gunMesh) {
            this._gunParent.remove(this.gunMesh);
            if (this.gunMesh.geometry) this.gunMesh.geometry.dispose();
            if (this.gunMesh.material) this.gunMesh.material.dispose();
        }

        const gun = Soldier.buildGunMesh(weaponId);
        gun.position.set(0.05, -0.05, -0.45);
        gun.castShadow = false;

        this._gunParent.add(gun);
        this.gunMesh = gun;

        // Muzzle flash (attached to gun mesh)
        const flash = Soldier.createMuzzleFlashMesh();
        flash.visible = false;
        const flashDef = WeaponDefs[weaponId];
        flash.position.set(0, 0.01, flashDef.tpMuzzleZ);
        gun.add(flash);
        this._muzzleFlash = flash;

        // Adjust left arm grip per weapon
        if (this._leftArmMesh) {
            const def = WeaponDefs[weaponId];
            if (def && def.tpLeftArmRotX !== undefined) {
                this._leftArmMesh.rotation.x = def.tpLeftArmRotX;
            }
        }
    }

    setWeaponModel(weaponId) {
        this._createGunMesh(weaponId);
    }

    showMuzzleFlash() {
        if (!this._muzzleFlash) return;
        this._muzzleFlash.visible = true;
        this._muzzleFlash.scale.setScalar(0.85 + Math.random() * 0.3);
        this._muzzleFlash.rotation.z = (Math.random() - 0.5) * (10 * Math.PI / 180);
        this._muzzleFlashTimer = 0.04;
    }

    /**
     * Animate walk cycle — swing arms and legs with sin wave.
     * @param {number} dt — delta time
     * @param {number} speed — current movement speed (0 = idle)
     */
    animateWalk(dt, speed) {
        const swingFreq = 10.4;    // radians per second (8 * 1.3)
        const legSwingMax = 0.6;   // max leg rotation (radians)

        if (speed > 0.3) {
            this._walkPhase += dt * swingFreq;
            const swing = Math.sin(this._walkPhase);

            this.leftLeg.rotation.x = swing * legSwingMax;
            this.rightLeg.rotation.x = -swing * legSwingMax;
        } else {
            // Lerp back to idle
            const decay = 1 - Math.exp(-10 * dt);
            this.leftLeg.rotation.x *= (1 - decay);
            this.rightLeg.rotation.x *= (1 - decay);
            this._walkPhase = 0;
        }
        // Arms stay in fixed gun-holding pose (rotation set in _createMesh)
    }

    _createPhysicsBody() {
        const body = new CANNON.Body({
            mass: this.kinematic ? 0 : 80,
            type: this.kinematic ? CANNON.Body.KINEMATIC : CANNON.Body.DYNAMIC,
            material: this.physics.defaultMaterial,
            linearDamping: 0.9,
            angularDamping: 1.0,
            fixedRotation: true,
            collisionResponse: !this.kinematic,
        });
        const r = 0.35;
        body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, r, 0));
        body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, this.cameraHeight - r, 0));
        body.addShape(
            new CANNON.Cylinder(r, r, this.cameraHeight - 2 * r, 8),
            new CANNON.Vec3(0, this.cameraHeight / 2, 0)
        );
        return body;
    }

    removeFromPhysics() {
        if (this._inWorld) {
            this.physics.removeBody(this.body);
            this._inWorld = false;
        }
    }

    addToPhysics() {
        if (!this._inWorld) {
            this.physics.addBody(this.body);
            this._inWorld = true;
        }
    }

    /**
     * Apply damage to this soldier.
     * @param {number} amount - Damage amount
     * @param {THREE.Vector3} fromPosition - World position of the attacker
     * @param {number|null} hitY - Hit point Y coordinate (null for explosions etc.)
     * @returns {object} { killed: boolean, damage: number, headshot: boolean }
     */
    takeDamage(amount, fromPosition, hitY = null) {
        if (!this.alive) return { killed: false, damage: 0, headshot: false };

        const baseY = this.body.position.y;
        const headshot = hitY !== null && hitY >= baseY + 1.45;
        const legshot = hitY !== null && !headshot && hitY < baseY + 0.7;
        const actualDamage = headshot ? amount * 2 : legshot ? amount * 0.5 : amount;
        this.hp = Math.max(0, this.hp - actualDamage);
        this.timeSinceLastDamage = 0;
        this.lastDamagedTime = performance.now();

        // Track damage direction for HUD
        if (fromPosition) {
            _sdmgPos.set(this.body.position.x, 0, this.body.position.z);
            if (!this.lastDamageDirection) this.lastDamageDirection = new THREE.Vector3();
            this.lastDamageDirection.copy(_sdmgDir.set(fromPosition.x, 0, fromPosition.z).sub(_sdmgPos)).normalize();
            this.damageIndicatorTimer = 1.0; // show for 1 second
        }

        if (this.hp <= 0) {
            this.die(fromPosition);
            return { killed: true, damage: actualDamage, headshot };
        }

        // Notify AI controller for immediate reaction
        if (this.controller && this.controller.onDamaged) {
            this.controller.onDamaged();
        }

        return { killed: false, damage: actualDamage, headshot };
    }

    die(fromPosition) {
        this.alive = false;
        this.hp = 0;
        this.deathTimer = this.respawnDelay;
        this.ragdollActive = true;

        // Ragdoll needs physics — re-add if removed (kinematic AI)
        this.addToPhysics();

        // Replace shapes with a single cylinder centered on body.position
        // Move body.position up to body center so rotation axis = geometric center
        while (this.body.shapes.length > 0) {
            this.body.removeShape(this.body.shapes[0]);
        }
        this.body.position.y += 0.8; // move pivot from feet to body center
        this.body.addShape(
            new CANNON.Cylinder(0.3, 0.3, 1.6, 8)
            // NO offset — cylinder centered on body.position
        );

        this.body.type = CANNON.Body.DYNAMIC;
        this.body.mass = 60;
        this.body.fixedRotation = false;
        this.body.updateMassProperties();
        this.body.angularDamping = 0.4;
        this.body.linearDamping = 0.4;
        this.body.collisionResponse = true;

        // Apply bullet-direction impulse for toppling effect
        if (fromPosition) {
            const myPos = this.body.position;
            const dir = new CANNON.Vec3(
                myPos.x - fromPosition.x,
                0,
                myPos.z - fromPosition.z
            );
            const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
            if (len > 0.01) {
                dir.x /= len;
                dir.z /= len;
            }
            // Impulse at top of cylinder (0.6 above center) for maximum torque
            const force = 60;
            this.body.applyImpulse(
                new CANNON.Vec3(dir.x * force, 10, dir.z * force),
                new CANNON.Vec3(0, 0.6, 0)
            );
        }

        // Inherit walking momentum
        this.body.velocity.x += this.lastMoveVelocity.x;
        this.body.velocity.z += this.lastMoveVelocity.z;

        // Drop gun
        if (this.droppedGunManager && this.gunMesh) {
            // Get gun world transform before hiding
            this.gunMesh.updateWorldMatrix(true, false);
            const worldPos = new THREE.Vector3();
            const worldQuat = new THREE.Quaternion();
            this.gunMesh.getWorldPosition(worldPos);
            this.gunMesh.getWorldQuaternion(worldQuat);

            const vel = new THREE.Vector3(
                this.lastMoveVelocity.x,
                0,
                this.lastMoveVelocity.z
            );

            let impulseDir = null;
            if (fromPosition) {
                impulseDir = new THREE.Vector3(
                    this.body.position.x - fromPosition.x,
                    0,
                    this.body.position.z - fromPosition.z
                ).normalize();
            }

            this.droppedGunManager.spawn(this.gunMesh, worldPos, worldQuat, vel, impulseDir);
            this.gunMesh.visible = false;
        }
    }

    /**
     * Respawn at a given position.
     * @param {THREE.Vector3} position
     */
    respawn(position) {
        this.alive = true;
        this.hp = this.maxHP;
        this.timeSinceLastDamage = Infinity;
        this.targetedByCount = 0;
        this.mesh.visible = true;
        if (this.gunMesh) this.gunMesh.visible = true;
        this.mesh.rotation.set(0, 0, 0);

        // Reset body part rotations
        if (this.upperBody) this.upperBody.rotation.set(0, 0, 0);
        if (this.shoulderPivot) this.shoulderPivot.rotation.set(0, 0, 0);
        if (this.lowerBody) this.lowerBody.rotation.set(0, 0, 0);
        if (this.leftLeg) this.leftLeg.rotation.set(0, 0, 0);
        if (this.rightLeg) this.rightLeg.rotation.set(0, 0, 0);
        this._walkPhase = 0;

        // Restore capsule collision shapes
        while (this.body.shapes.length > 0) {
            this.body.removeShape(this.body.shapes[0]);
        }
        const r = 0.35;
        this.body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, r, 0));
        this.body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, this.cameraHeight - r, 0));
        this.body.addShape(
            new CANNON.Cylinder(r, r, this.cameraHeight - 2 * r, 8),
            new CANNON.Vec3(0, this.cameraHeight / 2, 0)
        );

        // Restore kinematic state
        if (this.kinematic) {
            this.body.type = CANNON.Body.KINEMATIC;
            this.body.mass = 0;
            this.body.collisionResponse = false;
        } else {
            this.body.type = CANNON.Body.DYNAMIC;
            this.body.mass = 80;
            this.body.collisionResponse = true;
        }
        this.body.fixedRotation = true;
        this.body.angularDamping = 1.0;
        this.body.linearDamping = 0.9;
        this.body.updateMassProperties();
        this.body.quaternion.set(0, 0, 0, 1);
        this.body.angularVelocity.set(0, 0, 0);
        this.body.position.set(position.x, position.y + 1, position.z); // back to feet level
        this.body.velocity.set(0, 0, 0);
        this.mesh.position.set(position.x, position.y + 1, position.z); // sync mesh immediately to avoid 1-frame flash at old position
        this.ragdollActive = false;
        this._waterSplashed = false;

        // Kinematic AI soldiers don't need physics after respawn
        if (this.kinematic) {
            this.removeFromPhysics();
        }
    }

    update(dt) {
        if (!this.alive) {
            this.deathTimer -= dt;
            // Ragdoll: sync mesh to physics body while dead
            // body.position is at body center (y+0.8), mesh origin is at feet
            // so offset mesh down by 0.8 in body's local frame
            if (this.ragdollActive) {
                this.mesh.quaternion.set(
                    this.body.quaternion.x,
                    this.body.quaternion.y,
                    this.body.quaternion.z,
                    this.body.quaternion.w
                );
                // Offset (0, -0.8, 0) rotated by body quaternion
                const ox = 0, oy = -0.8, oz = 0;
                const q = this.body.quaternion;
                const ix = q.w * ox + q.y * oz - q.z * oy;
                const iy = q.w * oy + q.z * ox - q.x * oz;
                const iz = q.w * oz + q.x * oy - q.y * ox;
                const iw = -q.x * ox - q.y * oy - q.z * oz;
                const rx = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
                const ry = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
                const rz = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
                this.mesh.position.set(
                    this.body.position.x + rx,
                    this.body.position.y + ry,
                    this.body.position.z + rz
                );
                // Water splash on ragdoll entering water
                if (!this._waterSplashed && this.body.position.y <= WATER_Y && this.impactVFX) {
                    this._waterSplashed = true;
                    _splashPos.set(this.body.position.x, WATER_Y, this.body.position.z);
                    this.impactVFX.spawn('water', _splashPos, _upDir);
                }

                // Stop ragdoll when timer runs out (about to respawn)
                if (this.deathTimer <= 0.5) {
                    this.ragdollActive = false;
                    this.mesh.visible = false;
                }
            }
            return;
        }

        // Health regen
        this.timeSinceLastDamage += dt;
        if (this.timeSinceLastDamage >= this.regenDelay && this.hp < this.maxHP) {
            this.hp = Math.min(this.maxHP, this.hp + this.regenRate * dt);
        }

        // Damage indicator fade
        if (this.damageIndicatorTimer > 0) {
            this.damageIndicatorTimer -= dt;
        }

        // Reload / bolt-cycling tilt animation (tracked here, applied to shoulderPivot in AIController)
        if (this.controller) {
            const bolting = this.controller.boltTimer > 0;
            const targetTilt = this.controller.isReloading ? GunAnim.reloadTilt : (bolting ? GunAnim.boltTilt : 0);
            const tiltSpeed = this.controller.isReloading ? 12 : 8;
            this._gunReloadTilt += (targetTilt - this._gunReloadTilt) * Math.min(1, tiltSpeed * dt);
        }

        // Muzzle flash timer
        if (this._muzzleFlashTimer > 0) {
            this._muzzleFlashTimer -= dt;
            if (this._muzzleFlashTimer <= 0 && this._muzzleFlash) {
                this._muzzleFlash.visible = false;
            }
        }

        // Gun recoil Z recovery + apply
        if (this._gunRecoilZ > 0) {
            this._gunRecoilZ = Math.max(0, this._gunRecoilZ - GunAnim.recoilRecovery * dt);
        }
        if (this.gunMesh) {
            this.gunMesh.position.z = -0.45 + this._gunRecoilZ;
        }

        // Sync mesh to physics body position
        this.mesh.position.set(
            this.body.position.x,
            this.body.position.y,
            this.body.position.z
        );
    }

    getPosition() {
        return this._posCache.set(this.body.position.x, this.body.position.y, this.body.position.z);
    }

    canRespawn() {
        return !this.alive && this.deathTimer <= 0;
    }
}
