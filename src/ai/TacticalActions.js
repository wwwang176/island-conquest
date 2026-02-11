import * as THREE from 'three';

const _v = new THREE.Vector3();

/**
 * Pure-function helpers for tactical AI decisions.
 */

/**
 * Find a flanking position ~90° offset from the enemy, snapped to nearby cover.
 * @param {THREE.Vector3} myPos
 * @param {THREE.Vector3} enemyPos
 * @param {CoverSystem|null} coverSystem
 * @param {number} side - 1 for right flank, -1 for left flank
 * @param {object} [navGrid] - NavGrid for walkability validation
 * @returns {THREE.Vector3}
 */
export function findFlankPosition(myPos, enemyPos, coverSystem, side = 1, navGrid = null) {
    // Vector from enemy to me
    _v.subVectors(myPos, enemyPos);
    _v.y = 0;
    const dist = Math.max(_v.length(), 1);
    _v.normalize();

    // 90° rotation for flank offset
    const perpX = _v.z * side;
    const perpZ = -_v.x * side;

    // Flank position: 18m to the side of enemy, at similar distance
    const flankPos = new THREE.Vector3(
        enemyPos.x + perpX * 18 + _v.x * (dist * 0.5),
        myPos.y,
        enemyPos.z + perpZ * 18 + _v.z * (dist * 0.5)
    );

    // Try to snap to nearby cover if available
    if (coverSystem) {
        const threatDir = new THREE.Vector3().subVectors(enemyPos, flankPos).normalize();
        const covers = coverSystem.findCover(flankPos, threatDir, 10, 1);
        if (covers.length > 0) {
            flankPos.copy(covers[0].cover.position);
        }
    }

    // Validate against NavGrid — snap to walkable if off-island or in water
    if (navGrid) {
        const g = navGrid.worldToGrid(flankPos.x, flankPos.z);
        if (!navGrid.isWalkable(g.col, g.row)) {
            const nearest = navGrid._findNearestWalkable(g.col, g.row);
            if (nearest) {
                const w = navGrid.gridToWorld(nearest.col, nearest.row);
                flankPos.x = w.x;
                flankPos.z = w.z;
            } else {
                // No walkable cell — fall back to own position
                flankPos.copy(myPos);
            }
        }
    }

    return flankPos;
}

/**
 * Predict enemy position using last known position + velocity × lead time.
 * @param {object} contact - TeamIntel contact { lastSeenPos, lastSeenVelocity }
 * @returns {THREE.Vector3}
 */
export function computePreAimPoint(contact) {
    const predicted = contact.lastSeenPos.clone();
    predicted.x += contact.lastSeenVelocity.x * 0.5;
    predicted.z += contact.lastSeenVelocity.z * 0.5;
    predicted.y += 1.2; // aim at chest height
    return predicted;
}

/**
 * Compute suppression target: last known position + random scatter.
 * @param {object} contact - TeamIntel contact
 * @returns {THREE.Vector3}
 */
export function computeSuppressionTarget(contact) {
    const target = contact.lastSeenPos.clone();
    target.x += (Math.random() - 0.5) * 3;
    target.z += (Math.random() - 0.5) * 3;
    target.y += 1.0 + Math.random() * 0.5;
    return target;
}
