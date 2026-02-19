import * as THREE from 'three';
import { WeaponDefs, GunAnim } from './WeaponDefs.js';
import { Soldier } from './Soldier.js';
import { applyFalloff } from '../shared/DamageFalloff.js';

const _tracerOrigin = new THREE.Vector3();

/**
 * Assault Rifle weapon system.
 * Handles firing (hitscan), reloading, recoil spread, and visual feedback.
 */
export class Weapon {
    constructor(scene, camera, weaponId = 'AR15', armColor) {
        this.scene = scene;
        this.camera = camera;

        this.weaponId = weaponId;
        const def = WeaponDefs[weaponId];
        this.def = def;

        // Stats
        this.magazineSize = def.magazineSize;
        this.currentAmmo = def.magazineSize;
        this.fireRate = def.fireRate;
        this.fireInterval = 60 / def.fireRate;
        this.reloadTime = def.reloadTime;
        this.damage = def.damage;
        this.headshotMultiplier = def.headshotMultiplier;
        this.maxRange = def.maxRange;

        // Damage falloff
        this.falloffStart = def.falloffStart;
        this.falloffEnd = def.falloffEnd;
        this.falloffMinScale = def.falloffMinScale;

        // Recoil / spread
        this.baseSpread = def.baseSpread;
        this.maxSpread = def.maxSpread;
        this.spreadIncreasePerShot = def.spreadIncreasePerShot;
        this.spreadRecoveryRate = def.spreadRecoveryRate;
        this.currentSpread = def.baseSpread;

        // State
        this.isReloading = false;
        this.reloadTimer = 0;
        this.fireCooldown = 0;
        this.triggerHeld = false; // true while fire button is held down

        // Bolt-action state
        this.isBolting = false;
        this.boltTimer = 0;

        // Scope state (BOLT only)
        this.isScoped = false;
        this._defaultFOV = camera.fov;

        // Gun mesh (simple low-poly representation)
        this.armColor = armColor;
        this.gunGroup = this._createGunMesh();
        this.camera.add(this.gunGroup);

        // Visual: muzzle flash (attached to gunGroup so it follows recoil)
        this.muzzleFlash = this._createMuzzleFlash();
        this.muzzleFlashTimer = 0;

        // Recoil visual (camera kick)
        this.recoilOffset = 0;
        this.recoilRecoverySpeed = GunAnim.recoilRecovery;
    }

    /**
     * Build a first-person gun mesh group for the given weapon ID.
     * Static so spectator view can reuse it without a Weapon instance.
     */
    static buildFPGunMesh(weaponId, armColor) {
        // Reuse shared gun mesh, position it for first-person view
        const gun = Soldier.buildGunMesh(weaponId);
        gun.position.set(0.25, -0.19, -0.40);

        const group = new THREE.Group();
        group.add(gun);

        // ── First-person arms (box style, same as COM) ──
        const armMat = new THREE.MeshLambertMaterial({ color: armColor || 0xddbb99 });

        // Grip Z positions from weapon config
        const [rGripZ, lGripZ] = WeaponDefs[weaponId].fpGripZ;

        // Right arm (trigger hand)
        const rightArmGeo = new THREE.BoxGeometry(0.15, 0.40, 0.15);
        rightArmGeo.translate(0, -0.20, 0);
        const rightArm = new THREE.Mesh(rightArmGeo, armMat);
        rightArm.position.set(0.28, -0.22, rGripZ);
        rightArm.rotation.set(-1.1, 0, 0);
        group.add(rightArm);

        // Left arm (support hand)
        const leftArmGeo = new THREE.BoxGeometry(0.15, 0.55, 0.15);
        leftArmGeo.translate(0, -0.275, 0);
        const leftArm = new THREE.Mesh(leftArmGeo, armMat);
        leftArm.position.set(0.21, -0.22, lGripZ);
        leftArm.rotation.set(-1.2, 0, -0.5);
        group.add(leftArm);

        // Align with third-person gun position seen in spectator follow mode
        group.position.set(-0.20, -0.10, 0);
        return group;
    }

    _createGunMesh() {
        return Weapon.buildFPGunMesh(this.weaponId, this.armColor);
    }

    _createMuzzleFlash() {
        const flash = Soldier.createMuzzleFlashMesh();
        flash.visible = false;
        // gunGroup space: gun at (0.25, -0.19, -0.40), barrel tip = gun + tpMuzzleZ
        const def = WeaponDefs[this.weaponId];
        flash.position.set(0.25, -0.18, -0.40 + def.tpMuzzleZ);
        this.gunGroup.add(flash);
        return flash;
    }


    /**
     * Fire the weapon. Returns hit info or null.
     * @param {THREE.Vector3} origin - Ray origin (camera position)
     * @param {THREE.Vector3} direction - Aim direction (camera forward)
     * @param {Array<THREE.Object3D>} targets - Objects that can be hit
     * @returns {object|null} { target, point, distance } or null
     */
    fire(origin, direction, targets = []) {
        if (this.isBolting || this.isReloading || this.fireCooldown > 0 || this.currentAmmo <= 0) {
            return null;
        }

        this.currentAmmo--;
        this.fireCooldown += this.fireInterval;

        // Apply spread
        const spreadDir = direction.clone();
        const spreadAngleX = (Math.random() - 0.5) * 2 * this.currentSpread;
        const spreadAngleY = (Math.random() - 0.5) * 2 * this.currentSpread;
        const euler = new THREE.Euler(spreadAngleY, spreadAngleX, 0, 'YXZ');
        spreadDir.applyEuler(euler);

        // Increase spread (recoil) — negative spreadIncreasePerShot means sustained fire tightens
        if (this.spreadIncreasePerShot >= 0) {
            this.currentSpread = Math.min(this.maxSpread, this.currentSpread + this.spreadIncreasePerShot);
        } else {
            this.currentSpread = Math.max(this.def.minSpread || 0.001, this.currentSpread + this.spreadIncreasePerShot);
        }

        // Visual recoil kick
        this.recoilOffset = GunAnim.recoilOffset;

        // Muzzle flash
        this.muzzleFlash.visible = true;
        this.muzzleFlash.scale.setScalar(0.85 + Math.random() * 0.3);
        this.muzzleFlash.rotation.z = (Math.random() - 0.5) * (10 * Math.PI / 180);
        this.muzzleFlashTimer = 0.04;

        // Bolt cycling (BOLT weapon only)
        if (this.def.boltTime) {
            this.isBolting = true;
            this.boltTimer = this.def.boltTime;
        }

        // Hitscan raycast
        const raycaster = new THREE.Raycaster(origin, spreadDir, 0, this.maxRange);
        const intersections = raycaster.intersectObjects(targets, true);

        if (intersections.length > 0) {
            const hit = intersections[0];
            // Impact particles
            if (this.impactVFX) {
                const surfaceType = this._getSurfaceType(hit.object);
                const impactType = surfaceType === 'water' ? 'water'
                    : (surfaceType === 'rock' ? 'spark' : 'dirt');
                const worldNormal = this._getWorldNormal(hit);
                this.impactVFX.spawn(impactType, hit.point, worldNormal);
            }

            // Player tracer — skip past gun model so line starts in front of character
            if (this.tracerSystem) {
                const tracerSkip = Math.abs(-0.40 + this.def.tpMuzzleZ) * 1.5;
                if (hit.distance > tracerSkip) {
                    _tracerOrigin.copy(origin).addScaledVector(spreadDir, tracerSkip);
                    this.tracerSystem.fire(_tracerOrigin, spreadDir, hit.distance - tracerSkip);
                }
            }

            // Calculate damage with falloff
            const dmg = applyFalloff(this.damage, hit.distance, this.falloffStart, this.falloffEnd, this.falloffMinScale);

            return {
                target: hit.object,
                point: hit.point,
                distance: hit.distance,
                damage: dmg,
            };
        }

        // No hit — tracer at max range
        if (this.tracerSystem) {
            const tracerSkip = Math.abs(-0.40 + this.def.tpMuzzleZ) * 1.5;
            _tracerOrigin.copy(origin).addScaledVector(spreadDir, tracerSkip);
            this.tracerSystem.fire(_tracerOrigin, spreadDir, this.maxRange - tracerSkip);
        }

        return null;
    }

    reload() {
        if (this.isReloading || this.currentAmmo === this.magazineSize) return;
        this.isReloading = true;
        this.reloadTimer = this.reloadTime;
        // Unscope on reload
        if (this.isScoped) this.setScoped(false);
    }

    /** Toggle scope (BOLT weapon only). */
    setScoped(scoped) {
        if (!this.def.scopeFOV) return;
        this.isScoped = scoped;
        this.camera.fov = scoped ? this.def.scopeFOV : this._defaultFOV;
        this.camera.updateProjectionMatrix();
        // Hide gun model when scoped
        if (this.gunGroup) this.gunGroup.visible = !scoped;
    }

    _getWorldNormal(hit) {
        if (!hit.face) return null;
        const normal = hit.face.normal.clone();
        normal.transformDirection(hit.object.matrixWorld);
        return normal;
    }

    _getSurfaceType(obj) {
        let current = obj;
        while (current) {
            if (current.userData && current.userData.surfaceType) {
                return current.userData.surfaceType;
            }
            current = current.parent;
        }
        return 'terrain';
    }

    update(dt) {
        // Fire cooldown
        if (this.fireCooldown > 0) {
            this.fireCooldown -= dt;
        }

        // Bolt cycling
        if (this.isBolting) {
            this.boltTimer -= dt;
            if (this.boltTimer <= 0) {
                this.isBolting = false;
                this.boltTimer = 0;
            }
        }

        // Reload
        if (this.isReloading) {
            this.reloadTimer -= dt;
            if (this.reloadTimer <= 0) {
                this.currentAmmo = this.magazineSize;
                this.isReloading = false;
            }
        }

        // Spread recovery: only recover when trigger is fully released
        // Recovery always moves toward baseSpread (up for LMG after sustained fire, down for others)
        if (!this.triggerHeld) {
            if (this.currentSpread > this.baseSpread) {
                this.currentSpread = Math.max(this.baseSpread, this.currentSpread - this.spreadRecoveryRate * dt);
            } else if (this.currentSpread < this.baseSpread) {
                this.currentSpread = Math.min(this.baseSpread, this.currentSpread + this.spreadRecoveryRate * dt);
            }
        }

        // Muzzle flash timer
        if (this.muzzleFlashTimer > 0) {
            this.muzzleFlashTimer -= dt;
            if (this.muzzleFlashTimer <= 0) {
                this.muzzleFlash.visible = false;
            }
        }

        // Visual recoil recovery
        if (this.recoilOffset > 0) {
            this.recoilOffset = Math.max(0, this.recoilOffset - this.recoilRecoverySpeed * dt);
        }
        // Gun tilt: bolt cycling / reload
        const targetTilt = this.isReloading ? GunAnim.reloadTilt : (this.isBolting ? GunAnim.boltTilt : 0);
        if (this._reloadTilt === undefined) this._reloadTilt = 0;
        const tiltSpeed = this.isReloading ? 12 : 8; // faster going down, slower coming back
        this._reloadTilt += (targetTilt - this._reloadTilt) * Math.min(1, tiltSpeed * dt);
        // Apply gun recoil + reload tilt animation
        if (this.gunGroup) {
            this.gunGroup.position.z = -this.recoilOffset;
            this.gunGroup.rotation.x = this._reloadTilt;
        }

        // Auto-reload when empty
        if (this.currentAmmo <= 0 && !this.isReloading) {
            this.reload();
        }
    }
}
