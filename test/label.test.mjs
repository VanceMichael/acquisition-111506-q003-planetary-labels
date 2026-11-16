import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, firstChild, children, childText, attr } from '../src/xml.mjs';
import { parseLabel, normalizeWindow, windowByteRange, SUPPORTED_TYPES } from '../src/label.mjs';
import { readFile } from 'node:fs/promises';

const fixtureLabel = () => readFile(new URL('../fixtures/product.xml', import.meta.url));

test('解析命名空间、嵌套元素与属性，保留本地名和层级', async () => {
  const root = parseXml(await fixtureLabel());
  assert.equal(root.localName, 'Product_Observational');
  assert.equal(root.namespace, 'http://pds.nasa.gov/pds4/pds/v1');
  const area = firstChild(root, 'File_Area_Observational');
  const tables = children(area, 'Table_Binary');
  assert.equal(tables.length, 2);
  const file = firstChild(area, 'File');
  assert.equal(childText(file, 'file_name'), 'measure.bin');
  assert.equal(attr(firstChild(file, 'file_size'), 'unit'), 'byte');
});

test('Special_Constants 与深层嵌套 Group_Field_Binary 不丢失', async () => {
  const model = parseLabel(await fixtureLabel());
  const table = model.objects.find(object => object.localIdentifier === 'measurements');
  assert.equal(table.supported, true);
  const readings = table.members.find(member => member.kind === 'group');
  assert.equal(readings.repetitions, 2);
  const temperature = readings.members.find(member => member.kind === 'field' && member.name === 'temperature');
  assert.deepEqual(temperature.specialConstants, [{ kind: 'missing', constantName: 'missing_constant', rawValue: -9999 }]);
  const flags = readings.members.find(member => member.kind === 'group');
  assert.equal(flags.name, 'flags');
  assert.equal(flags.repetitions, 3);
  assert.equal(flags.span, 2);
  assert.equal(flags.length, 6);
});

test('布局：记录跨度、组跨度和相对偏移与标签声明一致', async () => {
  const model = parseLabel(await fixtureLabel());
  const table = model.objects.find(object => object.localIdentifier === 'measurements');
  assert.equal(table.recordLength, 28);
  assert.equal(table.records, 2);
  assert.equal(table.offset, 0);
  const readings = table.members.find(member => member.kind === 'group');
  assert.equal(readings.relativeOffset, 4);
  assert.equal(readings.length, 24);
  const observation = table.members.find(member => member.kind === 'field');
  assert.equal(observation.relativeOffset, 0);
  assert.equal(observation.length, 4);
});

test('保留产品版本与对象标识：URN 与 local_identifier/位置共同构成身份', async () => {
  const model = parseLabel(await fixtureLabel());
  assert.equal(model.product.urn, 'urn:demo:obs:17::1.0');
  assert.equal(model.product.versionId, '1.0');
  const ids = model.objects.map(object => object.objectId);
  assert.deepEqual(ids, ['urn:demo:obs:17::1.0#measurements', 'urn:demo:obs:17::1.0#unsupported-note']);
});

test('未知字段类型的对象标记为不支持并给出可定位原因，不影响其他对象', async () => {
  const model = parseLabel(await fixtureLabel());
  const supported = model.objects.find(object => object.localIdentifier === 'measurements');
  const unsupported = model.objects.find(object => object.localIdentifier === 'unsupported-note');
  assert.equal(supported.supported, true);
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.reasons.join(' '), /Custom_Note/);
  assert.match(unsupported.reasons.join(' '), /unsupported-note/);
});

test('字段长度与类型不符、记录跨度冲突、计数不符都会登记原因', () => {
  const label = `<?xml version="1.0"?><Product_Observational xmlns="http://pds.nasa.gov/pds4/pds/v1">
  <Identification_Area><logical_identifier>urn:x:bad</logical_identifier><version_id>2.0</version_id><product_class>Product_Observational</product_class></Identification_Area>
  <File_Area_Observational><File><file_name>x.bin</file_name><file_size unit="byte">8</file_size><md5_checksum>${'a'.repeat(32)}</md5_checksum></File>
  <Table_Binary><local_identifier>t</local_identifier><offset unit="byte">0</offset><records>1</records>
    <Record_Binary><fields>1</fields><groups>0</groups><record_length unit="byte">99</record_length>
      <Field_Binary><name>f</name><field_location unit="byte">1</field_location><data_type>UnsignedLSB2</data_type><field_length unit="byte">4</field_length></Field_Binary>
    </Record_Binary></Table_Binary></File_Area_Observational></Product_Observational>`;
  const model = parseLabel(label);
  const table = model.objects[0];
  assert.equal(table.supported, false);
  const reason = table.reasons.join(' ');
  assert.match(reason, /field_length=4/);
  assert.match(reason, /record_length=4，标签声明=99/);
});

test('支持类型清单固定在契约范围内', () => {
  assert.deepEqual(Object.keys(SUPPORTED_TYPES).sort(), ['IEEE754LSBSingle', 'UnsignedLSB2', 'UnsignedMSB4'].sort());
});

test('记录窗口归一化与字节区间计算', async () => {
  const model = parseLabel(await fixtureLabel());
  const table = model.objects.find(object => object.localIdentifier === 'measurements');
  assert.deepEqual(normalizeWindow(undefined, 2), { start: 0, count: 2 });
  assert.deepEqual(normalizeWindow({ start: 1 }, 2), { start: 1, count: 1 });
  assert.throws(() => normalizeWindow({ start: 5 }, 2), /起点无效/);
  assert.throws(() => normalizeWindow({ start: 0, count: 0 }, 2), /数量无效/);
  assert.throws(() => normalizeWindow({ start: 1, count: 5 }, 2), /数量无效/);
  assert.deepEqual(windowByteRange(table, { start: 1, count: 1 }), { begin: 28, end: 55 });
});

test('XML 安全：拒绝 DTD、外部实体引用和未声明实体', () => {
  assert.throws(() => parseXml('<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r/>'), /禁止 DTD/);
  assert.throws(() => parseXml('<r xmlns="x"><a>&undeclared;</a></r>'), /不支持的 XML 实体/);
  assert.throws(() => parseXml('<r xmlns="x"><a>text'), /没有闭合/);
  // 预定义实体仍可用
  assert.equal(childText(parseXml('<r xmlns="x"><a>1 &lt; 2</a></r>'), 'a'), '1 < 2');
});

test('非契约命名空间和非观测产品类被识别为范围外', () => {
  const label = '<Product_Observational xmlns="http://example.com/other"><Identification_Area><logical_identifier>urn:x:o</logical_identifier><version_id>1.0</version_id></Identification_Area><File_Area_Observational><File><file_name>x</file_name><file_size unit="byte">0</file_size><md5_checksum>00000000000000000000000000000000</md5_checksum></File></File_Area_Observational></Product_Observational>';
  const model = parseLabel(label);
  assert.match(model.issues.join(' '), /命名空间不在契约范围/);
});
