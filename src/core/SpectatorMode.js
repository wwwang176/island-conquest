import * as THREE from 'three';
import { SpectatorHUD } from '../ui/SpectatorHUD.js';

const _v = new THREE.Vector3();

/**
 * Spectator camera controller.
 * Two modes: first-person follow (attached to an AI soldier) and overhead bird's-eye.
 */
export class SpectatorMode {
    constructor(camera, input, aiManager) {
        this.camera = camera;
        this.input = input;
        this.aiManager = aiManager;

        this.mode = 'follow'; // 'follow' | 'overhead'
        this.targetIndex = 0;
        this._trackedSoldier = null; // keep reference to avoid jumps
        this.targets = [];    // rebuilt each frame: { soldier, controller, team }

        // Follow mode
        this.followLerp = 0.12;

        // Overhead mode
        this.overheadPos = new THREE.Vector3(0, 120, 0);
        this.overheadZoom = 120;
        this.panSpeed = 80;

        // Smooth camera transition
        this._lerpPos = new THREE.Vector3();
        this._lerpYaw = 0;
        this._lerpPitch = 0;
        this._initialized = false;

        // Death freeze: hold camera still before switching
        this._deathFreezeTimer = 0;

        this.hud = new SpectatorHUD();
        this.active = false;
    }

    activate() {
        this.active = true;
        this.hud.show();
        if (this.mode === 'follow') {
            this.hud.setFollowMode();
        } else {
            this.hud.setOverheadMode();
        }
    }

    deactivate() {
        this.active = false;
        this.hud.hide();
    }

    /**
     * Rebuild the list of alive soldiers from both teams (interleaved).
     * Preserves tracked soldier across rebuilds.
     */
    _rebuildTargets() {
        this.targets.length = 0;
        const a = this.aiManager.teamA;
        const b = this.aiManager.teamB;
        const maxLen = Math.max(a.soldiers.length, b.soldiers.length);

        for (let i = 0; i < maxLen; i++) {
            if (i < a.soldiers.length && a.soldiers[i].alive) {
                this.targets.push({ soldier: a.soldiers[i], controller: a.controllers[i], team: 'teamA' });
            }
            if (i < b.soldiers.length && b.soldiers[i].alive) {
                this.targets.push({ soldier: b.soldiers[i], controller: b.controllers[i], team: 'teamB' });
            }
        }

        // Re-find tracked soldier in new list
        if (this._trackedSoldier) {
            const idx = this.targets.findIndex(t => t.soldier === this._trackedSoldier);
            if (idx >= 0) {
                this.targetIndex = idx;
            } else if (this._deathFreezeTimer <= 0) {
                // Tracked soldier died — freeze camera, then switch after delay
                this._deathFreezeTimer = 1.0;
            }
        }
    }

    nextTarget() {
        if (this.targets.length === 0) return;
        this._deathFreezeTimer = 0;
        this.targetIndex = (this.targetIndex + 1) % this.targets.length;
        this._trackedSoldier = this.targets[this.targetIndex].soldier;
        this._initialized = false; // trigger smooth transition
    }

    toggleView() {
        if (this.mode === 'follow') {
            this.mode = 'overhead';
            // Set overhead position from current camera
            const pos = this.camera.position;
            this.overheadPos.set(pos.x, this.overheadZoom, pos.z);
            this.hud.setOverheadMode();
        } else {
            this.mode = 'follow';
            this._initialized = false;
            this._deathFreezeTimer = 0;
            this._pendingFollowHUD = true; // defer HUD until camera snaps
        }
    }

    getCurrentTarget() {
        if (this.targets.length === 0) return null;
        // During death freeze, don't expose next target yet
        if (this._deathFreezeTimer > 0) return null;
        if (this.targetIndex >= this.targets.length) {
            this.targetIndex = 0;
        }
        const target = this.targets[this.targetIndex];
        // Auto-track on first access
        if (!this._trackedSoldier && target) {
            this._trackedSoldier = target.soldier;
        }
        return target;
    }

    update(dt) {
        if (!this.active) return;

        this._rebuildTargets();

        if (this.mode === 'follow') {
            this._updateFollow(dt);
        } else {
            this._updateOverhead(dt);
        }
    }

    _updateFollow(dt) {
        // Death freeze: hold camera still, then switch target
        if (this._deathFreezeTimer > 0) {
            this._deathFreezeTimer -= dt;
            if (this._deathFreezeTimer <= 0) {
                this._trackedSoldier = null;
                if (this.targetIndex >= this.targets.length) this.targetIndex = 0;
                this._initialized = false;
            }
            return;
        }

        const target = this.getCurrentTarget();
        if (!target) return;

        const { soldier, controller } = target;
        const pos = soldier.getPosition();

        // Head position
        const headPos = _v.set(pos.x, pos.y + 1.6, pos.z);

        // Yaw from facing direction (camera faces -Z, so negate)
        const yaw = Math.atan2(-controller.facingDir.x, -controller.facingDir.z);

        // Pitch from aim point (if aiming at enemy or pre-aiming intel contact)
        let pitch = 0;
        if ((controller.targetEnemy && controller.hasReacted) || controller._preAimActive) {
            const aimTarget = controller.aimPoint;
            const dx = aimTarget.x - headPos.x;
            const dy = aimTarget.y - headPos.y;
            const dz = aimTarget.z - headPos.z;
            const hDist = Math.sqrt(dx * dx + dz * dz);
            pitch = Math.atan2(dy, hDist);
            pitch = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, pitch));
        }

        // Position: snap directly to head (no lag behind moving soldier)
        this._lerpPos.copy(headPos);

        // Rotation: light smoothing to avoid jarring snaps on fast turns
        if (!this._initialized) {
            this._lerpYaw = yaw;
            this._lerpPitch = pitch;
            this._initialized = true;
        } else {
            const t = Math.min(1, 0.25 * 60 * dt);

            // Lerp yaw with wrapping
            let yawDiff = yaw - this._lerpYaw;
            if (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
            if (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
            this._lerpYaw += yawDiff * t;

            this._lerpPitch += (pitch - this._lerpPitch) * t;
        }

        this.camera.position.copy(this._lerpPos);
        const euler = new THREE.Euler(this._lerpPitch, this._lerpYaw, 0, 'YXZ');
        this.camera.quaternion.setFromEuler(euler);

        // Show follow HUD after camera has snapped to target
        if (this._pendingFollowHUD) {
            this._pendingFollowHUD = false;
            this.hud.setFollowMode();
        }

        // Allow mouse look offset in follow mode (pointer locked)
        if (this.input.isPointerLocked) {
            const { dx, dy } = this.input.consumeMouseDelta();
            // Small view offset — don't consume, just let it be
            // (optional: could add free-look around the followed soldier)
        }

        // Update HUD
        const name = `${target.team === 'teamA' ? 'A' : 'B'}-${soldier.id}`;
        this.hud.updateTarget(name, controller.personality.name, target.team, soldier.hp, soldier.maxHP);
    }

    _updateOverhead(dt) {
        // Pan with WASD (move the look-at point on the ground)
        const speed = this.panSpeed * dt;
        if (this.input.isKeyDown('KeyW')) this.overheadPos.z -= speed;
        if (this.input.isKeyDown('KeyS')) this.overheadPos.z += speed;
        if (this.input.isKeyDown('KeyA')) this.overheadPos.x -= speed;
        if (this.input.isKeyDown('KeyD')) this.overheadPos.x += speed;

        // Zoom with scroll (change distance, not just height)
        const scroll = this.input.consumeScrollDelta();
        if (scroll !== 0) {
            this.overheadZoom += scroll * 0.1;
            this.overheadZoom = Math.max(15, Math.min(200, this.overheadZoom));
        }

        // Tilt 60° from horizontal (30° from straight down)
        // Camera is offset behind and above the look-at point
        const tiltAngle = Math.PI / 3; // 60° from horizontal
        const camY = this.overheadZoom * Math.sin(tiltAngle);
        const camZOffset = this.overheadZoom * Math.cos(tiltAngle);

        this.camera.position.set(
            this.overheadPos.x,
            camY,
            this.overheadPos.z + camZOffset
        );
        this.camera.rotation.set(-tiltAngle, 0, 0);
    }
}
