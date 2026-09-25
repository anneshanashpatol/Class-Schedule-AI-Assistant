import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ base: '/assistant/', plugins: [react()], server: { proxy: { '/assistant/api': 'http://localhost:8787' } } });
