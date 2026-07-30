import { makeSuggestion, evidence, ref } from '../../core/suggestion';
import type { AgentContext, Suggestion } from '../../core/types';
import { preclean, foldKey } from '../../core/normalize/preclean';
import { parseValue, hintFromDesignator } from '../../core/normalize/parseValue';
import type { ValueHint } from '../../core/normalize/parseValue';
import { canonFootprint } from '../../core/normalize/canonFootprint';
import { decodeMPN, valuesAgree } from '../../core/normalize/decodeMPN';

/**
 * A4 工程文件导入映射。
 *
 * 这个 Agent 的价值不在“导入更快”，而在**存量字典审计**。
 *
 * 字典是越用越错的：一条错映射会在每一次导入时安静地重复一遍，
 * 而且因为“上次就是这么导的”，没人会去怀疑它。
 *
 * 下面三类检测对应真实已验证的三个错误形态：
 *   1. 数值不符：一条 910k 的键指向了一颗 472（4.7k）的电阻
 *   2. 颜色不符：pink 指向了 LED_GREEN
 *   3. 封装不符：tpd3e001 sot-553 指向了 SS14（SMA 封装的肖特基）
 */

export type DictTab = 'mpn' | 'value';

export interface DictEntry {
  id: string;
  tab: DictTab;
  /** 工程文件里的原始字符串 */
  rawKey: string;
  targetPartId?: string | null;
  targetMpn?: string | null;
  targetDescription?: string | null;
  targetFootprint?: string | null;
  targetCategory?: string | null;
  /** 命中次数。命中越多的错条目优先级越高。 */
  hitCount?: number;
}

const COLORS: Array<[RegExp, string]> = [
  [/\b(red|红)\b/i, 'RED'],
  [/\b(green|绿)\b/i, 'GREEN'],
  [/\b(blue|蓝)\b/i, 'BLUE'],
  [/\b(yellow|黄)\b/i, 'YELLOW'],
  [/\b(white|白)\b/i, 'WHITE'],
  [/\b(pink|粉)\b/i, 'PINK'],
  [/\b(orange|橙)\b/i, 'ORANGE'],
  [/\b(purple|violet|紫)\b/i, 'PURPLE'],
  [/\b(amber|琥珄)\b/i, 'AMBER'],
  [/\b(ir|infrared|红外)\b/i, 'IR'],
  [/\b(uv|紫外)\b/i, 'UV'],
];

function extractColor(s: string): string | null {
  const t = preclean(s);
  for (const c of COLORS) {
    if (c[0].test(t)) return c[1];
  }
  return null;
}

/** 从任意字符串里抽出看起来像封装的 token，并归一化。 */
function extractFootprintToken(s: string): string | null {
  const t = preclean(s);
  const m = t.match(/\b(SOT-?\d{2,3}[A-Z]?|SOD-?\d{2,3}|DO-?\d{3}|SMA|SMB|SMC|QFN-?\d+|SOIC-?\d+|SOP-?\d+|TSSOP-?\d+|MSOP-?\d+|DFN-?\d+|TO-?\d{2,3}|0201|0402|0603|0805|1206|1210|2010|2512)\b/i);
  if (!m) return null;
  const cf = canonFootprint(m[1]!);
  return cf.canon.startsWith('UNKNOWN') ? null : cf.canon;
}

/** 从字符串里抽第一个可解析的数值。 */
function extractValue(s: string, hint: ValueHint) {
  for (const token of preclean(s).split(/[\s,;()\[\]/]+/)) {
    if (token.length === 0) continue;
    const p = parseValue(token, hint);
    if (p.si !== null) return { token, parsed: p };
  }
  return null;
}

/** 从 rawKey 猜量纲：含 Ω/R、k、M 尾缀且无 F/H 则往电阻猜。猜不出来就返回 unknown。 */
function guessHint(rawKey: string, category?: string | null): ValueHint {
  const c = preclean(category);
  if (/电阻/.test(c)) return 'R';
  if (/电容/.test(c)) return 'C';
  if (/电感|磁珠/.test(c)) return 'L';
  const k = preclean(rawKey);
  if (/\d+(\.\d+)?\s*[kKM]?\s*(Ω|ohm|R)\b/i.test(k)) return 'R';
  if (/\d+(\.\d+)?\s*[pnu\u03BC]F\b/i.test(k)) return 'C';
  if (/\d+(\.\d+)?\s*[num\u03BC]?H\b/i.test(k)) return 'L';
  if (/^\d+(\.\d+)?[kKM]$/.test(k)) return 'R';
  return 'unknown';
}

/**
 * 存量字典审计。不修数据，只报问题。
 * 每一条报告都同时列出键与目标两边的原文，让人一眼能判。
 */
export function auditDictionary(entries: DictEntry[], ctx: AgentContext): Array<Suggestion<unknown>> {
  const out: Array<Suggestion<unknown>> = [];

  for (const e of entries) {
    const target = preclean(e.targetDescription) + ' ' + preclean(e.targetMpn);
    if (preclean(e.rawKey).length === 0 || target.trim().length === 0) continue;

    // 1) 数值不符
    const hint = guessHint(e.rawKey, e.targetCategory);
    if (hint !== 'unknown') {
      const fromKey = extractValue(e.rawKey, hint);
      const fromDesc = extractValue(preclean(e.targetDescription), hint);
      const decoded = hint === 'R' ? decodeMPN(preclean(e.targetMpn), 'R') : null;
      const targetSi = decoded && decoded.ok && decoded.valueSi !== undefined ? decoded.valueSi : fromDesc?.parsed.si ?? null;
      if (fromKey && targetSi !== null && !valuesAgree(fromKey.parsed.si, targetSi)) {
        out.push(makeSuggestion({
          agent: 'A4', code: 'A4.DICT_VALUE_MISMATCH', severity: 'block', confidence: 'high',
          target: { objectType: 'dictEntry', objectId: e.id },
          title: '字典键「' + e.rawKey + '」解析为 ' + fromKey.parsed.display + '，但指向的物料是 ' + String(decoded?.valueDisplay ?? fromDesc?.parsed.display),
          detail: '这条映射每次导入都会静默应用一次。命中次数：' + String(e.hitCount ?? '未知')
            + '。建议先停用该条目，再排查已经导入过的 BOM。',
          evidence: [
            evidence('dict', ref.dictEntry(e.tab, e.rawKey), e.rawKey),
            evidence('field', e.targetPartId ? ref.part(e.targetPartId, '规格描述') : 'dict:' + e.id, preclean(e.targetDescription)),
            evidence('mpn', 'mpn:' + preclean(e.targetMpn), String(decoded?.valueDisplay ?? '')),
          ].filter((x) => x.ref.length > 0),
        }));
      }
    }

    // 2) 颜色不符
    const keyColor = extractColor(e.rawKey);
    const targetColor = extractColor(target);
    if (keyColor !== null && targetColor !== null && keyColor !== targetColor) {
      out.push(makeSuggestion({
        agent: 'A4', code: 'A4.DICT_COLOR_MISMATCH', severity: 'block', confidence: 'high',
        target: { objectType: 'dictEntry', objectId: e.id },
        title: '字典键「' + e.rawKey + '」是 ' + keyColor + '，指向的物料是 ' + targetColor,
        detail: '颜色不是外观问题，不同颜色 LED 的正向压降差很多，限流电阻也跟着变。',
        evidence: [
          evidence('dict', ref.dictEntry(e.tab, e.rawKey), e.rawKey),
          evidence('field', e.targetPartId ? ref.part(e.targetPartId, '规格描述') : 'dict:' + e.id, preclean(e.targetDescription)),
        ],
      }));
    }

    // 3) 封装不符
    const keyFp = extractFootprintToken(e.rawKey);
    const targetFp = extractFootprintToken(preclean(e.targetFootprint) + ' ' + target);
    if (keyFp !== null && targetFp !== null && keyFp !== targetFp) {
      out.push(makeSuggestion({
        agent: 'A4', code: 'A4.DICT_FOOTPRINT_MISMATCH', severity: 'block', confidence: 'high',
        target: { objectType: 'dictEntry', objectId: e.id },
        title: '字典键「' + e.rawKey + '」带封装 ' + keyFp + '，指向的物料封装是 ' + targetFp,
        detail: '封装不同意味着焊不上。这类错映射往往是当年“先随便选一个把导入跑通”留下的。',
        evidence: [
          evidence('dict', ref.dictEntry(e.tab, e.rawKey), e.rawKey),
          evidence('field', e.targetPartId ? ref.part(e.targetPartId, '封装') : 'dict:' + e.id, preclean(e.targetFootprint)),
        ],
      }));
    }
  }

  return out;
}

export interface ImportRow {
  rowNo: number;
  refs?: string | null;
  rawValue?: string | null;
  rawFootprint?: string | null;
  rawMpn?: string | null;
  rawDescription?: string | null;
}

export interface PartCandidate {
  partId: string;
  mpn: string;
  description?: string | null;
  footprint?: string | null;
  category?: string | null;
  /** 历史用量，用作同分时的 tie-breaker */
  usageCount?: number;
}

/**
 * 导入时的映射建议。
 *
 * 关键设计：宁可让用户选，不要自己定。
 * eZ-PLM 现有的行为是“未匹配的物料将以黄色标记显示，需后续手动修改”，
 * 这个行为是对的，A4 要做的是把黄色行变少，而不是把黄色行强行变绿。
 */
export function suggestMapping(
  row: ImportRow, candidates: PartCandidate[], ctx: AgentContext,
): Array<Suggestion<unknown>> {
  if (candidates.length === 0) {
    return [makeSuggestion({
      agent: 'A4', code: 'A4.NO_CANDIDATE', severity: 'warn', confidence: 'low',
      target: { objectType: 'bomLine', objectId: 'import-row-' + row.rowNo, rowRef: preclean(row.refs) },
      title: '本行未找到候选物料',
      detail: '保持黄色未匹配状态。可交给 A5 走建档流程，或手动关联。',
      evidence: [evidence('row', 'import:row:' + row.rowNo, preclean(row.rawDescription) || preclean(row.rawValue))],
    })];
  }

  const hint = hintFromDesignator(row.refs);
  const wantValue = row.rawValue ? parseValue(row.rawValue, hint) : null;
  const wantFp = canonFootprint(row.rawFootprint);
  const wantMpnKey = foldKey(row.rawMpn);

  const scored = candidates.map((c) => {
    let score = 0;
    const why: string[] = [];

    if (wantMpnKey.length > 0 && foldKey(c.mpn) === wantMpnKey) {
      score += 0.5; why.push('型号完全一致');
    }
    const cFp = canonFootprint(c.footprint);
    if (!wantFp.canon.startsWith('UNKNOWN') && wantFp.canon === cFp.canon) {
      score += 0.25; why.push('封装归一化后一致 ' + cFp.canon);
    }
    if (wantValue && wantValue.si !== null) {
      const cv = extractValue(preclean(c.description), hint);
      if (cv && valuesAgree(cv.parsed.si, wantValue.si)) {
        score += 0.2; why.push('参数一致 ' + cv.parsed.display);
      }
    }
    score += Math.min((c.usageCount ?? 0) / 100, 0.05);
    return { c, score, why };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  const second = scored[1];

  // 只有“型号完全一致”且与第二名差距明确时，才敢给单一结果。
  const decisive = best.why.includes('型号完全一致') && (second === undefined || best.score - second.score >= 0.2);

  if (decisive) {
    return [makeSuggestion<string>({
      agent: 'A4', code: 'A4.MAP_HIGH', severity: 'info', confidence: 'high',
      target: { objectType: 'bomLine', objectId: 'import-row-' + row.rowNo, field: 'partId', rowRef: preclean(row.refs) },
      title: '建议映射到 ' + best.c.mpn,
      detail: best.why.join('；'),
      proposed: best.c.partId,
      evidence: [
        evidence('row', 'import:row:' + row.rowNo, preclean(row.rawMpn) || preclean(row.rawDescription)),
        evidence('library', ref.part(best.c.partId), best.c.mpn + ' ' + preclean(best.c.description)),
      ],
    })];
  }

  return [makeSuggestion<string>({
    agent: 'A4', code: 'A4.MAP_PICK', severity: 'warn', confidence: 'medium',
    target: { objectType: 'bomLine', objectId: 'import-row-' + row.rowNo, field: 'partId', rowRef: preclean(row.refs) },
    title: '找到 ' + scored.length + ' 个候选，需你选一个',
    detail: '没有任何一个候选达到可以自动预填的把握度。选完之后会回写到映射字典，下次就不再问你。',
    candidates: scored.slice(0, 5).map((s) => ({
      value: s.c.partId,
      label: s.c.mpn + '  ' + preclean(s.c.description),
      score: Number(s.score.toFixed(3)),
      evidence: [evidence('library', ref.part(s.c.partId), s.why.join('；') || '无硬匹配依据')],
    })),
    evidence: [evidence('row', 'import:row:' + row.rowNo, preclean(row.rawDescription) || preclean(row.rawValue))],
  })];
}
