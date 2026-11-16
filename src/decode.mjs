// 二进制字段解码。严格按契约：先在原始值层面识别 Special_Constants，
// 命中则保留常量种类且不套 scaling_factor/value_offset；正常值才做线性换算。
// 每个字段同时保留原始值、换算结果和在原文件中的实际字节位置。
// 解码分两步：先在“领取缓冲区本地坐标”读取，再整体平移为整文件绝对字节位置。

const readers = {
  UnsignedMSB4: (buffer, offset) => buffer.readUInt32BE(offset),
  UnsignedLSB2: (buffer, offset) => buffer.readUInt16LE(offset),
  IEEE754LSBSingle: (buffer, offset) => buffer.readFloatLE(offset),
};

// 特殊常量按字段原始数据类型解释后与原始值比较：
// 例如 IEEE754LSBSingle 字段的 -9999 应解释为 float32 再比较，而非按整数严格相等。
function matchesSpecial(raw, constant, dataType) {
  if (dataType === 'IEEE754LSBSingle') {
    const expected = Math.fround(constant.rawValue);
    return Math.fround(raw) === expected;
  }
  return raw === constant.rawValue;
}

function decodeField(field, buffer, localOffset) {
  const position = {
    fileOffset: localOffset, // 调用方负责平移为绝对位置
    length: field.length,
    parentLocation: field.location, // 1 起始，相对所属记录/组
    parentOffset: field.relativeOffset, // 0 起始，相对所属记录/组
  };
  const reader = readers[field.dataType];
  if (!reader) {
    return {
      kind: 'field',
      name: field.name,
      dataType: field.dataType,
      position,
      error: `数据类型不在支持范围：${field.dataType}`,
    };
  }
  const raw = reader(buffer, localOffset);
  const base = {
    kind: 'field',
    name: field.name,
    dataType: field.dataType,
    position,
    raw,
  };
  // 特殊常量先于比例/偏移识别，命中的常量不参与线性换算。
  const hit = field.specialConstants.find(constant => matchesSpecial(raw, constant, field.dataType));
  if (hit) {
    return {
      ...base,
      special: true,
      specialKind: hit.kind,
      specialConstantName: hit.constantName,
      value: null,
    };
  }
  const scaled = field.scalingFactor === null && field.valueOffset === null
    ? raw
    : raw * (field.scalingFactor ?? 1) + (field.valueOffset ?? 0);
  return {
    ...base,
    special: false,
    scalingFactor: field.scalingFactor,
    valueOffset: field.valueOffset,
    value: scaled,
  };
}

// parentLocalOffset：当前父结构（记录或重复组实例）在缓冲区内的本地偏移。
function decodeGroup(group, buffer, parentLocalOffset, repetitionPath = []) {
  const repetitions = [];
  for (let repetition = 0; repetition < group.repetitions; repetition += 1) {
    const groupLocalOffset = parentLocalOffset + group.relativeOffset + repetition * group.span;
    const path = [...repetitionPath, { group: group.name, index: repetition }];
    const members = group.members.map(member => (member.kind === 'field'
      ? decodeField(member, buffer, groupLocalOffset + member.relativeOffset)
      : decodeGroup(member, buffer, groupLocalOffset, path)));
    repetitions.push({
      kind: 'groupRepetition',
      group: group.name,
      repetition,
      path,
      position: {
        fileOffset: groupLocalOffset,
        length: group.span,
        parentLocation: group.location,
        parentOffset: group.relativeOffset,
      },
      members,
    });
  }
  return {
    kind: 'group',
    name: group.name,
    repetitions: group.repetitions,
    path: repetitionPath,
    entries: repetitions,
  };
}

function decodeRecord(table, recordIndex, buffer, recordLocalOffset) {
  const members = table.members.map(member => (member.kind === 'field'
    ? decodeField(member, buffer, recordLocalOffset + member.relativeOffset)
    : decodeGroup(member, buffer, recordLocalOffset)));
  return {
    kind: 'record',
    recordIndex,
    objectId: table.objectId,
    position: { fileOffset: recordLocalOffset, length: table.recordLength },
    members,
  };
}

// 把缓冲区内的本地偏移整体平移为整文件绝对字节位置。
function shiftToAbsolute(node, delta) {
  if (node.position) node.position.fileOffset += delta;
  if (node.kind === 'record' || node.kind === 'groupRepetition') {
    for (const member of node.members ?? []) shiftToAbsolute(member, delta);
  }
  if (node.kind === 'group') {
    for (const entry of node.entries ?? []) shiftToAbsolute(entry, delta);
  }
}

// 在一段连续记录缓冲区内解码一个记录窗口。
// buffer 从文件 bufferFileBegin 处开始；输出位置统一为整文件绝对坐标。
export function decodeWindow(table, window, buffer, bufferFileBegin) {
  const out = [];
  for (let step = 0; step < window.count; step += 1) {
    const recordIndex = window.start + step;
    const recordAbsoluteOffset = table.offset + recordIndex * table.recordLength;
    const recordLocalOffset = recordAbsoluteOffset - bufferFileBegin;
    if (recordLocalOffset < 0 || recordLocalOffset + table.recordLength > buffer.length) {
      throw Object.assign(new Error('领取的字节范围不覆盖目标记录，拒绝越界解码'), { code: 'RANGE_GAP' });
    }
    const record = decodeRecord(table, recordIndex, buffer, recordLocalOffset);
    shiftToAbsolute(record, bufferFileBegin);
    out.push(record);
  }
  return out;
}
