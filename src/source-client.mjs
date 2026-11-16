// 合作来源 HTTP 客户端：只使用契约声明的交互（Range、ETag、If-Match、206/Content-Range）。
// 文件地址相对标签 URL 解析。所有字节领取都绑定来源的 ETag；
// 局部读取只声明片段级校验，绝不声称已验证未读全文的 MD5。

import { createHash } from 'node:crypto';

export class SourceError extends Error {
  constructor(message, { status, code, url } = {}) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    this.code = code;
    this.url = url;
  }
}

export function resolveDataUrl(labelUrl, fileName) {
  return new URL(encodeURI(fileName).replace(/%2F/g, '/'), labelUrl);
}

async function httpFetch(url, headers) {
  let response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    throw new SourceError(`来源连接失败：${error.message}`, { status: 502, code: 'SOURCE_UNREACHABLE', url: String(url) });
  }
  return response;
}

function quotedEtag(value) {
  if (!value) return null;
  return value.startsWith('"') ? value : `"${value}"`;
}

function withIfMatch(ifMatch, extra = {}) {
  const quoted = quotedEtag(ifMatch);
  return quoted ? { ...extra, 'if-match': quoted } : extra;
}

export function createSourceClient(baseUrl) {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  // 领取标签全文。标签本身作为原始依据保存，并记录 ETag。
  async function fetchLabel(labelPath) {
    const url = new URL(labelPath, root);
    const response = await httpFetch(url, { accept: 'application/xml' });
    if (response.status === 412) {
      throw new SourceError('标签版本与预期不符（If-Match 412）', { status: 412, code: 'LABEL_PRECONDITION', url: String(url) });
    }
    if (!response.ok) {
      throw new SourceError(`标签领取失败：HTTP ${response.status}`, { status: response.status, code: 'LABEL_FETCH', url: String(url) });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return { bytes, etag: response.headers.get('etag'), mediaType: response.headers.get('content-type') ?? 'application/xml', url: String(url) };
  }

  // 按字节区间领取数据，返回 206 并核对 Content-Range 与实际长度。
  async function fetchRange(dataUrl, begin, end, ifMatch) {
    const response = await httpFetch(dataUrl, withIfMatch(ifMatch, {
      range: `bytes=${begin}-${end}`,
    }));
    if (response.status === 412) {
      throw new SourceError('数据版本已变化：If-Match 预检失败，拒绝按旧范围读取', { status: 412, code: 'DATA_VERSION_CHANGED', url: String(dataUrl) });
    }
    if (response.status !== 206) {
      throw new SourceError(`来源未按契约返回 206，实际 HTTP ${response.status}`, { status: response.status, code: 'RANGE_UNSUPPORTED', url: String(dataUrl) });
    }
    const contentRange = response.headers.get('content-range') ?? '';
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);
    if (!match) {
      throw new SourceError('206 响应缺少可解析的 Content-Range', { status: 502, code: 'BAD_CONTENT_RANGE', url: String(dataUrl) });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const rangeStart = Number(match[1]);
    const rangeEnd = Number(match[2]);
    const totalSize = match[3] === '*' ? null : Number(match[3]);
    if (rangeStart !== begin || rangeEnd !== end || bytes.length !== end - begin + 1) {
      throw new SourceError('返回字节区间与请求不一致，拒绝使用', { status: 502, code: 'RANGE_MISMATCH', url: String(dataUrl) });
    }
    return {
      bytes,
      etag: response.headers.get('etag'),
      totalSize,
      begin,
      end,
      mode: 'range',
      url: String(dataUrl),
    };
  }

  // 全文领取：仅在拿到完整文件时才能核对标签声明的 file_size 与 MD5。
  async function fetchFull(dataUrl, ifMatch) {
    const response = await httpFetch(dataUrl, withIfMatch(ifMatch));
    if (response.status === 412) {
      throw new SourceError('数据版本已变化：If-Match 预检失败，拒绝按旧范围读取', { status: 412, code: 'DATA_VERSION_CHANGED', url: String(dataUrl) });
    }
    if (!response.ok) {
      throw new SourceError(`数据全文领取失败：HTTP ${response.status}`, { status: response.status, code: 'DATA_FETCH', url: String(dataUrl) });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return { bytes, etag: response.headers.get('etag'), totalSize: bytes.length, begin: 0, end: bytes.length - 1, mode: 'full', url: String(dataUrl) };
  }

  return { root, fetchLabel, fetchRange, fetchFull };
}

// 完整性判定。全文模式校验标签声明的文件大小与 MD5；局部模式只能做片段级核对。
export function evaluateIntegrity(label, fetched) {
  const declaredSize = label.dataFile?.fileSize ?? null;
  const declaredMd5 = label.dataFile?.md5 ?? null;
  const checks = [];
  if (fetched.totalSize !== null && declaredSize !== null && fetched.totalSize !== declaredSize) {
    return {
      level: 'failed',
      checks: [...checks, { check: 'file_size', ok: false, expected: declaredSize, actual: fetched.totalSize }],
      reason: `来源文件大小 ${fetched.totalSize} 与标签声明 ${declaredSize} 不一致`,
    };
  }
  if (fetched.mode === 'full') {
    checks.push({ check: 'file_size', ok: declaredSize === null || fetched.bytes.length === declaredSize, expected: declaredSize, actual: fetched.bytes.length });
    const actualMd5 = createHash('md5').update(fetched.bytes).digest('hex');
    const md5Ok = declaredMd5 !== null && actualMd5 === declaredMd5;
    checks.push({ check: 'md5_checksum', ok: md5Ok, expected: declaredMd5, actual: actualMd5 });
    if (!checks.every(item => item.ok)) {
      return { level: 'failed', checks, reason: '完整文件与标签声明（file_size/MD5）不一致' };
    }
    return {
      level: 'full',
      checks,
      md5Verified: true,
      reason: '已领取全文并通过标签 file_size 与 MD5 校验',
    };
  }
  // 局部读取：未读全文，按契约不得声称已验证 MD5。
  checks.push({ check: 'content_range', ok: true, begin: fetched.begin, end: fetched.end });
  checks.push({ check: 'md5_checksum', ok: false, note: '仅读取局部字节，未读全文，无法核对整文件 MD5' });
  return {
    level: 'partial',
    checks,
    md5Verified: false,
    reason: '片段经 Content-Range 与长度核对；整文件 MD5 未验证（未读全文）',
  };
}
