// 自动收件编排：按标签选择测量对象，领取对应字节并解码为结构化结果。
// 关键约束：
// - 对象之间相互隔离：一个对象损坏或不支持，只在自身结果中留下可定位原因；
// - 数据版本用 ETag 绑定，If-Match 失败即拒绝，绝不沿用旧字节范围；
// - 只有能证明标签与数据相符（全文 MD5/大小，或片段级核对）的结果才标记 published；
// - 局部读取不声称整文件 MD5 已验证。

import { createHash } from 'node:crypto';
import { parseLabel, normalizeWindow, windowByteRange } from './label.mjs';
import { decodeWindow } from './decode.mjs';
import { createSourceClient, evaluateIntegrity, resolveDataUrl, SourceError } from './source-client.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export { createSourceClient, resolveDataUrl, SourceError };

// 只做标签层面的对象盘点，不下载数据文件。
export async function catalogObjects({ client, labelPath }) {
  const label = await client.fetchLabel(labelPath);
  const model = parseLabel(label.bytes);
  return {
    labelUrl: label.url,
    labelEtag: label.etag,
    product: model.product,
    dataFile: model.dataFile,
    labelIssues: model.issues,
    objects: model.objects.map(object => ({
      objectId: object.objectId,
      kind: object.kind,
      localIdentifier: object.localIdentifier,
      supported: object.supported,
      reasons: object.reasons,
      records: object.records,
      recordLength: object.recordLength,
      offset: object.offset,
    })),
  };
}

function selectObjects(model, requestedIds) {
  if (!requestedIds || requestedIds.length === 0) return model.objects;
  const uniqueIds = [...new Set(requestedIds)];
  return uniqueIds.map(id => {
    const found = model.objects.find(object => object.objectId === id || object.localIdentifier === id);
    if (found) return found;
    return {
      kind: 'Table_Binary',
      localIdentifier: null,
      objectId: id,
      supported: false,
      reasons: [`标签中不存在该对象标识：${id}`],
      offset: null, records: null, recordLength: null, members: [], missing: true,
    };
  });
}

// 主流程。mode：'full'（默认，可做 MD5 证明）或 'range'（只领取记录窗口）。
export async function runIngest({ baseUrl, labelPath, objectIds = [], window: requestedWindow, mode = 'full', client = createSourceClient(baseUrl) }) {
  if (!labelPath) throw Object.assign(new Error('缺少标签地址 labelPath'), { status: 422 });
  if (!['full', 'range'].includes(mode)) throw Object.assign(new Error(`未知领取模式：${mode}`), { status: 422 });

  const label = await client.fetchLabel(labelPath);
  const labelSha = sha256(label.bytes);
  const model = parseLabel(label.bytes);
  const chosen = selectObjects(model, objectIds);
  const dataUrl = model.dataFile?.fileName ? resolveDataUrl(new URL(label.url), model.dataFile.fileName) : null;

  // 按“数据文件 URL + 字节区间”缓存领取，并在一次收件内固定首个数据 ETag；
  // 后续请求带 If-Match，版本变化（412）即由客户端拒绝，绝不沿用旧范围。
  const fetchCache = new Map();
  const etagPins = new Map();
  const fetchFor = async (object, window) => {
    if (!dataUrl) throw new SourceError('标签缺少 File/file_name，无法定位数据文件', { code: 'NO_DATA_FILE', url: label.url });
    const urlKey = String(dataUrl);
    let cacheKey;
    let task;
    if (mode === 'full') {
      cacheKey = `${urlKey}#full`;
      if (fetchCache.has(cacheKey)) return fetchCache.get(cacheKey);
      task = (async () => {
        const fetched = await client.fetchFull(dataUrl, etagPins.get(urlKey));
        etagPins.set(urlKey, fetched.etag);
        return { fetched, integrity: evaluateIntegrity(model, fetched) };
      })();
    } else {
      const range = windowByteRange(object, window);
      cacheKey = `${urlKey}#${range.begin}-${range.end}`;
      if (fetchCache.has(cacheKey)) return fetchCache.get(cacheKey);
      task = (async () => {
        const fetched = await client.fetchRange(dataUrl, range.begin, range.end, etagPins.get(urlKey));
        etagPins.set(urlKey, fetched.etag);
        return { fetched, integrity: evaluateIntegrity(model, fetched) };
      })();
    }
    fetchCache.set(cacheKey, task);
    return task;
  };

  const results = [];
  for (const object of chosen) {
    const startedAt = new Date().toISOString();
    const reject = (code, reasons, extra = {}) => results.push({
      objectId: object.objectId,
      localIdentifier: object.localIdentifier,
      status: 'rejected',
      code,
      reasons: Array.isArray(reasons) ? reasons : [reasons],
      receivedAt: startedAt,
      ...extra,
    });

    if (object.missing) {
      reject('OBJECT_NOT_FOUND', object.reasons);
      continue;
    }
    if (!object.supported) {
      reject('UNSUPPORTED_OBJECT', object.reasons, { kind: object.kind });
      continue;
    }

    let window;
    try {
      window = normalizeWindow(requestedWindow, object.records);
    } catch (error) {
      reject('INVALID_WINDOW', error.message, { status: error.status });
      continue;
    }

    let fetched;
    let integrity;
    try {
      ({ fetched, integrity } = await fetchFor(object, window));
    } catch (error) {
      if (error instanceof SourceError) {
        reject(error.code, error.message, { httpStatus: error.status });
        continue;
      }
      throw error;
    }

    // ETag 变化（If-Match 412 已在客户端拒绝）；再防御性核对窗口落在已领缓冲区内。
    if (integrity.level === 'failed') {
      reject('INTEGRITY_FAILED', integrity.reason, { integrity });
      continue;
    }

    let records;
    try {
      const { begin } = mode === 'full'
        ? { begin: 0 }
        : windowByteRange(object, window);
      records = decodeWindow(object, window, fetched.bytes, mode === 'full' ? object.offset : begin);
    } catch (error) {
      reject('DECODE_FAILED', error.message);
      continue;
    }

    results.push({
      objectId: object.objectId,
      localIdentifier: object.localIdentifier,
      status: 'published',
      code: 'PUBLISHED',
      reasons: [],
      kind: object.kind,
      window,
      integrity,
      dataEtag: fetched.etag,
      dataUrl: fetched.url,
      recordCount: records.length,
      records,
      receivedAt: startedAt,
    });
  }

  // 原始依据：标签全文 + 实际领取的数据字节（全文或片段）。blobs 供收件端内容寻址落盘。
  const evidence = [{
    source: label.url,
    mediaType: label.mediaType,
    sha256: labelSha,
    size: label.bytes.length,
    role: 'pds4-label',
    etag: label.etag,
  }];
  const blobs = [{ role: 'pds4-label', sha256: labelSha, bytes: label.bytes }];
  for (const task of fetchCache.values()) {
    try {
      const { fetched } = await task;
      const dataSha = sha256(fetched.bytes);
      evidence.push({
        source: fetched.url,
        mediaType: 'application/octet-stream',
        sha256: dataSha,
        size: fetched.bytes.length,
        role: fetched.mode === 'full' ? 'data-full' : 'data-range',
        etag: fetched.etag,
        range: fetched.mode === 'range' ? { begin: fetched.begin, end: fetched.end, totalSize: fetched.totalSize } : undefined,
      });
      blobs.push({ role: fetched.mode === 'full' ? 'data-full' : 'data-range', sha256: dataSha, bytes: fetched.bytes });
    } catch {
      // 失败对象的原因已在 results 中；拿不到字节时不伪造依据。
    }
  }

  const published = results.filter(result => result.status === 'published');
  const rejected = results.filter(result => result.status !== 'published');
  const receipt = {
    product: model.product,
    labelUrl: label.url,
    labelEtag: label.etag,
    labelIssues: model.issues,
    dataFile: model.dataFile,
    mode,
    summary: {
      requested: chosen.length,
      published: published.length,
      rejected: rejected.length,
    },
    results,
    evidence,
    blobs,
    fetchedAt: new Date().toISOString(),
  };
  return receipt;
}

// 供持久层计算稳定身份：同标签、同对象选择、同窗口、同模式、同依据摘要幂等。
export function ingestIdentity(receipt) {
  const evidenceRefs = receipt.evidence.map(item => ({ source: item.source, sha256: item.sha256, range: item.range ?? null }));
  const selection = receipt.results.map(item => ({ objectId: item.objectId, status: item.status, window: item.window ?? null, etag: item.dataEtag ?? null }));
  return sha256(JSON.stringify({
    product: receipt.product.urn,
    mode: receipt.mode,
    selection,
    evidence: evidenceRefs,
  }));
}
