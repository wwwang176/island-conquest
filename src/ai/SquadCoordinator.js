import * as THREE from 'three';

const _v = new THREE.Vector3();
const _formationPos = new THREE.Vector3();

/**
 * Coordinates a squad of AI controllers toward shared objectives.
 * One per squad (8 total across 2 teams).
 */
export class SquadCoordinator {
    constructor(name, controllers, teamIntel, flags, team, strategy = 'secure') {
        this.name = name;
        this.controllers = controllers; // array of AIController
        this.teamIntel = teamIntel;
        this.flags = flags;
        this.team = team;
        this.strategy = strategy; // 'push' = far enemy flags, 'secure' = nearest flags

        this.objective = null; // target flag
        this.evalTimer = 0;
        // Secure squads re-evaluate faster to respond to threats
        this.evalInterval = strategy === 'secure'
            ? 3 + Math.random() * 2    // 3-5s
            : 8 + Math.random() * 4;   // 8-12s
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
     * @param {AIController} controller
     * @param {object} [navGrid] - NavGrid for bounds validation
     */
    getDesiredPosition(controller, navGrid) {
        if (!this.objective) return null;

        const objPos = this.objective.position;

        // Direction: from team base toward objective (stable reference)
        const baseFlag = this.team === 'teamA'
            ? this.flags[0] : this.flags[this.flags.length - 1];
        _v.subVectors(objPos, baseFlag.position);
        _v.y = 0;
        const dist = _v.length();
        if (dist < 0.1) _v.set(0, 0, -1);
        else _v.normalize();

        // "Forward" = attack direction (base → objective)
        // Perpendicular (right)
        const perpX = _v.z;
        const perpZ = -_v.x;

        const role = controller.personality.name;
        let offsetForward = 0;
        let offsetSide = 0;

        switch (role) {
            case 'Rusher':
                offsetForward = 8;
                offsetSide = 0;
                break;
            case 'Flanker':
                offsetForward = 0;
                offsetSide = 12 * (controller.flankSide || 1);
                break;
            case 'Defender':
                offsetForward = -10;
                offsetSide = 0;
                break;
            case 'Sniper':
                offsetForward = -15;
                offsetSide = 8 * (controller.flankSide || 1);
                break;
            case 'Support':
                offsetForward = 2;
                offsetSide = 0;
                break;
            case 'Captain':
                offsetForward = 5;
                offsetSide = 0;
                break;
        }

        // Anchor to flag, not captain
        _formationPos.set(
            objPos.x + _v.x * offsetForward + perpX * offsetSide,
            0,
            objPos.z + _v.z * offsetForward + perpZ * offsetSide
        );

        // Validate against NavGrid — snap to walkable if out of bounds
        if (navGrid) {
            const g = navGrid.worldToGrid(_formationPos.x, _formationPos.z);
            if (!navGrid.isWalkable(g.col, g.row)) {
                const nearest = navGrid._findNearestWalkable(g.col, g.row);
                if (nearest) {
                    const w = navGrid.gridToWorld(nearest.col, nearest.row);
                    _formationPos.x = w.x;
                    _formationPos.z = w.z;
                } else {
                    return null; // no valid position
                }
            }
        }

        return _formationPos;
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

        const captainPos = captain.soldier.getPosition();

        if (this.strategy === 'push') {
            // ── Push: always rush the nearest non-owned flag ──
            this.objective = this._pickNearestNonOwned(captainPos);
        } else {
            // ── Secure: defend threatened flags, otherwise attack ──
            const threatened = this._findThreatenedFlag();
            if (threatened) {
                this.objective = threatened;
            } else {
                // No threats — attack nearest non-owned flag
                this.objective = this._pickNearestNonOwned(captainPos);
            }
        }
    }

    /**
     * Pick the nearest neutral or enemy flag to the given position.
     */
    _pickNearestNonOwned(fromPos) {
        let bestFlag = null;
        let bestDist = Infinity;
        for (const flag of this.flags) {
            if (flag.owner === this.team) continue;
            const d = fromPos.distanceTo(flag.position);
            if (d < bestDist) {
                bestDist = d;
                bestFlag = flag;
            }
        }
        // All flags owned — fall back to nearest owned (patrol)
        if (!bestFlag) {
            for (const flag of this.flags) {
                const d = fromPos.distanceTo(flag.position);
                if (d < bestDist) {
                    bestDist = d;
                    bestFlag = flag;
                }
            }
        }
        return bestFlag;
    }

    /**
     * Find an owned flag that is threatened by nearby enemies.
     * Returns the most threatened flag, or null if all are safe.
     */
    _findThreatenedFlag() {
        let worstFlag = null;
        let worstThreat = 0;

        for (const flag of this.flags) {
            if (flag.owner !== this.team) continue;

            // Count known enemies within 35m of this flag
            const enemies = this.teamIntel.getKnownEnemies({
                minConfidence: 0.4,
                maxDist: 35,
                fromPos: flag.position,
            });
            if (enemies.length === 0) continue;

            // Flag is being captured by enemy → extra urgency
            const contested = flag.capturingTeam && flag.capturingTeam !== this.team;
            const threat = enemies.length + (contested ? 3 : 0);

            if (threat > worstThreat) {
                worstThreat = threat;
                worstFlag = flag;
            }
        }

        return worstFlag;
    }

    /**
     * Main update loop.
     */
    update(dt) {
        // Periodic objective evaluation
        this.evalTimer += dt;
        if (this.evalTimer >= this.evalInterval) {
            this.evalTimer = 0;
            this.evalInterval = this.strategy === 'secure'
                ? 3 + Math.random() * 2
                : 8 + Math.random() * 4;
            this._evaluateObjective();
        }

        // Initial objective
        if (!this.objective) {
            this._evaluateObjective();
        }
    }
}
