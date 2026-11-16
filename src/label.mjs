// PDS4 Product_Observational 标签建模。
// 支持范围严格限定 docs/source-contract.md：File_Area_Observational 中的 Table_Binary，
// Record_Binary、Field_Binary、嵌套 Group_Field_Binary，以及三种字段类型。
// 不支持的对象保留可定位原因，不影响同一产品中的其他对象。

import { parseXml, children, firstChild, childText } from './xml.mjs';

export const PDS4_NAMESPACE = 'http://pds.nasa.gov/pds4/pds/v1';
export const SUPPORTED_TYPES = {
  UnsignedMSB4: { length: 4 },
  UnsignedLSB2: { length: 2 },
  IEEE754LSBSingle: { length: 4 },
};

const integer = (value, what, issues) => {
  if (!/^[+-]?\d+$/.test(value ?? '')) {
    issues.push(`${what} 不是整数：${value ?? '缺失'}`);
    return null;
  }
  return Number(value);
};

const decimal = value => (value === null || value === '' ? null : Number(value));

function parseSpecialConstants(fieldNode) {
  const holder = firstChild(fieldNode, 'Special_Constants');
  if (!holder) return [];
  return holder.children.map(node => ({
    kind: node.localName.endsWith('_constant') ? node.localName.slice(0, -'_constant'.length) : node.localName,
    constantName: node.localName,
    rawValue: Number(node.text),
  }));
}

function parseField(fieldNode, path, issues) {
  const name = childText(fieldNode, 'name') ?? '';
  const location = integer(childText(fieldNode, 'field_location'), `${path}/field[${name}] 的 field_location`, issues);
  const length = integer(childText(fieldNode, 'field_length'), `${path}/field[${name}] 的 field_length`, issues);
  const dataType = childText(fieldNode, 'data_type') ?? '';
  const scalingFactor = decimal(childText(fieldNode, 'scaling_factor'));
  const valueOffset = decimal(childText(fieldNode, 'value_offset'));
  const specialConstants = parseSpecialConstants(fieldNode);
  const supported = Object.hasOwn(SUPPORTED_TYPES, dataType)
    && length !== null && length === SUPPORTED_TYPES[dataType].length;
  if (!Object.hasOwn(SUPPORTED_TYPES, dataType)) {
    issues.push(`${path}/field[${name}] 数据类型不在支持范围：${dataType || '缺失'}`);
  } else if (length !== SUPPORTED_TYPES[dataType].length) {
    issues.push(`${path}/field[${name}] 的 field_length=${length} 与 ${dataType} 要求的 ${SUPPORTED_TYPES[dataType].length} 字节不符`);
  }
  for (const constant of specialConstants) {
    if (!Number.isFinite(constant.rawValue)) {
      issues.push(`${path}/field[${name}] 的特殊常量 ${constant.constantName} 不是数值：${firstChild(fieldNode, 'Special_Constants').text}`);
    }
  }
  return {
    kind: 'field',
    name,
    dataType,
    supported,
    location, // PDS 约定：父结构内从 1 开始
    relativeOffset: location === null ? null : location - 1, // 父结构内从 0 开始
    length,
    scalingFactor,
    valueOffset,
    specialConstants,
  };
}

// 递归解析重复组；成员按标签出现顺序保留，位置均相对所属记录或组。
function parseGroup(groupNode, path, issues) {
  const name = childText(groupNode, 'name') ?? '';
  const groupPath = `${path}/group[${name}]`;
  const location = integer(childText(groupNode, 'group_location'), `${groupPath} 的 group_location`, issues);
  const repetitions = integer(childText(groupNode, 'repetitions'), `${groupPath} 的 repetitions`, issues);
  const declaredLength = integer(childText(groupNode, 'group_length'), `${groupPath} 的 group_length`, issues);
  const declaredFields = integer(childText(groupNode, 'fields'), `${groupPath} 的 fields`, issues);
  const declaredGroups = integer(childText(groupNode, 'groups'), `${groupPath} 的 groups`, issues);
  const members = groupNode.children
    .filter(node => node.localName === 'Field_Binary' || node.localName === 'Group_Field_Binary')
    .map((node, index) => node.localName === 'Field_Binary'
      ? parseField(node, `${groupPath}[${index}]`, issues)
      : parseGroup(node, `${groupPath}[${index}]`, issues));
  const fieldCount = members.filter(member => member.kind === 'field').length;
  const groupCount = members.filter(member => member.kind === 'group').length;
  if (declaredFields !== null && declaredFields !== fieldCount) {
    issues.push(`${groupPath} 声明 fields=${declaredFields}，实际字段数=${fieldCount}`);
  }
  if (declaredGroups !== null && declaredGroups !== groupCount) {
    issues.push(`${groupPath} 声明 groups=${declaredGroups}，实际嵌套组数=${groupCount}`);
  }
  const span = computeSpan(members, groupPath, issues);
  const computedLength = span * (repetitions ?? 0);
  if (declaredLength !== null && computedLength !== declaredLength) {
    issues.push(`${groupPath} 依据成员计算 group_length=${computedLength}，标签声明=${declaredLength}`);
  }
  return {
    kind: 'group',
    name,
    location,
    relativeOffset: location === null ? null : location - 1,
    repetitions,
    declaredLength,
    length: computedLength,
    span,
    members,
  };
}

// 单次重复（或单条记录）内成员布局的总跨度，并检查成员互不重叠。
function computeSpan(members, path, issues) {
  let cursor = 0;
  let span = 0;
  for (const member of members) {
    if (member.relativeOffset === null || member.length === null) continue;
    if (member.relativeOffset < cursor) {
      issues.push(`${path}/${member.kind}[${member.name}] 位置 ${member.location} 与前序成员重叠`);
    }
    cursor = member.relativeOffset;
    const end = cursor + member.length;
    if (end > span) span = end;
  }
  return span;
}

function parseTable(tableNode, productUrn, issues) {
  const localIdentifier = childText(tableNode, 'local_identifier');
  const objectPath = `${productUrn}#${localIdentifier ?? '未知local_identifier'}`;
  const tableIssues = [];
  if (!localIdentifier) tableIssues.push('Table_Binary 缺少 local_identifier，无法构成对象标识');
  const offset = integer(childText(tableNode, 'offset'), `${objectPath} 的 offset`, tableIssues);
  const records = integer(childText(tableNode, 'records'), `${objectPath} 的 records`, tableIssues);
  const recordNode = firstChild(tableNode, 'Record_Binary');
  if (!recordNode) {
    tableIssues.push(`${objectPath} 缺少 Record_Binary`);
    issues.push(...tableIssues);
    return {
      kind: 'Table_Binary',
      localIdentifier: localIdentifier ?? null,
      objectId: objectPath,
      supported: false,
      reasons: tableIssues,
      offset, records, recordLength: null, members: [],
    };
  }
  const recordLength = integer(childText(recordNode, 'record_length'), `${objectPath} 的 record_length`, tableIssues);
  const declaredFields = integer(childText(recordNode, 'fields'), `${objectPath} 的 fields`, tableIssues);
  const declaredGroups = integer(childText(recordNode, 'groups'), `${objectPath} 的 groups`, tableIssues);
  const members = recordNode.children
    .filter(node => node.localName === 'Field_Binary' || node.localName === 'Group_Field_Binary')
    .map((node, index) => node.localName === 'Field_Binary'
      ? parseField(node, `${objectPath}/record[${index}]`, tableIssues)
      : parseGroup(node, `${objectPath}/record[${index}]`, tableIssues));
  const fieldCount = members.filter(member => member.kind === 'field').length;
  const groupCount = members.filter(member => member.kind === 'group').length;
  if (declaredFields !== null && declaredFields !== fieldCount) {
    tableIssues.push(`${objectPath} 记录声明 fields=${declaredFields}，实际字段数=${fieldCount}`);
  }
  if (declaredGroups !== null && declaredGroups !== groupCount) {
    tableIssues.push(`${objectPath} 记录声明 groups=${declaredGroups}，实际组数=${groupCount}`);
  }
  const computedRecordLength = computeSpan(members, `${objectPath}/record`, tableIssues);
  if (recordLength !== null && computedRecordLength !== recordLength) {
    tableIssues.push(`${objectPath} 依据成员计算 record_length=${computedRecordLength}，标签声明=${recordLength}`);
  }
  const supported = tableIssues.length === 0
    && members.every(function walk(member) {
      if (member.kind === 'field') return member.supported;
      return member.members.every(walk);
    });
  issues.push(...tableIssues);
  return {
    kind: 'Table_Binary',
    localIdentifier: localIdentifier ?? null,
    objectId: objectPath,
    supported,
    reasons: tableIssues,
    offset,
    records,
    recordLength: recordLength ?? computedRecordLength,
    members,
  };
}

export function parseLabel(labelBytes) {
  const root = parseXml(labelBytes);
  const issues = [];
  if (root.localName !== 'Product_Observational') {
    issues.push(`根元素不是 Product_Observational：${root.qualifiedName}`);
  }
  if (root.namespace && root.namespace !== PDS4_NAMESPACE) {
    issues.push(`命名空间不在契约范围：${root.namespace}`);
  }
  const identification = firstChild(root, 'Identification_Area');
  const logicalIdentifier = identification ? childText(identification, 'logical_identifier') : null;
  const versionId = identification ? childText(identification, 'version_id') : null;
  const productClass = identification ? childText(identification, 'product_class') : null;
  const informationModelVersion = identification ? childText(identification, 'information_model_version') : null;
  if (!logicalIdentifier) issues.push('Identification_Area 缺少 logical_identifier');
  if (!versionId) issues.push('Identification_Area 缺少 version_id');
  if (productClass && productClass !== 'Product_Observational') {
    issues.push(`product_class 不在支持范围：${productClass}`);
  }
  const urn = logicalIdentifier && versionId ? `${logicalIdentifier}::${versionId}` : null;

  const area = firstChild(root, 'File_Area_Observational');
  if (!area) {
    issues.push('缺少 File_Area_Observational');
    return {
      rootName: root.qualifiedName,
      product: { logicalIdentifier, versionId, productClass, informationModelVersion, urn },
      dataFile: null,
      objects: [],
      issues,
    };
  }
  const fileNode = firstChild(area, 'File');
  const dataFile = fileNode ? {
    fileName: childText(fileNode, 'file_name'),
    fileSize: integer(childText(fileNode, 'file_size'), 'File/file_size', issues),
    md5: childText(fileNode, 'md5_checksum'),
  } : null;
  if (!fileNode) issues.push('File_Area_Observational 缺少 File 声明');
  if (fileNode && !/^[a-f0-9]{32}$/.test(dataFile.md5 ?? '')) {
    issues.push('File 缺少有效的 md5_checksum 声明');
  }
  const objects = children(area, 'Table_Binary').map(tableNode => parseTable(tableNode, urn ?? '未知产品', issues));
  // 契约范围外的其他对象（如注释类对象若不是 Table_Binary）同样登记为不可收，而不是伪装成空测量。
  const knownKinds = new Set(['File', 'Table_Binary']);
  for (const node of area.children.filter(node => !knownKinds.has(node.localName))) {
    const local = childText(node, 'local_identifier');
    objects.push({
      kind: node.localName,
      localIdentifier: local ?? null,
      objectId: `${urn ?? '未知产品'}#${local ?? node.localName}`,
      supported: false,
      reasons: [`对象类 ${node.localName} 不在合作契约支持范围（仅 Table_Binary）`],
      offset: null, records: null, recordLength: null, members: [],
    });
  }
  return {
    rootName: root.qualifiedName,
    product: { logicalIdentifier, versionId, productClass, informationModelVersion, urn },
    dataFile,
    objects,
    issues,
  };
}

// 记录窗口归一化：start 从 0 开始；省略 count 时读到最后一条。
export function normalizeWindow(requested, records) {
  const start = requested?.start ?? 0;
  if (!Number.isInteger(start) || start < 0 || start >= records) {
    throw Object.assign(new Error(`记录窗口起点无效：${requested?.start}`), { status: 422 });
  }
  const count = requested?.count ?? records - start;
  if (!Number.isInteger(count) || count <= 0 || start + count > records) {
    throw Object.assign(new Error(`记录窗口数量无效：${requested?.count}`), { status: 422 });
  }
  return { start, count };
}

// 计算记录窗口在数据文件中需要领取的字节跨度（合并为单个连续区间）。
export function windowByteRange(table, window) {
  const begin = table.offset + window.start * table.recordLength;
  return { begin, end: begin + window.count * table.recordLength - 1 };
}
