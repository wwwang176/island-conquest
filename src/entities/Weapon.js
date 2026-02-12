import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WeaponDefs } from './WeaponDefs.js';

/**
 * Assault Rifle weapon system.
 * Handles firing (hitscan), reloading, recoil spread, and visual feedback.
 */
export class Weapon {
    constructor(scene, camera, weaponId = 'AR15') {
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

        // Visual: muzzle flash
        this.muzzleFlash = this._createMuzzleFlash();
        this.muzzleFlashTimer = 0;

        // Visual: bullet impacts pool
        this.impactPool = [];
        this.maxImpacts = 20;
        this._initImpactPool();

        // Gun mesh (simple low-poly representation)
        this.gunGroup = this._createGunMesh();
        this.camera.add(this.gunGroup);

        // Recoil visual (camera kick)
        this.recoilOffset = 0;
        this.recoilRecoverySpeed = 8;
    }

    _createGunMesh() {
        // Both weapons anchor stock rear at z ≈ -0.15 (shoulder), difference extends forward
        // All parts merged into a single geometry to minimize draw calls
        const geos = [];

        if (this.weaponId === 'SMG') {
            const stockGeo = new THREE.BoxGeometry(0.04, 0.05, 0.12);
            stockGeo.translate(0.25, -0.22, -0.09);
            geos.push(stockGeo);

            const bodyGeo = new THREE.BoxGeometry(0.06, 0.08, 0.30);
            bodyGeo.translate(0.25, -0.2, -0.30);
            geos.push(bodyGeo);

            const barrelGeo = new THREE.CylinderGeometry(0.013, 0.013, 0.18, 6);
            barrelGeo.rotateX(Math.PI / 2);
            barrelGeo.translate(0.25, -0.17, -0.54);
            geos.push(barrelGeo);

            const magGeo = new THREE.BoxGeometry(0.045, 0.17, 0.05);
            magGeo.rotateX(-0.15);
            magGeo.translate(0.25, -0.32, -0.28);
            geos.push(magGeo);
        } else {
            const stockGeo = new THREE.BoxGeometry(0.05, 0.06, 0.18);
            stockGeo.translate(0.25, -0.22, -0.06);
            geos.push(stockGeo);

            const bodyGeo = new THREE.BoxGeometry(0.06, 0.08, 0.55);
            bodyGeo.translate(0.25, -0.2, -0.425);
            geos.push(bodyGeo);

            const barrelGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.525, 6);
            barrelGeo.rotateX(Math.PI / 2);
            barrelGeo.translate(0.25, -0.17, -0.9625);
            geos.push(barrelGeo);

            const magGeo = new THREE.BoxGeometry(0.04, 0.15, 0.06);
            magGeo.rotateX(-0.15);
            magGeo.translate(0.25, -0.32, -0.40);
            geos.push(magGeo);
        }

        const merged = mergeGeometries(geos);
        for (const g of geos) g.dispose();

        const gun = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: 0x333333 }));
        const group = new THREE.Group();
        group.add(gun);
        return group;
    }

    _createMuzzleFlash() {
        const geo = new THREE.SphereGeometry(0.05, 4, 4);
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffaa00,
            transparent: true,
            opacity: 0.9,
        });
        const flash = new THREE.Mesh(geo, mat);
        flash.visible = false;
        flash.position.set(0.25, -0.17, this.weaponId === 'SMG' ? -0.63 : -1.225);
        this.camera.add(flash);
        return flash;
    }

    _initImpactPool() {
        const geo = new THREE.SphereGeometry(0.06, 4, 4);
        const mat = new THREE.MeshBasicMaterial({ color: 0xffff44, transparent: true });
        for (let i = 0; i < this.maxImpacts; i++) {
            const mesh = new THREE.Mesh(geo, mat.clone());
            mesh.visible = false;
            mesh.userData.life = 0;
            this.scene.add(mesh);
            this.impactPool.push(mesh);
        }
        this.impactIndex = 0;
    }

    /**
     * Fire the weapon. Returns hit info or null.
     * @param {THREE.Vector3} origin - Ray origin (camera position)
     * @param {THREE.Vector3} direction - Aim direction (camera forward)
     * @param {Array<THREE.Object3D>} targets - Objects that can be hit
     * @returns {object|null} { target, point, distance } or null
     */
    fire(origin, direction, targets = []) {
        if (this.isReloading || this.fireCooldown > 0 || this.currentAmmo <= 0) {
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

        // Increase spread (recoil)
        this.currentSpread = Math.min(this.maxSpread, this.currentSpread + this.spreadIncreasePerShot);

        // Visual recoil kick
        this.recoilOffset = 0.015;

        // Muzzle flash
        this.muzzleFlash.visible = true;
        this.muzzleFlash.scale.setScalar(0.5 + Math.random() * 1.0);
        this.muzzleFlashTimer = 0.04;

        // Hitscan raycast
        const raycaster = new THREE.Raycaster(origin, spreadDir, 0, this.maxRange);
        const intersections = raycaster.intersectObjects(targets, true);

        if (intersections.length > 0) {
            const hit = intersections[0];
            this._showImpact(hit.point);

            // Impact particles
            if (this.impactVFX) {
                const surfaceType = this._getSurfaceType(hit.object);
                const impactType = surfaceType === 'water' ? 'water'
                    : (surfaceType === 'rock' ? 'spark' : 'dirt');
                const worldNormal = this._getWorldNormal(hit);
                this.impactVFX.spawn(impactType, hit.point, worldNormal);
            }

            // Player tracer
            if (this.tracerSystem) {
                this.tracerSystem.fire(origin, spreadDir, hit.distance);
            }

            // Calculate damage with falloff
            let dmg = this.damage;
            if (hit.distance > this.falloffStart) {
                const t = Math.min((hit.distance - this.falloffStart) / (this.falloffEnd - this.falloffStart), 1);
                dmg = this.damage * (1 - t * (1 - this.falloffMinScale));
            }

            return {
                target: hit.object,
                point: hit.point,
                distance: hit.distance,
                damage: dmg,
            };
        }

        // No hit — tracer at max range
        if (this.tracerSystem) {
            this.tracerSystem.fire(origin, spreadDir, this.maxRange);
        }

        return null;
    }

    reload() {
        if (this.isReloading || this.currentAmmo === this.magazineSize) return;
        this.isReloading = true;
        this.reloadTimer = this.reloadTime;
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

    _showImpact(point) {
        const impact = this.impactPool[this.impactIndex];
        this.impactIndex = (this.impactIndex + 1) % this.maxImpacts;
        impact.position.copy(point);
        impact.visible = true;
        impact.material.opacity = 1.0;
        impact.userData.life = 0.5; // seconds
    }

    update(dt) {
        // Fire cooldown
        if (this.fireCooldown > 0) {
            this.fireCooldown -= dt;
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
        if (!this.triggerHeld) {
            this.currentSpread = Math.max(this.baseSpread, this.currentSpread - this.spreadRecoveryRate * dt);
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
        // Apply gun recoil animation
        if (this.gunGroup) {
            this.gunGroup.position.z = -this.recoilOffset;
        }

        // Impact pool fade
        for (const impact of this.impactPool) {
            if (impact.visible && impact.userData.life > 0) {
                impact.userData.life -= dt;
                impact.material.opacity = Math.max(0, impact.userData.life / 0.5);
                if (impact.userData.life <= 0) {
                    impact.visible = false;
                }
            }
        }

        // Auto-reload when empty
        if (this.currentAmmo <= 0 && !this.isReloading) {
            this.reload();
        }
    }
}
