import { preclean } from './preclean';
import { formatSi } from './parseValue';

/**
 * 型号解码。
 *
 * 存在的意义是做**第二条独立证据链**：
 * 描述串说 910k、型号解码说 4.7k，两边不一致就能报出来。
 * 实际在映射字典里就抳到过这个错：一条 910k 的映射指向了一颗 472（4.7k）。
 *
 * 原则：只解已注册的系列，没命中就返回 ok:false。
 * 宁可不解，不可猜错 —— 解错一条会把一个正确的 BOM 行报成错的。
 */

export interface DecodedMPN {
  ok: boolean;
  series?: string;
  chipSize?: string;
  /** 归一到 SI（电阻为 Ω） */
  valueSi?: number | null;
  valueDisplay?: string;
  tolerancePct?: number | null;
  powerW?: number | null;
  raw: string;
  matchedBy?: string;
  notes: string[];
}

const TOL: Record<string, number> = { B: 0.1, C: 0.25, D: 0.5, F: 1, G: 2, J: 5, K: 10, M: 20 };

/** 片式电阻额定功率的行业惯例值。仅作参考，不可当作选型依据。 */
const POWER_BY_SIZE: Record<string, number> = {
  '0201': 1 / 20, '0402': 1 / 16, '0603': 1 / 10, '0805': 1 / 8,
  '1206': 1 / 4, '1210': 1 / 3, '2010': 3 / 4, '2512': 1,
};

/**
 * 数字代码 -> 阻值。
 * 3 位：前 2 位有效 + 倍率（472 = 47 x 10^2 = 4.7k）
 * 4 位：前 3 位有效 + 倍率（1004 = 100 x 10^4 = 1M）
 */
export function codeToOhm(code: string): number | null {
  if (/^\d{3}$/.test(code)) {
    return parseInt(code.slice(0, 2), 10) * Math.pow(10, parseInt(code[2]!, 10));
  }
  if (/^\d{4}$/.test(code)) {
    return parseInt(code.slice(0, 3), 10) * Math.pow(10, parseInt(code[3]!, 10));
  }
  return null;
}

/** RKM 尾串 -> 阻值：4K02 = 4.02k，1R00 = 1Ω，10K0 = 10k */
export function rkmToOhm(s: string): number | null {
  const m = s.match(/^(\d*)([RKM])(\d*)$/i);
  if (!m) return null;
  const letter = m[2]!.toUpperCase();
  const mult = letter === 'R' ? 1 : letter === 'K' ? 1e3 : 1e6;
  const head = m[1] ?? '';
  const tail = m[3] ?? '';
  if (head.length === 0 && tail.length === 0) return null;
  return parseFloat((head.length ? head : '0') + '.' + (tail.length ? tail : '0')) * mult;
}

export interface Decoder {
  name: string;
  re: RegExp;
  build(m: RegExpMatchArray): Partial<DecodedMPN> | null;
}

/**
 * 解码器注册表。新增厂商系列只往这里加一条，不动调用方。
 * 每条 decoder 都必须有至少一个来自真实 BOM 的 fixture（见 test/fixtures.real.ts）。
 */
export const RESISTOR_DECODERS: Decoder[] = [
  {
    // 厚声 Uni-Royal：0603WAF1004T5E / 0402WGF1502TCE / 0402WGJ0334TCE
    name: 'uniroyal',
    re: /^(\d{4})W([A-Z])([BCDFGJKM])(\d{3,4})T/i,
    build(m) {
      const ohm = codeToOhm(m[4]!);
      if (ohm === null) return null;
      const size = m[1]!;
      return {
        series: size + 'W' + m[2]!.toUpperCase() + m[3]!.toUpperCase(),
        chipSize: size,
        valueSi: ohm,
        tolerancePct: TOL[m[3]!.toUpperCase()] ?? null,
        powerW: POWER_BY_SIZE[size] ?? null,
      };
    },
  },
  {
    // FRC 系列：FRC0603J472_TS / FRC0402F2212TS
    name: 'frc',
    re: /^FRC(\d{4})([BCDFGJKM])(\d{3,4})/i,
    build(m) {
      const ohm = codeToOhm(m[3]!);
      if (ohm === null) return null;
      const size = m[1]!;
      return {
        series: 'FRC' + size + m[2]!.toUpperCase(),
        chipSize: size,
        valueSi: ohm,
        tolerancePct: TOL[m[2]!.toUpperCase()] ?? null,
        powerW: POWER_BY_SIZE[size] ?? null,
      };
    },
  },
  {
    // 国巨 Yageo：RT0603BRE074K02L / RC0402FR-071KL
    name: 'yageo',
    re: /^R([CT])(\d{4})([BDFJ])R?E?-?0?7?([0-9RKM.]+)L?$/i,
    build(m) {
      const tail = m[4]!;
      const ohm = rkmToOhm(tail) ?? codeToOhm(tail);
      if (ohm === null) return null;
      const size = m[2]!;
      return {
        series: 'R' + m[1]!.toUpperCase() + size + m[3]!.toUpperCase(),
        chipSize: size,
        valueSi: ohm,
        tolerancePct: TOL[m[3]!.toUpperCase()] ?? null,
        powerW: POWER_BY_SIZE[size] ?? null,
      };
    },
  },
];

export function decodeResistorMPN(rawIn: string): DecodedMPN {
  const raw = preclean(rawIn).replace(/\s+/g, '');
  for (const d of RESISTOR_DECODERS) {
    const m = raw.match(d.re);
    if (!m) continue;
    const part = d.build(m);
    if (!part) continue;
    const out: DecodedMPN = { ok: true, raw, matchedBy: d.name, notes: [], ...part };
    if (out.valueSi !== null && out.valueSi !== undefined) {
      out.valueDisplay = formatSi(out.valueSi, 'Ω');
    }
    return out;
  }
  return { ok: false, raw, notes: ['未命中已注册的电阻系列，需人工确认'] };
}

/**
 * 通用入口。
 * 电容/电感的厂商编码体系比电阻乱得多（同一位在不同系列里含义不同），
 * 目前**故意不实现**。宁可返回 ok:false 让 A1 跳过交叉验证，
 * 也不要拉一个不靠的解码器进来制造假阳性。
 */
export function decodeMPN(raw: string, hint?: 'R' | 'C' | 'L'): DecodedMPN {
  if (hint === undefined || hint === 'R') {
    const r = decodeResistorMPN(raw);
    if (r.ok) return r;
  }
  return { ok: false, raw: preclean(raw), notes: ['该品类解码器未实现，按 UNPARSED 处理'] };
}

/** 两个阻值是否在容差内一致。用于描述串 vs 型号解码的交叉比对。 */
export function valuesAgree(a: number | null | undefined, b: number | null | undefined, relTol = 0.02): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (a === 0 || b === 0) return a === b;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) <= relTol;
}
