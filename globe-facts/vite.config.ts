import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.API_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: { '/api': api },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
