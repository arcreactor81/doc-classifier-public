import type { DigestHeading } from '../digest/digest.ts';

export interface PdfHeadingPolicy {
  largeFontRatio: number;
  maximumHeadingCharacters: number;
  topPageFraction: number;
  gapRatio: number;
  minimumHeadings: number;
}
export interface PdfLine {
  text: string; page: number; x: number; y: number; fontSize: number;
  bold: boolean; position: number; pageHeight: number; itemFontSizes?: number[];
}
export function browserSupported(userAgent: string, hasDirectoryPicker: boolean): boolean {
  return hasDirectoryPicker && /(?:Chrome|Edg)\/\d+/.test(userAgent)
    && !/Android|Mobile|iPhone|iPad|CriOS|EdgiOS|OPR\/|SamsungBrowser\/|Firefox\//.test(userAgent);
}
export function validatePdfPolicy(policy: PdfHeadingPolicy): void {
  if (!policy || !Number.isFinite(policy.largeFontRatio) || policy.largeFontRatio <= 1
    || !Number.isSafeInteger(policy.maximumHeadingCharacters) || policy.maximumHeadingCharacters < 1
    || !Number.isFinite(policy.topPageFraction) || policy.topPageFraction <= 0 || policy.topPageFraction >= 1
    || !Number.isFinite(policy.gapRatio) || policy.gapRatio <= 1
    || !Number.isSafeInteger(policy.minimumHeadings) || policy.minimumHeadings < 0) throw new Error('Invalid PDF heading policy.');
}
export function inferPdfHeadings(lines: readonly PdfLine[], policy: PdfHeadingPolicy): DigestHeading[] {
  validatePdfPolicy(policy);
  const frequencies = new Map<number, number>();
  for (const line of lines) for (const size of line.itemFontSizes ?? [line.fontSize]) frequencies.set(size, (frequencies.get(size) ?? 0) + 1);
  const body = [...frequencies].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  if (body === undefined) return [];
  const gaps = lines.slice(1).map((line, index) => line.page === lines[index].page ? line.y - lines[index].y : 0).filter(gap => gap > 0).sort((a, b) => a - b);
  const typicalGap = gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)] : body;
  const sizes = [...frequencies.keys()].filter(size => size >= body * policy.largeFontRatio).sort((a, b) => b - a);
  return lines.flatMap((line, index) => {
    const previous = lines[index - 1];
    const large = line.fontSize >= body * policy.largeFontRatio;
    const afterGap = previous && previous.page === line.page && line.y - previous.y > typicalGap * policy.gapRatio;
    if (!(large || line.bold) || line.text.length > policy.maximumHeadingCharacters || !(line.y <= line.pageHeight * policy.topPageFraction || afterGap)) return [];
    return [{ id: `heading_${line.position}`, text: line.text, position: line.position, level: large ? sizes.indexOf(line.fontSize) + 1 : sizes.length + 1 }];
  });
}
