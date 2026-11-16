
import { createHash } from 'node:crypto';
import { mkdir, readFile, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function readJournal(file) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}

export async function openStore(directory) {
  await mkdir(join(directory, 'blobs'), { recursive: true });
  const journal = join(directory, 'receipts.jsonl');
  const ingestJournal = join(directory, 'ingests.jsonl');
  let receipts = await readJournal(journal);
  let ingests = await readJournal(ingestJournal);
  let pending = Promise.resolve();
  const serialize = operation => {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  };
  const saveBlob = async (directoryPath, ref, bytes) => {
    try {
      await writeFile(join(directoryPath, 'blobs', ref.sha256), bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  };
  return {
    list() {
      const latest = new Map();
      for (const receipt of receipts) latest.set(receipt.key, receipt);
      return structuredClone([...latest.values()]);
    },
    history(key) {
      return structuredClone(receipts.filter(receipt => receipt.key === key));
    },
    listIngests() {
      return structuredClone(ingests);
    },
    ingest(ingestId) {
      const found = ingests.find(receipt => receipt.ingestId === ingestId);
      return found ? structuredClone(found) : null;
    },
    async evidence(sha) {
      if (!/^[a-f0-9]{64}$/.test(sha)) throw Object.assign(new Error('依据标识无效'), { status: 400 });
      return readFile(join(directory, 'blobs', sha));
    },
    // 自动收件：结构化结果与原始字节都落盘；字节经 sha256 内容寻址，与人工收件共用 blob 目录。
    acceptIngest(receipt, identity, blobs) {
      return serialize(async () => {
        if (!Array.isArray(blobs) || blobs.length === 0) {
          throw Object.assign(new Error('自动收件缺少标签或数据原始字节'), { status: 422 });
        }
        for (const blob of blobs) {
          if (!Buffer.isBuffer(blob.bytes) || !/^[a-f0-9]{64}$/.test(blob.sha256) || digest(blob.bytes) !== blob.sha256) {
            throw Object.assign(new Error('自动收件字节与摘要不一致，拒绝落盘'), { status: 422 });
          }
        }
        const existing = ingests.find(item => item.identity === identity);
        if (existing) return { ...structuredClone(existing), duplicate: true };
        for (const blob of blobs) await saveBlob(directory, { sha256: blob.sha256 }, blob.bytes);
        // 原始字节已按内容寻址存入 blobs 目录，结构化收据不内嵌字节，避免 JSON 膨胀。
        const receiptWithoutBlobs = structuredClone(receipt);
        delete receiptWithoutBlobs.blobs;
        const stored = { ingestId: `ing-${ingests.length + 1}`, sequence: ingests.length + 1, identity, ...receiptWithoutBlobs };
        await appendFile(ingestJournal, JSON.stringify(stored) + '\n');
        ingests.push(stored);
        return { ...structuredClone(stored), duplicate: false };
      });
    },
    accept(key, record, evidence) {
      return serialize(async () => {
        if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 30) {
          throw Object.assign(new Error('收件需要原始依据，单次不超过30份'), { status: 422 });
        }
        const prepared = evidence.map(item => {
          if (!item || typeof item.source !== 'string' || !item.source.trim() || typeof item.bytesBase64 !== 'string') {
            throw Object.assign(new Error('依据必须包含来源和原始字节'), { status: 422 });
          }
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.bytesBase64)) {
            throw Object.assign(new Error('依据不是标准Base64'), { status: 422 });
          }
          const bytes = Buffer.from(item.bytesBase64, 'base64');
          const sha256 = digest(bytes);
          if (item.sha256 && item.sha256 !== sha256) throw Object.assign(new Error('依据哈希不匹配'), { status: 422 });
          return { bytes, ref: { source: item.source, mediaType: item.mediaType ?? 'application/octet-stream', sha256, size: bytes.length } };
        });
        const refs = prepared.map(item => item.ref);
        const identity = digest(JSON.stringify({ key, record, refs }));
        const existing = receipts.find(receipt => receipt.identity === identity);
        if (existing) return { ...structuredClone(existing), duplicate: true };
        for (const item of prepared) {
          try {
            await writeFile(join(directory, 'blobs', item.ref.sha256), item.bytes, { flag: 'wx' });
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }
        }
        const receipt = { sequence: receipts.length + 1, identity, key, record: structuredClone(record), evidence: refs, receivedAt: new Date().toISOString() };
        await appendFile(journal, JSON.stringify(receipt) + '\n');
        receipts.push(receipt);
        return { ...structuredClone(receipt), duplicate: false };
      });
    },
    flush() { return pending; },
  };
}
