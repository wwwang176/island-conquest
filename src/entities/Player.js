import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Weapon } from './Weapon.js';

/**
 * First-person player controller.
 * Handles FPS camera, WASD movement, jumping, shooting, health, and death.
 * Movement direction and aim direction are independent.
 */
export class Player {
    constructor(scene, camera, physicsWorld, inputManager, eventBus) {
        this.scene = scene;
        this.camera = camera;
        this.input = inputManager;
        this.physicsWorld = physicsWorld;
        this.eventBus = eventBus;

        // Settings
        this.moveSpeed = 6;
        this.jumpSpeed = 5;
        this.mouseSensitivity = 0.002;
        this.cameraHeight = 1.6;

        // Camera rotation
        this.pitch = 0;
        this.yaw = 0;

        // Health system
        this.maxHP = 100;
        this.hp = this.maxHP;
        this.regenDelay = 5;
        this.regenRate = 10;
        this.timeSinceLastDamage = Infinity;

        // Death / respawn
        this.alive = true;
        this.deathTimer = 0;
        this.respawnDelay = 5;
        this.team = null; // set when joining a team

        // Damage direction indicator
        this.lastDamageDirection = null;
        this.damageIndicatorTimer = 0;

        // Physics body
        this.body = new CANNON.Body({
            mass: 80,
            material: physicsWorld.defaultMaterial,
            linearDamping: 0.9,
            angularDamping: 1.0,
            fixedRotation: true,
        });
        const r = 0.4;
        this.body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, r, 0));
        this.body.addShape(new CANNON.Sphere(r), new CANNON.Vec3(0, this.cameraHeight - r, 0));
        this.body.addShape(
            new CANNON.Cylinder(r, r, this.cameraHeight - 2 * r, 8),
            new CANNON.Vec3(0, this.cameraHeight / 2, 0)
        );
        this.body.position.set(0, 5, 0);
        physicsWorld.addBody(this.body);

        // Ground contact
        this.isOnGround = false;
        this.body.addEventListener('collide', (e) => {
            const contact = e.contact;
            const normal = contact.ni;
            const isBodyA = contact.bi.id === this.body.id;
            const ny = isBodyA ? -normal.y : normal.y;
            if (ny > 0.5) this.isOnGround = true;
        });

        // Debug mesh (hidden in FPS)
        this.mesh = this._createDebugMesh();
        this.mesh.visible = false;
        scene.add(this.mesh);

        // Weapon
        this.weapon = new Weapon(scene, camera);
        this.shootTargets = [];
    }

    _createDebugMesh() {
        const group = new THREE.Group();
        const geo = new THREE.CapsuleGeometry(0.4, this.cameraHeight - 0.8, 4, 8);
        const mat = new THREE.MeshLambertMaterial({ color: 0x4488ff });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = this.cameraHeight / 2;
        group.add(mesh);
        return group;
    }

    update(dt) {
        if (!this.alive) {
            this.deathTimer -= dt;
            this._syncMeshAndCamera();
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

        this._handleMouseLook();
        this._handleMovement(dt);
        this._handleShooting(dt);
        this._syncMeshAndCamera();
        this.weapon.update(dt);
    }

    _handleMouseLook() {
        const { dx, dy } = this.input.consumeMouseDelta();
        this.yaw -= dx * this.mouseSensitivity;
        this.pitch -= dy * this.mouseSensitivity;
        this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    }

    _handleMovement(dt) {
        const forward = new THREE.Vector3(0, 0, -1);
        const right = new THREE.Vector3(1, 0, 0);
        const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
        forward.applyQuaternion(yawQuat);
        right.applyQuaternion(yawQuat);

        const moveDir = new THREE.Vector3(0, 0, 0);
        if (this.input.isKeyDown('KeyW')) moveDir.add(forward);
        if (this.input.isKeyDown('KeyS')) moveDir.sub(forward);
        if (this.input.isKeyDown('KeyA')) moveDir.sub(right);
        if (this.input.isKeyDown('KeyD')) moveDir.add(right);

        if (moveDir.lengthSq() > 0) {
            moveDir.normalize().multiplyScalar(this.moveSpeed);
        }

        this.body.velocity.x = moveDir.x;
        this.body.velocity.z = moveDir.z;

        if (this.input.isKeyDown('Space') && this.isOnGround) {
            this.body.velocity.y = this.jumpSpeed;
            this.isOnGround = false;
        }
    }

    _handleShooting(dt) {
        this.weapon.triggerHeld = this.input.mouseDown;

        if (this.input.mouseDown) {
            const origin = this.camera.position.clone();
            const dir = this.getAimDirection();
            const hit = this.weapon.fire(origin, dir, this.shootTargets);
            if (hit) {
                this.eventBus.emit('playerHit', hit);
            }
        }

        if (this.input.isKeyDown('KeyR')) {
            this.weapon.reload();
        }
    }

    _syncMeshAndCamera() {
        const pos = this.body.position;
        this.mesh.position.set(pos.x, pos.y, pos.z);
        this.camera.position.set(pos.x, pos.y + this.cameraHeight, pos.z);
        const euler = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
        this.camera.quaternion.setFromEuler(euler);
    }

    takeDamage(amount, fromPosition, headshot = false) {
        if (!this.alive) return { killed: false, damage: 0 };

        const actualDamage = headshot ? amount * 2 : amount;
        this.hp = Math.max(0, this.hp - actualDamage);
        this.timeSinceLastDamage = 0;

        // Damage direction for HUD indicator
        if (fromPosition) {
            const myPos = new THREE.Vector3(this.body.position.x, 0, this.body.position.z);
            this.lastDamageDirection = new THREE.Vector3()
                .subVectors(new THREE.Vector3(fromPosition.x, 0, fromPosition.z), myPos)
                .normalize();
            this.damageIndicatorTimer = 1.0;
        }

        if (this.hp <= 0) {
            this.die();
            return { killed: true, damage: actualDamage };
        }
        return { killed: false, damage: actualDamage };
    }

    die() {
        this.alive = false;
        this.hp = 0;
        this.deathTimer = this.respawnDelay;
        this.eventBus.emit('playerDied');
    }

    respawn(position) {
        this.alive = true;
        this.hp = this.maxHP;
        this.timeSinceLastDamage = Infinity;
        this.damageIndicatorTimer = 0;
        this.weapon.currentAmmo = this.weapon.magazineSize;
        this.weapon.isReloading = false;
        this.body.position.set(position.x, position.y + 1, position.z);
        this.body.velocity.set(0, 0, 0);
        this.eventBus.emit('playerRespawned');
    }

    canRespawn() {
        return !this.alive && this.deathTimer <= 0;
    }

    getPosition() {
        return new THREE.Vector3(this.body.position.x, this.body.position.y, this.body.position.z);
    }

    getAimDirection() {
        const dir = new THREE.Vector3(0, 0, -1);
        dir.applyQuaternion(this.camera.quaternion);
        return dir;
    }
}
