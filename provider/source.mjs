
import { readFile } from 'node:fs/promises';
import { serve, bytes, ranged } from './http.mjs';
const label = await readFile(new URL('../fixtures/product.xml', import.meta.url));
const data = Buffer.from(JSON.parse(await readFile(new URL('../fixtures/measure.json', import.meta.url))).base64, 'base64');
export async function startProvider(options = {}) {
  return serve(async ({ request, response, url, state }) => {
    if (url.pathname === '/products/17/label.xml') return bytes(response, label, 'application/xml', 200, { etag: '"label-v1"' });
    if (url.pathname === '/products/17/measure.bin') {
      state.reads = (state.reads ?? 0) + 1;
      const changed = options.scenario === 'changed' && state.reads > 1;
      const body = changed ? Buffer.concat([data, Buffer.alloc(28)]) : data;
      return ranged(request, response, body, changed ? '"data-v2"' : '"data-v1"');
    }
    return false;
  }, options);
}
