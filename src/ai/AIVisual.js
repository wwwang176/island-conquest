/**
 * AI Visual logic — extracted from AIController.
 * Function-bag pattern: each function takes `ctx` (AIController instance).
 */
import * as THREE from 'three';

/** Lerp between two angles handling wraparound. */
function _lerpAngle(a, b, t) {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
}

/** Main visual update — upper body aim + lower body walk + tac label. */
export function updateSoldierVisual(ctx, dt) {
    if (!ctx.soldier.alive) return;
    updateUpperBodyAim(ctx, dt);
    updateLowerBodyMove(ctx, dt);
    updateTacLabel(ctx);
}

/** Upper body aiming — universal (ground + vehicle passengers). */
export function updateUpperBodyAim(ctx, dt) {
    const soldier = ctx.soldier;
    const myPos = soldier.getPosition();
    const aimAngle = Math.atan2(-ctx.facingDir.x, -ctx.facingDir.z);
    if (soldier.upperBody) {
        soldier.upperBody.rotation.y = aimAngle;
        if (soldier.shoulderPivot) {
            let targetPitch = 0;
            if (ctx._grenadeThrowTimer > 0) {
                targetPitch = ctx._grenadeThrowPitch;
            } else if ((ctx.targetEnemy && ctx.targetEnemy.alive && ctx.hasReacted) || ctx._preAimActive) {
                const dx = ctx.aimPoint.x - myPos.x;
                const dy = ctx.aimPoint.y - (myPos.y + 1.35);
                const dz = ctx.aimPoint.z - myPos.z;
                const hDist = Math.sqrt(dx * dx + dz * dz);
                if (hDist > 0.1) targetPitch = Math.atan2(dy, hDist);
            }
            if (ctx._smoothAimPitch === undefined) ctx._smoothAimPitch = 0;
            ctx._smoothAimPitch += (targetPitch - ctx._smoothAimPitch) * 0.15;
            soldier.shoulderPivot.rotation.x = ctx._smoothAimPitch + (soldier._gunReloadTilt || 0);
        }
    }
    soldier.mesh.rotation.set(0, 0, 0);
}

/** Lower body movement — rotates lower body toward movement direction + walk animation. */
export function updateLowerBodyMove(ctx, dt) {
    const soldier = ctx.soldier;
    if (!soldier.lowerBody) return;
    const myPos = soldier.getPosition();
    const dx = myPos.x - ctx.lastPos.x;
    const dz = myPos.z - ctx.lastPos.z;
    const moveSpeed = Math.sqrt(dx * dx + dz * dz) / Math.max(dt, 0.001);

    if (moveSpeed > 0.3) {
        const moveAngle = Math.atan2(-dx, -dz);
        soldier.lowerBody.rotation.y = _lerpAngle(soldier.lowerBody.rotation.y, moveAngle, 1 - Math.exp(-10 * dt));
    } else {
        const aimAngle = Math.atan2(-ctx.facingDir.x, -ctx.facingDir.z);
        soldier.lowerBody.rotation.y = _lerpAngle(soldier.lowerBody.rotation.y, aimAngle, 1 - Math.exp(-5 * dt));
    }

    soldier.animateWalk(dt, moveSpeed);
}

/** Get current tactic text for the label above the soldier's head. */
export function getTacticText(ctx) {
    if (ctx.fallbackTarget) return 'FALLBACK';
    if (ctx.rushTarget) return ctx.squad && ctx.squad.rushActive ? 'RUSH!' : 'RALLY';
    if (ctx.suppressionTarget && ctx.suppressionTimer > 0) return 'SUPPRESS';
    if (ctx.crossfirePos) return 'CROSSFIRE';
    if (ctx.isReloading) return null;
    if (ctx.currentAmmo <= 0 && ctx.squad && !ctx.squad.canReload(ctx)) return 'HOLD';
    return null;
}

/** Create a sprite label with the given text. */
export function createTacLabel(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, 256, 64);
    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.roundRect(8, 4, 240, 56, 8);
    c.fill();
    c.fillStyle = '#ffffff';
    c.font = 'bold 36px Arial';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, 128, 32);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.7, 0.675, 1);
    sprite.position.set(0, 2.2, 0);
    sprite.renderOrder = 999;
    return sprite;
}

/** Update the tactical label above the soldier. */
export function updateTacLabel(ctx) {
    // Importing AIController.showTacLabels via the ctx reference
    const showTacLabels = ctx.constructor.showTacLabels;
    if (!showTacLabels) {
        if (ctx._tacLabel) ctx._tacLabel.visible = false;
        return;
    }

    const text = getTacticText(ctx);

    if (!text) {
        if (ctx._tacLabel) {
            ctx._tacLabel.visible = false;
            ctx._tacLabelText = '';
        }
        return;
    }

    if (text === ctx._tacLabelText && ctx._tacLabel) {
        ctx._tacLabel.visible = true;
        return;
    }

    // Create or re-create sprite with new text
    if (ctx._tacLabel) {
        ctx._tacLabel.material.map.dispose();
        ctx._tacLabel.material.dispose();
        ctx.soldier.mesh.remove(ctx._tacLabel);
    }
    ctx._tacLabel = createTacLabel(text);
    ctx._tacLabel.raycast = () => {}; // exclude from hitscan raycaster
    ctx.soldier.mesh.add(ctx._tacLabel);
    ctx._tacLabelText = text;
}

/** Ensure debug path line has enough capacity. */
export function ensureDebugPath(ctx, pointCount) {
    if (ctx._debugArc && ctx._debugArcSize >= pointCount) {
        return ctx._debugArc;
    }
    if (ctx._debugArc) {
        ctx._debugArc.geometry.dispose();
        ctx._debugArc.material.dispose();
        ctx.soldier.scene.remove(ctx._debugArc);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(pointCount * 3), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xffdd00, transparent: true, opacity: 0.7 });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    ctx.soldier.scene.add(line);
    ctx._debugArc = line;
    ctx._debugArcSize = pointCount;
    return line;
}

/** Update the debug A* path visualization. */
export function updateDebugArc(ctx) {
    const debugArcsOn = ctx.constructor.debugArcs;
    if (!debugArcsOn) {
        if (ctx._debugArc) ctx._debugArc.visible = false;
        return;
    }

    if (!ctx.soldier.alive || !ctx.moveTarget) {
        if (ctx._debugArc) ctx._debugArc.visible = false;
        return;
    }

    // Build key-point list: soldier → remaining waypoints → moveTarget
    const myPos = ctx.soldier.getPosition();
    const keys = [{ x: myPos.x, z: myPos.z }];

    if (ctx.currentPath.length > 0 && ctx.pathIndex < ctx.currentPath.length) {
        for (let i = ctx.pathIndex; i < ctx.currentPath.length; i++) {
            keys.push(ctx.currentPath[i]);
        }
    }
    keys.push({ x: ctx.moveTarget.x, z: ctx.moveTarget.z });

    // Subdivide each segment so the line hugs terrain (~1.5m steps)
    const SUB_STEP = 1.5;
    const groundOffset = 0.3;
    const verts = [];

    for (let k = 0; k < keys.length - 1; k++) {
        const ax = keys[k].x, az = keys[k].z;
        const bx = keys[k + 1].x, bz = keys[k + 1].z;
        const dx = bx - ax, dz = bz - az;
        const segLen = Math.sqrt(dx * dx + dz * dz);
        const steps = Math.max(1, Math.ceil(segLen / SUB_STEP));

        for (let s = 0; s < steps; s++) {
            const t = s / steps;
            const px = ax + dx * t;
            const pz = az + dz * t;
            verts.push(px, ctx.getHeightAt(px, pz) + groundOffset, pz);
        }
    }
    // Final point
    const last = keys[keys.length - 1];
    verts.push(last.x, ctx.getHeightAt(last.x, last.z) + groundOffset, last.z);

    const totalPts = verts.length / 3;
    const line = ensureDebugPath(ctx, totalPts);
    line.visible = true;

    const positions = line.geometry.attributes.position;
    for (let i = 0; i < totalPts; i++) {
        positions.setXYZ(i, verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
    }
    // Collapse unused
    for (let i = totalPts; i < ctx._debugArcSize; i++) {
        positions.setXYZ(i, verts[verts.length - 3], verts[verts.length - 2], verts[verts.length - 1]);
    }
    positions.needsUpdate = true;
    line.geometry.setDrawRange(0, totalPts);
}
