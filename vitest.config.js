import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        include: ['tests/**/*.test.js'],
    },
    resolve: {
        alias: {
            // CDN-only packages — provide minimal stubs for tests
            'three': new URL('./tests/__mocks__/three.js', import.meta.url).pathname,
            'cannon-es': new URL('./tests/__mocks__/cannon-es.js', import.meta.url).pathname,
        }
    }
});
