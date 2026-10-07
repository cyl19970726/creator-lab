import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),base:'/space-workbench/',plugins:[react()],build:{outDir:'dist',emptyOutDir:true},server:{host:'127.0.0.1',port:4398,proxy:{'/api/workflow-spaces':{target:'http://127.0.0.1:4397',changeOrigin:true},'/space-workbench/session':{target:'http://127.0.0.1:4397',changeOrigin:true}}}});
