import { LingoList, LingoPropList, type LingoValue } from "./lingo-runtime.js";

function nodeValue(node: Node): LingoPropList {
  const names: LingoValue[] = [];
  const values: LingoValue[] = [];
  if (node instanceof Element) {
    for (const attr of Array.from(node.attributes)) {
      names.push(attr.name);
      values.push(attr.value);
    }
  }
  const children = Array.from(node.childNodes)
    .filter((child) => child.nodeType === Node.ELEMENT_NODE
      || (child.nodeType === Node.TEXT_NODE && Boolean(child.textContent?.trim())))
    .map(nodeValue);
  return new LingoPropList([
    "name", node.nodeType === Node.TEXT_NODE ? "#text" : node.nodeName,
    ...(node.nodeType === Node.TEXT_NODE ? ["text", node.textContent ?? ""] : []),
    "child", new LingoList(children),
    "attributeName", new LingoList(names),
    "attributeValue", new LingoList(values),
  ]);
}

/** DOM-backed implementation of LibreShockwave's registered xmlparser Xtra. */
export class BrowserXmlParserXtra {
  private root = new LingoPropList(["child", new LingoList()]);
  private error: string | undefined;

  get child(): LingoValue { return this.root.get("child"); }
  get name(): LingoValue { return this.root.get("name"); }
  get attributeName(): LingoValue { return this.root.get("attributeName"); }
  get attributeValue(): LingoValue { return this.root.get("attributeValue"); }

  parseString(value: LingoValue): number {
    this.error = undefined;
    const doc = new DOMParser().parseFromString(String(value ?? ""), "application/xml");
    const parseError = doc.querySelector("parsererror");
    if (parseError) {
      this.error = parseError.textContent ?? "Invalid XML";
      this.root = new LingoPropList(["child", new LingoList()]);
      return 0;
    }
    this.root = nodeValue(doc);
    return 1;
  }

  getError(): LingoValue { return this.error; }
  count(key?: LingoValue): number {
    const value = key === undefined ? this.root : this.root.get(key);
    return value instanceof LingoList || value instanceof LingoPropList ? value.count : 0;
  }
  getProp(key: LingoValue, index?: LingoValue): LingoValue {
    const value = this.root.get(key);
    return index !== undefined && value instanceof LingoList ? value.get(Number(index)) : value;
  }
  getPropRef(key: LingoValue, index?: LingoValue): LingoValue { return this.getProp(key, index); }
  getAProp(key: LingoValue, index?: LingoValue): LingoValue { return this.getProp(key, index); }
  getProperty(key: LingoValue, index?: LingoValue): LingoValue { return this.getProp(key, index); }
  getAt(key: LingoValue, index?: LingoValue): LingoValue { return this.getProp(key, index); }
}
