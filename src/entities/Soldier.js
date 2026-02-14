import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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

        // Last movement velocity (for death momentum inheritance)
        this.lastMoveVelocity = new THREE.Vector3();

        // Cached position vector (avoids new Vector3 per getPosition call)
        this._posCache = new THREE.Vector3();
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
            new THREE.BoxGeometry(0.18, 0.55, 0.18),
            new THREE.MeshLambertMaterial({ color: limbColor })
        );
        leftLegMesh.position.y = -0.275;
        leftLegMesh.castShadow = false;
        leftLeg.add(leftLegMesh);
        lowerBody.add(leftLeg);

        // Right leg
        const rightLeg = new THREE.Group();
        rightLeg.position.set(0.13, 0.7, 0);
        const rightLegMesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.18, 0.55, 0.18),
            new THREE.MeshLambertMaterial({ color: limbColor })
        );
        rightLegMesh.position.y = -0.275;
        rightLegMesh.castShadow = false;
        rightLeg.add(rightLegMesh);
        lowerBody.add(rightLeg);

        group.add(lowerBody);

        // ── Upper body (torso + head + arms merged into one mesh) ──
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

        // Right arm — bake group transform (position + rotation) into geometry
        const rightArmGeo = new THREE.BoxGeometry(0.15, 0.4, 0.15);
        rightArmGeo.translate(0, -0.2, 0); // local offset within group
        const raMatrix = new THREE.Matrix4();
        raMatrix.compose(
            new THREE.Vector3(0.2, 1.35, 0),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(1.1, 0, 0)),
            new THREE.Vector3(1, 1, 1)
        );
        rightArmGeo.applyMatrix4(raMatrix);
        this._setGeometryVertexColor(rightArmGeo, limbColor);

        // Left arm — bake group transform
        const leftArmGeo = new THREE.BoxGeometry(0.15, 0.55, 0.15);
        leftArmGeo.translate(0, -0.275, 0);
        const laMatrix = new THREE.Matrix4();
        laMatrix.compose(
            new THREE.Vector3(-0.2, 1.35, 0),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(1.2, 0, 0.5)),
            new THREE.Vector3(1, 1, 1)
        );
        leftArmGeo.applyMatrix4(laMatrix);
        this._setGeometryVertexColor(leftArmGeo, limbColor);

        // Merge all 4 into one geometry
        const mergedUpperGeo = mergeGeometries([torsoGeo, headGeo, rightArmGeo, leftArmGeo]);
        torsoGeo.dispose(); headGeo.dispose(); rightArmGeo.dispose(); leftArmGeo.dispose();

        const upperMesh = new THREE.Mesh(
            mergedUpperGeo,
            new THREE.MeshLambertMaterial({ vertexColors: true })
        );
        upperMesh.castShadow = true;
        upperBody.add(upperMesh);

        // Gun — placeholder, replaced by setWeaponModel()
        this.gunMesh = null;
        this._gunParent = upperBody;
        this._gunReloadTilt = 0;
        this._createGunMesh('AR15');

        group.add(upperBody);

        // Store references for animation
        this.upperBody = upperBody;
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

    _createGunMesh(weaponId) {
        if (this.gunMesh) {
            this._gunParent.remove(this.gunMesh);
            if (this.gunMesh.geometry) this.gunMesh.geometry.dispose();
            if (this.gunMesh.material) this.gunMesh.material.dispose();
        }

        const geos = [];

        if (weaponId === 'LMG') {
            // LMG: thick squared body + heavy barrel + drum magazine
            const bodyGeo = new THREE.BoxGeometry(0.10, 0.10, 0.50);
            geos.push(bodyGeo);

            const barrelGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.35, 6);
            barrelGeo.rotateX(Math.PI / 2);
            barrelGeo.translate(0, 0.01, -0.42);
            geos.push(barrelGeo);

            // Drum magazine (cylinder underneath)
            const drumGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.08, 8);
            drumGeo.translate(0, -0.10, 0.05);
            geos.push(drumGeo);
        } else if (weaponId === 'SMG') {
            // SMG: short body + stubby barrel
            const bodyGeo = new THREE.BoxGeometry(0.08, 0.08, 0.30);
            bodyGeo.translate(0, 0, 0.10);
            geos.push(bodyGeo);

            const barrelGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.15, 6);
            barrelGeo.rotateX(Math.PI / 2);
            barrelGeo.translate(0, 0.01, -0.15);
            geos.push(barrelGeo);
        } else {
            // AR-15: long body + long barrel
            const bodyGeo = new THREE.BoxGeometry(0.08, 0.08, 0.50);
            geos.push(bodyGeo);

            const barrelGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.35, 6);
            barrelGeo.rotateX(Math.PI / 2);
            barrelGeo.translate(0, 0.01, -0.42);
            geos.push(barrelGeo);
        }

        const merged = mergeGeometries(geos);
        for (const g of geos) g.dispose();

        const gun = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: 0x333333 }));
        gun.position.set(0.05, 1.3, -0.45);
        gun.castShadow = false;

        this._gunParent.add(gun);
        this.gunMesh = gun;
    }

    setWeaponModel(weaponId) {
        this._createGunMesh(weaponId);
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
     * @param {boolean} headshot - Is this a headshot?
     * @returns {object} { killed: boolean, damage: number }
     */
    takeDamage(amount, fromPosition, headshot = false) {
        if (!this.alive) return { killed: false, damage: 0 };

        const actualDamage = headshot ? amount * 2 : amount;
        this.hp = Math.max(0, this.hp - actualDamage);
        this.timeSinceLastDamage = 0;
        this.lastDamagedTime = performance.now();

        // Track damage direction for HUD
        if (fromPosition) {
            const myPos = new THREE.Vector3(this.body.position.x, 0, this.body.position.z);
            this.lastDamageDirection = new THREE.Vector3()
                .subVectors(fromPosition, myPos)
                .normalize();
            this.damageIndicatorTimer = 1.0; // show for 1 second
        }

        if (this.hp <= 0) {
            this.die(fromPosition);
            return { killed: true, damage: actualDamage };
        }

        return { killed: false, damage: actualDamage };
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
    }

    /**
     * Respawn at a given position.
     * @param {THREE.Vector3} position
     */
    respawn(position) {
        this.alive = true;
        this.hp = this.maxHP;
        this.timeSinceLastDamage = Infinity;
        this.mesh.visible = true;
        this.mesh.rotation.set(0, 0, 0);

        // Reset body part rotations
        if (this.upperBody) this.upperBody.rotation.set(0, 0, 0);
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
        this.ragdollActive = false;

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

        // Gun reload tilt animation
        if (this.gunMesh && this.controller) {
            const targetTilt = this.controller.isReloading ? 0.6 : 0;
            const tiltSpeed = this.controller.isReloading ? 12 : 8;
            this._gunReloadTilt += (targetTilt - this._gunReloadTilt) * Math.min(1, tiltSpeed * dt);
            this.gunMesh.rotation.x = this._gunReloadTilt;
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
