import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Generate battlement walls near each flag point.
 * Battlements are ground-level walls providing actual cover.
 *
 * @param {import('./Island.js').Island} island
 * @param {THREE.Vector3[]} flagPositions
 */
export function generateFortifications(island, flagPositions) {
    const battlementGeos = [];
    const noise = island.noise;

    for (let fi = 0; fi < flagPositions.length; fi++) {
        const fp = flagPositions[fi];
        const groundY = island.getHeightAt(fp.x, fp.z);

        // Skip flags that are too close to water
        if (groundY < 0.5) continue;

        // ── Battlements ──
        // 3-4 wall segments arranged in an arc 8-12m from the flag
        const segCount = 3 + (noise.noise2D(fp.x * 0.5, fi * 10) > 0 ? 1 : 0);
        const baseAngle = fi * 1.2 + noise.noise2D(fi * 7, 50) * 0.5;
        const arcSpan = Math.PI * 0.8; // ~144° arc
        const radius = 8 + Math.abs(noise.noise2D(fp.x * 0.2, fp.z * 0.2)) * 4;

        for (let si = 0; si < segCount; si++) {
            const segAngle = baseAngle + (si / (segCount - 1 || 1) - 0.5) * arcSpan;
            const wx = fp.x + Math.cos(segAngle) * radius;
            const wz = fp.z + Math.sin(segAngle) * radius;
            const wGroundY = island.getHeightAt(wx, wz);
            if (wGroundY < 0.5) continue;

            // Wall faces outward from flag center
            const faceAngle = segAngle + noise.noise2D(wx * 0.4, wz * 0.4) * 0.15;
            _buildBattlement(island, battlementGeos, wx, wz, wGroundY, faceAngle, fi, si);
        }
    }

    // ── Merge & add to scene ──
    if (battlementGeos.length > 0) {
        const merged = mergeGeometries(battlementGeos);
        for (const g of battlementGeos) g.dispose();
        const mesh = new THREE.Mesh(
            merged,
            new THREE.MeshLambertMaterial({ color: 0x999999, flatShading: true })
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.surfaceType = 'rock';
        island.scene.add(mesh);
        island.collidables.push(mesh);
    }
}

// ── Battlement Builder ──

function _buildBattlement(island, battlementGeos, cx, cz, groundY, faceAngle, flagIdx, segIdx) {
    // A battlement segment: 3 merlons with 2 gaps
    const merlonW = 0.8;
    const merlonH = 1.2;
    const merlonD = 0.4;
    const gapW = 0.3;
    const merlonCount = 3;

    const totalW = merlonCount * merlonW + (merlonCount - 1) * gapW; // 3*0.8 + 2*0.3 = 3.0
    const rotQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), faceAngle);
    const segGeos = [];

    for (let mi = 0; mi < merlonCount; mi++) {
        const localX = -totalW / 2 + mi * (merlonW + gapW) + merlonW / 2;
        const localY = groundY + merlonH / 2;

        const geo = new THREE.BoxGeometry(merlonW, merlonH, merlonD);
        const mat4 = new THREE.Matrix4();
        // Position in local space, then rotate around center
        const offset = new THREE.Vector3(localX, 0, 0).applyQuaternion(rotQ);
        mat4.compose(
            new THREE.Vector3(cx + offset.x, localY, cz + offset.z),
            rotQ,
            new THREE.Vector3(1, 1, 1)
        );
        geo.applyMatrix4(mat4);
        segGeos.push(geo);
    }

    // Merge merlons of this segment into one geometry for the overall merge
    if (segGeos.length > 0) {
        const merged = mergeGeometries(segGeos);
        for (const g of segGeos) g.dispose();
        merged.computeBoundingBox();
        island.obstacleBounds.push(merged.boundingBox.clone());
        battlementGeos.push(merged);
    }

    // Physics: one box body encompassing the full segment
    const bodyW = totalW;
    const bodyH = merlonH;
    const bodyD = merlonD;
    const bodyY = groundY + bodyH / 2;
    const body = new CANNON.Body({ mass: 0, material: island.physics.defaultMaterial });
    body.addShape(new CANNON.Box(new CANNON.Vec3(bodyW / 2, bodyH / 2, bodyD / 2)));
    body.position.set(cx, bodyY, cz);
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), faceAngle);
    island.physics.addBody(body);

    // NavGrid obstacle
    island._obstacleDescs.push({
        type: 'box', x: cx, y: bodyY, z: cz,
        w: bodyW, h: bodyH, d: bodyD, rotY: faceAngle
    });

    // CoverSystem: register cover on both sides of the wall
    const nx = Math.cos(faceAngle + Math.PI / 2);
    const nz = Math.sin(faceAngle + Math.PI / 2);
    island.coverSystem.register(
        new THREE.Vector3(cx + nx * 0.5, groundY, cz + nz * 0.5),
        new THREE.Vector3(nx, 0, nz),
        1.0, 2
    );
    island.coverSystem.register(
        new THREE.Vector3(cx - nx * 0.5, groundY, cz - nz * 0.5),
        new THREE.Vector3(-nx, 0, -nz),
        1.0, 2
    );
}
