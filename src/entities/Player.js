import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Weapon } from './Weapon.js';
import { WeaponDefs } from './WeaponDefs.js';

// Module-level reusable objects (avoid per-frame allocation)
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _yawQuat = new THREE.Quaternion();
const _moveDir = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

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
        this.jumpSpeed = 4;
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
        this.selectedWeaponId = 'AR15';

        // Grenade state
        this.grenadeCount = WeaponDefs.GRENADE.maxPerLife;
        this.grenadeCooldown = 0;
        this.grenadeManager = null; // set by Game
        this._grenadePrevDown = false;

        // Scope state
        this._prevRightMouse = false;

        // Movement velocity (for grenade velocity inheritance)
        this.lastMoveVelocity = new THREE.Vector3();

        // Damage direction indicator
        this.lastDamageDirection = null;
        this.damageIndicatorTimer = 0;

        // Terrain helpers (set by Game after creation)
        /** @type {Function|null} */
        this.getHeightAt = null;
        /** @type {import('../ai/NavGrid.js').NavGrid|null} */
        this.navGrid = null;

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
        this.weapon = new Weapon(scene, camera, this.selectedWeaponId);
        this.shootTargets = [];
    }

    _getLimbColor() {
        if (!this.team) return 0xddbb99;
        const tc = new THREE.Color(this.team === 'teamA' ? 0x4488ff : 0xff4444);
        return tc.multiplyScalar(0.7).getHex();
    }

    switchWeapon(weaponId) {
        // Unscope before switching
        if (this.weapon.isScoped) this.weapon.setScoped(false);

        // Dispose old gun + arm geometries & materials
        for (const child of this.weapon.gunGroup.children) {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        }

        // Remove old weapon visuals
        this.camera.remove(this.weapon.gunGroup);
        this.camera.remove(this.weapon.muzzleFlash);

        // Create new weapon
        const tracerSystem = this.weapon.tracerSystem;
        const impactVFX = this.weapon.impactVFX;
        this.weapon = new Weapon(this.scene, this.camera, weaponId, this._getLimbColor());
        this.weapon.tracerSystem = tracerSystem;
        this.weapon.impactVFX = impactVFX;
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

        // Grenade cooldown
        if (this.grenadeCooldown > 0) this.grenadeCooldown -= dt;

        if (this.input.isPointerLocked) {
            this._handleMouseLook();
            const prevX = this.body.position.x;
            const prevZ = this.body.position.z;
            this._handleMovement(dt);
            if (dt > 0.001) {
                const invDt = 1 / dt;
                this.lastMoveVelocity.set(
                    (this.body.position.x - prevX) * invDt,
                    0,
                    (this.body.position.z - prevZ) * invDt
                );
            } else {
                this.lastMoveVelocity.set(0, 0, 0);
            }
            this._handleShooting(dt);
            this._handleGrenade();
        }
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
        _forward.set(0, 0, -1);
        _right.set(1, 0, 0);
        _yawQuat.setFromAxisAngle(_yAxis, this.yaw);
        _forward.applyQuaternion(_yawQuat);
        _right.applyQuaternion(_yawQuat);

        _moveDir.set(0, 0, 0);
        if (this.input.isKeyDown('KeyW')) _moveDir.add(_forward);
        if (this.input.isKeyDown('KeyS')) _moveDir.sub(_forward);
        if (this.input.isKeyDown('KeyA')) _moveDir.sub(_right);
        if (this.input.isKeyDown('KeyD')) _moveDir.add(_right);

        if (_moveDir.lengthSq() > 0) {
            _moveDir.normalize();
        } else {
            // No input — just snap to ground if not jumping
            if (!this.isJumping) {
                pos.y = groundY + 0.05;
            }
            return;
        }

        // Kinematic position update
        const dx = _moveDir.x * this.moveSpeed * dt;
        const dz = _moveDir.z * this.moveSpeed * dt;
        const newX = pos.x + dx;
        const newZ = pos.z + dz;

        // NavGrid obstacle check with axis-separated sliding
        let finalX = newX;
        let finalZ = newZ;
        if (this.navGrid) {
            let g = this.navGrid.worldToGrid(newX, newZ);
            if (!this.navGrid.isWalkable(g.col, g.row)) {
                // Try sliding along each axis individually
                const gX = this.navGrid.worldToGrid(newX, pos.z);
                const gZ = this.navGrid.worldToGrid(pos.x, newZ);
                if (this.navGrid.isWalkable(gX.col, gX.row)) {
                    finalX = newX; finalZ = pos.z;
                } else if (this.navGrid.isWalkable(gZ.col, gZ.row)) {
                    finalX = pos.x; finalZ = newZ;
                } else {
                    return; // fully blocked
                }
            }
        }

        const newGroundY = getH(finalX, finalZ);
        const currentFootY = pos.y;
        const slopeRise = newGroundY - currentFootY;
        const stepX = finalX - pos.x;
        const stepZ = finalZ - pos.z;
        const slopeRun = Math.sqrt(stepX * stepX + stepZ * stepZ);
        const slopeAngle = slopeRun > 0.001 ? Math.atan2(slopeRise, slopeRun) : 0;
        const maxClimbAngle = Math.PI * 0.42; // ~75°

        if (slopeAngle < maxClimbAngle) {
            pos.x = finalX;
            pos.z = finalZ;
            if (!this.isJumping) pos.y = newGroundY + 0.05;
        } else {
            // Steep terrain — auto jump
            if (!this.isJumping) {
                this.isJumping = true;
                this.jumpVelY = 2.5;
                pos.x += _moveDir.x * this.moveSpeed * 0.3 * dt;
                pos.z += _moveDir.z * this.moveSpeed * 0.3 * dt;
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

        // Right-click scope toggle (BOLT only, edge-triggered)
        // Block scope during bolt cycling or reloading
        const rmb = this.input.rightMouseDown;
        if (rmb && !this._prevRightMouse && this.weapon.def.scopeFOV
            && !this.weapon.isBolting && !this.weapon.isReloading) {
            this.weapon.setScoped(!this.weapon.isScoped);
        }
        this._prevRightMouse = rmb;

        // Force unscope during bolt cycling or reloading
        if (this.weapon.isScoped && (this.weapon.isBolting || this.weapon.isReloading)) {
            this.weapon.setScoped(false);
        }

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

    _handleGrenade() {
        if (!this.grenadeManager) return;
        const pressed = this.input.isKeyDown('KeyG');
        if (pressed === this._grenadePrevDown) return;
        this._grenadePrevDown = pressed;
        if (!pressed) return; // only act on key-down edge
        if (this.grenadeCount <= 0 || this.grenadeCooldown > 0) return;

        const def = WeaponDefs.GRENADE;
        const origin = this.camera.position.clone();
        const dir = this.getAimDirection();
        const velocity = dir.multiplyScalar(def.throwSpeed);
        velocity.add(this.lastMoveVelocity);

        this.grenadeManager.spawn(origin, velocity, def.fuseTime, this.team, 'You');
        this.grenadeCount--;
        this.grenadeCooldown = 1;
    }

    _syncMeshAndCamera() {
        const pos = this.body.position;
        this.mesh.position.set(pos.x, pos.y, pos.z);
        this.camera.position.set(pos.x, pos.y + this.cameraHeight, pos.z);
        const euler = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
        this.camera.quaternion.setFromEuler(euler);
    }

    takeDamage(amount, fromPosition, hitY = null) {
        if (!this.alive) return { killed: false, damage: 0, headshot: false };

        const baseY = this.body.position.y;
        const headshot = hitY !== null && hitY >= baseY + 1.45;
        const legshot = hitY !== null && !headshot && hitY < baseY + 0.7;
        const actualDamage = headshot ? amount * 2 : legshot ? amount * 0.5 : amount;
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
            return { killed: true, damage: actualDamage, headshot };
        }
        return { killed: false, damage: actualDamage, headshot };
    }

    die() {
        this.alive = false;
        this.hp = 0;
        this.deathTimer = this.respawnDelay;
        // Unscope on death
        if (this.weapon.isScoped) this.weapon.setScoped(false);
        this.eventBus.emit('playerDied');
    }

    respawn(position) {
        this.alive = true;
        this.hp = this.maxHP;
        this.timeSinceLastDamage = Infinity;
        this.damageIndicatorTimer = 0;
        if (this.weapon.weaponId !== this.selectedWeaponId) {
            this.switchWeapon(this.selectedWeaponId);
        }
        this.weapon.currentAmmo = this.weapon.magazineSize;
        this.weapon.isReloading = false;
        this.weapon.isBolting = false;
        this.weapon.boltTimer = 0;
        if (this.weapon.isScoped) this.weapon.setScoped(false);
        // Apply weapon move speed multiplier
        const mult = WeaponDefs[this.selectedWeaponId].moveSpeedMult || 1.0;
        this.moveSpeed = 6 * mult;
        this.body.position.set(position.x, position.y + 1, position.z);
        this.body.velocity.set(0, 0, 0);
        this.isJumping = false;
        this.jumpVelY = 0;
        this.grenadeCount = WeaponDefs.GRENADE.maxPerLife;
        this.grenadeCooldown = 0;
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
