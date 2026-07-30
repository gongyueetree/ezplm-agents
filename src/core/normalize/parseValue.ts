import { preclean } from './preclean';

/**
 * 参数值解析。
 *
 * 设计要点：
 * 1. hint 是**必需参数**。裸数字 47 在电阱列是 47Ω，在电容列是 47pF，没有 hint 就不可能对。
 * 2. 型号与符号名必须在数字解析**之前**被拦掉，
 *    否则 0603WAF1004T5E 会被当成 0603 这个数字。
 * 3. 解不了就返回 unparsed，给出 reason。**绝不猜。**
 *    猜错一次的代价是用户永久不再信任整个面板。
 * 4. 所有做过的假设进 assumed，UI 必须展示。
 */

export type ValueHint = 'R' | 'C' | 'L' | 'V' | 'A' | 'W' | 'Y' | 'unknown';

export type ValueKind =
  | 'resistance' | 'capacitance' | 'inductance'
  | 'voltage' | 'current' | 'power' | 'frequency'
  | 'non_value'   // 确定不是数值（NC / DNP / 待定 / 空）
  | 'unparsed';   // 看不懎，且拒绝猜

export interface ParsedValue {
  kind: ValueKind;
  /** 归一到 SI 基本单位：Ω / F / H / V / A / W / Hz */
  si: number | null;
  display: string;
  tolerancePct?: number | null;
  raw: string;
  /** kind === 'unparsed' 时必填 */
  reason?: string;
  assumed: string[];
}

const NON_VALUE = new Set([
  'NC', 'DNP', 'DNI', 'NA', 'N/A', 'NONE', 'NULL',
  '-', '—', '–', '/', '?',
  '待定', 'TBD', '无', '空', '待选', '不装', '不用',
]);

interface UnitDef { kind: ValueKind; sym: string }

const UNIT_BY_TOKEN: Record<string, UnitDef> = {
  'Ω': { kind: 'resistance', sym: 'Ω' },
  'OHM': { kind: 'resistance', sym: 'Ω' },
  'OHMS': { kind: 'resistance', sym: 'Ω' },
  'F': { kind: 'capacitance', sym: 'F' },
  'H': { kind: 'inductance', sym: 'H' },
  'V': { kind: 'voltage', sym: 'V' },
  'A': { kind: 'current', sym: 'A' },
  'W': { kind: 'power', sym: 'W' },
  'HZ': { kind: 'frequency', sym: 'Hz' },
};

const MULT: Record<string, number> = {
  p: 1e-12, n: 1e-9, '\u03BC': 1e-6, u: 1e-6, U: 1e-6,
  m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9,
};

const HINT_KIND: Record<ValueHint, ValueKind> = {
  R: 'resistance', C: 'capacitance', L: 'inductance',
  V: 'voltage', A: 'current', W: 'power', Y: 'frequency',
  unknown: 'unparsed',
};

/** 裸数字的默认单位，EDA 界的约定：电阻=Ω，电容=pF，电感=nH。 */
const BARE_DEFAULT: Partial<Record<ValueHint, { mult: number; note: string }>> = {
  R: { mult: 1, note: '裸数字按位号前缀 R 解释为 Ω' },
  C: { mult: 1e-12, note: '裸数字按位号前缀 C 解释为 pF' },
  L: { mult: 1e-9, note: '裸数字按位号前缀 L 解释为 nH' },
};

const TOL_LETTER: Record<string, number> = { B: 0.1, C: 0.25, D: 0.5, F: 1, G: 2, J: 5, K: 10, M: 20 };

const SI_STEPS: Array<[number, string]> = [
  [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''],
  [1e-3, 'm'], [1e-6, '\u03BC'], [1e-9, 'n'], [1e-12, 'p'],
];

function unitSym(kind: ValueKind): string {
  if (kind === 'resistance') return 'Ω';
  if (kind === 'capacitance') return 'F';
  if (kind === 'inductance') return 'H';
  if (kind === 'voltage') return 'V';
  if (kind === 'current') return 'A';
  if (kind === 'power') return 'W';
  if (kind === 'frequency') return 'Hz';
  return '';
}

export function formatSi(si: number, sym: string): string {
  const abs = Math.abs(si);
  for (const step of SI_STEPS) {
    if (abs >= step[0]) {
      return String(parseFloat((si / step[0]).toPrecision(6))) + step[1] + sym;
    }
  }
  return String(si) + sym;
}

/** 看起来像型号：长度够、字母够、数字够，且不是“数字+单位”这种形式。 */
export function looksLikeMPN(s: string): boolean {
  if (s.length < 6) return false;
  if (/^\d+(\.\d+)?\s*[a-zA-ZΩ]{0,3}$/.test(s)) return false;
  return /[A-Za-z]{2,}/.test(s) && /\d{3,}/.test(s);
}

/** 看起来像符号/封装名：R_0603_1608Metric、l_bourns_srn6045ta */
export function looksLikeSymbolName(s: string): boolean {
  return /^[A-Za-z]{1,4}_[A-Za-z0-9_.\-]{2,}$/.test(s) || /^[lL]_[A-Za-z]+_/.test(s);
}

function fail(raw: string, reason: string): ParsedValue {
  return { kind: 'unparsed', si: null, display: raw, raw, reason, assumed: [] };
}

function pickTolerance(s: string): number | null {
  const pct = s.match(/±\s*(\d+(?:\.\d+)?)\s*%/) ?? s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return parseFloat(pct[1]!);
  const letter = s.match(/(?:^|[\s,(])([BCDFGJKM])(?:[\s,)]|$)/);
  if (letter) return TOL_LETTER[letter[1]!] ?? null;
  return null;
}

export function parseValue(rawIn: string | null | undefined, hint: ValueHint = 'unknown'): ParsedValue {
  const raw = preclean(rawIn);
  const assumed: string[] = [];

  // 1) 空
  if (raw.length === 0) return { kind: 'non_value', si: null, display: '', raw: '', assumed };

  // 2) 明确的非数值占位
  if (NON_VALUE.has(raw.toUpperCase())) return { kind: 'non_value', si: null, display: raw, raw, assumed };

  // 3) 型号 / 符号名：必须在数字解析之前拦掉
  if (looksLikeSymbolName(raw)) return fail(raw, 'looks_like_symbol_name');
  if (looksLikeMPN(raw)) return fail(raw, 'looks_like_mpn');

  // 4) 显式单位：100nF / 4.7uH / 1MΩ / 50V / 1.5A / 0.25W / 24MHz
  const withUnit = raw.match(/^([+-]?\d+(?:\.\d+)?)\s*(p|n|\u03BC|u|m|k|K|M|G)?\s*(Ω|ohms?|F|H|V|A|W|Hz)\b/i);
  if (withUnit) {
    const num = parseFloat(withUnit[1]!);
    const pre = withUnit[2];
    const unitDef = UNIT_BY_TOKEN[withUnit[3]!.toUpperCase()] ?? UNIT_BY_TOKEN[withUnit[3]!];
    if (unitDef) {
      const si = num * (pre ? MULT[pre] ?? 1 : 1);
      return {
        kind: unitDef.kind, si, display: formatSi(si, unitDef.sym),
        tolerancePct: pickTolerance(raw), raw, assumed,
      };
    }
  }

  // 4b) 只有倍率没有单位：1M / 10k / 4.7u —— 靠 hint 定量纲
  const multOnly = raw.match(/^([+-]?\d+(?:\.\d+)?)\s*(p|n|\u03BC|u|m|k|K|M|G)$/);
  if (multOnly) {
    const kind = HINT_KIND[hint];
    if (kind === 'unparsed') return fail(raw, 'need_hint_for_unitless');
    // 电容的 M 是容差代码 ±20%，不是兆。这里不能猜。
    if (hint === 'C' && multOnly[2] === 'M') return fail(raw, 'ambiguous_M_on_capacitor');
    const si = parseFloat(multOnly[1]!) * MULT[multOnly[2]!]!;
    return {
      kind, si, display: formatSi(si, unitSym(kind)), raw,
      assumed: ['无单位，按 hint=' + hint + ' 定量纲'],
    };
  }

  // 5) RKM 编码：4k7 / 1R0 / 10R / R47 / 4u7
  const rkm = raw.match(/^(\d*)(R|K|k|M|G|p|n|\u03BC|u|m)(\d*)$/);
  if (rkm) {
    const head = rkm[1] ?? '';
    const letter = rkm[2]!;
    const tail = rkm[3] ?? '';
    if (head.length === 0 && tail.length === 0) return fail(raw, 'rkm_no_digits');
    const isOhmR = letter === 'R';
    const mult = isOhmR ? 1 : MULT[letter] ?? 1;
    const num = parseFloat((head.length ? head : '0') + '.' + (tail.length ? tail : '0'));
    let kind: ValueKind;
    if (isOhmR) {
      kind = 'resistance';
    } else if (HINT_KIND[hint] === 'unparsed') {
      kind = 'resistance';
      assumed.push('RKM 编码无量纲线索，默认按电阻处理');
    } else {
      kind = HINT_KIND[hint];
    }
    const si = num * mult;
    return { kind, si, display: formatSi(si, unitSym(kind)), raw, assumed };
  }

  // 6) 裸数字 + hint
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const def = BARE_DEFAULT[hint];
    if (!def) return fail(raw, 'bare_number_without_usable_hint');
    assumed.push(def.note);
    const kind = HINT_KIND[hint];
    const si = parseFloat(raw) * def.mult;
    return { kind, si, display: formatSi(si, unitSym(kind)), raw, assumed };
  }

  // 7) 认输。绝不猜。
  return fail(raw, 'unrecognized_pattern');
}

/**
 * EIA 三位容量编码（104 = 100nF）。
 * 单独导出而不并入 parseValue，是因为“100”既可能是 100pF 也可能是 10pF，
 * 只有调用方确定当前上下文是“容量代码位”时才能用它。
 */
export function parseEia3(rawIn: string): ParsedValue {
  const raw = preclean(rawIn);
  if (!/^\d{3}$/.test(raw)) return fail(raw, 'not_eia3');
  const si = parseInt(raw.slice(0, 2), 10) * Math.pow(10, parseInt(raw[2]!, 10)) * 1e-12;
  return { kind: 'capacitance', si, display: formatSi(si, 'F'), raw, assumed: ['按 EIA 三位代码解释'] };
}

/** 位号前缀 -> hint。FB/L 都归电感量纲（磁珠也用 H）。 */
export function hintFromDesignator(refs: string | null | undefined): ValueHint {
  const p = preclean(refs).match(/^([A-Za-z]{1,4})/);
  if (!p) return 'unknown';
  const prefix = p[1]!.toUpperCase();
  if (prefix === 'R' || prefix === 'RN' || prefix === 'RV') return 'R';
  if (prefix === 'C' || prefix === 'CN') return 'C';
  if (prefix === 'L' || prefix === 'FB' || prefix === 'FL') return 'L';
  if (prefix === 'Y' || prefix === 'X' || prefix === 'XT') return 'Y';
  return 'unknown';
}
