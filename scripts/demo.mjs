
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApplication } from '../src/server.mjs';
import { startProvider } from '../provider/source.mjs';
import { product } from '../src/domain.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const source = await startProvider();
const application = await startApplication({ directory });
const postJson = async (path, body) => {
  const response = await fetch(`${application.url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
try {
  const fixture = await readFile(new URL('../fixtures/manual.json', import.meta.url));
  const record = JSON.parse(fixture);
  console.log(`${product}：人工收件 + PDS4 标签自动收件端到端演示`);
  console.log('本地来源状态', await (await fetch(`${source.url}/health`)).text());

  // 一、人工收件保持原有语义
  const manualBody = { record, evidence: [{ source: 'operator:local', bytesBase64: fixture.toString('base64'), mediaType: 'application/json' }] };
  const manual = await postJson('/api/manual', manualBody);
  console.log('人工收件', JSON.stringify({ status: manual.status, key: manual.body.key, duplicate: manual.body.duplicate }));

  // 二、按标签盘点可选择的测量对象（不下载数据文件）
  const catalog = await (await fetch(`${application.url}/api/source/objects?baseUrl=${encodeURIComponent(source.url)}`)).json();
  console.log('标签对象盘点', JSON.stringify(catalog.objects.map(o => ({ id: o.localIdentifier, supported: o.supported, reasons: o.reasons }))));

  // 三、全文自动收件：只发布能证明标签与数据相符的对象
  const full = await postJson('/api/ingest', { baseUrl: source.url, objectIds: ['measurements', 'unsupported-note'] });
  if (!full.status.toString().startsWith('2')) throw new Error(JSON.stringify(full.body));
  const published = full.body.results.find(r => r.status === 'published');
  const rejected = full.body.results.find(r => r.status === 'rejected');
  const special = published.records[0].members.find(m => m.kind === 'group').entries[1].members[0];
  console.log('全文自动收件', JSON.stringify({
    status: full.status, ingestId: full.body.ingestId, summary: full.body.summary,
    integrity: published.integrity.level, md5Verified: published.integrity.md5Verified,
  }));
  console.log('  特殊常量字段', JSON.stringify({ name: special.name, raw: special.raw, specialKind: special.specialKind, value: special.value }));
  console.log('  被拒对象保留原因', JSON.stringify({ id: rejected.localIdentifier, code: rejected.code, reasons: rejected.reasons }));

  // 原始依据（标签与数据全文）按摘要回查
  for (const ref of full.body.evidence) {
    const bytes = Buffer.from(await (await fetch(`${application.url}/api/evidence/${ref.sha256}`)).arrayBuffer());
    console.log('  依据回查', JSON.stringify({ role: ref.role, sha256: ref.sha256.slice(0, 12), bytesMatch: bytes.length === ref.size }));
  }

  // 四、记录窗口局部领取：只声明片段完整性，不冒充整文件 MD5
  const ranged = await postJson('/api/ingest', {
    baseUrl: source.url, objectIds: ['measurements'], window: { start: 1, count: 1 }, mode: 'range',
  });
  const rangeResult = ranged.body.results[0];
  console.log('局部窗口收件', JSON.stringify({
    status: ranged.status, window: rangeResult.window, integrity: rangeResult.integrity.level,
    md5Verified: rangeResult.integrity.md5Verified, recordOffset: rangeResult.records[0].position.fileOffset,
  }));

  // 五、同件重复收件幂等
  const again = await postJson('/api/ingest', { baseUrl: source.url, objectIds: ['measurements', 'unsupported-note'] });
  console.log('重复自动收件', JSON.stringify({ status: again.status, duplicate: again.body.duplicate, ingestId: again.body.ingestId }));

  console.log('收件历史数量', (await (await fetch(`${application.url}/api/ingests`)).json()).length);
} finally {
  await application.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
