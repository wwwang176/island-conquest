import * as THREE from 'three';

const _v = new THREE.Vector3();

/**
 * Coordinates a squad of AI controllers toward shared objectives.
 * One per squad (8 total across 2 teams).
 */
export class SquadCoordinator {
    constructor(name, controllers, teamIntel, flags, team) {
        this.name = name;
        this.controllers = controllers; // array of AIController
        this.teamIntel = teamIntel;
        this.flags = flags;
        this.team = team;

        this.objective = null; // target flag
        this.isDeepFlank = false; // deep-behind-enemy-lines mode
        this.evalTimer = 0;
        this.evalInterval = 8 + Math.random() * 4; // 8-12s
    }

    /**
     * Get the captain (first alive member).
     */
    getCaptain() {
        for (const ctrl of this.controllers) {
            if (ctrl.soldier.alive) return ctrl;
        }
        return null;
    }

    /**
     * Get squad's current objective flag.
     */
    getSquadObjective() {
        return this.objective;
    }

    /**
     * Get formation position for a specific controller relative to the squad objective.
     */
    getDesiredPosition(controller) {
        const captain = this.getCaptain();
        if (!captain || !this.objective) return null;

        const captainPos = captain.soldier.getPosition();
        const objPos = this.objective.position;

        // Direction from captain toward objective
        _v.subVectors(objPos, captainPos);
        _v.y = 0;
        const dist = _v.length();
        if (dist < 0.1) _v.set(0, 0, -1);
        else _v.normalize();

        // Perpendicular direction (right)
        const perpX = _v.z;
        const perpZ = -_v.x;

        const role = controller.personality.name;
        let offsetForward = 0;
        let offsetSide = 0;

        const deepFlank = this.isDeepFlank;

        switch (role) {
            case 'Rusher':
                offsetForward = deepFlank ? 20 : 8;
                offsetSide = 0;
                break;
            case 'Flanker':
                offsetForward = 0;
                offsetSide = (deepFlank ? 24 : 12) * (controller.flankSide || 1);
                break;
            case 'Defender':
                offsetForward = -5;
                offsetSide = 0;
                break;
            case 'Sniper':
                offsetForward = -15;
                offsetSide = 6 * (controller.flankSide || 1);
                break;
            case 'Support':
                offsetForward = 2;
                offsetSide = 0;
                break;
            case 'Captain':
                offsetForward = 3;
                offsetSide = 0;
                break;
        }

        return new THREE.Vector3(
            captainPos.x + _v.x * offsetForward + perpX * offsetSide,
            captainPos.y,
            captainPos.z + _v.z * offsetForward + perpZ * offsetSide
        );
    }

    /**
     * Request suppression fire on a contact.
     * Captain and Support will suppress while Flanker repositions.
     */
    requestSuppression(contact) {
        for (const ctrl of this.controllers) {
            if (!ctrl.soldier.alive) continue;
            const role = ctrl.personality.name;
            if (role === 'Captain' || role === 'Support' || role === 'Defender') {
                ctrl.suppressionTarget = contact;
                ctrl.suppressionTimer = ctrl.personality.suppressDuration || 3;
            }
        }
    }

    /**
     * Evaluate and pick best objective flag.
     */
    _evaluateObjective() {
        const captain = this.getCaptain();
        if (!captain) return;

        // ── Deep flank check: when team is far ahead, flankers/rushers infiltrate ──
        this.isDeepFlank = false;
        const hasFlankerOrRusher = this.controllers.some(c => {
            const n = c.personality.name;
            return n === 'Flanker' || n === 'Rusher';
        });

        if (hasFlankerOrRusher) {
            let ownedByUs = 0, ownedByEnemy = 0;
            for (const f of this.flags) {
                if (f.owner === this.team) ownedByUs++;
                else if (f.owner !== null) ownedByEnemy++;
            }
            const teamAdvantage = ownedByUs - ownedByEnemy;

            if (teamAdvantage >= 1 && Math.random() < 0.45) {
                // Pick the deepest enemy flag (farthest from our base)
                const baseFlag = this.team === 'teamA'
                    ? this.flags[0] : this.flags[this.flags.length - 1];
                let deepest = null;
                let deepestDist = -1;
                for (const f of this.flags) {
                    if (f.owner === this.team) continue; // skip our own flags
                    const d = f.position.distanceTo(baseFlag.position);
                    if (d > deepestDist) {
                        deepestDist = d;
                        deepest = f;
                    }
                }
                if (deepest) {
                    this.objective = deepest;
                    this.isDeepFlank = true;
                    return;
                }
            }
        }

        // ── Normal objective evaluation ──
        const captainPos = captain.soldier.getPosition();
        let bestScore = -Infinity;
        let bestFlag = null;

        for (const flag of this.flags) {
            let score = 0;

            // Unowned/enemy flags are more valuable to attack-oriented squads
            if (flag.owner !== this.team) {
                score += captain.personality.attack * 10;
            } else {
                score += captain.personality.defend * 6;
            }

            // Distance penalty
            const dist = captainPos.distanceTo(flag.position);
            score -= dist * 0.04;

            // Intel: penalize flags near many known threats
            const threats = this.teamIntel.getKnownEnemies({
                minConfidence: 0.5,
                maxDist: 40,
                fromPos: flag.position,
            });
            score -= threats.length * 2;

            // Small randomization to prevent all squads picking same flag
            score += (Math.random() - 0.5) * 4;

            if (score > bestScore) {
                bestScore = score;
                bestFlag = flag;
            }
        }

        this.objective = bestFlag;
    }

    /**
     * Main update loop.
     */
    update(dt) {
        // Periodic objective evaluation
        this.evalTimer += dt;
        if (this.evalTimer >= this.evalInterval) {
            this.evalTimer = 0;
            this.evalInterval = 8 + Math.random() * 4;
            this._evaluateObjective();
        }

        // Initial objective
        if (!this.objective) {
            this._evaluateObjective();
        }
    }
}
