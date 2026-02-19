/**
 * Shared capsule physics body helpers for Soldier and Player.
 * Capsule = two spheres (top/bottom) + one cylinder between them.
 */
import * as CANNON from 'cannon-es';

/**
 * Build a capsule-shaped CANNON.Body.
 * @param {CANNON.Material|null} material - Physics material
 * @param {number} radius - Capsule radius
 * @param {number} height - Total capsule height (between sphere centers + diameter)
 * @param {boolean} kinematic - Whether body is kinematic
 * @param {number} mass - Body mass (ignored if kinematic)
 * @param {number} group - Collision filter group
 * @returns {CANNON.Body}
 */
export function createCapsuleBody(material, radius, height, kinematic, mass, group) {
    const body = new CANNON.Body({
        mass: kinematic ? 0 : mass,
        type: kinematic ? CANNON.Body.KINEMATIC : CANNON.Body.DYNAMIC,
        material: material,
        linearDamping: 0.9,
        angularDamping: 1.0,
        fixedRotation: true,
        collisionResponse: !kinematic,
        collisionFilterGroup: group,
    });
    addCapsuleShapes(body, radius, height);
    return body;
}

/**
 * Add capsule collision shapes (two spheres + one cylinder) to an existing body.
 * @param {CANNON.Body} body
 * @param {number} radius
 * @param {number} height - Total capsule height (cameraHeight)
 */
export function addCapsuleShapes(body, radius, height) {
    body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0, radius, 0));
    body.addShape(new CANNON.Sphere(radius), new CANNON.Vec3(0, height - radius, 0));
    body.addShape(
        new CANNON.Cylinder(radius, radius, height - 2 * radius, 8),
        new CANNON.Vec3(0, height / 2, 0)
    );
}

/**
 * Remove all shapes from body and re-add capsule shapes.
 * Used during respawn to restore collision shape from ragdoll.
 * @param {CANNON.Body} body
 * @param {number} radius
 * @param {number} height
 */
export function resetCapsuleShapes(body, radius, height) {
    while (body.shapes.length > 0) {
        body.removeShape(body.shapes[0]);
    }
    addCapsuleShapes(body, radius, height);
}
