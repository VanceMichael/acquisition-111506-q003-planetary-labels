import test from 'node:test';
import assert from 'node:assert/strict';
import { startProvider } from '../provider/source.mjs';

test("来源实际交互保持已声明的语义", async () => {
  const source = await startProvider();
  try {
    const label = await (await fetch(`${source.url}/products/17/label.xml`)).text();
    assert.match(label, /Group_Field_Binary/);
    const range = await fetch(`${source.url}/products/17/measure.bin`, { headers: { range: 'bytes=0-27', 'if-match': '"data-v1"' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), 'bytes 0-27/56');
    assert.equal((await range.arrayBuffer()).byteLength, 28);
    assert.equal((await fetch(`${source.url}/products/17/measure.bin`, { headers: { 'if-match': '"wrong"' } })).status, 412);
  } finally { await source.close(); }
});
