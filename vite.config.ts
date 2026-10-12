import { defineConfig } from 'vite';
import { pdfAssets } from './scripts/pdf-assets.ts';
export default defineConfig({
 plugins:[pdfAssets()],
 root:'ui/app',
 build:{outDir:'../../dist',emptyOutDir:true,target:'es2022'},
 worker:{format:'es'},
 // The app's own modules live under ui/app/api/, so their .ts requests must not be proxied to the Worker.
 server:{host:'127.0.0.1',proxy:{'/api':{target:'http://127.0.0.1:8787',bypass:req=>/^\/api\/[^?]+\.ts(\?|$)/.test(req.url??'')?req.url:undefined}}},
});
