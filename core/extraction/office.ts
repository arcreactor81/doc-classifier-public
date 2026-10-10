import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { DigestInput, DigestHeading, DigestTable, DigestBlock } from '../digest/digest.ts';

type XmlNode = Record<string, unknown>;
const namespaces = new WeakMap<XmlNode, string>();
const namespaceScopes = new WeakMap<XmlNode, Readonly<Record<string, string>>>();

/** Document-level note: embedded content or an unfamiliar auxiliary structure cannot be fully interpreted here. */
export const EMBEDDED_UNREAD_NOTE = 'N_EXTRACTION_EMBEDDED_UNREAD';
/** Mathematical layout that this text reader cannot preserve; never an informational note. */
export const MATH_STRUCTURE_UNREAD_NOTE = 'N_MATH_STRUCTURE_UNREAD';
export interface ParsedDocument { fullText: string; outline: DigestInput; notes: string[] }
/**
 * Relationship-type suffixes of the XML parts the readers consume. Everything reachable through one of these from the
 * main part is loaded; images and embedded packages never are. Notes pages (`/notesSlide`) are deliberately absent:
 * speaker notes are not read (owner decision, 29 September 2026).
 */
export const OFFICE_PART_TYPES = /\/(?:slide|slideLayout|slideMaster|header|footer|footnotes|endnotes|styles|numbering|comments|chart|chartEx|diagramData)$/;

// ---------------------------------------------------------------------------------------------------------------
// XML access
// ---------------------------------------------------------------------------------------------------------------

function parse(xml: string): XmlNode[] {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error(`Invalid document XML: ${valid.err.code}`);
  // htmlEntities also decodes numeric character references (&#8217; &#x2013;), which Office writes for curly quotes and dashes.
  const nodes = new XMLParser({ preserveOrder: true, ignoreAttributes: false, removeNSPrefix: false, trimValues: false, parseTagValue: false, processEntities: true, htmlEntities: true }).parse(xml) as XmlNode[];
  function visit(items: XmlNode[], inherited: Record<string, string>): void {
    for (const node of items) {
      const scope = { ...inherited };
      for (const [key, value] of Object.entries((node[':@'] ?? {}) as Record<string, string>)) {
        if (key === '@_xmlns') scope[''] = value;
        else if (key.startsWith('@_xmlns:')) scope[key.slice(8)] = value;
      }
      const qualified = rawTag(node), prefix = qualified.includes(':') ? qualified.split(':')[0] : '';
      namespaces.set(node, scope[prefix] ?? '');
      namespaceScopes.set(node, scope);
      visit(children(node), scope);
    }
  }
  visit(nodes, {});
  return nodes;
}
const rawTag = (node: XmlNode) => Object.keys(node).find(key => key !== ':@') ?? '';
const tag = (node: XmlNode) => rawTag(node).split(':').at(-1)!;
const children = (node: XmlNode): XmlNode[] => Array.isArray(node[rawTag(node)]) ? node[rawTag(node)] as XmlNode[] : [];
function attr(node: XmlNode | undefined, key: string, namespacedOnly = false): string | undefined {
  const attributes = node?.[':@'] as Record<string, string> | undefined;
  if (!attributes) return undefined;
  if (!namespacedOnly && attributes['@_' + key] !== undefined) return attributes['@_' + key];
  const matching = Object.entries(attributes).filter(([name]) => name.startsWith('@_') && name.includes(':') && name.split(':').at(-1) === key);
  if (matching.length > 1) throw new Error('Ambiguous XML attribute namespace.');
  return matching[0]?.[1];
}
const child = (node: XmlNode | undefined, name: string): XmlNode | undefined => node && children(node).find(item => tag(item) === name);
/** The `w:val`-style value of a named child element. */
const val = (node: XmlNode | undefined, name: string): string | undefined => attr(child(node, name), 'val');
function required(parts: ReadonlyMap<string, string>, path: string): XmlNode[] {
  const xml = parts.get(path);
  if (xml === undefined) throw new Error(`Required document part is missing: ${path}`);
  return parse(xml);
}

const markupCompatibilityNamespace = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const drawing2010Namespace = 'http://schemas.microsoft.com/office/drawing/2010/main';
const extendedChartNamespace = 'http://schemas.microsoft.com/office/drawing/2014/chartex';
const supportedChoiceNamespaces = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main',
  'http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main',
  'http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
]);
const mathNamespaces = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/math', 'http://purl.oclc.org/ooxml/officeDocument/math']);
const wordNamespaces = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const drawingNamespaces = new Set(['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main']);
const textNamespaces = new Set([...wordNamespaces, ...drawingNamespaces, ...mathNamespaces]);
/** `w:t`, `a:t` and `m:t` carry displayed text; conventional prefixes are accepted alongside the namespace URIs. */
const textCarrier = (node: XmlNode) => tag(node) === 't' && (['w:t', 'a:t', 'm:t'].includes(rawTag(node)) || textNamespaces.has(namespaces.get(node) ?? ''));
const isMath = (node: XmlNode) => ['oMath', 'oMathPara'].includes(tag(node)) && (rawTag(node).startsWith('m:') || mathNamespaces.has(namespaces.get(node) ?? ''));
const literal = (node: XmlNode) => children(node).filter(item => rawTag(item) === '#text').map(item => String(item['#text'])).join('');
const hasReadableContent = (nodes: readonly XmlNode[]): boolean => nodes.some(node => textCarrier(node) || isMath(node) || hasReadableContent(children(node)));

/** Children of a node with `mc:AlternateContent` resolved to exactly one branch; never both. */
function contentChildren(node: XmlNode): XmlNode[] {
  if (namespaces.get(node) !== markupCompatibilityNamespace || tag(node) !== 'AlternateContent') return children(node);
  const branches = children(node);
  for (const choice of branches.filter(branch => namespaces.get(branch) === markupCompatibilityNamespace && tag(branch) === 'Choice')) {
    const requiredPrefixes = attr(choice, 'Requires');
    if (requiredPrefixes === undefined || requiredPrefixes.trim() === '') throw new Error('AlternateContent Choice Requires is missing or empty.');
    const scope = namespaceScopes.get(choice) ?? {};
    const uris = requiredPrefixes.trim().split(/\s+/).map(prefix => scope[prefix] ?? '');
    if (uris.every(uri => supportedChoiceNamespaces.has(uri))) return children(choice);
    // The supported extended-chart reference leads to cached chart XML, not the picture-only fallback.
    if (uris.every(uri => supportedChoiceNamespaces.has(uri) || uri === extendedChartNamespace) &&
        all(children(choice), 'chart').some(item => namespaces.get(item) === extendedChartNamespace)) return children(choice);
    // Office wraps equations (and some text) in a Choice requiring the 2010 drawing extensions; its Fallback is a picture.
    if (uris.every(uri => supportedChoiceNamespaces.has(uri) || uri === drawing2010Namespace) && hasReadableContent(children(choice))) return children(choice);
  }
  const fallback = branches.find(branch => namespaces.get(branch) === markupCompatibilityNamespace && tag(branch) === 'Fallback');
  if (fallback) return children(fallback);
  throw new Error('AlternateContent has no supported Choice or declared Fallback.');
}
/** Rejected structure is not guaranteed to have leaf text carriers: visit every descendant to retain its text. */
function readableText(nodes: readonly XmlNode[]): string {
  const fragments = (node: XmlNode): string[] => {
    if (rawTag(node) === '#text') {
      const text = String(node['#text']);
      return text.trim() ? [text] : [];
    }
    return contentChildren(node).flatMap(fragments);
  };
  return nodes.flatMap(fragments).join(' ');
}
const unreadMarker = (text: string) => `[Unread equation structure: ${text || '(no readable text)'}]`;
function all(nodes: readonly XmlNode[], name: string): XmlNode[] {
  return nodes.flatMap(node => [...(tag(node) === name ? [node] : []), ...all(contentChildren(node), name)]);
}
/** Descendants named `name`, descending through wrappers (content controls, custom XML, AlternateContent) but not into a match. */
function collect(nodes: readonly XmlNode[], name: string): XmlNode[] {
  return nodes.flatMap(node => tag(node) === name ? [node] : tag(node) === '#text' ? [] : collect(contentChildren(node), name));
}

// ---------------------------------------------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------------------------------------------

function resolvePart(base: string, target: string): string {
  if (/^[a-z]+:/i.test(target)) throw new Error('External document relationships are not supported.');
  const segments = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { if (!segments.length) throw new Error('Invalid document relationship path.'); segments.pop(); }
    else segments.push(segment);
  }
  return segments.join('/');
}
function relations(parts: ReadonlyMap<string, string>, base: string): XmlNode[] {
  const bits = base.split('/'); const file = bits.pop()!;
  const rel = parts.get([...bits, '_rels', `${file}.rels`].join('/'));
  return rel ? all(parse(rel), 'Relationship') : [];
}
const relationship = (rels: readonly XmlNode[], id: string | undefined) => id === undefined ? undefined : rels.find(rel => attr(rel, 'Id') === id);
const relationsOfType = (rels: readonly XmlNode[], suffix: string) => rels.filter(rel => attr(rel, 'Type')?.endsWith(`/${suffix}`) && attr(rel, 'Target') && attr(rel, 'TargetMode') !== 'External');
/** XML text parts reachable through content relationships; images are never read. */
export function relatedTextParts(xml: string, sourcePart: string): string[] {
  return all(parse(xml), 'Relationship').flatMap(rel => {
    const type = attr(rel, 'Type');
    const target = attr(rel, 'Target');
    if (!target || attr(rel, 'TargetMode') === 'External' || !type || !OFFICE_PART_TYPES.test(type)) return [];
    return [resolvePart(sourcePart, target)];
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Blocks and the accumulator
// ---------------------------------------------------------------------------------------------------------------

type Block =
  | { kind: 'text'; text: string; level?: number }
  | { kind: 'marker'; text: string; page?: boolean }
  | { kind: 'table'; rows: string[][]; header: number };
const textBlock = (text: string, level?: number): Block => ({ kind: 'text', text, ...(level !== undefined ? { level } : {}) });
const marker = (text: string): Block => ({ kind: 'marker', text });
/** Blocks rendered as one table cell: lines joined by newlines, nested tables flattened to tab-joined rows, page markers dropped. */
function cellText(blocks: readonly Block[]): string {
  return blocks.flatMap(block => block.kind === 'text' ? [block.text] : block.kind === 'marker' ? (block.page ? [] : [block.text]) : block.rows.map(row => row.join('\t'))).filter(line => line.trim()).join('\n');
}
class Accumulator {
  chunks: string[] = [];
  headings: DigestHeading[] = [];
  tables: DigestTable[] = [];
  blocks: DigestBlock[] = [];
  position = 0;
  currentHeading: string | undefined;
  add(text: string, level?: number): void {
    if (!text.trim()) return;
    const position = this.position;
    this.position += text.length + 1;
    this.chunks.push(text);
    if (level !== undefined) {
      this.currentHeading = `heading_${position}`;
      this.headings.push({ id: this.currentHeading, text, level, position });
    } else this.blocks.push({ text, position, ...(this.currentHeading ? { headingId: this.currentHeading } : {}) });
  }
  marker(value: string): void { this.chunks.push(value); this.position += value.length + 1; }
  table(rows: readonly (readonly string[])[], header: number): void {
    if (rows[header]) this.tables.push({ position: this.position, headers: rows[header] });
    for (const row of rows) this.add(row.join('\t'));
  }
  apply(blocks: readonly Block[]): void {
    for (const block of blocks) {
      if (block.kind === 'text') this.add(block.text, block.level);
      else if (block.kind === 'marker') this.marker(block.text);
      else this.table(block.rows, block.header);
    }
  }
  finish(title: string | undefined, notes: ReadonlySet<string>): ParsedDocument {
    return { fullText: this.chunks.join('\n'), outline: { ...(title ? { title } : {}), headings: this.headings, tables: this.tables, blocks: this.blocks }, notes: [...notes] };
  }
}
function metadataTitle(parts: ReadonlyMap<string, string>): string | undefined {
  const core = parts.get('docProps/core.xml');
  return core === undefined ? undefined : all(parse(core), 'title').map(literal).find(value => value.trim());
}

// ---------------------------------------------------------------------------------------------------------------
// Shared: equations, numbering formats, charts, SmartArt, alt text
// ---------------------------------------------------------------------------------------------------------------

/** A vertical shift of ordinary text (Word `vertAlign`, DrawingML `baseline`); the magnitude is layout and dropped. */
type Shift = 'sup' | 'sub';
interface Piece { text: string; shift?: Shift }
/**
 * Consecutive pieces shifted in one direction become one `^( )` / `_( )` group; leading and trailing whitespace of
 * the group stays outside, a whitespace-only group is plain whitespace, and no base is ever inferred (math-reading-policy-v1).
 */
function shiftedText(pieces: readonly Piece[]): string {
  let out = '';
  for (let index = 0; index < pieces.length;) {
    const shift = pieces[index].shift;
    let group = '';
    while (index < pieces.length && pieces[index].shift === shift) group += pieces[index++].text;
    if (!shift) { out += group; continue; }
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(group)!;
    out += core ? `${lead}${shift === 'sup' ? '^' : '_'}(${core})${trail}` : group;
  }
  return out;
}
type BaselineValue = string | null | undefined;
/** A DrawingML baseline is unqualified. A foreign or conflicting spelling is malformed, never an inherited absence. */
function drawingBaseline(properties: XmlNode | undefined): BaselineValue {
  if (!properties) return undefined;
  const attributes = Object.entries((properties[':@'] ?? {}) as Record<string, string>)
    .filter(([key]) => !key.startsWith('@_xmlns') && key.slice(2).split(':').at(-1) === 'baseline');
  if (!attributes.length) return undefined;
  return drawingNamespaces.has(namespaces.get(properties) ?? '') && attributes.length === 1 && attributes[0][0] === '@_baseline'
    ? attributes[0][1] : null;
}
const firstBaseline = (...values: BaselineValue[]): BaselineValue => values.find(value => value !== undefined);
/** DrawingML `baseline`: a signed decimal integer or declared decimal percentage; malformed values stop inheritance. */
function baselineShift(value: BaselineValue): Shift | undefined | null {
  if (value === undefined || value === null) return value;
  const lexical = value.trim();
  if (!/^[+-]?\d+$/.test(lexical) && !/^-?\d+(?:\.\d+)?%$/.test(lexical)) return null;
  const number = Number(lexical.replace(/%$/, ''));
  if (!Number.isFinite(number)) return null;
  return number > 0 ? 'sup' : number < 0 ? 'sub' : undefined;
}
/**
 * local-extractor-1.3.2 (math-reading-policy-v1): grouped OMML text, not a visual renderer. Operands and script
 * positions stay distinct. Only the structures in `structures` are supported. Unknown/malformed objects or properties
 * retain readable text in an explicit marker and add a review-forcing note; they are never silently flattened into a
 * valid-looking formula. Formatting Office writes into every equation (`w:rPr`/`a:rPr` inside `m:r`, `m:ctrlPr` inside
 * every property block, the `m:rPr` children sty/nor/lit/aln/brk) is dropped, never text.
 * Defaults follow the Microsoft OOXML references recorded in the extraction handoff; the n-ary, accent, group-character
 * and bar-position defaults were verified against Microsoft's ISO 29500 element documentation on 1 October 2026.
 */
function mathText(node: XmlNode, notes: Set<string>): string {
  const mathNode = (item: XmlNode) => mathNamespaces.has(namespaces.get(item) ?? '');
  const elements = (item: XmlNode) => children(item).filter(part => tag(part) !== '#text');
  /** `w:rPr` / `a:rPr` inside `m:r`: run formatting Office always writes; dropped. Any other foreign element still flags. */
  const foreignRunProperties = (part: XmlNode) => tag(part) === 'rPr' && !mathNode(part) &&
    (['w:rPr', 'a:rPr'].includes(rawTag(part)) || textNamespaces.has(namespaces.get(part) ?? ''));
  /** ST_OnOff in all six spellings; an element without `val` means true; anything else is undefined (flagged by the caller). */
  const onOff = (property: XmlNode | undefined, absent: boolean): boolean | undefined => {
    if (property === undefined) return absent;
    const value = attr(property, 'val');
    return value === undefined || ['1', 'true', 'on'].includes(value) ? true : ['0', 'false', 'off'].includes(value) ? false : undefined;
  };
  const attributesKnown = (item: XmlNode, allowed: readonly string[] = [], acceptedNamespaces: ReadonlySet<string> = mathNamespaces): boolean => {
    const keys = Object.keys((item[':@'] ?? {}) as Record<string, unknown>)
      .filter(key => key !== '@_xmlns' && !key.startsWith('@_xmlns:'));
    // A property cannot provide both val and m:val (or two aliases): never let attribute lookup choose one.
    if (new Set(keys.map(key => key.slice(2).split(':').at(-1))).size !== keys.length) return false;
    return keys.every(key => {
      const qualified = key.slice(2), bits = qualified.split(':');
      if (qualified === 'xml:space') return tag(item) === 't';
      return allowed.includes(bits.at(-1)!) && (bits.length === 1 || acceptedNamespaces.has(namespaceScopes.get(item)?.[bits[0]] ?? ''));
    });
  };
  const shape = (item: XmlNode, allowed: readonly string[], repeated: readonly string[] = [], ignored: (part: XmlNode) => boolean = () => false): boolean => {
    const parts = elements(item).filter(part => !ignored(part));
    return mathNode(item) && attributesKnown(item) &&
      children(item).every(part => tag(part) !== '#text' || !String(part['#text']).trim()) &&
      parts.every(part => mathNode(part) && allowed.includes(tag(part))) &&
      allowed.every(name => repeated.includes(name) || parts.filter(part => tag(part) === name).length <= 1);
  };
  const whitespaceOnly = (item: XmlNode) => children(item).every(part => tag(part) !== '#text' || !String(part['#text']).trim());
  const wordScalarProperties = new Set(['rStyle', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'effect', 'vertAlign', 'rtl', 'cs', 'em', 'specVanish', 'oMath']);
  const wordPropertyAttributes: Record<string, readonly string[]> = {
    rFonts: ['ascii', 'hAnsi', 'eastAsia', 'cs', 'asciiTheme', 'hAnsiTheme', 'eastAsiaTheme', 'cstheme', 'hint'],
    color: ['val', 'themeColor', 'themeTint', 'themeShade'],
    u: ['val', 'color', 'themeColor', 'themeTint', 'themeShade'],
    bdr: ['val', 'sz', 'space', 'color', 'themeColor', 'themeTint', 'themeShade', 'frame', 'shadow'],
    shd: ['val', 'color', 'fill', 'themeColor', 'themeTint', 'themeShade', 'themeFill', 'themeFillTint', 'themeFillShade'],
    fitText: ['val', 'id'], lang: ['val', 'eastAsia', 'bidi'],
    eastAsianLayout: ['id', 'combine', 'combineBrackets', 'vert', 'vertCompress'],
  };
  const drawingRunAttributes = ['kumimoji', 'lang', 'altLang', 'sz', 'b', 'i', 'u', 'strike', 'kern', 'cap', 'spc', 'normalizeH', 'baseline', 'noProof', 'dirty', 'err', 'smtClean', 'smtId', 'bmk'];
  const drawingColorAttributes: Record<string, readonly string[]> = {
    srgbClr: ['val'], scrgbClr: ['r', 'g', 'b'], hslClr: ['hue', 'sat', 'lum'], sysClr: ['val', 'lastClr'], schemeClr: ['val'], prstClr: ['val'],
  };
  const colorValueModifiers = new Set(['tint', 'shade', 'alpha', 'alphaOff', 'alphaMod', 'hue', 'hueOff', 'hueMod', 'sat', 'satOff', 'satMod', 'lum', 'lumOff', 'lumMod', 'red', 'redOff', 'redMod', 'green', 'greenOff', 'greenMod', 'blue', 'blueOff', 'blueMod']);
  const colorFlagModifiers = new Set(['comp', 'inv', 'gray', 'gamma', 'invGamma']);
  /** Only named, text-free formatting can be discarded. Unknown extensions take the enclosing equation's unread path. */
  const formattingLeaf = (item: XmlNode, allowed: readonly string[], ns: ReadonlySet<string>) =>
    ns.has(namespaces.get(item) ?? '') && attributesKnown(item, allowed, ns) && elements(item).length === 0 && whitespaceOnly(item);
  const drawingColor = (item: XmlNode): boolean => drawingNamespaces.has(namespaces.get(item) ?? '') &&
    drawingColorAttributes[tag(item)] !== undefined && attributesKnown(item, drawingColorAttributes[tag(item)], drawingNamespaces) && whitespaceOnly(item) &&
    elements(item).every(part => colorValueModifiers.has(tag(part)) ? formattingLeaf(part, ['val'], drawingNamespaces) : colorFlagModifiers.has(tag(part)) && formattingLeaf(part, [], drawingNamespaces));
  const runFormatting = (item: XmlNode): boolean => {
    const ns = namespaces.get(item) ?? '';
    if (tag(item) !== 'rPr' || !whitespaceOnly(item)) return false;
    const parts = elements(item);
    if (new Set(parts.map(part => `${namespaces.get(part)}:${tag(part)}`)).size !== parts.length) return false;
    if (wordNamespaces.has(ns)) return attributesKnown(item) && parts.every(part => {
      const allowed = wordScalarProperties.has(tag(part)) ? ['val'] : wordPropertyAttributes[tag(part)];
      return allowed !== undefined && formattingLeaf(part, allowed, wordNamespaces);
    });
    if (drawingNamespaces.has(ns)) return attributesKnown(item, drawingRunAttributes, drawingNamespaces) && parts.every(part => {
      if (['latin', 'ea', 'cs', 'sym'].includes(tag(part))) return formattingLeaf(part, ['typeface', 'panose', 'pitchFamily', 'charset'], drawingNamespaces);
      if (tag(part) === 'noFill') return formattingLeaf(part, [], drawingNamespaces);
      return tag(part) === 'solidFill' && drawingNamespaces.has(namespaces.get(part) ?? '') && attributesKnown(part) && whitespaceOnly(part) && elements(part).length === 1 && drawingColor(elements(part)[0]);
    });
    return false;
  };
  const controlFormatting = (item: XmlNode): boolean => shape(item, [], [], foreignRunProperties) &&
    elements(item).length <= 1 && elements(item).every(runFormatting);
  const matrixColumns = (item: XmlNode): boolean => shape(item, ['mc'], ['mc']) && elements(item).every(column =>
    shape(column, ['mcPr']) && elements(column).every(property => shape(property, ['count', 'mcJc']) && elements(property).every(value =>
      attributesKnown(value, ['val']) && elements(value).length === 0 && whitespaceOnly(value) &&
      (tag(value) === 'count' ? /^[1-9]\d*$/.test(attr(value, 'val') ?? '') : ['left', 'center', 'right'].includes(attr(value, 'val') ?? 'center')))));
  const booleanProperties = new Set(['alnScr', 'grow', 'degHide', 'subHide', 'supHide', 'plcHide', 'maxDist', 'objDist', 'opEmu', 'noBreak', 'diff', 'aln', 'hideTop', 'hideBot', 'hideLeft', 'hideRight', 'strikeH', 'strikeV', 'strikeBLTR', 'strikeTLBR', 'show', 'zeroWid', 'zeroAsc', 'zeroDesc', 'transp', 'nor', 'lit']);
  const enumProperties: Record<string, readonly string[]> = {
    type: ['bar', 'lin', 'skw', 'noBar'], shp: ['centered', 'match'], limLoc: ['subSup', 'undOvr'],
    baseJc: ['top', 'center', 'bot'], pos: ['top', 'bot'], vertJc: ['top', 'bot'],
    sty: ['p', 'b', 'i', 'bi'], scr: ['roman'], jc: ['left', 'right', 'center', 'centerGroup'],
  };
  const propertyValueKnown = (item: XmlNode): boolean => {
    const name = tag(item), value = attr(item, name === 'brk' ? 'alnAt' : 'val');
    if (booleanProperties.has(name)) return onOff(item, false) !== undefined;
    if (enumProperties[name]) return value === undefined || enumProperties[name].includes(value);
    if (['rSpRule', 'cGpRule', 'rSp', 'cSp', 'cGp', 'brk'].includes(name)) return value === undefined || /^\d+$/.test(value);
    return true;
  };
  /**
   * A property block: control/run formatting and matrix-column layout are dropped only after validating their
   * named text-free structure; every other child is a leaf with at most `val` (`brk` carries `alnAt` instead).
   */
  const propertyBlock = (item: XmlNode, name: string) => elements(item).find(part => tag(part) === name && mathNode(part));
  const properties = (item: XmlNode, name: string, allowed: readonly string[] = [], nested: readonly string[] = []): boolean => {
    const property = propertyBlock(item, name);
    return property === undefined || (shape(property, [...allowed, 'ctrlPr', ...nested]) && elements(property).every(part => {
      if (tag(part) === 'ctrlPr') return controlFormatting(part);
      if (nested.includes(tag(part))) return tag(part) === 'mcs' && matrixColumns(part);
      return attributesKnown(part, tag(part) === 'brk' ? ['alnAt'] : ['val']) && elements(part).length === 0 &&
        whitespaceOnly(part) && propertyValueKnown(part);
    }));
  };
  const unread = (item: XmlNode): string => {
    notes.add(MATH_STRUCTURE_UNREAD_NOTE);
    return unreadMarker(readableText([item]));
  };
  /**
   * Every supported structure: its operand children (`repeated` may occur more than once), the leaf children its
   * property block may carry (all layout, dropped unless read below) and property children dropped with their content.
   */
  const structures: Record<string, { operands: readonly string[]; repeated?: readonly string[]; props?: readonly string[]; nested?: readonly string[] }> = {
    sSup: { operands: ['e', 'sup'] }, sSub: { operands: ['e', 'sub'] }, sSubSup: { operands: ['e', 'sub', 'sup'], props: ['alnScr'] },
    sPre: { operands: ['sub', 'sup', 'e'] },
    f: { operands: ['num', 'den'], props: ['type'] },
    rad: { operands: ['deg', 'e'], props: ['degHide'] },
    d: { operands: ['e'], repeated: ['e'], props: ['begChr', 'sepChr', 'endChr', 'grow', 'shp'] },
    nary: { operands: ['sub', 'sup', 'e'], props: ['chr', 'limLoc', 'grow', 'subHide', 'supHide'] },
    func: { operands: ['fName', 'e'] }, limLow: { operands: ['e', 'lim'] }, limUpp: { operands: ['e', 'lim'] },
    m: { operands: ['mr'], repeated: ['mr'], props: ['baseJc', 'plcHide', 'rSpRule', 'cGpRule', 'rSp', 'cSp', 'cGp'], nested: ['mcs'] },
    eqArr: { operands: ['e'], repeated: ['e'], props: ['baseJc', 'maxDist', 'objDist', 'rSpRule', 'rSp'] },
    acc: { operands: ['e'], props: ['chr'] }, bar: { operands: ['e'], props: ['pos'] }, groupChr: { operands: ['e'], props: ['chr', 'pos', 'vertJc'] },
    box: { operands: ['e'], props: ['opEmu', 'noBreak', 'diff', 'brk', 'aln'] },
    borderBox: { operands: ['e'], props: ['hideTop', 'hideBot', 'hideLeft', 'hideRight', 'strikeH', 'strikeV', 'strikeBLTR', 'strikeTLBR'] },
    phant: { operands: ['e'], props: ['show', 'zeroWid', 'zeroAsc', 'zeroDesc', 'transp'] },
  };
  const accents: Record<string, string> = { '\u0302': 'hat', '\u0304': 'bar', '\u0305': 'bar', '\u0303': 'tilde', '\u0307': 'dot', '\u0308': 'ddot', '\u20d7': 'vec' };
  const contentKinds = ['r', ...Object.keys(structures)];
  function sequence(item: XmlNode): string {
    let out = '', previousStructural = false;
    for (const part of elements(item).filter(part => tag(part) !== 'argPr')) {
      const text = render(part), structural = tag(part) !== 'r';
      if (out && text && (structural || previousStructural) && !out.endsWith(' ') && !text.startsWith(' ')) out += ' ';
      out += text;
      previousStructural = structural;
    }
    return out;
  }
  function argument(item: XmlNode, allowEmpty = false): string {
    if (!shape(item, [...contentKinds, 'argPr'], contentKinds) || !properties(item, 'argPr', ['argSz'])) return unread(item);
    const size = child(child(item, 'argPr'), 'argSz');
    if (size && !['-2', '-1', '0', '1', '2'].includes(attr(size, 'val') ?? '')) return unread(item);
    const text = sequence(item);
    return text.trim() || allowEmpty ? text : unread(item);
  }
  function render(item: XmlNode): string {
    const name = tag(item);
    if (name === 'oMathPara') {
      if (!shape(item, ['oMath', 'oMathParaPr'], ['oMath']) || !properties(item, 'oMathParaPr', ['jc']) || !child(item, 'oMath')) return unread(item);
      if (!['left', 'right', 'center', 'centerGroup'].includes(val(child(item, 'oMathParaPr'), 'jc') ?? 'centerGroup')) return unread(item);
      return elements(item).filter(isMath).map(render).join('\n');
    }
    if (name === 'oMath') return child(item, 'argPr') ? unread(item) : argument(item);
    if (name === 'r') {
      // m:rPr children sty/nor/lit/aln/brk are formatting (dropped); scr other than roman is a script alphabet and may carry meaning.
      if (!shape(item, ['rPr', 't'], ['t'], foreignRunProperties) || !elements(item).filter(foreignRunProperties).every(runFormatting) ||
        !properties(item, 'rPr', ['sty', 'nor', 'lit', 'aln', 'brk', 'scr']) || !child(item, 't')) return unread(item);
      if ((val(propertyBlock(item, 'rPr'), 'scr') ?? 'roman') !== 'roman') return unread(item);
      const text = elements(item).filter(part => tag(part) === 't');
      if (text.some(part => !attributesKnown(part) || children(part).some(value => tag(value) !== '#text'))) return unread(item);
      return text.map(literal).join('');
    }
    const spec = structures[name];
    if (!spec || !mathNode(item)) return unread(item);
    if (!shape(item, [...spec.operands, name + 'Pr'], spec.repeated ?? []) || spec.operands.some(key => !child(item, key)) ||
      !properties(item, name + 'Pr', spec.props, spec.nested)) return unread(item);
    const props = propertyBlock(item, name + 'Pr');
    const arg = (key: string) => argument(child(item, key)!);
    const glyph = (key: string, fallback: string) => child(props, key) === undefined ? fallback : val(props, key) ?? '';
    /** A single glyph property (`chr`); empty or multi-character values are not a symbol this text can name. */
    const symbol = (key: string, fallback: string) => { const value = glyph(key, fallback); return [...value].length === 1 ? value : undefined; };
    /** A function name or limit base is written bare when it is runs only; one structure keeps its own delimiters; a mixture is grouped. */
    const base = (key: string) => {
      const operand = child(item, key)!, parts = elements(operand).filter(part => tag(part) !== 'argPr');
      return parts.every(part => tag(part) === 'r') || parts.length === 1 ? arg(key) : `(${arg(key)})`;
    };
    if (name === 'sSup' || name === 'sSub' || name === 'sSubSup')
      return `(${arg('e')})${name !== 'sSup' ? `_(${arg('sub')})` : ''}${name !== 'sSub' ? `^(${arg('sup')})` : ''}`;
    if (name === 'sPre') return `_(${arg('sub')})^(${arg('sup')})(${arg('e')})`;
    if (name === 'f') {
      const type = val(props, 'type') ?? 'bar';
      if (!['bar', 'lin', 'skw', 'noBar'].includes(type)) return unread(item);
      return type === 'noBar' ? `stack(top=(${arg('num')}), bottom=(${arg('den')}))` : `((${arg('num')})/(${arg('den')}))`;
    }
    if (name === 'rad') {
      const hidden = onOff(child(props, 'degHide'), false);
      if (hidden === undefined) return unread(item);
      const degree = argument(child(item, 'deg')!, true);
      if (hidden) {
        if (degree.trim()) return unread(item); // A hidden, nonempty degree cannot be interpreted as a square root.
        return `sqrt(${arg('e')})`;
      }
      if (!degree.trim()) return unread(item); // Visible but empty is an unfinished degree, not an inferred square root.
      return `root(degree=(${degree}), radicand=(${arg('e')}))`;
    }
    if (name === 'd') {
      const begin = glyph('begChr', '('), end = glyph('endChr', ')'), separator = glyph('sepChr', '\u2502');
      if ([begin, end, separator].some(value => [...value].length > 1)) return unread(item);
      const args = elements(item).filter(part => tag(part) === 'e').map(part => argument(part));
      return args.length === 1 && begin === '(' && end === ')' ? `(${args[0]})` :
        `delimiter(begin=${JSON.stringify(begin)}, separator=${JSON.stringify(separator)}, end=${JSON.stringify(end)}, arguments=[${args.map(value => `(${value})`).join(', ')}])`;
    }
    if (name === 'nary') {
      const operator = symbol('chr', '\u222b');
      if (operator === undefined) return unread(item);
      // A hidden empty limit is omitted; a hidden non-empty one and a visible empty one (an unfinished placeholder) are flagged.
      const limit = (key: string, hide: string, mark: string): string | undefined => {
        const hidden = onOff(child(props, hide), false), text = argument(child(item, key)!, true);
        if (hidden === undefined) return undefined;
        if (hidden) return text.trim() ? undefined : '';
        return text.trim() ? `${mark}(${text})` : undefined;
      };
      const sub = limit('sub', 'subHide', '_'), sup = limit('sup', 'supHide', '^');
      return sub === undefined || sup === undefined ? unread(item) : `${operator}${sub}${sup}(${arg('e')})`;
    }
    if (name === 'func') return `${arg('fName')}(${arg('e')})`;
    if (name === 'limLow' || name === 'limUpp') return `${base('e')}${name === 'limLow' ? '_' : '^'}(${arg('lim')})`;
    if (name === 'm') {
      const rows = elements(item).filter(part => tag(part) === 'mr');
      if (rows.some(row => !shape(row, ['e'], ['e']) || !child(row, 'e'))) return unread(item);
      return `[${rows.map(row => elements(row).map(cell => argument(cell)).join(', ')).join('; ')}]`;
    }
    if (name === 'eqArr') return `eqArr(${elements(item).filter(part => tag(part) === 'e').map(part => argument(part)).join('; ')})`;
    if (name === 'acc') {
      const character = symbol('chr', '\u0302');
      if (character === undefined) return unread(item);
      return accents[character] ? `${accents[character]}(${arg('e')})` : `accent(${JSON.stringify(character)}, ${arg('e')})`;
    }
    if (name === 'bar') {
      const position = val(props, 'pos') ?? 'bot';
      if (!['top', 'bot'].includes(position)) return unread(item);
      return `${position === 'top' ? 'bar' : 'underbar'}(${arg('e')})`;
    }
    if (name === 'groupChr') {
      const character = symbol('chr', '\u23df');
      return character === undefined ? unread(item) : `group(${JSON.stringify(character)}, ${arg('e')})`;
    }
    if (name === 'phant') return `phantom(${arg('e')})`;
    return `(${arg('e')})`; // box, borderBox: transparent grouping.
  }
  return render(node);
}
function roman(n: number): string {
  const table: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [value, digits] of table) while (n >= value) { out += digits; n -= value; }
  return out;
}
const letters = (n: number) => String.fromCharCode(97 + (n - 1) % 26).repeat(Math.floor((n - 1) / 26) + 1);
/** `style` is a Word numFmt or the leading part of a PowerPoint autonumber scheme; anything unknown renders decimal. */
function formatNumber(n: number, style: string): string {
  if (!Number.isInteger(n) || n < 1) return String(n);
  switch (style) {
    case 'lowerLetter': case 'alphaLc': return letters(n);
    case 'upperLetter': case 'alphaUc': return letters(n).toUpperCase();
    case 'lowerRoman': case 'romanLc': return roman(n).toLowerCase();
    case 'upperRoman': case 'romanUc': return roman(n);
    default: return String(n);
  }
}
/** Bullet glyphs from symbol fonts arrive as private-use code points, which mean nothing outside that font; they become •. */
const bulletChar = (char: string | undefined) => { const code = char?.codePointAt(0); return !char || (code !== undefined && code >= 0xe000 && code <= 0xf8ff) ? '•' : char; };
/** Author-written alternative text of a picture or shape (`descr`, else `title`), or nothing when empty. */
const altText = (node: XmlNode | undefined): string | undefined => { const text = (attr(node, 'descr') ?? '').trim() || (attr(node, 'title') ?? '').trim(); return text ? `[Image: ${text}]` : undefined; };
const altBlock = (node: XmlNode | undefined): Block[] => { const text = altText(node); return text ? [textBlock(text)] : []; };

interface PartContext { parts: ReadonlyMap<string, string>; base: string; rels: readonly XmlNode[]; notes: Set<string> }
function relatedPart(ctx: PartContext, id: string | undefined, what: string): XmlNode[] {
  const rel = relationship(ctx.rels, id);
  const target = attr(rel, 'Target');
  if (!target || attr(rel, 'TargetMode') === 'External') throw new Error(`A ${what} relationship is missing or external.`);
  return required(ctx.parts, resolvePart(ctx.base, target));
}
/**
 * Paragraph text inside DrawingML (`a:p`): runs, breaks, fields, equations and hyperlink targets; no bullets.
 * A run's `baseline` (own `rPr`, else the paragraph's `pPr/defRPr`, else `levelBaseline` from the shape's list style)
 * becomes `^( )` / `_( )`; `endParaRPr` is the paragraph mark, not run content. Layouts and masters are not resolved
 * (see parsePptxParts, which flags a nonzero baseline found there).
 */
function drawingRuns(nodes: readonly XmlNode[], rels: readonly XmlNode[], notes: Set<string>, levelBaseline?: BaselineValue): string {
  const paragraphBaseline = firstBaseline(drawingBaseline(child(nodes.find(item => tag(item) === 'pPr'), 'defRPr')), levelBaseline);
  const shiftOf = (value: BaselineValue): Shift | undefined => {
    const shift = baselineShift(value);
    if (shift === null) notes.add(MATH_STRUCTURE_UNREAD_NOTE); // An unparseable offset: keep the text flat and require review.
    return shift ?? undefined;
  };
  const pieces: Piece[] = [];
  for (const item of nodes) {
    const name = tag(item);
    if (name === '#text' || name === 'pPr' || name === 'endParaRPr') continue;
    if (isMath(item)) { pieces.push({ text: mathText(item, notes) }); continue; }
    if (textCarrier(item)) { pieces.push({ text: literal(item) }); continue; }
    if (name === 'br') { pieces.push({ text: '\n' }); continue; }
    // Slide numbers, dates and times are template fields, not content; every other field keeps its cached text.
    if (name === 'fld' && /^(?:slidenum|datetime)/.test(attr(item, 'type') ?? '')) continue;
    if (name === 'r' || name === 'fld') {
      const properties = child(item, 'rPr');
      const shift = shiftOf(firstBaseline(drawingBaseline(properties), paragraphBaseline));
      pieces.push({ text: children(item).filter(textCarrier).map(literal).join(''), ...(shift ? { shift } : {}) });
      const link = relationship(rels, attr(child(properties, 'hlinkClick'), 'id', true));
      if (link && attr(link, 'TargetMode') === 'External' && attr(link, 'Target')) pieces.push({ text: ` <${attr(link, 'Target')}>` });
      continue;
    }
    pieces.push({ text: drawingRuns(contentChildren(item), rels, notes, levelBaseline) });
  }
  return shiftedText(pieces);
}
interface ChartDimension {
  name: string;
  count: string | undefined;
  points: { index: string | undefined; value: string }[];
  dense: boolean;
  unread: string | null;
}
const chartIndex = (value: string | undefined): number | null => value !== undefined && /^\d+$/.test(value) && Number(value) <= 4_294_967_295 ? Number(value) : null;
function chartPointIdentity(points: ChartDimension['points'], count: string | undefined): boolean {
  const indices = points.map(point => chartIndex(point.index)), size = chartIndex(count);
  return indices.every(index => index !== null) && new Set(indices).size === points.length
    && (count === undefined || size !== null && indices.every(index => index! < size));
}
function chartDimensionBlocks(dimension: ChartDimension, label = dimension.name): Block[] {
  const out: Block[] = [marker(`[Chart dimension: ${label}, count=${JSON.stringify(dimension.count ?? null)}]`)];
  if (dimension.points.length) out.push({ kind: 'table', rows: [['Point index', 'Value'], ...dimension.points.map(point => [point.index ?? '(missing)', point.value])], header: 0 });
  if (dimension.unread !== null) out.push(marker(`[Unread chart structure: ${dimension.unread || '(no readable text)'}]`));
  return out;
}
/** Keep the recorded identities; never allocate an array from a source-provided point count or index. */
function chartDimension(node: XmlNode): ChartDimension {
  const elements = (item: XmlNode) => children(item).filter(value => tag(value) !== '#text');
  const sources = elements(node).filter(item => tag(node) !== 'datalabelsRange' || tag(item) !== 'f'), source = sources[0];
  const caches = source && ['numRef', 'strRef'].includes(tag(source))
    ? elements(source).filter(item => tag(item) !== 'f') : sources;
  const cache = caches[0];
  const points = all(children(node), 'pt').map(point => ({ index: attr(point, 'idx'), value: all(children(point), 'v').map(literal).join(' ') }));
  const counts = cache ? elements(cache).filter(item => tag(item) === 'ptCount') : [];
  const count = attr(counts[0], 'val'), countNumber = chartIndex(count);
  const indices = points.map(point => chartIndex(point.index));
  const pointNodes = cache ? elements(cache).filter(item => tag(item) === 'pt') : [];
  const valid = sources.length === 1 && caches.length === 1 && cache !== undefined
    && ['numLit', 'strLit', 'numCache', 'strCache', 'dlblRangeCache'].includes(tag(cache))
    && elements(cache).every(item => ['pt', 'ptCount', 'formatCode'].includes(tag(item)))
    && pointNodes.length === points.length && pointNodes.every(point => elements(point).length === 1 && tag(elements(point)[0]) === 'v')
    && chartPointIdentity(points, count) && counts.length <= 1 && (counts.length === 0 || countNumber !== null);
  return {
    name: tag(node), count, points,
    dense: valid && indices.every((index, position) => index === position) && (count === undefined || countNumber === points.length),
    unread: valid ? null : readableText(children(node)),
  };
}
function extendedChartBlocks(root: readonly XmlNode[], notes: Set<string>, cover: (node: XmlNode | undefined) => void,
  text: (node: XmlNode | undefined) => string[]): Block[] {
  const out: Block[] = [];
  const datasets = all(root, 'data'), dataIds = datasets.map(data => attr(data, 'id'));
  if (dataIds.some(id => chartIndex(id) === null) || new Set(dataIds).size !== dataIds.length) notes.add(EMBEDDED_UNREAD_NOTE);
  for (const series of all(root, 'series')) {
    const name = text(child(series, 'tx')).join(' ');
    const ids = children(series).filter(node => tag(node) === 'dataId'), id = attr(ids[0], 'val');
    if (ids.length !== 1 || !dataIds.includes(id)) notes.add(EMBEDDED_UNREAD_NOTE);
    out.push(marker(`[Chart series: name=${JSON.stringify(name)}, data=${JSON.stringify(id ?? null)}, layout=${JSON.stringify(attr(series, 'layoutId') ?? null)}]`));
  }
  for (const data of datasets) {
    out.push(marker(`[Chart data: id=${JSON.stringify(attr(data, 'id') ?? null)}]`));
    for (const dimension of children(data).filter(node => ['strDim', 'numDim'].includes(tag(node)))) {
      const levels = children(dimension).filter(node => tag(node) === 'lvl');
      if (!levels.length || attr(dimension, 'type') === undefined) {
        cover(dimension);
        notes.add(EMBEDDED_UNREAD_NOTE);
        out.push(marker(`[Unread chart structure: ${readableText(children(dimension)) || '(no readable text)'}]`));
      }
      for (const [index, level] of levels.entries()) {
        cover(level);
        const points = children(level).filter(node => tag(node) === 'pt').map(point => ({ index: attr(point, 'idx'), value: readableText(children(point)) }));
        const count = attr(level, 'ptCount');
        const valid = count !== undefined && chartIndex(count) !== null && chartPointIdentity(points, count)
          && children(level).every(node => tag(node) === '#text' || tag(node) === 'pt' && children(node).every(value => tag(value) === '#text'));
        if (!valid) notes.add(EMBEDDED_UNREAD_NOTE);
        out.push(...chartDimensionBlocks({ name: tag(dimension), count, points, dense: false,
          unread: valid ? null : readableText(children(level)) }, `${tag(dimension)}, type=${JSON.stringify(attr(dimension, 'type') ?? null)}, level=${index}`));
      }
    }
  }
  return out;
}
/**
 * Chart text: titles, cache values with their series identity, and explicit data-label text. Series share one table
 * only when their recorded coordinates are identical; otherwise each keeps its own table. Cell references (`c:f`)
 * are not content, and no coordinates or glyphs are inferred from chart rendering.
 */
function chartBlocks(ctx: PartContext, id: string | undefined): Block[] {
  const root = relatedPart(ctx, id, 'chart');
  const covered = new WeakSet<XmlNode>();
  const cover = (node: XmlNode | undefined) => { if (node) covered.add(node); };
  const paragraphs = (node: XmlNode) => all(children(node), 'p').map(p => {
    cover(p);
    return drawingRuns(children(p), [], ctx.notes);
  }).filter(text => text.trim());
  const values = (node: XmlNode | undefined) => node ? all(children(node), 'v').map(value => {
    // Only these literal text nodes were read; an unfamiliar child remains available to the loss guard below.
    for (const item of children(value)) if (rawTag(item) === '#text') cover(item);
    return literal(value);
  }) : [];
  const chartText = (node: XmlNode | undefined) => node ? [...paragraphs(node), ...values(node)] : [];
  const out: Block[] = [marker('[Chart]')];
  for (const title of all(root, 'title')) {
    for (const line of [...paragraphs(title), ...values(child(title, 'tx'))]) out.push(textBlock(line));
  }
  const rows: string[][] = [];
  const series = all(root, 'ser');
  const nativeGroupCount = (nodes: readonly XmlNode[]): number => nodes.reduce((total, node) => {
    const nested = contentChildren(node);
    return total + (nested.some(item => tag(item) === 'ser') ? 1 : 0) + nativeGroupCount(nested);
  }, 0);
  const multipleNativeGroups = nativeGroupCount(root) > 1;
  const labelSeries = new Map<XmlNode, { name: string; index: string | undefined }>();
  const rangeLabels: { name: string; index: string | undefined; dimension: ChartDimension }[] = [];
  if (series.length) {
    const data = series.map(ser => {
      const name = values(child(ser, 'tx')).join(' ');
      const index = attr(child(ser, 'idx'), 'val');
      for (const label of all(children(ser), 'dLbl')) labelSeries.set(label, { name, index });
      for (const range of all(children(ser), 'datalabelsRange')) {
        cover(range);
        const dimension = chartDimension(range);
        if (dimension.unread !== null) ctx.notes.add(EMBEDDED_UNREAD_NOTE);
        rangeLabels.push({ name, index, dimension });
      }
      const dimensions = children(ser).filter(node => ['cat', 'xVal', 'val', 'yVal', 'bubbleSize'].includes(tag(node)))
        .map(node => { cover(node); return chartDimension(node); });
      const coordinate = dimensions.filter(item => ['cat', 'xVal'].includes(item.name));
      const value = dimensions.filter(item => ['val', 'yVal'].includes(item.name));
      const ambiguous = coordinate.length > 1 || value.length > 1 || dimensions.filter(item => item.name === 'bubbleSize').length > 1;
      if (ambiguous || dimensions.some(item => item.unread !== null)) ctx.notes.add(EMBEDDED_UNREAD_NOTE);
      const dense = !ambiguous && dimensions.length === 2 && coordinate.length === 1 && value.length === 1
        && dimensions.every(item => item.dense) && coordinate[0].points.length === value[0].points.length;
      return { name, index, dimensions, dense,
        coordinates: coordinate[0]?.points.map(point => point.value) ?? [], values: value[0]?.points.map(point => point.value) ?? [] };
    });
    const names = new Map<string, number>();
    for (const item of data) names.set(item.name, (names.get(item.name) ?? 0) + 1);
    // A display name is sufficient for the old dense table only when it identifies exactly one series. Ambiguous
    // names need the same recorded index alongside both their values and labels; no series index is synthesized.
    for (const item of data) if (!item.name.trim() || names.get(item.name)! > 1) item.dense = false;
    if (labelSeries.size || rangeLabels.length || data.some(item => !item.name.trim() || names.get(item.name)! > 1)) {
      const identities = data.map(item => chartIndex(item.index));
      if (identities.some(index => index === null) || new Set(identities).size !== identities.length)
        ctx.notes.add(EMBEDDED_UNREAD_NOTE);
    }
    const coordinates = data[0].coordinates;
    const shared = data.every(item => item.dense && item.coordinates.length === coordinates.length && item.coordinates.every((value, index) => value === coordinates[index]));
    if (shared) {
      if (coordinates.length) rows.push(['', ...coordinates]);
      for (const item of data) rows.push([item.name, ...item.values]);
    } else {
      for (const item of data) {
        if (item.dense) out.push(marker('[Chart series]'), {
          kind: 'table', rows: [['', ...item.coordinates], [item.name, ...item.values]], header: 0,
        });
        else {
          out.push(marker(`[Chart series: name=${JSON.stringify(item.name)}, index=${JSON.stringify(item.index ?? null)}]`));
          for (const dimension of item.dimensions) out.push(...chartDimensionBlocks(dimension));
        }
      }
    }
  } else {
    // Extended charts keep data/series links, dimensions and levels explicit; point order never implies identity.
    out.push(...extendedChartBlocks(root, ctx.notes, cover, chartText));
  }
  if (rows.length) out.push({ kind: 'table', rows, header: 0 });
  for (const { name, index, dimension } of rangeLabels)
    out.push(marker(`[Chart labels from cells: series=${JSON.stringify(name)}, seriesIndex=${JSON.stringify(index ?? null)}]`), ...chartDimensionBlocks(dimension));
  for (const label of all(root, 'dLbl')) {
    const text = child(label, 'tx');
    if (!text) continue;
    const lines = [...paragraphs(text), ...values(text)].filter(line => line.trim());
    if (!lines.length) continue;
    const owner = labelSeries.get(label);
    // A group-level label in a combination chart is not a label for every series in the chart. Until that group
    // ownership is represented, retain its text but require review rather than silently imply a global label.
    if (!owner && multipleNativeGroups) ctx.notes.add(EMBEDDED_UNREAD_NOTE);
    out.push(marker(`[Chart label: series=${JSON.stringify(owner?.name ?? null)}, seriesIndex=${JSON.stringify(owner?.index ?? null)}, index=${JSON.stringify(attr(child(label, 'idx'), 'val') ?? null)}]`), ...lines.map(line => textBlock(line)));
  }
  // Preserve unfamiliar chart prose rather than relying on a growing list of label/extension names. Known numeric
  // formatting and workbook reference formulas are metadata, not prose. This is extracted text/context, never XML.
  const chartNamespaces = new Set(['http://schemas.openxmlformats.org/drawingml/2006/chart',
    'http://purl.oclc.org/ooxml/drawingml/chart', 'http://schemas.microsoft.com/office/drawing/2012/chart', extendedChartNamespace]);
  const retainUncovered = (node: XmlNode, path: string[]): void => {
    if (covered.has(node)) return;
    if (chartNamespaces.has(namespaces.get(node) ?? '') && ['f', 'formatCode'].includes(tag(node))) return;
    if (rawTag(node) === '#text') {
      const text = String(node['#text']);
      if (text.trim()) {
        ctx.notes.add(EMBEDDED_UNREAD_NOTE);
        out.push(marker(`[Unread chart text: path=${JSON.stringify(path.join('/'))}]`), textBlock(text));
      }
      return;
    }
    const identity = attr(node, 'idx') ?? attr(node, 'id') ?? val(node, 'idx');
    const next = [...path, rawTag(node) + (identity === undefined ? '' : `[index=${JSON.stringify(identity)}]`)];
    for (const item of contentChildren(node)) retainUncovered(item, next);
  };
  for (const node of root) retainUncovered(node, []);
  return out;
}
/** SmartArt text from the diagram data model, one block per data point, in model order. */
function smartArtBlocks(ctx: PartContext, id: string | undefined): Block[] {
  const root = relatedPart(ctx, id, 'SmartArt data');
  const lines = all(root, 'pt').flatMap(point => all(children(point), 'p').map(p => drawingRuns(children(p), [], ctx.notes))).filter(text => text.trim());
  return [marker('[SmartArt]'), ...lines.map(line => textBlock(line))];
}
const embeddedTags = new Set(['altChunk', 'subDoc', 'object', 'objectEmbed', 'OLEObject', 'oleObj']);

// ---------------------------------------------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------------------------------------------

interface ListReference { numId: string; ilvl: number }
/** `word/numbering.xml`: resolves `w:numPr` to a rendered prefix and keeps the counters of every list. */
class Numbering {
  private readonly abstracts = new Map<string, Map<number, XmlNode>>();
  /** `w:numStyleLink`: an abstract definition that defers to the list a numbering style points at. */
  private readonly styleLinks = new Map<string, string>();
  private readonly instances = new Map<string, { abstract: string; overrides: Map<number, { start?: number; level?: XmlNode }> }>();
  private readonly counters = new Map<string, number[]>();
  private readonly styleList: (id: string) => ListReference | undefined;
  constructor(xml: string | undefined, styleList: (id: string) => ListReference | undefined) {
    this.styleList = styleList;
    if (xml === undefined) return;
    const root = parse(xml);
    for (const abstract of all(root, 'abstractNum')) {
      const id = attr(abstract, 'abstractNumId');
      if (id === undefined) continue;
      this.abstracts.set(id, new Map(children(abstract).filter(node => tag(node) === 'lvl').map(level => [Number(attr(level, 'ilvl')), level])));
      const link = val(abstract, 'numStyleLink');
      if (link !== undefined) this.styleLinks.set(id, link);
    }
    for (const instance of all(root, 'num')) {
      const id = attr(instance, 'numId'), abstract = val(instance, 'abstractNumId');
      if (id === undefined || abstract === undefined) continue;
      const overrides = new Map<number, { start?: number; level?: XmlNode }>();
      for (const override of children(instance).filter(node => tag(node) === 'lvlOverride')) {
        const start = val(override, 'startOverride');
        overrides.set(Number(attr(override, 'ilvl')), { ...(start !== undefined ? { start: Number(start) } : {}), ...(child(override, 'lvl') ? { level: child(override, 'lvl') } : {}) });
      }
      this.instances.set(id, { abstract, overrides });
    }
  }
  /** Advances the counter for (numId, ilvl), resets deeper levels, and renders `lvlText` such as `%1.%2` in each level's format. */
  prefix({ numId, ilvl }: ListReference): string {
    const instance = this.instances.get(numId);
    if (!instance || numId === '0') return '';
    const linkedStyle = this.styleLinks.get(instance.abstract);
    const linkedNumId = linkedStyle !== undefined ? this.styleList(linkedStyle)?.numId : undefined;
    const levels = this.abstracts.get((linkedNumId !== undefined && this.instances.get(linkedNumId)?.abstract) || instance.abstract);
    const levelOf = (index: number) => instance.overrides.get(index)?.level ?? levels?.get(index);
    const startOf = (index: number) => instance.overrides.get(index)?.start ?? Number(val(levelOf(index), 'start') ?? 0);
    const counts = this.counters.get(numId) ?? [];
    counts[ilvl] = counts[ilvl] === undefined ? startOf(ilvl) : counts[ilvl] + 1;
    counts.length = ilvl + 1;
    this.counters.set(numId, counts);
    const level = levelOf(ilvl);
    if (!level) return '';
    const format = val(level, 'numFmt') ?? 'decimal', text = val(level, 'lvlText') ?? '';
    if (format === 'bullet') return `${bulletChar(text)} `;
    const rendered = text.replace(/%(\d)/g, (_, digit: string) => {
      const index = Number(digit) - 1;
      return format === 'none' ? '' : formatNumber(counts[index] ?? startOf(index), val(levelOf(index), 'numFmt') ?? 'decimal');
    });
    return rendered ? `${rendered} ` : '';
  }
}
interface WordRunValue { value: string | null; unread?: string }
interface WordContext extends PartContext {
  page: { number: number };
  styleLevel(id: string | undefined): number | undefined;
  styleList(id: string | undefined): ListReference | undefined;
  /** A run property's `val` resolved through the run's `rPr`, its character style chain, the paragraph style chain and docDefaults. */
  runProperty(name: string, run: XmlNode | undefined, paragraphStyle: string | undefined): WordRunValue | undefined;
  numbering: Numbering;
}
interface Sink { paragraphStyle: string | undefined; emit(text: string, shift?: Shift): void; pageBreak(): void; defer(blocks: () => Block[]): void }
const skippedInline = new Set(['pPr', 'rPr', 'del', 'moveFrom', 'instrText', 'delInstrText', 'fldChar', 'footnoteRef', 'endnoteRef', 'softHyphen']);
/**
 * Inline content of a Word paragraph. Text boxes, charts and SmartArt are deferred so they follow the host paragraph as
 * their own blocks. `shift` is the enclosing run's resolved vertAlign: its text becomes `^( )` / `_( )`; a note reference
 * is already rendered `[n]` and stays unshifted. A manual `w:position` raise/lower is flagged, not represented.
 */
function wordInline(nodes: readonly XmlNode[], ctx: WordContext, sink: Sink, shift?: Shift): void {
  for (const node of nodes) {
    const name = tag(node);
    if (name === '#text' || skippedInline.has(name)) continue;
    if (isMath(node)) { sink.emit(mathText(node, ctx.notes)); continue; }
    if (name === 'r') {
      const properties = child(node, 'rPr');
      const vertical = ctx.runProperty('vertAlign', properties, sink.paragraphStyle);
      const position = ctx.runProperty('position', properties, sink.paragraphStyle);
      for (const property of [vertical, position]) if (property?.unread) sink.emit(property.unread);
      if (position?.value != null && Number(position.value) !== 0) ctx.notes.add(MATH_STRUCTURE_UNREAD_NOTE);
      wordInline(contentChildren(node), ctx, sink, vertical?.value === 'superscript' ? 'sup' : vertical?.value === 'subscript' ? 'sub' : undefined);
      continue;
    }
    if (textCarrier(node)) { sink.emit(literal(node), shift); continue; }
    if (name === 'lastRenderedPageBreak' || (name === 'br' && attr(node, 'type') === 'page')) { sink.pageBreak(); continue; }
    if (name === 'tab' || name === 'ptab') { sink.emit('\t', shift); continue; }
    if (name === 'br' || name === 'cr') { sink.emit('\n', shift); continue; }
    if (name === 'noBreakHyphen') { sink.emit('-', shift); continue; }
    if (name === 'sym') {
      const code = attr(node, 'char');
      if (!code || !/^[0-9a-f]{1,6}$/i.test(code)) throw new Error('A symbol character code is missing or invalid.');
      // w:sym uses a character code in the explicitly named font, not a portable Unicode scalar. Keep both
      // source attributes and require review rather than assigning a glyph without decoding that font.
      ctx.notes.add('N_FONT_TEXT_UNREADABLE');
      sink.emit(`[Unread symbol: font=${JSON.stringify(attr(node, 'font') ?? null)}, char=${JSON.stringify(code)}]`, shift);
      continue;
    }
    if (name === 'footnoteReference' || name === 'endnoteReference') {
      const id = attr(node, 'id');
      if (id === undefined) throw new Error('A note reference has no identifier.');
      sink.emit(`[${id}]`);
      continue;
    }
    if (name === 'hyperlink') {
      wordInline(contentChildren(node), ctx, sink, shift);
      const target = attr(relationship(ctx.rels, attr(node, 'id', true)), 'Target');
      if (target) sink.emit(` <${target}>`);
      continue;
    }
    if (name === 'docPr') { sink.emit(altText(node) ?? ''); continue; }
    if (name === 'textpath') { sink.emit(attr(node, 'string') ?? ''); continue; }
    if (name === 'shape' && attr(node, 'alt')?.trim()) sink.emit(`[Image: ${attr(node, 'alt')!.trim()}]`);
    if (name === 'txbxContent') { sink.defer(() => wordBlocks(children(node), ctx)); continue; }
    if (name === 'chart') { sink.defer(() => chartBlocks(ctx, attr(node, 'id', true))); continue; }
    if (name === 'relIds') { sink.defer(() => smartArtBlocks(ctx, attr(node, 'dm', true))); continue; }
    if (embeddedTags.has(name)) ctx.notes.add(EMBEDDED_UNREAD_NOTE);
    wordInline(contentChildren(node), ctx, sink, shift);
  }
}
function wordParagraph(node: XmlNode, ctx: WordContext): Block[] {
  const properties = child(node, 'pPr');
  const outline = child(properties, 'outlineLvl');
  const rawLevel = outline ? Number(attr(outline, 'val')) : undefined;
  const styleId = val(properties, 'pStyle');
  const level = rawLevel !== undefined ? (rawLevel >= 0 && rawLevel < 9 ? rawLevel + 1 : undefined) : ctx.styleLevel(styleId);
  const numPr = child(properties, 'numPr');
  const styleList = ctx.styleList(styleId);
  const numId = val(numPr, 'numId') ?? styleList?.numId;
  const list = numId !== undefined ? { numId, ilvl: Number(val(numPr, 'ilvl') ?? styleList?.ilvl ?? 0) } : undefined;
  const blocks: Block[] = [];
  const deferred: (() => Block[])[] = [];
  let pieces: Piece[] = list ? [{ text: ctx.numbering.prefix(list) }] : [];
  wordInline(children(node), ctx, {
    paragraphStyle: styleId,
    emit: (text, shift) => { pieces.push({ text, ...(shift ? { shift } : {}) }); },
    pageBreak: () => { blocks.push(textBlock(shiftedText(pieces), level)); pieces = []; blocks.push({ kind: 'marker', text: `[Page ${++ctx.page.number}]`, page: true }); },
    defer: producer => deferred.push(producer),
  });
  blocks.push(textBlock(shiftedText(pieces), level));
  for (const producer of deferred) blocks.push(...producer());
  return blocks;
}
function wordTable(node: XmlNode, ctx: WordContext): Block {
  const rows = collect(contentChildren(node), 'tr').filter(row => !child(child(row, 'trPr'), 'del'));
  const header = rows.findIndex(row => child(child(row, 'trPr'), 'tblHeader'));
  return { kind: 'table', rows: rows.map(row => collect(contentChildren(row), 'tc').map(cell => cellText(wordBlocks(children(cell), ctx)))), header: header < 0 ? 0 : header };
}
function wordBlocks(nodes: readonly XmlNode[], ctx: WordContext): Block[] {
  const out: Block[] = [];
  for (const node of nodes) {
    const name = tag(node);
    if (name === '#text' || name === 'sectPr' || name === 'del' || name === 'moveFrom') continue;
    if (name === 'p') out.push(...wordParagraph(node, ctx));
    else if (name === 'tbl') out.push(wordTable(node, ctx));
    else if (embeddedTags.has(name)) ctx.notes.add(EMBEDDED_UNREAD_NOTE);
    else out.push(...wordBlocks(contentChildren(node), ctx));
  }
  return out;
}
export function parseDocxParts(parts: ReadonlyMap<string, string>): ParsedDocument {
  const base = 'word/document.xml';
  const root = required(parts, base);
  const body = all(root, 'body')[0];
  if (!body) throw new Error('The document body is missing.');
  const styles = new Map<string, { level?: number; parent?: string; list?: ListReference; runProperties?: XmlNode }>();
  const styleXml = parts.get('word/styles.xml');
  const styleRoot = styleXml ? parse(styleXml) : [];
  let defaultParagraphStyle: string | undefined;
  for (const style of all(styleRoot, 'style')) {
    const id = attr(style, 'styleId');
    const outline = all(children(style), 'outlineLvl')[0];
    const level = outline ? Number(attr(outline, 'val')) : undefined;
    const numPr = child(child(style, 'pPr'), 'numPr');
    const numId = val(numPr, 'numId');
    if (id && attr(style, 'type') === 'paragraph' && ['1', 'true', 'on'].includes(attr(style, 'default') ?? '')) defaultParagraphStyle = id;
    if (id) styles.set(id, {
      ...(level !== undefined && level >= 0 && level < 9 ? { level: level + 1 } : {}),
      parent: val(style, 'basedOn'),
      ...(numId !== undefined ? { list: { numId, ilvl: Number(val(numPr, 'ilvl') ?? 0) } } : {}),
      ...(child(style, 'rPr') ? { runProperties: child(style, 'rPr') } : {}),
    });
  }
  const documentDefaults = child(all(styleRoot, 'rPrDefault')[0], 'rPr');
  /** The first defined value of `pick` along a style's `basedOn` chain. */
  function resolve<T>(id: string | undefined, pick: (style: NonNullable<ReturnType<typeof styles.get>>) => T | undefined, seen = new Set<string>()): T | undefined {
    if (!id) return undefined;
    if (seen.has(id)) throw new Error('Document heading styles contain a cycle.');
    seen.add(id);
    const style = styles.get(id);
    if (!style) return undefined;
    return pick(style) ?? resolve(style.parent, pick, seen);
  }
  const inherited = <K extends 'level' | 'list'>(key: K, id: string | undefined) => resolve(id, style => style[key]);
  const notes = new Set<string>();
  const retainedPropertyText = new Set<XmlNode>();
  /** Undefined means absent; a null value is malformed and must not be replaced by inheritance. */
  const runValue = (properties: XmlNode | undefined, name: string): WordRunValue | undefined => {
    const matches = properties ? children(properties).filter(item => tag(item) === name) : [];
    if (!matches.length) return undefined;
    const property = matches[0], keys = Object.keys((property[':@'] ?? {}) as Record<string, unknown>).filter(key => key !== '@_xmlns' && !key.startsWith('@_xmlns:'));
    const validAttribute = keys.length === 1 && keys[0].includes(':') && keys[0].split(':').at(-1) === 'val' &&
      wordNamespaces.has(namespaceScopes.get(property)?.[keys[0].slice(2).split(':')[0]] ?? '');
    const value = validAttribute ? attr(property, 'val') : undefined;
    if (matches.length !== 1 || !wordNamespaces.has(namespaces.get(properties!) ?? '') || !wordNamespaces.has(namespaces.get(property) ?? '') ||
      value === undefined || children(property).some(item => tag(item) !== '#text' || String(item['#text']).trim()) ||
      (name === 'vertAlign' ? !['baseline', 'superscript', 'subscript'].includes(value) : !/^[+-]?\d+$/.test(value))) {
      notes.add(MATH_STRUCTURE_UNREAD_NOTE);
      // Styles/defaults may be reused by many runs. Keep source property text once, at its first affected run.
      const unseen = matches.filter(item => !retainedPropertyText.has(item));
      for (const item of unseen) retainedPropertyText.add(item);
      const text = readableText(unseen);
      return { value: null, ...(text ? { unread: unreadMarker(text) } : {}) };
    }
    return { value };
  };
  // Direct rPr, then the character style, paragraph style and docDefaults. An invalid value stops this chain.
  const styleRunValue = (id: string | undefined, name: string, seen = new Set<string>()): WordRunValue | undefined => {
    if (!id) return undefined;
    if (seen.has(id)) throw new Error('Document heading styles contain a cycle.');
    seen.add(id);
    const style = styles.get(id);
    if (!style) return undefined;
    const value = runValue(style.runProperties, name);
    return value !== undefined ? value : styleRunValue(style.parent, name, seen);
  };
  const runProperty = (name: string, run: XmlNode | undefined, paragraphStyle: string | undefined) => {
    for (const read of [() => runValue(run, name), () => styleRunValue(val(run, 'rStyle'), name),
      () => styleRunValue(paragraphStyle ?? defaultParagraphStyle, name), () => runValue(documentDefaults, name)]) {
      const value = read();
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const documentRels = relations(parts, base);
  const numberingTarget = attr(relationsOfType(documentRels, 'numbering')[0], 'Target');
  const styleList = (id: string | undefined) => inherited('list', id);
  const shared = { parts, notes, page: { number: 1 }, numbering: new Numbering(parts.get(numberingTarget ? resolvePart(base, numberingTarget) : 'word/numbering.xml'), styleList), styleLevel: (id: string | undefined) => inherited('level', id), styleList, runProperty };
  const context = (path: string): WordContext => ({ ...shared, base: path, rels: path === base ? documentRels : relations(parts, path) });
  const document = context(base);
  const acc = new Accumulator();
  acc.marker(`[Page ${document.page.number}]`);
  acc.apply(wordBlocks(contentChildren(body), document));
  const part = (rel: XmlNode) => { const path = resolvePart(base, attr(rel, 'Target')!); return { path, root: required(parts, path), ctx: context(path) }; };
  for (const [suffix, label] of [['header', '[Header]'], ['footer', '[Footer]']] as const) {
    for (const rel of relationsOfType(document.rels, suffix)) {
      const { root: partRoot, ctx } = part(rel);
      acc.currentHeading = undefined;
      acc.marker(label);
      acc.apply(wordBlocks(partRoot, ctx));
    }
  }
  for (const [suffix, element, label] of [['footnotes', 'footnote', '[Footnotes]'], ['endnotes', 'endnote', '[Endnotes]']] as const) {
    for (const rel of relationsOfType(document.rels, suffix)) {
      const { root: partRoot, ctx } = part(rel);
      // An absent type and explicit normal are equivalent. Only the declared separator/continuation entries are
      // layout; unfamiliar types keep their available text and require review rather than disappearing.
      const entries = all(partRoot, element).filter(note => {
        const type = attr(note, 'type');
        if (type === undefined || type === 'normal') return true;
        if (['separator', 'continuationSeparator', 'continuationNotice'].includes(type)) return false;
        notes.add(EMBEDDED_UNREAD_NOTE);
        return true;
      });
      if (!entries.length) continue;
      acc.currentHeading = undefined;
      acc.marker(label);
      for (const note of entries) {
        const blocks = wordBlocks(children(note), ctx);
        const first = blocks.find(block => block.kind === 'text' && block.text.trim());
        if (first && first.kind === 'text') first.text = `[${attr(note, 'id')}] ${first.text}`;
        acc.apply(blocks);
      }
    }
  }
  for (const rel of relationsOfType(document.rels, 'comments')) {
    const { root: partRoot, ctx } = part(rel);
    const comments = all(partRoot, 'comment').map(comment => cellText(wordBlocks(children(comment), ctx))).filter(text => text.trim());
    if (!comments.length) continue;
    acc.currentHeading = undefined;
    acc.marker('[Comments]');
    for (const comment of comments) acc.add(comment);
  }
  return acc.finish(metadataTitle(parts), notes);
}

// ---------------------------------------------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------------------------------------------

interface SlideContext extends PartContext { layout: readonly XmlNode[] }
/**
 * One slide paragraph with its own bullet or number. Autonumber counters are per shape and per level; nothing is
 * inherited from layouts or masters. `listStyle` is the text body's own `a:lstStyle`, consulted for a level's baseline.
 */
function slideParagraph(node: XmlNode, rels: readonly XmlNode[], counters: Map<number, number>, notes: Set<string>, listStyle?: XmlNode): string {
  const properties = child(node, 'pPr');
  const level = Number(attr(properties, 'lvl') ?? 0);
  const levelBaseline = firstBaseline(drawingBaseline(child(child(listStyle, `lvl${level + 1}pPr`), 'defRPr')),
    drawingBaseline(child(child(listStyle, 'defPPr'), 'defRPr')));
  let prefix = '';
  const autoNumber = child(properties, 'buAutoNum');
  if (autoNumber) {
    const scheme = attr(autoNumber, 'type') ?? 'arabicPeriod';
    const current = counters.get(level);
    const number = current === undefined ? Number(attr(autoNumber, 'startAt') ?? 1) : current + 1;
    counters.set(level, number);
    for (const deeper of [...counters.keys()].filter(key => key > level)) counters.delete(deeper);
    const [, style = 'arabic', shape = 'Period'] = /^(arabic|alphaLc|alphaUc|romanLc|romanUc|[a-z]+?)(Period|ParenR|ParenBoth|Plain|[A-Z][A-Za-z]*)?$/.exec(scheme) ?? [];
    const rendered = formatNumber(number, style);
    prefix = `${shape === 'ParenR' ? `${rendered})` : shape === 'ParenBoth' ? `(${rendered})` : shape === 'Plain' ? rendered : `${rendered}.`} `;
  } else if (child(properties, 'buChar')) prefix = `${bulletChar(attr(child(properties, 'buChar'), 'char'))} `;
  return prefix + drawingRuns(children(node), rels, notes, levelBaseline);
}
function slideTable(node: XmlNode, ctx: SlideContext): Block {
  const rows = children(node).filter(item => tag(item) === 'tr').map(row => children(row).filter(item => tag(item) === 'tc').map(cell => all(children(cell), 'p').map(p => slideParagraph(p, ctx.rels, new Map(), ctx.notes, all(children(cell), 'lstStyle')[0])).filter(text => text.trim()).join('\n')));
  return { kind: 'table', rows, header: 0 };
}
const templatePlaceholders = new Set(['sldNum', 'dt', 'ftr']);
function slideShapes(nodes: readonly XmlNode[], ctx: SlideContext): Block[] {
  const out: Block[] = [];
  for (const node of nodes) {
    const name = tag(node);
    if (name === '#text') continue;
    if (name === 'sp') {
      const placeholder = all(children(node), 'ph')[0];
      const inherited = placeholder && all(ctx.layout, 'ph').find(ph => (attr(ph, 'idx') ?? '0') === (attr(placeholder, 'idx') ?? '0'));
      const kind = placeholder ? attr(placeholder, 'type') ?? (inherited && attr(inherited, 'type')) : undefined;
      if (kind && templatePlaceholders.has(kind)) continue;
      out.push(...altBlock(all(children(node), 'cNvPr')[0]));
      const counters = new Map<number, number>();
      const listStyle = all(children(node), 'lstStyle')[0];
      const paragraphs = all(children(node), 'p').map(p => slideParagraph(p, ctx.rels, counters, ctx.notes, listStyle));
      if (kind === 'title' || kind === 'ctrTitle') out.push(textBlock(paragraphs.join('\n'), 1));
      else out.push(...paragraphs.map(text => textBlock(text)));
    } else if (name === 'tbl') out.push(slideTable(node, ctx));
    else if (name === 'chart') out.push(...chartBlocks(ctx, attr(node, 'id', true)));
    else if (name === 'relIds') out.push(...smartArtBlocks(ctx, attr(node, 'dm', true)));
    else if (name === 'cNvPr') out.push(...altBlock(node));
    else {
      if (embeddedTags.has(name)) ctx.notes.add(EMBEDDED_UNREAD_NOTE);
      out.push(...slideShapes(contentChildren(node), ctx));
    }
  }
  return out;
}
/** Slide comments: legacy `p:cm/p:text` and modern comment parts whose `cm` and replies hold `a:p` paragraphs. */
function slideComments(root: readonly XmlNode[], notes: Set<string>): Block[] {
  return all(root, 'cm').map(comment => {
    const paragraphs = all(children(comment), 'p').map(p => drawingRuns(children(p), [], notes)).filter(text => text.trim());
    return paragraphs.length ? paragraphs.join('\n') : literal(child(comment, 'text') ?? {});
  }).filter(text => text.trim()).map(text => textBlock(text));
}
export function parsePptxParts(parts: ReadonlyMap<string, string>): ParsedDocument {
  const base = 'ppt/presentation.xml';
  const presentation = required(parts, base);
  const rels = relations(parts, base);
  const presentationNamespaces = new Set(['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main']);
  const root = presentation.find(node => tag(node) === 'presentation' && presentationNamespaces.has(namespaces.get(node) ?? ''));
  if (!root) throw new Error('The presentation root is missing or unsupported.');
  const presentationNamespace = namespaces.get(root);
  // Section extensions also contain sldId elements, but only this direct list orders slides.
  const ids = children(root)
    .filter(node => tag(node) === 'sldIdLst' && namespaces.get(node) === presentationNamespace)
    .flatMap(node => children(node).filter(item => tag(item) === 'sldId' && namespaces.get(item) === presentationNamespace));
  if (!ids.length) throw new Error('The presentation contains no slides.');
  const acc = new Accumulator();
  const notes = new Set<string>();
  // Baseline shifts inherited from a layout or master are not resolved: a nonzero (or unparseable) default there is flagged once.
  const templates = new Set<string>();
  const inheritedShift = (path: string) => {
    if (templates.has(path)) return;
    templates.add(path);
    if (all(required(parts, path), 'defRPr').some(property => baselineShift(drawingBaseline(property)) !== undefined)) notes.add(MATH_STRUCTURE_UNREAD_NOTE);
    for (const master of relationsOfType(relations(parts, path), 'slideMaster')) inheritedShift(resolvePart(path, attr(master, 'Target')!));
  };
  for (const [index, id] of ids.entries()) {
    const rel = relationship(rels, attr(id, 'id', true));
    const target = attr(rel, 'Target');
    if (!target || attr(rel, 'TargetMode') === 'External') throw new Error('A slide relationship is missing or external.');
    const path = resolvePart(base, target);
    const slide = required(parts, path);
    const slideRels = relations(parts, path);
    const layoutTarget = attr(relationsOfType(slideRels, 'slideLayout')[0], 'Target');
    const layoutPath = layoutTarget ? resolvePart(path, layoutTarget) : undefined;
    if (layoutPath) inheritedShift(layoutPath);
    const ctx: SlideContext = { parts, base: path, rels: slideRels, notes, layout: layoutPath ? required(parts, layoutPath) : [] };
    const hidden = slide.some(node => tag(node) === 'sld' && attr(node, 'show') === '0');
    acc.currentHeading = undefined;
    acc.marker(hidden ? `[Slide ${index + 1}, hidden]` : `[Slide ${index + 1}]`);
    acc.apply(slideShapes(slide, ctx));
    for (const commentRel of relationsOfType(slideRels, 'comments')) {
      const blocks = slideComments(required(parts, resolvePart(path, attr(commentRel, 'Target')!)), notes);
      if (!blocks.length) continue;
      acc.marker('[Comments]');
      acc.apply(blocks);
    }
  }
  return acc.finish(metadataTitle(parts), notes);
}
