import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-static';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit({ adapter: adapter({ fallback: '200.html', precompress: false }) })],
  envPrefix: 'PUBLIC_',
  optimizeDeps: { exclude: ['maplibre-gl', '@stormtrack/wind-layer'] },
  build: { target: 'es2022' },
  test: { include: ['src/**/*.test.ts'], environment: 'node' }
});
