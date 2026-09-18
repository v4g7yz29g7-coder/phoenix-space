import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/3d/',
  build: {
    outDir: '../public/arena3d',
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: {
          'three': ['three'],
          'r3f': ['@react-three/fiber', '@react-three/drei'],
          'react': ['react', 'react-dom'],
          'socket': ['socket.io-client'],
        },
      },
    },
  },
  server: {
    port: 3021,
    host: '0.0.0.0',
    proxy: {
      '/socket.io': { target: 'http://localhost:3020', ws: true },
      '/api': { target: 'http://localhost:3020' },
    },
  },
});
