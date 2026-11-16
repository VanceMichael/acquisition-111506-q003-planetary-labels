
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { validateRecord, product } from './domain.mjs';
import { createSourceClient, runIngest, catalogObjects, ingestIdentity } from './ingest.mjs';

export async function readJson(request, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('收件超过大小限制'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求不是有效JSON'), { status: 400 }); }
}

export function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export async function startApplication({ directory, port = 0, host = '127.0.0.1' }) {
  const store = await openStore(directory);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { product, status: 'ok' });
      if (request.method === 'POST' && url.pathname === '/api/manual') {
        const input = await readJson(request);
        const { key, record } = validateRecord(input.record);
        const receipt = await store.accept(key, record, input.evidence);
        return sendJson(response, receipt.duplicate ? 200 : 201, receipt);
      }
      if (request.method === 'GET' && url.pathname === '/api/records') return sendJson(response, 200, store.list());
      if (request.method === 'GET' && url.pathname === '/api/history') return sendJson(response, 200, store.history(url.searchParams.get('key')));
      // 自动来源：先盘点标签内可选择的对象，不下载数据文件。
      if (request.method === 'GET' && url.pathname === '/api/source/objects') {
        const baseUrl = url.searchParams.get('baseUrl');
        const labelPath = url.searchParams.get('labelPath') ?? '/products/17/label.xml';
        if (!baseUrl) return sendJson(response, 422, { error: '缺少合作来源地址 baseUrl' });
        const catalog = await catalogObjects({ client: createSourceClient(baseUrl), labelPath });
        return sendJson(response, 200, catalog);
      }
      // 自动收件：按标签选择测量对象并领取对应字节。
      if (request.method === 'POST' && url.pathname === '/api/ingest') {
        const input = await readJson(request);
        const receipt = await runIngest({
          baseUrl: input.baseUrl,
          labelPath: input.labelPath ?? '/products/17/label.xml',
          objectIds: input.objectIds ?? [],
          window: input.window,
          mode: input.mode ?? 'full',
        });
        // 字节按 sha256 内容寻址落盘，结构化收据本身不内嵌原始字节。
        const blobs = receipt.blobs;
        const stored = await store.acceptIngest(receipt, ingestIdentity(receipt), blobs);
        return sendJson(response, stored.duplicate ? 200 : 201, stored);
      }
      if (request.method === 'GET' && url.pathname === '/api/ingests') {
        const id = url.searchParams.get('ingestId');
        if (id) {
          const found = store.ingest(id);
          if (!found) return sendJson(response, 404, { error: '自动收件不存在' });
          return sendJson(response, 200, found);
        }
        return sendJson(response, 200, store.listIngests());
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/evidence/')) {
        const bytes = await store.evidence(url.pathname.slice('/api/evidence/'.length));
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        return response.end(bytes);
      }
      sendJson(response, 404, { error: '入口不存在' });
    } catch (error) {
      const status = error.status ?? (error.code === 'ENOENT' ? 404 : 500);
      sendJson(response, status, { error: status === 500 ? '收件服务内部错误' : error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { store, server, url: `http://${host}:${server.address().port}`, async close() {
    await new Promise(resolve => server.close(resolve));
    await store.flush();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const application = await startApplication({ directory: process.env.DATA_DIR ?? './var', port: Number(process.env.PORT ?? 4310), host: process.env.HOST ?? '127.0.0.1' });
  console.log(JSON.stringify({ product, url: application.url }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => application.close().then(() => process.exit(0)));
}
