import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const target = process.env.KOLIBRI_SERVER ?? 'http://localhost:4000';
const proxy = { target, changeOrigin: true, ws: false };

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    proxy: { '/api': proxy, '/files': proxy, '/mcp': proxy },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
