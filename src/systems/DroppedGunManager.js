import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Soldier } from '../entities/Soldier.js';

const WATER_Y = -0.3;
const _splashPos = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Manages dropped guns that fly off soldiers/player on death.
 * Each dropped gun has a cloned mesh + physics body, cleaned up after a timeout.
 */
export class DroppedGunManager {
    constructor(scene, physicsWorld, impactVFX) {
        this.scene = scene;
        this.physics = physicsWorld;
        this.impactVFX = impactVFX;
        this.guns = [];
    }

    /**
     * Spawn a dropped gun from a dying soldier or player.
     * @param {THREE.Mesh} gunMesh — the soldier's gun mesh to clone
     * @param {THREE.Vector3} worldPos — world position of the gun
     * @param {THREE.Quaternion} worldQuat — world rotation of the gun
     * @param {THREE.Vector3} velocity — inherited velocity from the dying entity
     * @param {THREE.Vector3} [impulseDir] — direction away from attacker (for launch)
     */
    spawn(gunMesh, worldPos, worldQuat, velocity, impulseDir) {
        // Clone mesh
        const clone = gunMesh.clone();
        clone.material = gunMesh.material.clone();
        this.scene.add(clone);
        clone.position.copy(worldPos);
        clone.quaternion.copy(worldQuat);

        // Measure bounding box for physics shape
        const box = new THREE.Box3().setFromObject(clone);
        const size = new THREE.Vector3();
        box.getSize(size);
        const hx = Math.max(size.x, 0.05) / 2;
        const hy = Math.max(size.y, 0.05) / 2;
        const hz = Math.max(size.z, 0.05) / 2;

        // Physics body
        const body = new CANNON.Body({
            mass: 2,
            material: this.physics.defaultMaterial,
            linearDamping: 0.3,
            angularDamping: 0.3,
        });
        body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)));
        body.position.set(worldPos.x, worldPos.y, worldPos.z);
        body.quaternion.set(worldQuat.x, worldQuat.y, worldQuat.z, worldQuat.w);

        // Inherit velocity
        body.velocity.set(velocity.x, velocity.y, velocity.z);

        // Launch impulse — away from attacker + upward
        if (impulseDir) {
            body.applyImpulse(
                new CANNON.Vec3(
                    impulseDir.x * 4 + (Math.random() - 0.5) * 3,
                    3 + Math.random() * 2,
                    impulseDir.z * 4 + (Math.random() - 0.5) * 3
                )
            );
        } else {
            // Random toss
            body.applyImpulse(
                new CANNON.Vec3(
                    (Math.random() - 0.5) * 4,
                    3 + Math.random() * 2,
                    (Math.random() - 0.5) * 4
                )
            );
        }

        // Random spin
        body.angularVelocity.set(
            (Math.random() - 0.5) * 10,
            (Math.random() - 0.5) * 10,
            (Math.random() - 0.5) * 10
        );

        this.physics.addBody(body);

        this.guns.push({
            mesh: clone,
            body,
            life: 8, // disappear after 8 seconds
            waterSplashed: false,
        });
    }

    /**
     * Spawn a dropped gun from a weapon ID (for player death).
     */
    spawnFromWeaponId(weaponId, worldPos, velocity, impulseDir) {
        const mesh = DroppedGunManager.buildGunMesh(weaponId);
        const quat = new THREE.Quaternion();
        this.spawn(mesh, worldPos, quat, velocity, impulseDir);
        // The spawn() cloned it and added it, but mesh was not added to scene
        // — actually spawn() clones, so we need to dispose this temp mesh
        mesh.geometry.dispose();
        mesh.material.dispose();
    }

    static buildGunMesh(weaponId) {
        return Soldier.buildGunMesh(weaponId);
    }

    update(dt) {
        for (let i = this.guns.length - 1; i >= 0; i--) {
            const gun = this.guns[i];
            gun.life -= dt;

            // Sync mesh to physics
            gun.mesh.position.set(gun.body.position.x, gun.body.position.y, gun.body.position.z);
            gun.mesh.quaternion.set(
                gun.body.quaternion.x,
                gun.body.quaternion.y,
                gun.body.quaternion.z,
                gun.body.quaternion.w
            );

            // Water splash
            if (!gun.waterSplashed && gun.body.position.y <= WATER_Y && this.impactVFX) {
                gun.waterSplashed = true;
                _splashPos.set(gun.body.position.x, WATER_Y, gun.body.position.z);
                this.impactVFX.spawn('water', _splashPos, _up);
            }

            // Fade out in last 1.5 seconds
            if (gun.life <= 1.5) {
                gun.mesh.material.transparent = true;
                gun.mesh.material.opacity = Math.max(0, gun.life / 1.5);
            }

            // Remove when expired
            if (gun.life <= 0) {
                this.scene.remove(gun.mesh);
                gun.mesh.geometry.dispose();
                gun.mesh.material.dispose();
                this.physics.removeBody(gun.body);
                this.guns.splice(i, 1);
            }
        }
    }
}
