import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../provider/source.mjs';
import { createSourceClient, runIngest, catalogObjects } from '../src/ingest.mjs';
import { parseLabel } from '../src/label.mjs';
import { decodeWindow } from '../src/decode.mjs';
import { startApplication } from '../src/server.mjs';
import { digest } from '../src/store.mjs';

const LABEL_PATH = '/products/17/label.xml';
const labelBytes = await readFile(new URL('../fixtures/product.xml', import.meta.url));
const measureB64 = JSON.parse(await readFile(new URL('../fixtures/measure.json', import.meta.url))).base64;
const measureBytes = Buffer.from(measureB64, 'base64');

function findField(record, name) {
  for (const member of record.members) {
    if (member.kind === 'field' && member.name === name) return member;
    if (member.kind === 'group') {
      for (const entry of member.entries) {
        const hit = entry.members.find(m => m.kind === 'field' && m.name === name);
        if (hit) return hit;
      }
    }
  }
  return null;
}

test('全文收件：三种类型解码、比例偏移、绝对字节位置与父子组关系', async () => {
  const source = await startProvider();
  try {
    const receipt = await runIngest({ baseUrl: source.url, labelPath: LABEL_PATH, objectIds: ['measurements'] });
    const published = receipt.results[0];
    assert.equal(published.status, 'published');
    assert.equal(published.integrity.level, 'full');
    assert.equal(published.integrity.md5Verified, true);
    assert.equal(published.recordCount, 2);

    const [r0, r1] = published.records;
    assert.equal(r0.recordIndex, 0);
    assert.deepEqual(r0.position, { fileOffset: 0, length: 28 });
    assert.deepEqual(r1.position, { fileOffset: 28, length: 28 });

    // UnsignedMSB4
    assert.equal(findField(r0, 'observation').value, 17);
    assert.equal(findField(r0, 'observation').position.fileOffset, 0);
    assert.equal(findField(r1, 'observation').value, 18);

    const readings0 = r0.members.find(m => m.kind === 'group');
    assert.equal(readings0.name, 'readings');
    assert.equal(readings0.entries.length, 2);
    // IEEE754LSBSingle + scaling 2 + offset 10：2.5 -> 15
    const temp0 = readings0.entries[0].members[0];
    assert.equal(temp0.raw, 2.5);
    assert.equal(temp0.value, 15);
    assert.equal(temp0.position.fileOffset, 4);
    // UnsignedLSB2 quality
    assert.equal(readings0.entries[0].members[1].value, 1);
    assert.equal(readings0.entries[0].members[1].dataType, 'UnsignedLSB2');

    // 嵌套 flags 组保持父记录关系，位置为整文件绝对偏移
    const flags = readings0.entries[0].members.find(m => m.kind === 'group');
    assert.equal(flags.name, 'flags');
    assert.deepEqual(flags.entries.map(e => e.repetition), [0, 1, 2]);
    assert.deepEqual(flags.entries.map(e => e.members[0].value), [11, 12, 13]);
    assert.deepEqual(flags.entries.map(e => e.members[0].position.fileOffset), [10, 12, 14]);
    // 第二个 reading 的 flags 偏移随父组平移
    const flags1 = readings0.entries[1].members.find(m => m.kind === 'group');
    assert.deepEqual(flags1.entries.map(e => e.members[0].position.fileOffset), [22, 24, 26]);
  } finally {
    await source.close();
  }
});

test('特殊常量先于比例偏移识别：-9999 标记为 missing 且不被换算', async () => {
  const source = await startProvider();
  try {
    const receipt = await runIngest({ baseUrl: source.url, labelPath: LABEL_PATH, objectIds: ['measurements'] });
    const r0 = receipt.results[0].records[0];
    const special = r0.members.find(m => m.kind === 'group').entries[1].members[0];
    assert.equal(special.raw, -9999);
    assert.equal(special.special, true);
    assert.equal(special.specialKind, 'missing');
    assert.equal(special.specialConstantName, 'missing_constant');
    assert.equal(special.value, null);
    // 同字段正常值仍正常换算
    const normal = r0.members.find(m => m.kind === 'group').entries[0].members[0];
    assert.equal(normal.special, false);
    assert.equal(normal.value, 15);
  } finally {
    await source.close();
  }
});

test('局部领取只声明片段完整性，绝不声称整文件 MD5 已验证', async () => {
  const source = await startProvider();
  try {
    const receipt = await runIngest({
      baseUrl: source.url, labelPath: LABEL_PATH, objectIds: ['measurements'],
      window: { start: 1, count: 1 }, mode: 'range',
    });
    const published = receipt.results[0];
    assert.equal(published.status, 'published');
    assert.equal(published.integrity.level, 'partial');
    assert.equal(published.integrity.md5Verified, false);
    const dataEvidence = receipt.evidence.find(e => e.role === 'data-range');
    assert.deepEqual(dataEvidence.range, { begin: 28, end: 55, totalSize: 56 });
    assert.equal(dataEvidence.size, 28);
    // 解码位置仍是整文件绝对偏移
    assert.equal(published.records[0].position.fileOffset, 28);
    assert.equal(findField(published.records[0], 'observation').position.fileOffset, 28);
  } finally {
    await source.close();
  }
});

test('对象隔离：不支持与不存在的对象留下可定位原因，独立对象照常发布', async () => {
  const source = await startProvider();
  try {
    const receipt = await runIngest({
      baseUrl: source.url, labelPath: LABEL_PATH,
      objectIds: ['measurements', 'unsupported-note', 'ghost-object'],
    });
    assert.equal(receipt.summary.published, 1);
    assert.equal(receipt.summary.rejected, 2);
    const byId = Object.fromEntries(receipt.results.map(r => [r.localIdentifier ?? r.objectId, r]));
    assert.equal(byId.measurements.status, 'published');
    assert.equal(byId['unsupported-note'].status, 'rejected');
    assert.equal(byId['unsupported-note'].code, 'UNSUPPORTED_OBJECT');
    assert.match(byId['unsupported-note'].reasons.join(' '), /Custom_Note/);
    const ghost = receipt.results.find(r => r.code === 'OBJECT_NOT_FOUND');
    assert.match(ghost.reasons.join(' '), /ghost-object/);
  } finally {
    await source.close();
  }
});

test('默认选择全部对象时，注释对象不被伪装成空测量记录', async () => {
  const source = await startProvider();
  try {
    const catalog = await catalogObjects({ client: createSourceClient(source.url), labelPath: LABEL_PATH });
    assert.equal(catalog.objects.length, 2);
    const note = catalog.objects.find(o => o.localIdentifier === 'unsupported-note');
    assert.equal(note.supported, false);
    const receipt = await runIngest({ baseUrl: source.url, labelPath: LABEL_PATH });
    assert.deepEqual(receipt.summary, { requested: 2, published: 1, rejected: 1 });
  } finally {
    await source.close();
  }
});

test('数据版本变化：全文大小/MD5 不符与 ETag 预检失败都拒绝，不沿用旧范围', async () => {
  const source = await startProvider({ scenario: 'changed' });
  try {
    const first = await runIngest({ baseUrl: source.url, labelPath: LABEL_PATH, objectIds: ['measurements'] });
    assert.equal(first.results[0].status, 'published');
    assert.equal(first.results[0].dataEtag, '"data-v1"');
    // 第二次文件请求换成更大版本，标签仍声明 56 字节
    const second = await runIngest({ baseUrl: source.url, labelPath: LABEL_PATH, objectIds: ['measurements'] });
    assert.equal(second.results[0].status, 'rejected');
    assert.equal(second.results[0].code, 'INTEGRITY_FAILED');
    assert.match(second.results[0].reasons.join(' '), /84/);

    // 显式 If-Match：用旧 ETag 请求已变化的来源应得到 412
    const client = createSourceClient(source.url);
    const label = await client.fetchLabel(LABEL_PATH);
    const url = new URL('measure.bin', label.url);
    await assert.rejects(client.fetchRange(url, 0, 27, '"data-v1"'), error => error.code === 'DATA_VERSION_CHANGED' && error.status === 412);
  } finally {
    await source.close();
  }
});

test('标签声明 MD5 与损坏数据不符时拒绝发布', async () => {
  const source = await startProvider();
  try {
    const client = createSourceClient(source.url);
    const label = await client.fetchLabel(LABEL_PATH);
    const url = new URL('measure.bin', label.url);
    const full = await client.fetchFull(url);
    const corrupted = Buffer.from(full.bytes);
    corrupted[0] ^= 0xff;
    const model = parseLabel(label.bytes);
    const { evaluateIntegrity } = await import('../src/source-client.mjs');
    const integrity = evaluateIntegrity(model, { ...full, bytes: corrupted });
    assert.equal(integrity.level, 'failed');
    assert.equal(integrity.checks.find(c => c.check === 'md5_checksum').ok, false);
  } finally {
    await source.close();
  }
});

test('Content-Range 与请求区间不一致时客户端拒绝', async () => {
  // 构造一个返回错误 Content-Range 的假来源
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.url.endsWith('label.xml')) {
      res.writeHead(200, { 'content-type': 'application/xml', etag: '"l"' });
      return res.end(labelBytes);
    }
    res.writeHead(206, { 'content-range': 'bytes 5-9/56', etag: '"d"' });
    res.end(measureBytes.subarray(0, 5));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const receipt = await runIngest({
      baseUrl: `http://127.0.0.1:${port}`, labelPath: LABEL_PATH,
      objectIds: ['measurements'], window: { start: 0, count: 1 }, mode: 'range',
    });
    assert.equal(receipt.results[0].code, 'RANGE_MISMATCH');
    assert.equal(receipt.results[0].status, 'rejected');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('窗口非法以对象级原因返回；来源不可达在标签阶段明确报错', async () => {
  const source = await startProvider();
  try {
    const badWindow = await runIngest({
      baseUrl: source.url, labelPath: LABEL_PATH,
      objectIds: ['measurements'], window: { start: 99, count: 1 }, mode: 'range',
    });
    assert.equal(badWindow.results[0].code, 'INVALID_WINDOW');
  } finally {
    await source.close();
  }
  // 标签都无法领取时不存在可发布对象，明确抛出可识别的来源错误而非静默成功
  await assert.rejects(
    runIngest({ baseUrl: 'http://127.0.0.1:1', labelPath: LABEL_PATH, objectIds: ['measurements'] }),
    error => error.name === 'SourceError' && error.code === 'SOURCE_UNREACHABLE',
  );
});

test('解码单元：缓冲区本地坐标与整文件绝对位置分离', () => {
  const model = parseLabel(labelBytes);
  const table = model.objects.find(o => o.localIdentifier === 'measurements');
  // 只领取第二条记录的 28 字节片段
  const slice = measureBytes.subarray(28);
  const records = decodeWindow(table, { start: 1, count: 1 }, slice, 28);
  assert.equal(records[0].position.fileOffset, 28);
  assert.equal(findField(records[0], 'observation').value, 18);
  assert.equal(findField(records[0], 'observation').position.fileOffset, 28);
});
