import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../provider/source.mjs';
import { startApplication } from '../src/server.mjs';
import { digest } from '../src/store.mjs';

const LABEL_PATH = '/products/17/label.xml';

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('自动收件 HTTP 全流程：对象盘点、收件落盘、依据回查与幂等', async () => {
  const source = await startProvider();
  const directory = await mkdtemp(join(tmpdir(), 'ingest-api-'));
  const application = await startApplication({ directory });
  try {
    // 盘点对象，不下载数据文件
    const catalogRes = await fetch(`${application.url}/api/source/objects?baseUrl=${encodeURIComponent(source.url)}`);
    assert.equal(catalogRes.status, 200);
    const catalog = await catalogRes.json();
    assert.equal(catalog.product.urn, 'urn:demo:obs:17::1.0');
    assert.deepEqual(catalog.objects.map(o => o.localIdentifier), ['measurements', 'unsupported-note']);

    // 全文收件，只选择可收的测量对象
    const first = await postJson(`${application.url}/api/ingest`, {
      baseUrl: source.url, labelPath: LABEL_PATH, objectIds: ['measurements'],
    });
    assert.equal(first.status, 201);
    const receipt = first.body;
    assert.equal(receipt.summary.published, 1);
    assert.equal(receipt.results[0].status, 'published');
    assert.equal(receipt.results[0].integrity.md5Verified, true);
    assert.ok(receipt.ingestId);

    // 结构化结果保留产品版本、对象标识和字节位置
    const record = receipt.results[0].records[0];
    assert.equal(receipt.product.urn, 'urn:demo:obs:17::1.0');
    assert.equal(receipt.results[0].objectId, 'urn:demo:obs:17::1.0#measurements');
    assert.equal(record.position.fileOffset, 0);

    // 原始依据（标签 + 全文数据）可通过摘要回查，字节一致
    assert.equal(receipt.evidence.length, 2);
    for (const ref of receipt.evidence) {
      const bytes = Buffer.from(await (await fetch(`${application.url}/api/evidence/${ref.sha256}`)).arrayBuffer());
      assert.equal(digest(bytes), ref.sha256);
      assert.equal(bytes.length, ref.size);
    }

    // 同件重复收件幂等：返回原收件，不新增
    const again = await postJson(`${application.url}/api/ingest`, {
      baseUrl: source.url, labelPath: LABEL_PATH, objectIds: ['measurements'],
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.ingestId, receipt.ingestId);

    const list = await (await fetch(`${application.url}/api/ingests`)).json();
    assert.equal(list.length, 1);
    const one = await (await fetch(`${application.url}/api/ingests?ingestId=${encodeURIComponent(receipt.ingestId)}`)).json();
    assert.equal(one.ingestId, receipt.ingestId);
  } finally {
    await application.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('一次收件同时含可收与不可收对象：结果隔离且仅发布可证明相符者', async () => {
  const source = await startProvider();
  const directory = await mkdtemp(join(tmpdir(), 'ingest-mix-'));
  const application = await startApplication({ directory });
  try {
    const { status, body } = await postJson(`${application.url}/api/ingest`, {
      baseUrl: source.url, labelPath: LABEL_PATH,
      objectIds: ['measurements', 'unsupported-note'],
    });
    assert.equal(status, 201);
    assert.deepEqual(body.summary, { requested: 2, published: 1, rejected: 1 });
    const rejected = body.results.find(r => r.status === 'rejected');
    assert.match(rejected.reasons.join(' '), /Custom_Note/);
    // 可收对象的数据依据已落盘；被拒对象不产生伪造字节
    assert.equal(body.evidence.length, 2);
  } finally {
    await application.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('range 模式收件：片段依据与局部完整性状态持久化', async () => {
  const source = await startProvider();
  const directory = await mkdtemp(join(tmpdir(), 'ingest-range-'));
  const application = await startApplication({ directory });
  try {
    const { status, body } = await postJson(`${application.url}/api/ingest`, {
      baseUrl: source.url, labelPath: LABEL_PATH, objectIds: ['measurements'],
      window: { start: 0, count: 1 }, mode: 'range',
    });
    assert.equal(status, 201);
    const published = body.results[0];
    assert.equal(published.integrity.level, 'partial');
    assert.equal(published.integrity.md5Verified, false);
    const dataRef = body.evidence.find(e => e.role === 'data-range');
    assert.deepEqual(dataRef.range, { begin: 0, end: 27, totalSize: 56 });
    const bytes = Buffer.from(await (await fetch(`${application.url}/api/evidence/${dataRef.sha256}`)).arrayBuffer());
    assert.equal(bytes.length, 28);
  } finally {
    await application.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('数据版本变化后收件失败并留下原因，不写入可发布结果', async () => {
  const source = await startProvider({ scenario: 'changed' });
  const directory = await mkdtemp(join(tmpdir(), 'ingest-changed-'));
  const application = await startApplication({ directory });
  try {
    const first = await postJson(`${application.url}/api/ingest`, {
      baseUrl: source.url, labelPath: LABEL_PATH, objectIds: ['measurements'],
    });
    assert.equal(first.status, 201);
    const second = await postJson(`${application.url}/api/ingest`, {
      baseUrl: source.url, labelPath: LABEL_PATH, objectIds: ['measurements'],
    });
    // 第二次全部对象被拒，没有可发布内容
    assert.equal(second.body.summary.published, 0);
    assert.equal(second.body.results[0].code, 'INTEGRITY_FAILED');
  } finally {
    await application.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('缺少 baseUrl 与未知路由返回明确错误状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ingest-err-'));
  const application = await startApplication({ directory });
  try {
    const missing = await fetch(`${application.url}/api/source/objects`);
    assert.equal(missing.status, 422);
    const noRoute = await fetch(`${application.url}/nope`);
    assert.equal(noRoute.status, 404);
    const badMode = await postJson(`${application.url}/api/ingest`, { baseUrl: 'http://127.0.0.1:1', mode: 'weird' });
    assert.equal(badMode.status, 422);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('重开存储后自动收件历史仍可回查，且与人工收件互不干扰', async () => {
  const source = await startProvider();
  const directory = await mkdtemp(join(tmpdir(), 'ingest-reopen-'));
  const application = await startApplication({ directory });
  try {
    await postJson(`${application.url}/api/ingest`, {
      baseUrl: source.url, labelPath: LABEL_PATH, objectIds: ['measurements'],
    });
    const manual = await postJson(`${application.url}/api/manual`, {
      record: { observationId: 'p17:table:0', product: 'urn:demo:obs:17::1.0', measurements: [12, null] },
      evidence: [{ source: 'operator:receipt', bytesBase64: Buffer.from('x').toString('base64') }],
    });
    assert.equal(manual.status, 201);
  } finally {
    await application.close();
    await source.close();
  }
  const reopened = await startApplication({ directory });
  try {
    const ingests = await (await fetch(`${reopened.url}/api/ingests`)).json();
    assert.equal(ingests.length, 1);
    assert.equal(ingests[0].summary.published, 1);
    const records = await (await fetch(`${reopened.url}/api/records`)).json();
    assert.equal(records.length, 1);
    assert.equal(records[0].key, 'p17:table:0');
  } finally {
    await reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});
