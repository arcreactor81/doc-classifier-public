import type { DigestTable } from '../digest/digest.ts';
interface Structure { role?: string; type?: string; id?: string; scope?: string; children?: Structure[] }
export interface MarkedText { text: string; position: number }
/** Tagged PDF semantics are authoritative; untagged text stays in its text blocks. */
export function taggedTables(tree: Structure | null, content: ReadonlyMap<string, MarkedText>): DigestTable[] {
  function fragments(node: Structure): MarkedText[] {
    if (node.type === 'content' && node.id && content.has(node.id)) return [content.get(node.id)!];
    return (node.children ?? []).flatMap(fragments);
  }
  function headers(node: Structure): string[] {
    if (node.role === 'TH') return node.scope === 'Row' ? [] : [fragments(node).map(value => value.text).join('')];
    return (node.children ?? []).flatMap(headers);
  }
  function walk(node: Structure): DigestTable[] {
    if (node.role === 'Table') {
      const values = fragments(node);
      return values.length ? [{ position: Math.min(...values.map(value => value.position)), headers: headers(node) }] : [];
    }
    return (node.children ?? []).flatMap(walk);
  }
  return tree ? walk(tree) : [];
}