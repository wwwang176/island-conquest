import * as THREE from 'three';

const _flagWorldPos = new THREE.Vector3();
const _flagLookDir = new THREE.Vector3();
const _defaultQuat = new THREE.Quaternion();

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
        const flagGeo = new THREE.PlaneGeometry(1.8, 1.0, 6, 2);
        this._flagTime = { value: 0 };
        this.flagMat = new THREE.MeshLambertMaterial({
            color: this.colors.neutral,
            side: THREE.DoubleSide,
        });
        const flagTime = this._flagTime;
        this.flagMat.onBeforeCompile = (shader) => {
            shader.uniforms.uFlagTime = flagTime;
            shader.vertexShader = shader.vertexShader.replace(
                '#include <common>',
                `#include <common>
                uniform float uFlagTime;`
            );
            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
                float wf = (transformed.x + 0.9) / 1.8;
                float wave = wf * wf;
                transformed.z += sin(uFlagTime * 4.0 - wf * 8.0) * 0.12 * wave;
                transformed.z += sin(uFlagTime * 7.0 - wf * 14.0) * 0.03 * wave;
                transformed.y += sin(uFlagTime * 3.0 - wf * 6.0) * 0.03 * wave;`
            );
        };
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

        // Progress bar container (billboarded as a unit)
        this.progressBarContainer = new THREE.Group();
        this.progressBarContainer.position.y = 6.5;
        this.group.add(this.progressBarContainer);

        // Progress bar background (shrinks from right as capture progresses)
        const barBgGeo = new THREE.PlaneGeometry(2.5, 0.25);
        const barBgMat = new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
        this.progressBarBg = new THREE.Mesh(barBgGeo, barBgMat);
        this.progressBarContainer.add(this.progressBarBg);

        // Progress bar fill (grows from left as capture progresses)
        const barFillGeo = new THREE.PlaneGeometry(2.5, 0.25);
        this.progressBarFillMat = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
        this.progressBarFill = new THREE.Mesh(barFillGeo, this.progressBarFillMat);
        this.progressBarFill.scale.x = 0;
        this.progressBarContainer.add(this.progressBarFill);
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
    update(teamASoldiers, teamBSoldiers, dt, camera) {
        this._camera = camera;
        this._flagTime.value += dt;
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
            const dy = s.y - this.position.y;
            const dz = s.z - this.position.z;
            if (dx * dx + dy * dy + dz * dz <= r2) count++;
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

        // Progress bar: fill grows from left, bg shrinks from right
        const p = this.captureProgress;
        if (p > 0 && p < 1 && this.owner !== this.capturingTeam) {
            this.progressBarContainer.visible = true;
            // Fill (team color): scale = progress, shift left so it grows rightward
            this.progressBarFill.scale.x = p;
            this.progressBarFill.position.x = -(1 - p) * 1.25;
            this.progressBarFillMat.color.setHex(capColor);
            // Bg (dark): scale = remaining, shift right
            this.progressBarBg.scale.x = 1 - p;
            this.progressBarBg.position.x = p * 1.25;
        } else {
            this.progressBarContainer.visible = false;
        }

        // Billboard: only compute when progress bar is actively shown
        if (this.progressBarContainer.visible && this._camera) {
            const cam = this._camera;
            const dx = cam.position.x - this.group.position.x;
            const dz = cam.position.z - this.group.position.z;
            const len = Math.sqrt(dx * dx + dz * dz);
            if (len > 0.01) {
                const nx = dx / len;
                const nz = dz / len;
                this.progressBarContainer.position.x = nx * 0.15;
                this.progressBarContainer.position.z = nz * 0.15;
            }
            this.group.updateWorldMatrix(true, false);
            const cWX = this.group.position.x + this.progressBarContainer.position.x;
            const cWZ = this.group.position.z + this.progressBarContainer.position.z;
            const cWY = this.group.position.y + this.progressBarContainer.position.y;
            this.progressBarContainer.lookAt(2 * cWX - cam.position.x, cWY, 2 * cWZ - cam.position.z);
        }
    }

    getOwner() {
        return this.owner;
    }
}
