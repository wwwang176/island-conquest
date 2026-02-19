import * as THREE from 'three';

/**
 * Shared intelligence board for one team.
 * Tracks enemy contacts with status decay: VISIBLE → LOST → SUSPECTED → CLEARED.
 */

// ── Shared sprite texture (created once) ──
let _sharedDotTexture = null;
function getDotTexture() {
    if (_sharedDotTexture) return _sharedDotTexture;
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    _sharedDotTexture = new THREE.CanvasTexture(canvas);
    return _sharedDotTexture;
}

const STATUS_COLORS = {
    visible:   new THREE.Color(0xff3333),
    lost:      new THREE.Color(0xff8800),
    suspected: new THREE.Color(0x888888),
};

const POOL_SIZE = 24;

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
    reportSighting(enemy, position, velocity, inVehicle = false) {
        let contact = this.contacts.get(enemy);
        if (!contact) {
            contact = {
                enemy,
                status: ContactStatus.VISIBLE,
                lastSeenPos: position.clone(),
                lastSeenTime: 0,
                lastSeenVelocity: new THREE.Vector3(),
                confidence: 1.0,
                inVehicle: false,
            };
            this.contacts.set(enemy, contact);
        }
        contact.status = ContactStatus.VISIBLE;
        contact.lastSeenPos.copy(position);
        contact.lastSeenTime = 0;
        contact.confidence = 1.0;
        contact.inVehicle = inVehicle;
        if (velocity) {
            contact.lastSeenVelocity.set(velocity.x, velocity.y, velocity.z);
        }
    }

    /**
     * Report that an enemy was lost (no longer visible).
     */
    reportLost(enemy) {
        const contact = this.contacts.get(enemy);
        if (!contact || contact.status !== ContactStatus.VISIBLE) return;
        if (contact.inVehicle) {
            this.contacts.delete(enemy);   // vehicle moves too fast, lastSeenPos is stale
        } else {
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
            // Remove contacts for dead enemies immediately
            if (!enemy.alive) {
                this.contacts.delete(enemy);
                continue;
            }

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

    // ───── 3D Visualization ─────

    setVisualization(scene, visible) {
        if (visible) {
            if (!this._visGroup) {
                this._visGroup = new THREE.Group();
                this._visGroup.name = `intel-vis-${this.team}`;
                this._visPool = [];
                const dotTex = getDotTexture();
                const ringGeo = new THREE.RingGeometry(1, 1.15, 32);
                for (let i = 0; i < POOL_SIZE; i++) {
                    // Dot sprite
                    const spriteMat = new THREE.SpriteMaterial({
                        map: dotTex,
                        transparent: true,
                        depthWrite: false,
                        sizeAttenuation: true,
                    });
                    const sprite = new THREE.Sprite(spriteMat);
                    sprite.scale.set(1.2, 1.2, 1);
                    sprite.visible = false;
                    this._visGroup.add(sprite);

                    // Ground ring
                    const ringMat = new THREE.MeshBasicMaterial({
                        color: 0xffffff,
                        transparent: true,
                        opacity: 0.3,
                        depthWrite: false,
                        side: THREE.DoubleSide,
                    });
                    const ring = new THREE.Mesh(ringGeo, ringMat);
                    ring.rotation.x = -Math.PI / 2;
                    ring.visible = false;
                    this._visGroup.add(ring);

                    this._visPool.push({ sprite, ring });
                }
                this._visRingGeo = ringGeo;
                scene.add(this._visGroup);
            }
            this._visGroup.visible = true;
            this.updateVisualization();
        } else {
            if (this._visGroup) this._visGroup.visible = false;
        }
    }

    updateVisualization() {
        if (!this._visGroup || !this._visGroup.visible) return;
        const pool = this._visPool;
        let idx = 0;
        for (const contact of this.contacts.values()) {
            if (idx >= POOL_SIZE) break;
            const { sprite, ring } = pool[idx];
            const color = STATUS_COLORS[contact.status] || STATUS_COLORS.suspected;

            // Dot sprite
            sprite.visible = true;
            sprite.position.set(
                contact.lastSeenPos.x,
                contact.lastSeenPos.y + 2.5,
                contact.lastSeenPos.z
            );
            sprite.material.color.copy(color);
            sprite.material.opacity = contact.confidence;

            // Ground ring
            ring.visible = true;
            ring.position.set(
                contact.lastSeenPos.x,
                contact.lastSeenPos.y + 0.3,
                contact.lastSeenPos.z
            );
            ring.material.color.copy(color);
            ring.material.opacity = contact.confidence * 0.3;
            const radius = contact.status === 'visible' ? 0 : contact.lastSeenTime * 4;
            ring.scale.set(radius, radius, radius);
            ring.visible = radius > 0;

            idx++;
        }
        // Hide unused pool members
        for (let i = idx; i < POOL_SIZE; i++) {
            pool[i].sprite.visible = false;
            pool[i].ring.visible = false;
        }
    }

    disposeVisualization() {
        if (!this._visGroup) return;
        this._visGroup.parent?.remove(this._visGroup);
        for (const { sprite, ring } of this._visPool) {
            sprite.material.dispose();
            ring.material.dispose();
        }
        this._visRingGeo.dispose();
        this._visGroup = null;
        this._visPool = null;
    }
}
