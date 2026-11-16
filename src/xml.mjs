// 最小化 XML 解析器：仅服务于合作契约范围内的 PDS4 标签。
// 不解析 DTD、不加载外部实体、不处理自定义实体扩展，避免不可信资料的 XXE/实体炸弹风险。
// 命名空间按标准 URI 处理，元素暴露 localName/namespace，属性暴露限定名与本地名。

const PREDEFINED_ENTITIES = {
  lt: '<', gt: '>', amp: '&', apos: "'", quot: '"',
};

class XmlError extends Error {
  constructor(message, lineNumber) {
    super(lineNumber == null ? message : `${message}（第 ${lineNumber} 行）`);
    this.name = 'XmlError';
  }
}

function isNameStart(code) {
  return code === 0x3a || code === 0x5f || // : _
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code >= 0xc0;
}

function isNameChar(code) {
  return isNameStart(code) || code === 0x2d || code === 0x2e || (code >= 0x30 && code <= 0x39);
}

function decodeEntities(text, lineOf) {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z_][\w.-]*));/g, (whole, dec, hex, named) => {
    if (dec != null) return String.fromCodePoint(Number(dec));
    if (hex != null) return String.fromCodePoint(parseInt(hex, 16));
    if (Object.hasOwn(PREDEFINED_ENTITIES, named)) return PREDEFINED_ENTITIES[named];
    throw new XmlError(`不支持的 XML 实体：${whole}`, lineOf());
  });
}

export function parseXml(input) {
  const source = typeof input === 'string' ? input : new TextDecoder().decode(input);
  const length = source.length;
  let index = 0;
  const line = () => source.slice(0, index).split('\n').length;

  function skipMisc() {
    for (;;) {
      const at = index;
      if (source.startsWith('<!--', index)) {
        const end = source.indexOf('-->', index + 4);
        if (end === -1) throw new XmlError('XML 注释没有闭合', line());
        index = end + 3;
      } else if (source.startsWith('<?', index)) {
        const end = source.indexOf('?>', index + 2);
        if (end === -1) throw new XmlError('XML 处理指令没有闭合', line());
        index = end + 2;
      } else if (/\s/.test(source[index] ?? '')) {
        index += 1;
      }
      if (at === index) return;
    }
  }

  function parseAttributes() {
    const attributes = {};
    for (;;) {
      skipMisc();
      if (source[index] === '>') return attributes;
      if (source[index] === '/' && source[index + 1] === '>') return attributes;
      if (index >= length) throw new XmlError('元素属性没有结束', line());
      const nameStart = index;
      while (index < length && isNameChar(source.charCodeAt(index))) index += 1;
      const qualified = source.slice(nameStart, index);
      if (!qualified) throw new XmlError('属性名无法识别', line());
      skipMisc();
      if (source[index] !== '=') throw new XmlError(`属性 ${qualified} 缺少等号`, line());
      index += 1;
      skipMisc();
      const quote = source[index];
      if (quote !== '"' && quote !== "'") throw new XmlError(`属性 ${qualified} 缺少引号`, line());
      index += 1;
      const valueStart = index;
      while (index < length && source[index] !== quote) {
        if (source[index] === '<') throw new XmlError(`属性 ${qualified} 的值中出现非法字符 <`, line());
        index += 1;
      }
      if (index >= length) throw new XmlError(`属性 ${qualified} 的值没有闭合`, line());
      const rawValue = source.slice(valueStart, index);
      index += 1;
      const local = qualified.includes(':') ? qualified.slice(qualified.indexOf(':') + 1) : qualified;
      const value = decodeEntities(rawValue, line);
      // 结构化属性，避免本地名与子元素同名时互相覆盖。
      attributes[qualified] = { name: qualified, localName: local, value };
    }
  }

  function parseElement(parentNamespaces = {}) {
    if (source[index] !== '<') throw new XmlError('元素应以 < 开始', line());
    index += 1;
    const nameStart = index;
    while (index < length && isNameChar(source.charCodeAt(index))) index += 1;
    const qualified = source.slice(nameStart, index);
    if (!qualified || !isNameStart(qualified.charCodeAt(0))) throw new XmlError('元素名无法识别', line());
    const attributes = parseAttributes();
    const namespaces = { ...parentNamespaces };
    for (const attributeName of Object.keys(attributes)) {
      const attribute = attributes[attributeName];
      if (attributeName === 'xmlns') namespaces[''] = attribute.value;
      else if (attributeName.startsWith('xmlns:')) namespaces[attributeName.slice(6)] = attribute.value;
    }
    const prefix = qualified.includes(':') ? qualified.slice(0, qualified.indexOf(':')) : '';
    const node = {
      qualifiedName: qualified,
      localName: prefix ? qualified.slice(prefix.length + 1) : qualified,
      prefix,
      namespace: namespaces[prefix] ?? null,
      namespaces,
      attributes,
      children: [],
      text: '',
    };
    if (source.startsWith('/>', index)) {
      index += 2;
      return node;
    }
    if (source[index] !== '>') throw new XmlError(`元素 ${qualified} 没有正确开始`, line());
    index += 1;
    const textParts = [];
    for (;;) {
      if (index >= length) throw new XmlError(`元素 ${qualified} 没有闭合`, line());
      if (source.startsWith('</', index)) {
        index += 2;
        const closeStart = index;
        while (index < length && isNameChar(source.charCodeAt(index))) index += 1;
        const closeName = source.slice(closeStart, index);
        if (closeName !== qualified) throw new XmlError(`元素 ${qualified} 的闭合标签不匹配：${closeName}`, line());
        skipMisc();
        if (source[index] !== '>') throw new XmlError(`元素 ${qualified} 的闭合标签缺少 >`, line());
        index += 1;
        node.text = decodeEntities(textParts.join('').trim(), line);
        return node;
      }
      if (source.startsWith('<!--', index) || source.startsWith('<?', index)) {
        skipMisc();
        continue;
      }
      if (source.startsWith('<![', index)) throw new XmlError('不支持 CDATA 或条件节', line());
      if (source[index] === '<') {
        const child = parseElement(namespaces);
        node.children.push(child);
        continue;
      }
      const textStart = index;
      while (index < length && source[index] !== '<') index += 1;
      textParts.push(source.slice(textStart, index));
    }
  }

  skipMisc();
  if (source.startsWith('<!DOCTYPE', index) || source.startsWith('<!doctype', index)) {
    throw new XmlError('PDS4 标签禁止 DTD：不解析外部或内部 DTD', line());
  }
  if (source[index] !== '<') throw new XmlError('文档应以 XML 声明或根元素开始', line());
  const root = parseElement();
  skipMisc();
  if (index < length) throw new XmlError('根元素之后仍有内容', line());
  return root;
}

export function children(node, localName) {
  if (localName === undefined) return node.children;
  return node.children.filter(child => child.localName === localName);
}

export function firstChild(node, localName) {
  return node.children.find(child => child.localName === localName) ?? null;
}

export function childText(node, localName) {
  const child = firstChild(node, localName);
  return child ? child.text : null;
}

// 按限定名或本地名读取属性值；不存在时返回 fallback。
export function attr(node, name, fallback = null) {
  const hit = node.attributes[name] ?? Object.values(node.attributes).find(attribute => attribute.localName === name);
  return hit ? hit.value : fallback;
}
