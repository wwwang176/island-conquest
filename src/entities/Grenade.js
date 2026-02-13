import * as THREE from 'three';
import * as CANNON from 'cannon-es';

/**
 * A single grenade entity with mesh, physics body, and fuse timer.
 */
export class Grenade {
    constructor(scene, physicsWorld, origin, velocity, fuseTime, throwerTeam, throwerName = '') {
        this.scene = scene;
        this.physics = physicsWorld;
        this.throwerTeam = throwerTeam;
        this.throwerName = throwerName;
        this.fuseTime = fuseTime;
        this.alive = true;

        // Visual — small dark sphere
        const geo = new THREE.SphereGeometry(0.08, 8, 6);
        const mat = new THREE.MeshLambertMaterial({ color: 0x333333 });
        this.mesh = new THREE.Mesh(geo, mat);
        this.mesh.castShadow = false;
        scene.add(this.mesh);

        // Physics
        this.body = new CANNON.Body({
            mass: 0.4,
            material: physicsWorld.defaultMaterial,
            linearDamping: 0.0,
            angularDamping: 0.4,
        });
        this.body.addShape(new CANNON.Sphere(0.08));
        this.body.position.set(origin.x, origin.y, origin.z);
        this.body.velocity.set(velocity.x, velocity.y, velocity.z);
        physicsWorld.addBody(this.body);
    }

    /**
     * Update fuse timer and sync mesh.
     * @returns {{ position: THREE.Vector3 } | null} — non-null when exploding
     */
    update(dt) {
        if (!this.alive) return null;

        this.fuseTime -= dt;

        // Sync mesh to physics
        this.mesh.position.set(
            this.body.position.x,
            this.body.position.y,
            this.body.position.z
        );
        this.mesh.quaternion.set(
            this.body.quaternion.x,
            this.body.quaternion.y,
            this.body.quaternion.z,
            this.body.quaternion.w
        );

        if (this.fuseTime <= 0) {
            const pos = new THREE.Vector3(
                this.body.position.x,
                this.body.position.y,
                this.body.position.z
            );
            this.dispose();
            return { position: pos };
        }

        return null;
    }

    dispose() {
        this.alive = false;
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this.physics.removeBody(this.body);
    }
}
