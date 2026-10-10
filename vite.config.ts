import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { library } from './server/library-plugin.ts';

export default defineConfig({
  // Relative paths so the built site works from any folder on your website.
  base: './',
  plugins: [
    react(),
    // Publishing copies a reading's PDF or saved page only when you switch on
    // "publish the file" for it (open access only). Everything else is notes.
    library({ dataDir: process.env.READINGS_DATA ?? 'data' }),
  ],
  build: { chunkSizeWarningLimit: 2500 }, // three.js is big; it's one cached file
  server: {
    port: 4747,
    open: true,
    watch: { ignored: ['**/data/**', '**/.publish/**'] },
  },
});
