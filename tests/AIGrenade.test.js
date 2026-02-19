import { describe, it, expect } from 'vitest';
import { solveGrenadeBallistic } from '../src/ai/AIGrenade.js';

describe('solveGrenadeBallistic', () => {
    const speed = 18;
    const fuseTime = 3;

    it('flat ground throw returns valid angles', () => {
        const result = solveGrenadeBallistic(20, 0, speed, fuseTime);
        expect(result).not.toBeNull();
        expect(result.vHoriz).toBeGreaterThan(0);
        expect(result.vy).toBeGreaterThan(0);
        expect(result.flightTime).toBeGreaterThan(0);
        expect(result.flightTime).toBeLessThanOrEqual(fuseTime + 0.1);
    });

    it('uphill throw (positive dy)', () => {
        const result = solveGrenadeBallistic(15, 5, speed, fuseTime);
        expect(result).not.toBeNull();
        expect(result.vy).toBeGreaterThan(0);
    });

    it('downhill throw (negative dy)', () => {
        const result = solveGrenadeBallistic(15, -5, speed, fuseTime);
        expect(result).not.toBeNull();
        expect(result.vHoriz).toBeGreaterThan(0);
    });

    it('out of range uses 45° fallback', () => {
        // Very long distance that exceeds range
        const result = solveGrenadeBallistic(100, 0, speed, fuseTime);
        expect(result).not.toBeNull();
        // At 45° fallback, vHoriz ≈ vy ≈ v * 0.707
        expect(result.vHoriz).toBeCloseTo(speed * 0.707, 1);
        expect(result.vy).toBeCloseTo(speed * 0.707, 1);
    });

    it('zero horizontal distance', () => {
        // Edge case — throwing straight up/down
        const result = solveGrenadeBallistic(0, 5, speed, fuseTime);
        expect(result).not.toBeNull();
    });
});
