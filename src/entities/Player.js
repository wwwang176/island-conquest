import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Weapon } from './Weapon.js';
import { WeaponDefs } from './WeaponDefs.js';
import { HELI_PASSENGER_SLOTS, HELI_PILOT_OFFSET } from './Helicopter.js';

// Module-level reusable objects (avoid per-frame allocation)
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _yawQuat = new THREE.Quaternion();
const _moveDir = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _seatPos = new THREE.Vector3();
const _eyeOffset = { x: 0, y: 0, z: 0 };
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _aimDir = new THREE.Vector3();
const _shotOrigin = new THREE.Vector3();
const _dmgPos = new THREE.Vector3();
const _dmgFrom = new THREE.Vector3();
const _dmgFwd = new THREE.Vector3();
const _dmgQuat = new THREE.Quaternion();

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

        // Position cache (avoid per-frame allocation in getPosition)
        this._posCache = new THREE.Vector3();

        // Vehicle state
        this.vehicle = null;

        // Grenade state
        this.grenadeCount = WeaponDefs.GRENADE.maxPerLife;
        this.grenadeCooldown = 0;
        this.grenadeManager = null; // set by Game
        this._grenadePrevDown = false;
        this._grenadeThrowTimer = 0; // blocks fire & scope during throw

        // Jump edge detection (prevent jump on spawn frame)
        this._prevSpace = false;

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

        // Movement inertia
        this._velX = 0;
        this._velZ = 0;

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

        // Vehicle mode: handle driving
        if (this.vehicle) {
            this._handleVehicleUpdate(dt);
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
        if (this._grenadeThrowTimer > 0) this._grenadeThrowTimer -= dt;

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
        const sens = this.weapon.isScoped ? this.mouseSensitivity * 0.5 : this.mouseSensitivity;
        this.yaw -= dx * sens;
        this.pitch -= dy * sens;
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

        // Manual jump (edge-triggered to avoid jump on spawn/respawn frame)
        const spaceDown = this.input.isKeyDown('Space');
        if (spaceDown && !this._prevSpace && !this.isJumping) {
            this.isJumping = true;
            this.jumpVelY = this.jumpSpeed;
        }
        this._prevSpace = spaceDown;

        // Compute target velocity from input
        let targetVX = 0, targetVZ = 0;
        if (_moveDir.lengthSq() > 0) {
            _moveDir.normalize();
            targetVX = _moveDir.x * this.moveSpeed;
            targetVZ = _moveDir.z * this.moveSpeed;
        }

        // Lerp current velocity toward target (inertia)
        const accelRate = 20;
        const decelRate = 12;
        const rate = (targetVX !== 0 || targetVZ !== 0) ? accelRate : decelRate;
        const t = Math.min(1, rate * dt);
        this._velX += (targetVX - this._velX) * t;
        this._velZ += (targetVZ - this._velZ) * t;

        // Snap to zero when very slow
        if (this._velX * this._velX + this._velZ * this._velZ < 0.01) {
            this._velX = 0;
            this._velZ = 0;
            if (!this.isJumping) pos.y = groundY + 0.05;
            return;
        }

        // Kinematic position update
        const dx = this._velX * dt;
        const dz = this._velZ * dt;
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

    }

    _handleShooting(dt) {
        this.weapon.triggerHeld = this.input.mouseDown;

        // Block fire & scope during grenade throw
        if (this._grenadeThrowTimer > 0) return;

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
            _shotOrigin.copy(this.camera.position);
            const origin = _shotOrigin;
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
        this._grenadeThrowTimer = 0.5;
        if (this.weapon.isScoped) this.weapon.setScoped(false);
    }

    _syncMeshAndCamera() {
        const pos = this.body.position;
        this.mesh.position.set(pos.x, pos.y, pos.z);
        this.camera.position.set(pos.x, pos.y + this.cameraHeight, pos.z);
        _euler.set(this.pitch, this.yaw, 0);
        this.camera.quaternion.setFromEuler(_euler);
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
            _dmgPos.set(this.body.position.x, 0, this.body.position.z);
            _dmgFrom.set(fromPosition.x, 0, fromPosition.z);
            if (!this.lastDamageDirection) this.lastDamageDirection = new THREE.Vector3();
            this.lastDamageDirection.subVectors(_dmgFrom, _dmgPos).normalize();
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
        // Exit vehicle on death
        if (this.vehicle) {
            this.vehicle.exit(this);
            this.vehicle = null;
        }
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
        this._velX = 0;
        this._velZ = 0;
        this._prevSpace = true; // suppress jump on spawn frame
        this.grenadeCount = WeaponDefs.GRENADE.maxPerLife;
        this.grenadeCooldown = 0;
        this._grenadeThrowTimer = 0;
        this.eventBus.emit('playerRespawned');
    }

    canRespawn() {
        return !this.alive && this.deathTimer <= 0;
    }

    getPosition() {
        return this._posCache.set(this.body.position.x, this.body.position.y, this.body.position.z);
    }

    getAimDirection() {
        _aimDir.set(0, 0, -1);
        _aimDir.applyQuaternion(this.camera.quaternion);
        return _aimDir;
    }

    // ───── Vehicle Controls ─────

    _handleVehicleUpdate(dt) {
        // Health regen still works in vehicle
        this.timeSinceLastDamage += dt;
        if (this.timeSinceLastDamage >= this.regenDelay && this.hp < this.maxHP) {
            this.hp = Math.min(this.maxHP, this.hp + this.regenRate * dt);
        }

        if (this.input.isPointerLocked) {
            this._handleMouseLook();
            this._handleVehicleControls(dt);
            // Pilots cannot shoot; passengers can
            const isPilot = this.vehicle && this.vehicle.driver === this;
            let sideBlocked = false;
            // Helicopter passengers: restricted to their side
            if (this.vehicle && !isPilot && this.vehicle.type === 'helicopter') {
                const slotIdx = this.vehicle.passengers.indexOf(this);
                const isLeftSeat = slotIdx >= 0 && slotIdx < 2;
                const aimDir = this.getAimDirection();
                const rY = this.vehicle.rotationY;
                const cross = Math.sin(rY) * aimDir.z - Math.cos(rY) * aimDir.x;
                sideBlocked = isLeftSeat ? cross < 0 : cross > 0;
            }
            if (!isPilot && !sideBlocked) {
                this._handleShooting(dt);
            }
        }
        this._syncCameraToVehicle();
        this.weapon.update(dt);
    }

    _handleVehicleControls(dt) {
        const v = this.vehicle;
        if (!v) return;

        // Only the pilot (driver) can steer
        if (v.driver !== this) return;

        const input = {
            thrust: 0,
            brake: 0,
            steerLeft: false,
            steerRight: false,
            ascend: false,
            descend: false,
        };

        if (this.input.isKeyDown('KeyW')) input.thrust = 1;
        if (this.input.isKeyDown('KeyS')) input.brake = 1;
        if (this.input.isKeyDown('KeyA')) input.steerLeft = true;
        if (this.input.isKeyDown('KeyD')) input.steerRight = true;

        if (v.type === 'helicopter') {
            if (this.input.isKeyDown('Space')) input.ascend = true;
            if (this.input.isKeyDown('ShiftLeft') || this.input.isKeyDown('ShiftRight')) input.descend = true;
        }

        v.applyInput(input, dt);
    }

    _syncCameraToVehicle() {
        const v = this.vehicle;
        if (!v || !v.mesh) return;

        const vp = v.mesh.position;
        let camX = vp.x, camY = vp.y, camZ = vp.z;

        if (v.type === 'helicopter') {
            if (v.driver === this) {
                // Pilot: full world-space transform (eye offset baked in)
                _eyeOffset.x = HELI_PILOT_OFFSET.x;
                _eyeOffset.y = HELI_PILOT_OFFSET.y + 1.6;
                _eyeOffset.z = HELI_PILOT_OFFSET.z;
                v.getWorldSeatPos(_seatPos, _eyeOffset);
                camX = _seatPos.x;
                camY = _seatPos.y;
                camZ = _seatPos.z;
            } else {
                // Passenger: full world-space transform (eye offset baked in)
                const slotIdx = v.passengers ? v.passengers.indexOf(this) : -1;
                if (slotIdx >= 0 && slotIdx < HELI_PASSENGER_SLOTS.length) {
                    const slot = HELI_PASSENGER_SLOTS[slotIdx];
                    _eyeOffset.x = slot.x;
                    _eyeOffset.y = slot.y + 1.6;
                    _eyeOffset.z = slot.z;
                    v.getWorldSeatPos(_seatPos, _eyeOffset);
                    camX = _seatPos.x;
                    camY = _seatPos.y;
                    camZ = _seatPos.z;
                } else {
                    camY = vp.y + 0.5;
                }
            }
        } else {
            camY = vp.y + 2.0;
        }

        this.camera.position.set(camX, camY, camZ);

        // Use player's own yaw/pitch for free look
        _euler.set(this.pitch, this.yaw, 0);
        this.camera.quaternion.setFromEuler(_euler);

        // Sync physics body to vehicle position
        this.body.position.set(camX, vp.y, camZ);
    }

    /**
     * Enter a vehicle.
     * @param {import('./Vehicle.js').Vehicle} vehicle
     */
    enterVehicle(vehicle) {
        this.vehicle = vehicle;
        vehicle.enter(this);
        this.mesh.visible = false;
        // Face the vehicle direction
        this.yaw = vehicle.rotationY;
        // Unscope
        if (this.weapon.isScoped) this.weapon.setScoped(false);
    }

    /**
     * Exit the current vehicle.
     * @param {THREE.Vector3} exitPos - Where to place the player
     */
    exitVehicle(exitPos) {
        const v = this.vehicle;
        if (!v) return;
        v.exit(this);
        this.vehicle = null;
        this.mesh.visible = false; // Stay hidden in FPS
        this.body.position.set(exitPos.x, exitPos.y + 1, exitPos.z);
        this.body.velocity.set(0, 0, 0);
        this.isJumping = false;
        this.jumpVelY = 0;
        this._velX = 0;
        this._velZ = 0;
    }
}
