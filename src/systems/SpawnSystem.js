import * as THREE from 'three';

/**
 * Manages respawn logic.
 * Players/AI can respawn at:
 *   1. A friendly teammate (if teammate hasn't been in combat for 5s)
 *   2. A team-owned flag (10~15m away randomly)
 */
export class SpawnSystem {
    constructor(flags) {
        this.flags = flags;
        this.safeCombatTime = 5; // teammate must be out of combat this long
    }

    /**
     * Get available spawn points for a team.
     * @param {string} team - 'teamA' or 'teamB'
     * @param {Array<Soldier>} teammates - Living teammates
     * @param {Function} getHeightAt - Function to query terrain height
     * @returns {Array<{type: string, position: THREE.Vector3, label: string}>}
     */
    getSpawnPoints(team, teammates, getHeightAt) {
        const points = [];

        // Flag spawn points
        for (const flag of this.flags) {
            if (flag.owner === team) {
                const angle = Math.random() * Math.PI * 2;
                const dist = 10 + Math.random() * 5;
                const x = flag.position.x + Math.cos(angle) * dist;
                const z = flag.position.z + Math.sin(angle) * dist;
                const y = getHeightAt ? getHeightAt(x, z) : flag.position.y;
                points.push({
                    type: 'flag',
                    position: new THREE.Vector3(x, Math.max(y, 1), z),
                    label: `Flag ${flag.name}`,
                });
            }
        }

        // Teammate spawn points
        for (const mate of teammates) {
            if (mate.alive && mate.timeSinceLastDamage >= this.safeCombatTime) {
                const angle = Math.random() * Math.PI * 2;
                const offset = new THREE.Vector3(Math.cos(angle) * 3, 0, Math.sin(angle) * 3);
                const pos = mate.getPosition().add(offset);
                if (getHeightAt) pos.y = getHeightAt(pos.x, pos.z) + 1;
                points.push({
                    type: 'teammate',
                    position: pos,
                    label: `Teammate ${mate.id}`,
                });
            }
        }

        // Fallback: team base spawn (first/last flag area even if not captured)
        if (points.length === 0) {
            const baseFlag = team === 'teamA' ? this.flags[0] : this.flags[this.flags.length - 1];
            const angle = Math.random() * Math.PI * 2;
            const dist = 10 + Math.random() * 5;
            const x = baseFlag.position.x + Math.cos(angle) * dist;
            const z = baseFlag.position.z + Math.sin(angle) * dist;
            const y = getHeightAt ? getHeightAt(x, z) : baseFlag.position.y;
            points.push({
                type: 'base',
                position: new THREE.Vector3(x, Math.max(y, 1), z),
                label: 'Base',
            });
        }

        return points;
    }
}
