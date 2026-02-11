import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Weapon } from './Weapon.js';

const _raycaster = new THREE.Raycaster();
const _downDir = new THREE.Vector3(0, -1, 0);

/**
 * First-person player controller.
 * Handles FPS camera, WASD movement, jumping, shooting, health, and death.
 * Movement uses kinematic terrain-snapping (same as COM) for smooth slope climbing.
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

        // Terrain helpers (set by Game after creation)
        /** @type {Function|null} */
        this.getHeightAt = null;
        /** @type {THREE.Object3D[]|null} */
        this.collidables = null;

        // Kinematic jump state
        this.isJumping = false;
        this.jumpVelY = 0;

        // Physics body (kinematic — we control position directly)
        this.body = new CANNON.Body({
            mass: 0,
            type: CANNON.Body.KINEMATIC,
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
        const body = this.body;
        const pos = body.position;
        const getH = this.getHeightAt;
        if (!getH) return;

        const groundY = getH(pos.x, pos.z);

        // Handle jumping (manual parabola, same as COM)
        if (this.isJumping) {
            this.jumpVelY -= 9.8 * dt;
            pos.y += this.jumpVelY * dt;
            if (pos.y <= groundY + 0.05) {
                pos.y = groundY + 0.05;
                this.isJumping = false;
                this.jumpVelY = 0;
            }
        }

        // Build move direction from input
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
            moveDir.normalize();
        } else {
            // No input — just snap to ground if not jumping
            if (!this.isJumping) {
                pos.y = groundY + 0.05;
            }
            return;
        }

        // Kinematic position update
        const dx = moveDir.x * this.moveSpeed * dt;
        const dz = moveDir.z * this.moveSpeed * dt;
        const newX = pos.x + dx;
        const newZ = pos.z + dz;

        // Effective ground = max(terrain, obstacle top)
        const newTerrainY = getH(newX, newZ);
        let newGroundY = newTerrainY;
        if (this.collidables) {
            const origin = new THREE.Vector3(newX, pos.y + 2.0, newZ);
            _raycaster.set(origin, _downDir);
            _raycaster.far = 4.0;
            const hits = _raycaster.intersectObjects(this.collidables, true);
            for (const hit of hits) {
                if (hit.point.y <= newTerrainY + 0.3) continue;
                if (hit.point.y > newGroundY) newGroundY = hit.point.y;
            }
        }

        const currentFootY = pos.y;
        const slopeRise = newGroundY - currentFootY;
        const slopeRun = Math.sqrt(dx * dx + dz * dz);
        const slopeAngle = slopeRun > 0.001 ? Math.atan2(slopeRise, slopeRun) : 0;
        const maxClimbAngle = Math.PI * 0.42; // ~75°
        const isObstacle = newGroundY > newTerrainY + 0.3;

        if (isObstacle && newGroundY > currentFootY + 0.3) {
            // Blocked by obstacle — don't move
        } else if (slopeAngle < maxClimbAngle) {
            pos.x = newX;
            pos.z = newZ;
            if (!this.isJumping) pos.y = newGroundY + 0.05;
        } else if (!isObstacle) {
            // Steep terrain — auto jump
            if (!this.isJumping) {
                this.isJumping = true;
                this.jumpVelY = 2.5;
                pos.x += moveDir.x * this.moveSpeed * 0.3 * dt;
                pos.z += moveDir.z * this.moveSpeed * 0.3 * dt;
            }
        }

        // Manual jump
        if (this.input.isKeyDown('Space') && !this.isJumping) {
            this.isJumping = true;
            this.jumpVelY = this.jumpSpeed;
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
        this.isJumping = false;
        this.jumpVelY = 0;
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
