import { preclean } from './preclean';

/**
 * 位号串解析。A1 的 R01（位号数与用量不一致）完全建立在这个函数上。
 *
 * 真实 BOM 里碰到过的写法：
 *   R1,R2,R3        半角逗号
 *   R1，R2         全角逗号
 *   R1-R5           区间
 *   FB1,FB2,FB3,FB4,FB5,FB8   断号（合法，不一定是错）
 *   C12 C13 C14     空格分隔
 *   U1A / U1B       同一器件的不同部分
 */

const REF_RE = /^([A-Za-z]{1,4})(\d{1,5})([A-Za-z]?)$/;

/** 区间展开的上限。防的不是恶意输入，而是手滑把 R1-R99999 敏敏到格子里。 */
const MAX_RANGE_SPAN = 500;

export interface ParsedRefs {
  /** 展开、去重、自然序 */
  refs: string[];
  count: number;
  /** 行内重复的位号 */
  duplicates: string[];
  /** 无法识别的片段，原样回传，不尝试修正 */
  malformed: string[];
  /** 展开过的区间，必须告知用户——因为展开直接影响用量 */
  expandedFrom: string[];
}

export function parseRefs(rawIn: string | null | undefined): ParsedRefs {
  const raw = preclean(rawIn);
  const collected: string[] = [];
  const malformed: string[] = [];
  const expandedFrom: string[] = [];

  if (raw.length === 0) {
    return { refs: [], count: 0, duplicates: [], malformed: [], expandedFrom: [] };
  }

  for (const tokenRaw of raw.split(/[,;、\s]+/)) {
    const token = tokenRaw.trim();
    if (token.length === 0) continue;

    const range = token.match(/^([A-Za-z]{1,4})(\d{1,5})\s*(?:-|~|—|\.\.)\s*([A-Za-z]{0,4})(\d{1,5})$/);
    if (range) {
      const p1 = range[1]!.toUpperCase();
      const p2 = range[3] ?? '';
      if (p2.length > 0 && p2.toUpperCase() !== p1) { malformed.push(token); continue; }
      const from = parseInt(range[2]!, 10);
      const to = parseInt(range[4]!, 10);
      if (to < from || to - from > MAX_RANGE_SPAN) { malformed.push(token); continue; }
      for (let i = from; i <= to; i += 1) collected.push(p1 + String(i));
      expandedFrom.push(token);
      continue;
    }

    const m = token.match(REF_RE);
    if (m) {
      collected.push(m[1]!.toUpperCase() + String(parseInt(m[2]!, 10)) + (m[3] ?? '').toUpperCase());
    } else {
      malformed.push(token);
    }
  }

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const r of collected) {
    if (seen.has(r)) duplicates.push(r);
    else seen.add(r);
  }
  const refs = Array.from(seen).sort(naturalRefCmp);
  return {
    refs,
    count: refs.length,
    duplicates: Array.from(new Set(duplicates)),
    malformed,
    expandedFrom,
  };
}

export function naturalRefCmp(a: string, b: string): number {
  const pa = a.match(REF_RE);
  const pb = b.match(REF_RE);
  if (!pa || !pb) return a.localeCompare(b);
  if (pa[1] !== pb[1]) return pa[1]!.localeCompare(pb[1]!);
  return parseInt(pa[2]!, 10) - parseInt(pb[2]!, 10);
}

export interface RefGap {
  prefix: string;
  missing: number[];
  range: [number, number];
}

/**
 * 断号检测（A1/R15）。
 *
 * **必须对整张 BOM 的位号并集做，不能逐行做。**
 * 逐行做的后果：某行写 FB1..FB5,FB8 会报“缺 FB6,FB7”，
 * 而 FB6/FB7 实际上就在另一行（用了不同型号）。这种误报一出现，规则就死了。
 *
 * 另外两条克制：
 *  - 样本 < 3 不报（信息不足）
 *  - 编号过于稀疏不报（很多团队按功能块分段编号，如 R101 R102 R201）
 */
export function findGaps(allRefs: string[]): RefGap[] {
  const byPrefix = new Map<string, number[]>();
  for (const r of allRefs) {
    const m = r.match(REF_RE);
    if (!m) continue;
    const key = m[1]!.toUpperCase();
    const arr = byPrefix.get(key);
    if (arr) arr.push(parseInt(m[2]!, 10));
    else byPrefix.set(key, [parseInt(m[2]!, 10)]);
  }

  const result: RefGap[] = [];
  for (const entry of byPrefix) {
    const prefix = entry[0];
    const sorted = Array.from(new Set(entry[1])).sort((x, y) => x - y);
    if (sorted.length < 3) continue;
    const lo = sorted[0]!;
    const hi = sorted[sorted.length - 1]!;
    if (hi - lo + 1 > sorted.length * 3) continue;
    const present = new Set(sorted);
    const missing: number[] = [];
    for (let i = lo; i <= hi; i += 1) if (!present.has(i)) missing.push(i);
    if (missing.length > 0) result.push({ prefix, missing, range: [lo, hi] });
  }
  return result;
}

/** 跨行重复位号（A1/R02 的整表版）。同一位号被两行占用是硬错。 */
export function findCrossRowDuplicates(
  rows: Array<{ id: string; rowNo: number; refs: string | null | undefined }>,
): Array<{ ref: string; rows: Array<{ id: string; rowNo: number }> }> {
  const owner = new Map<string, Array<{ id: string; rowNo: number }>>();
  for (const row of rows) {
    for (const r of parseRefs(row.refs).refs) {
      const arr = owner.get(r);
      if (arr) arr.push({ id: row.id, rowNo: row.rowNo });
      else owner.set(r, [{ id: row.id, rowNo: row.rowNo }]);
    }
  }
  const out: Array<{ ref: string; rows: Array<{ id: string; rowNo: number }> }> = [];
  for (const entry of owner) {
    if (entry[1].length > 1) out.push({ ref: entry[0], rows: entry[1] });
  }
  return out.sort((a, b) => naturalRefCmp(a.ref, b.ref));
}
