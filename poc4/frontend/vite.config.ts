import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const mockMode = mode === 'mock';
  return {
    plugins: [react(), tailwindcss()],
    publicDir: mockMode ? 'public-mock' : 'public',
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        input: mockMode
          ? {
              app: fileURLToPath(new URL('./index.html', import.meta.url)),
              stage0: fileURLToPath(new URL('./stage0.html', import.meta.url)),
            }
          : fileURLToPath(new URL('./index.html', import.meta.url)),
      },
    },
  };
});
