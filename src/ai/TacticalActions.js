import * as THREE from 'three';

const _v = new THREE.Vector3();
const _threatDir = new THREE.Vector3();

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
 * @param {THREE.Vector3} out - output vector (mutated in place)
 * @returns {THREE.Vector3} out
 */
export function findFlankPosition(myPos, enemyPos, coverSystem, side = 1, navGrid = null, out) {
    // Vector from enemy to me
    _v.subVectors(myPos, enemyPos);
    _v.y = 0;
    const dist = Math.max(_v.length(), 1);
    _v.normalize();

    // 90° rotation for flank offset
    const perpX = _v.z * side;
    const perpZ = -_v.x * side;

    // Flank position: 18m to the side of enemy, at similar distance
    out.set(
        enemyPos.x + perpX * 18 + _v.x * (dist * 0.5),
        myPos.y,
        enemyPos.z + perpZ * 18 + _v.z * (dist * 0.5)
    );

    // Try to snap to nearby cover if available
    if (coverSystem) {
        _threatDir.subVectors(enemyPos, out).normalize();
        const covers = coverSystem.findCover(out, _threatDir, 10, 1);
        if (covers.length > 0) {
            out.copy(covers[0].cover.position);
        }
    }

    // Validate against NavGrid — snap to walkable if off-island or in water
    if (navGrid) {
        const g = navGrid.worldToGrid(out.x, out.z);
        if (!navGrid.isWalkable(g.col, g.row)) {
            const nearest = navGrid._findNearestWalkable(g.col, g.row);
            if (nearest) {
                const w = navGrid.gridToWorld(nearest.col, nearest.row);
                out.x = w.x;
                out.z = w.z;
            } else {
                // No walkable cell — fall back to own position
                out.copy(myPos);
            }
        }
    }

    return out;
}

/**
 * Predict enemy position using last known position + velocity × lead time.
 * @param {object} contact - TeamIntel contact { lastSeenPos, lastSeenVelocity }
 * @param {THREE.Vector3} out - output vector (mutated in place)
 * @returns {THREE.Vector3} out
 */
export function computePreAimPoint(contact, out) {
    out.copy(contact.lastSeenPos);
    out.x += contact.lastSeenVelocity.x * 0.5;
    out.z += contact.lastSeenVelocity.z * 0.5;
    out.y += 1.2; // aim at chest height
    return out;
}

/**
 * Find the ridgeline aim point between eyePos and targetPos.
 * Scans terrain along the XZ line and returns the point with the highest
 * elevation angle from the eye — i.e. the hilltop where an enemy would appear.
 * If no terrain blocks the view, returns the target position + bodyHeight.
 * @param {THREE.Vector3} eyePos - COM eye position (world)
 * @param {THREE.Vector3} targetPos - contact last seen position (world)
 * @param {Function} getHeightAt - terrain height lookup (x, z) → y
 * @param {THREE.Vector3} out - output vector (mutated in place)
 * @returns {THREE.Vector3} out
 */
export function findRidgelineAimPoint(eyePos, targetPos, getHeightAt, out) {
    const dx = targetPos.x - eyePos.x;
    const dz = targetPos.z - eyePos.z;
    const hDist = Math.sqrt(dx * dx + dz * dz);

    if (hDist < 3) {
        // Too close — just aim at target chest height
        out.copy(targetPos);
        out.y += 1.2;
        return out;
    }

    const step = 1; // sample every 1m
    const steps = Math.min(Math.floor(hDist / step), 100);
    const invDist = 1 / hDist;
    const dirX = dx * invDist;
    const dirZ = dz * invDist;

    // Find terrain point that protrudes most above the eye→target line of sight
    const eyeY = eyePos.y;
    const targetY = targetPos.y + 1.2;
    let bestExcess = 0; // how far terrain pokes above line of sight
    let bestX = 0;
    let bestZ = 0;
    let bestH = 0;

    for (let i = 1; i <= steps; i++) {
        const t = i * step;
        const sx = eyePos.x + dirX * t;
        const sz = eyePos.z + dirZ * t;
        const h = getHeightAt(sx, sz);
        // Line of sight height at this distance
        const losY = eyeY + (targetY - eyeY) * (t / hDist);
        const excess = h - losY;
        if (excess > bestExcess) {
            bestExcess = excess;
            bestX = sx;
            bestZ = sz;
            bestH = h;
        }
    }

    if (bestExcess > 0.3) {
        // Ridge blocks line of sight — aim at terrain crest (no body height)
        out.set(bestX, bestH, bestZ);
    } else {
        // Clear line of sight — aim at target chest height
        out.copy(targetPos);
        out.y += 1.2;
    }

    return out;
}

/**
 * Compute suppression target: last known position + random scatter.
 * @param {object} contact - TeamIntel contact
 * @param {THREE.Vector3} out - output vector (mutated in place)
 * @returns {THREE.Vector3} out
 */
export function computeSuppressionTarget(contact, out) {
    out.copy(contact.lastSeenPos);
    out.x += (Math.random() - 0.5) * 3;
    out.z += (Math.random() - 0.5) * 3;
    out.y += 1.0 + Math.random() * 0.5;
    return out;
}
