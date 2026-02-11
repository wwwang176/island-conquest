import * as THREE from 'three';

/**
 * A flag capture point on the map.
 * Handles visual representation and capture state.
 */
export class FlagPoint {
    constructor(scene, position, name, index, getHeightAt) {
        this.scene = scene;
        this.name = name;
        this.index = index;
        this.position = position.clone();
        this.getHeightAt = getHeightAt || null;

        // Capture state
        this.owner = 'neutral';     // 'neutral', 'teamA', 'teamB'
        this.captureProgress = 0;   // 0~1
        this.capturingTeam = null;
        this.captureRadius = 8;
        this.captureTime = 10;      // seconds for 1 person

        // Colors
        this.colors = {
            neutral: 0xaaaaaa,
            teamA: 0x4488ff,
            teamB: 0xff4444,
        };

        // Build visual
        this.group = new THREE.Group();
        this.group.position.copy(position);
        this._buildVisual();
        scene.add(this.group);
    }

    _buildVisual() {
        // Flag pole
        const poleGeo = new THREE.CylinderGeometry(0.08, 0.08, 6, 6);
        const poleMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.y = 3;
        pole.castShadow = true;
        this.group.add(pole);

        // Flag cloth
        const flagGeo = new THREE.PlaneGeometry(1.8, 1.0);
        this.flagMat = new THREE.MeshLambertMaterial({
            color: this.colors.neutral,
            side: THREE.DoubleSide,
        });
        this.flag = new THREE.Mesh(flagGeo, this.flagMat);
        this.flag.position.set(0.9, 5.2, 0);
        this.flag.castShadow = true;
        this.group.add(this.flag);

        // Capture zone ring (terrain-conforming)
        const ringGeo = this._buildTerrainRingGeo(this.captureRadius - 0.3, this.captureRadius, 64);
        this.ringMat = new THREE.MeshBasicMaterial({
            color: this.colors.neutral,
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(ringGeo, this.ringMat);
        this.group.add(ring);

        // Capture zone fill (terrain-conforming)
        const fillGeo = this._buildTerrainDiscGeo(this.captureRadius - 0.3, 64, 6);
        this.fillMat = new THREE.MeshBasicMaterial({
            color: this.colors.neutral,
            transparent: true,
            opacity: 0.08,
            side: THREE.DoubleSide,
        });
        this.fill = new THREE.Mesh(fillGeo, this.fillMat);
        this.group.add(this.fill);

        // Flag label (floating text sprite)
        this.label = this._createLabel(this.name);
        this.label.position.y = 7;
        this.group.add(this.label);

        // Progress bar background
        const barBgGeo = new THREE.PlaneGeometry(2.5, 0.25);
        const barBgMat = new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
        this.progressBarBg = new THREE.Mesh(barBgGeo, barBgMat);
        this.progressBarBg.position.y = 6.5;
        this.group.add(this.progressBarBg);

        // Progress bar fill
        const barFillGeo = new THREE.PlaneGeometry(2.5, 0.25);
        this.progressBarFillMat = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
        this.progressBarFill = new THREE.Mesh(barFillGeo, this.progressBarFillMat);
        this.progressBarFill.position.y = 6.5;
        this.progressBarFill.position.z = 0.01;
        this.progressBarFill.scale.x = 0;
        this.group.add(this.progressBarFill);
    }

    /** Build a ring geometry that conforms to terrain height. */
    _buildTerrainRingGeo(innerR, outerR, segments) {
        const pos = this.position;
        const geo = new THREE.BufferGeometry();
        const vertices = [];
        const indices = [];

        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            // Inner vertex
            const ix = cos * innerR;
            const iz = sin * innerR;
            const iy = this.getHeightAt
                ? this.getHeightAt(pos.x + ix, pos.z + iz) - pos.y + 0.1
                : 0.05;
            vertices.push(ix, iy, iz);

            // Outer vertex
            const ox = cos * outerR;
            const oz = sin * outerR;
            const oy = this.getHeightAt
                ? this.getHeightAt(pos.x + ox, pos.z + oz) - pos.y + 0.1
                : 0.05;
            vertices.push(ox, oy, oz);

            if (i < segments) {
                const base = i * 2;
                indices.push(base, base + 1, base + 2);
                indices.push(base + 1, base + 3, base + 2);
            }
        }

        geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        return geo;
    }

    /** Build a filled disc geometry that conforms to terrain height. */
    _buildTerrainDiscGeo(radius, angularSegments, radialSegments) {
        const pos = this.position;
        const geo = new THREE.BufferGeometry();
        const vertices = [];
        const indices = [];

        // Center vertex
        const cy = this.getHeightAt
            ? this.getHeightAt(pos.x, pos.z) - pos.y + 0.08
            : 0.03;
        vertices.push(0, cy, 0);

        for (let r = 1; r <= radialSegments; r++) {
            const radius_r = (r / radialSegments) * radius;
            for (let i = 0; i <= angularSegments; i++) {
                const angle = (i / angularSegments) * Math.PI * 2;
                const vx = Math.cos(angle) * radius_r;
                const vz = Math.sin(angle) * radius_r;
                const vy = this.getHeightAt
                    ? this.getHeightAt(pos.x + vx, pos.z + vz) - pos.y + 0.08
                    : 0.03;
                vertices.push(vx, vy, vz);
            }
        }

        const ringVerts = angularSegments + 1;

        // First ring connects to center
        for (let i = 0; i < angularSegments; i++) {
            indices.push(0, 1 + i, 1 + i + 1);
        }

        // Subsequent rings
        for (let r = 1; r < radialSegments; r++) {
            const curr = 1 + r * ringVerts;
            const prev = 1 + (r - 1) * ringVerts;
            for (let i = 0; i < angularSegments; i++) {
                indices.push(prev + i, curr + i, curr + i + 1);
                indices.push(prev + i, curr + i + 1, prev + i + 1);
            }
        }

        geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        return geo;
    }

    _createLabel(text) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'white';
        ctx.font = 'bold 40px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 64, 32);

        const tex = new THREE.CanvasTexture(canvas);
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(2, 1, 1);
        return sprite;
    }

    /**
     * Update capture state based on soldiers in range.
     * @param {Array} teamASoldiers - positions of team A soldiers
     * @param {Array} teamBSoldiers - positions of team B soldiers
     * @param {number} dt - delta time
     */
    update(teamASoldiers, teamBSoldiers, dt) {
        // Count soldiers in capture radius
        const aCount = this._countInRadius(teamASoldiers);
        const bCount = this._countInRadius(teamBSoldiers);

        if (aCount > 0 && bCount > 0) {
            // Contested — no progress change
        } else if (aCount > 0) {
            this._progressCapture('teamA', aCount, dt);
        } else if (bCount > 0) {
            this._progressCapture('teamB', bCount, dt);
        }

        // Update visuals
        this._updateVisuals();
    }

    _countInRadius(soldiers) {
        let count = 0;
        const r2 = this.captureRadius * this.captureRadius;
        for (const s of soldiers) {
            const dx = s.x - this.position.x;
            const dz = s.z - this.position.z;
            if (dx * dx + dz * dz <= r2) count++;
        }
        return count;
    }

    _progressCapture(team, count, dt) {
        // If same team as current capturer, increase progress
        // If different team or neutral, first need to de-capture then re-capture
        const speed = (1 / this.captureTime) * (1 + (count - 1) * 0.3);

        if (this.owner === team) {
            // Already owned, nothing to capture
            this.captureProgress = 1;
            this.capturingTeam = team;
            return;
        }

        if (this.capturingTeam === team || this.capturingTeam === null) {
            // Capturing for this team
            this.capturingTeam = team;
            this.captureProgress = Math.min(1, this.captureProgress + speed * dt);
            if (this.captureProgress >= 1) {
                this.owner = team;
                this.captureProgress = 1;
            }
        } else {
            // Different team was capturing — reverse progress first
            this.captureProgress = Math.max(0, this.captureProgress - speed * dt);
            if (this.captureProgress <= 0) {
                this.capturingTeam = team;
                this.captureProgress = 0;
            }
        }
    }

    _updateVisuals() {
        const ownerColor = this.colors[this.owner] || this.colors.neutral;
        const capColor = this.capturingTeam ? this.colors[this.capturingTeam] : this.colors.neutral;

        this.flagMat.color.setHex(ownerColor);
        this.ringMat.color.setHex(ownerColor);
        this.fillMat.color.setHex(ownerColor);
        this.fillMat.opacity = this.owner !== 'neutral' ? 0.15 : 0.08;

        // Progress bar
        if (this.captureProgress > 0 && this.captureProgress < 1 && this.owner !== this.capturingTeam) {
            this.progressBarBg.visible = true;
            this.progressBarFill.visible = true;
            this.progressBarFill.scale.x = this.captureProgress;
            this.progressBarFill.position.x = -(1 - this.captureProgress) * 1.25;
            this.progressBarFillMat.color.setHex(capColor);
        } else {
            this.progressBarBg.visible = false;
            this.progressBarFill.visible = false;
        }

        // Make label and progress bar face camera (billboarding handled by Sprite for label)
        // Progress bar needs manual billboarding
        this.progressBarBg.lookAt(
            this.progressBarBg.getWorldPosition(new THREE.Vector3()).add(
                new THREE.Vector3(0, 0, 1).applyQuaternion(this.scene.children[0]?.quaternion || new THREE.Quaternion())
            )
        );
    }

    getOwner() {
        return this.owner;
    }
}
