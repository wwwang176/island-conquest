import * as CANNON from 'cannon-es';

/**
 * Wraps Cannon.js physics world.
 * Provides gravity, ground plane, and step updates.
 */
export class PhysicsWorld {
    constructor() {
        this.world = new CANNON.World();
        this.world.gravity.set(0, -9.82, 0);
        this.world.broadphase = new CANNON.SAPBroadphase(this.world);
        this.world.allowSleep = true;

        // Default contact material
        this.defaultMaterial = new CANNON.Material('default');
        const defaultContact = new CANNON.ContactMaterial(
            this.defaultMaterial, this.defaultMaterial, {
                friction: 0.4,
                restitution: 0.1,
            }
        );
        this.world.addContactMaterial(defaultContact);
        this.world.defaultContactMaterial = defaultContact;
    }

    addBody(body) {
        this.world.addBody(body);
    }

    removeBody(body) {
        this.world.removeBody(body);
    }

    createGroundPlane() {
        const groundShape = new CANNON.Plane();
        const groundBody = new CANNON.Body({
            mass: 0,
            material: this.defaultMaterial,
        });
        groundBody.addShape(groundShape);
        groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
        this.world.addBody(groundBody);
        return groundBody;
    }

    step(dt) {
        this.world.step(1 / 60, dt, 3);
    }
}
