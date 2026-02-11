import * as THREE from 'three';
import * as CANNON from 'cannon-es';

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
        physicsWorld.addBody(this.body);

        // Damage direction tracking (for HUD indicator)
        this.lastDamageDirection = null;
        this.damageIndicatorTimer = 0;

        // Last time this soldier took damage (for safe-respawn checks)
        this.lastDamagedTime = 0;

        // Ragdoll death effect
        this.ragdollActive = false;
    }

    _createMesh() {
        const group = new THREE.Group();

        // Body (capsule)
        const bodyGeo = new THREE.CapsuleGeometry(0.35, 0.8, 4, 8);
        const bodyMat = new THREE.MeshLambertMaterial({ color: this.teamColor });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 1.0;
        body.castShadow = true;
        group.add(body);

        // Head
        const headGeo = new THREE.SphereGeometry(0.2, 6, 6);
        const headMat = new THREE.MeshLambertMaterial({ color: 0xddbb99 });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.y = 1.65;
        head.castShadow = true;
        group.add(head);
        this.headMesh = head;

        // Simple gun
        const gunGeo = new THREE.BoxGeometry(0.08, 0.08, 0.5);
        const gunMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
        const gun = new THREE.Mesh(gunGeo, gunMat);
        gun.position.set(0.3, 1.1, -0.3);
        group.add(gun);
        this.gunMesh = gun;

        return group;
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
            const force = 120;
            this.body.applyImpulse(
                new CANNON.Vec3(dir.x * force, 20, dir.z * force),
                new CANNON.Vec3(0, 0.6, 0)
            );
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
        this.mesh.visible = true;
        this.mesh.rotation.set(0, 0, 0);

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

        // Sync mesh to physics body position
        this.mesh.position.set(
            this.body.position.x,
            this.body.position.y,
            this.body.position.z
        );
    }

    getPosition() {
        return new THREE.Vector3(this.body.position.x, this.body.position.y, this.body.position.z);
    }

    canRespawn() {
        return !this.alive && this.deathTimer <= 0;
    }
}
