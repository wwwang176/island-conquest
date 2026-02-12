import * as THREE from 'three';

/**
 * Shared intelligence board for one team.
 * Tracks enemy contacts with status decay: VISIBLE → LOST → SUSPECTED → CLEARED.
 */

const ContactStatus = {
    VISIBLE:   'visible',
    LOST:      'lost',
    SUSPECTED: 'suspected',
};

const LOST_TIMEOUT      = 3;   // seconds before VISIBLE → LOST
const SUSPECTED_TIMEOUT = 15;  // seconds before contact is removed
const DECAY_START        = 8;  // seconds when confidence starts decaying

export class TeamIntel {
    constructor(team) {
        this.team = team;
        /** @type {Map<object, EnemyContact>} keyed by enemy reference */
        this.contacts = new Map();
        this._resultsBuf = [];
    }

    /**
     * Report a direct visual sighting of an enemy.
     */
    reportSighting(enemy, position, velocity) {
        let contact = this.contacts.get(enemy);
        if (!contact) {
            contact = {
                enemy,
                status: ContactStatus.VISIBLE,
                lastSeenPos: position.clone(),
                lastSeenTime: 0,
                lastSeenVelocity: new THREE.Vector3(),
                confidence: 1.0,
            };
            this.contacts.set(enemy, contact);
        }
        contact.status = ContactStatus.VISIBLE;
        contact.lastSeenPos.copy(position);
        contact.lastSeenTime = 0;
        contact.confidence = 1.0;
        if (velocity) {
            contact.lastSeenVelocity.set(velocity.x, velocity.y, velocity.z);
        }
    }

    /**
     * Report that an enemy was lost (no longer visible).
     */
    reportLost(enemy) {
        const contact = this.contacts.get(enemy);
        if (contact && contact.status === ContactStatus.VISIBLE) {
            contact.status = ContactStatus.LOST;
        }
    }

    /**
     * Get all known enemy contacts, optionally filtered.
     * @param {object} [filter] - { minConfidence, status, maxDist, fromPos }
     */
    getKnownEnemies(filter) {
        const results = this._resultsBuf;
        results.length = 0;
        for (const contact of this.contacts.values()) {
            if (filter) {
                if (filter.minConfidence !== undefined && contact.confidence < filter.minConfidence) continue;
                if (filter.status && contact.status !== filter.status) continue;
                if (filter.maxDist !== undefined && filter.fromPos) {
                    if (contact.lastSeenPos.distanceTo(filter.fromPos) > filter.maxDist) continue;
                }
            }
            results.push(contact);
        }
        return results;
    }

    /**
     * Get nearest threat to a position.
     */
    getNearestThreat(pos) {
        let nearest = null;
        let nearestDist = Infinity;
        for (const contact of this.contacts.values()) {
            if (contact.confidence < 0.3) continue;
            const d = contact.lastSeenPos.distanceTo(pos);
            if (d < nearestDist) {
                nearestDist = d;
                nearest = contact;
            }
        }
        return nearest;
    }

    /**
     * Get existing contact for a specific enemy.
     */
    getContactFor(enemy) {
        return this.contacts.get(enemy) || null;
    }

    /**
     * Update decay: advance timers, transition statuses, prune old contacts.
     */
    update(dt) {
        for (const [enemy, contact] of this.contacts) {
            // Don't age visible contacts
            if (contact.status === ContactStatus.VISIBLE) continue;

            contact.lastSeenTime += dt;

            // LOST → start confidence decay after DECAY_START
            if (contact.status === ContactStatus.LOST) {
                if (contact.lastSeenTime >= LOST_TIMEOUT) {
                    contact.status = ContactStatus.SUSPECTED;
                }
                // confidence stays at 1.0 during LOST phase
            }

            // SUSPECTED → decay confidence
            if (contact.status === ContactStatus.SUSPECTED) {
                const decayProgress = (contact.lastSeenTime - DECAY_START) / (SUSPECTED_TIMEOUT - DECAY_START);
                if (decayProgress > 0) {
                    contact.confidence = Math.max(0, 1.0 - decayProgress);
                }
            }

            // Remove fully decayed contacts
            if (contact.lastSeenTime >= SUSPECTED_TIMEOUT) {
                this.contacts.delete(enemy);
            }
        }
    }
}
