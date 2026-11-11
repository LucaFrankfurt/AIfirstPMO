import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const target = process.env.KOLIBRI_SERVER ?? 'http://localhost:4000';
const proxy = { target, changeOrigin: true, ws: false };

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    // `/w` is the support widget's iframe and its routes: served by the API
    // server with the widget's own frame-ancestors, so it is proxied too.
    proxy: { '/api': proxy, '/files': proxy, '/mcp': proxy, '/w/': proxy },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      // Two pages: the app, and the page inside a support widget's iframe.
      input: { main: 'index.html', widget: 'widget.html' },
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
