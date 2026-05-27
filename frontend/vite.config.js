import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';
export default defineConfig({
    plugins: [tailwindcss(), react()],
    build: {
        chunkSizeWarningLimit: 1000,
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        host: '0.0.0.0',
        port: 4874,
        proxy: {
            '/api': 'http://localhost:4873',
            '/health': 'http://localhost:4873',
        },
    },
});
