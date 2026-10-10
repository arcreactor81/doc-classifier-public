import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/** The same installed PDF maps and fonts in development, browser tests and the release. */
export function pdfAssets(): Plugin {
  const directory = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));
  let files: Map<string, { bytes: Uint8Array; contentType: string }>;
  async function assets() {
    if (files) return files;
    const { version } = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const selected = new Map<string, { bytes: Uint8Array; contentType: string }>();
    for (const folder of ['cmaps', 'standard_fonts']) {
      for (const name of (await readdir(join(directory, folder))).sort()) {
        const license = name.startsWith('LICENSE');
        if (!license && !/\.(bcmap|pfb|ttf)$/.test(name)) throw new Error(`Unexpected PDF asset: ${folder}/${name}`);
        const path = `/assets/pdfjs-${version}/${folder}/${name}${license ? '.txt' : ''}`;
        selected.set(path, { bytes: await readFile(join(directory, folder, name)),
          contentType: license ? 'text/plain; charset=utf-8' : name.endsWith('.ttf') ? 'font/ttf' : 'application/octet-stream' });
      }
    }
    files = selected;
    return files;
  }
  return {
    name: 'local-pdf-assets',
    async buildStart() { await assets(); },
    async generateBundle() {
      for (const [path, asset] of await assets()) this.emitFile({ type: 'asset', fileName: path.slice(1), source: asset.bytes });
    },
    async configureServer(server) {
      const listed = await assets();
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://local.invalid').pathname;
        if (!pathname.startsWith('/assets/pdfjs-')) return next();
        const asset = listed.get(pathname);
        if (!asset) { response.statusCode = 404; response.end(); return; }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405; response.setHeader('Allow', 'GET, HEAD'); response.end(); return;
        }
        response.setHeader('Content-Type', asset.contentType);
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.end(request.method === 'HEAD' ? undefined : asset.bytes);
      });
    }
  };
}
