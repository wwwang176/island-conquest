import * as THREE from 'three';

/**
 * Registry of all cover positions on the map.
 * AI uses this to find nearby cover when under threat.
 */
export class CoverSystem {
    constructor() {
        // Array of cover spots
        // Each: { position: Vector3, normal: Vector3, coverLevel: 0~1, slots: number, occupiedBy: Set }
        this.covers = [];
    }

    /**
     * Register a cover position.
     * @param {THREE.Vector3} position - World position of cover spot
     * @param {THREE.Vector3} normal - Direction the cover faces (away from the protected side)
     * @param {number} coverLevel - 0 (no cover) to 1 (full cover)
     * @param {number} slots - How many soldiers can use this cover simultaneously
     */
    register(position, normal, coverLevel, slots = 2) {
        this.covers.push({
            position: position.clone(),
            normal: normal.clone().normalize(),
            coverLevel,
            slots,
            occupiedBy: new Set(),
        });
    }

    /**
     * Find best cover spots near a position, facing away from a threat.
     * @param {THREE.Vector3} pos - Seeker's current position
     * @param {THREE.Vector3} threatDir - Direction threat is coming from (normalized)
     * @param {number} maxDist - Maximum search radius
     * @param {number} count - Number of results to return
     * @returns {Array} Sorted cover spots (best first)
     */
    findCover(pos, threatDir, maxDist = 30, count = 5) {
        const candidates = [];

        for (const cover of this.covers) {
            const dist = pos.distanceTo(cover.position);
            if (dist > maxDist) continue;
            if (cover.occupiedBy.size >= cover.slots) continue;

            // Cover should be between seeker and threat (dot product check)
            const toCover = new THREE.Vector3().subVectors(cover.position, pos).normalize();

            // How well does cover face the threat? (normal should oppose threat direction)
            const facingScore = Math.max(0, -cover.normal.dot(threatDir));

            // Direction correctness: cover should be roughly towards or perpendicular to threat
            const dirScore = Math.max(0, toCover.dot(threatDir) * 0.3 + 0.7);

            const score =
                cover.coverLevel * 0.4 +
                (1 - dist / maxDist) * 0.3 +
                facingScore * 0.2 +
                dirScore * 0.1;

            candidates.push({ cover, score, dist });
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates.slice(0, count);
    }

    /**
     * Occupy a cover slot.
     */
    occupy(cover, soldierId) {
        cover.occupiedBy.add(soldierId);
    }

    /**
     * Release a cover slot.
     */
    release(cover, soldierId) {
        cover.occupiedBy.delete(soldierId);
    }
}
