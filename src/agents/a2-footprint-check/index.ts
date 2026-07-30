import { makeSuggestion, evidence, ref } from '../../core/suggestion';
import type { AgentContext, Suggestion } from '../../core/types';
import { preclean } from '../../core/normalize/preclean';
import { canonFootprint, sameGeometry } from '../../core/normalize/canonFootprint';
import type { CanonFootprint, GeometryVerdict } from '../../core/normalize/canonFootprint';
import { parseValue } from '../../core/normalize/parseValue';
import type { ValueHint } from '../../core/normalize/parseValue';

/**
 * A2 封装与焊盘核对。
 *
 * **本 Agent 永远不输出“这两颗可以互换”。**
 *
 * 它只输出三件事：
 *   1. 焊盘几何是否同一个（same / different / unknown）
 *   2. 可机器比对的参数是否被覆盖
 *   3. **未核对项清单** —— 这一项比前两项都重要
 *
 * 为什么：说“可互换”是一个工程责任，需要引脚定义、温度等级、认证、EMC、
 * 以及设计意图。这些东西一半不在 PLM 里。一旦 Agent 说过一次“可互换”而出了事，
 * 之后没人会再用它——而且这次“出事”可能是一整批板子。
 */

export interface PartForCompare {
  id: string;
  mpn: string;
  manufacturer?: string | null;
  footprint?: string | null;
  category?: string | null;
  description?: string | null;
  lifecycle?: string | null;
  /** 属性名 -> 值。属性名应已经过 A5 的受控词表归一。 */
  attrs?: Record<string, string>;
}

export type ParamVerdict = 'covered' | 'narrower' | 'conflict' | 'unknown';

export interface ParamCheck {
  name: string;
  base?: string;
  candidate?: string;
  verdict: ParamVerdict;
  note?: string;
}

export interface CompareResult {
  geometry: GeometryVerdict;
  baseFootprint: CanonFootprint;
  candidateFootprint: CanonFootprint;
  params: ParamCheck[];
  /** 未核对项清单。这个列表永远不为空。 */
  unverified: string[];
  suggestions: Array<Suggestion<unknown>>;
}

/** 每个品类必须比对的参数。缺失一项就进 unverified，不当作“通过”。 */
const MANDATORY: Array<{ match: RegExp; params: Array<{ name: string; hint: ValueHint; biggerIsSafer?: boolean }> }> = [
  { match: /电阻/, params: [
    { name: '阻值', hint: 'R' },
    { name: '精度', hint: 'unknown' },
    { name: '额定功率', hint: 'W', biggerIsSafer: true },
    { name: '额定电压', hint: 'V', biggerIsSafer: true },
    { name: '温度系数', hint: 'unknown' },
  ] },
  { match: /电容/, params: [
    { name: '容值', hint: 'C' },
    { name: '额定电压', hint: 'V', biggerIsSafer: true },
    { name: '介质', hint: 'unknown' },
    { name: '精度', hint: 'unknown' },
  ] },
  { match: /电感|磁珠/, params: [
    { name: '感值', hint: 'L' },
    { name: '额定电流', hint: 'A', biggerIsSafer: true },
    { name: '直流电阻', hint: 'R' },
    { name: '饱和电流', hint: 'A', biggerIsSafer: true },
  ] },
  { match: /二极管|TVS|稳压/, params: [
    { name: '反向耐压', hint: 'V', biggerIsSafer: true },
    { name: '正向电流', hint: 'A', biggerIsSafer: true },
    { name: '正向压降', hint: 'V' },
  ] },
];

/**
 * 永远无法用 PLM 数据自动核对的项。
 * 这个列表是硬编码的，并且每次都全部列出。
 */
const ALWAYS_UNVERIFIED = [
  '引脚定义一致性（需对照两份数据手册的 pinout）',
  '温度等级与降额曲线',
  '认证与合规（AEC-Q / 车规 / 医疗）',
  'EMC 与寄生参数（ESR / ESL / 寄生电容）',
  '供货周期与最小起订量',
  '设计意图（该位置是否有特殊选型约束）',
];

function attr(p: PartForCompare, name: string): string | undefined {
  const a = p.attrs;
  if (!a) return undefined;
  for (const key of Object.keys(a)) {
    if (preclean(key).includes(name)) return a[key];
  }
  return undefined;
}

function checkParam(
  name: string, hint: ValueHint, biggerIsSafer: boolean,
  base: PartForCompare, cand: PartForCompare,
): ParamCheck {
  const bs = attr(base, name);
  const cs = attr(cand, name);
  if (bs === undefined || cs === undefined) {
    return { name, base: bs, candidate: cs, verdict: 'unknown', note: '至少一边缺该属性，无法比对' };
  }
  const pb = parseValue(bs, hint);
  const pc = parseValue(cs, hint);
  if (pb.si === null || pc.si === null) {
    const same = preclean(bs).toUpperCase() === preclean(cs).toUpperCase();
    return { name, base: bs, candidate: cs, verdict: same ? 'covered' : 'unknown', note: same ? '文本完全一致' : '无法解析为数值，需人工比对' };
  }
  if (pb.si === pc.si) return { name, base: bs, candidate: cs, verdict: 'covered' };
  if (biggerIsSafer) {
    return pc.si > pb.si
      ? { name, base: bs, candidate: cs, verdict: 'covered', note: '候选料指标更高' }
      : { name, base: bs, candidate: cs, verdict: 'narrower', note: '候选料指标更低，不能直接代用' };
  }
  return { name, base: bs, candidate: cs, verdict: 'conflict', note: '关键参数不等' };
}

export function compareForReplacement(
  base: PartForCompare, candidate: PartForCompare, ctx: AgentContext,
): CompareResult {
  const fpA = canonFootprint(base.footprint);
  const fpB = canonFootprint(candidate.footprint);
  const geometry = sameGeometry(fpA, fpB);

  const category = preclean(base.category) + ' ' + preclean(base.description);
  const spec = MANDATORY.find((m) => m.match.test(category));
  const params: ParamCheck[] = spec
    ? spec.params.map((p) => checkParam(p.name, p.hint, p.biggerIsSafer === true, base, candidate))
    : [];

  const unverified: string[] = [...ALWAYS_UNVERIFIED];
  if (!spec) unverified.unshift('本品类尚未定义必比参数集，所有电参数均需人工核对');
  for (const p of params) {
    if (p.verdict === 'unknown') unverified.push(p.name + '（' + String(p.note) + '）');
  }
  if (geometry === 'unknown') unverified.push('焊盘几何（至少一边为厂商专属封装或封装信息不足）');

  const conflicts = params.filter((p) => p.verdict === 'conflict' || p.verdict === 'narrower');

  const suggestions: Array<Suggestion<unknown>> = [];

  suggestions.push(makeSuggestion({
    agent: 'A2', code: 'A2.GEOMETRY', severity: geometry === 'different' ? 'block' : 'info',
    confidence: geometry === 'unknown' ? 'low' : 'high',
    target: { objectType: 'part', objectId: base.id, field: '封装' },
    title: geometry === 'same'
      ? '焊盘几何一致：' + fpA.canon
      : geometry === 'different'
        ? '焊盘几何不一致：' + fpA.canon + ' vs ' + fpB.canon
        : '焊盘几何无法判定',
    detail: '焊盘一致仅意味着能焊上去，不意味着能用。本结论不构成可互换的依据。'
      + (fpA.hasExposedPad !== fpB.hasExposedPad ? ' 注意：两边的散热焊盘情况不同。' : ''),
    evidence: [
      evidence('field', ref.part(base.id, '封装'), preclean(base.footprint)),
      evidence('field', ref.part(candidate.id, '封装'), preclean(candidate.footprint)),
    ],
    assumed: fpA.notes.concat(fpB.notes),
  }));

  if (conflicts.length > 0) {
    suggestions.push(makeSuggestion({
      agent: 'A2', code: 'A2.PARAM_CONFLICT', severity: 'block', confidence: 'high',
      target: { objectType: 'part', objectId: candidate.id },
      title: '有 ' + conflicts.length + ' 项关键参数不被覆盖',
      detail: conflicts.map((c) => c.name + '：' + String(c.base) + ' -> ' + String(c.candidate) + '（' + String(c.note) + '）').join('；'),
      evidence: conflicts.map((c) => evidence('field', ref.part(candidate.id, c.name), String(c.candidate))),
    }));
  }

  suggestions.push(makeSuggestion({
    agent: 'A2', code: 'A2.UNVERIFIED', severity: 'warn', confidence: 'low',
    target: { objectType: 'part', objectId: candidate.id },
    title: '以下 ' + unverified.length + ' 项本次未核对，需工程师自行确认',
    detail: unverified.map((u, i) => String(i + 1) + '. ' + u).join('\n'),
    evidence: [evidence('rule', 'A2/unverified-checklist')],
  }));

  return { geometry, baseFootprint: fpA, candidateFootprint: fpB, params, unverified, suggestions };
}

/**
 * 批量模式：给一颗基准料和一组候选，输出排序后的对比表。
 * 注意：排序不等于推荐。排序只是把“更值得看的”放到前面，
 * 每一项仍然带着它的未核对清单。
 */
export function compareMany(
  base: PartForCompare, candidates: PartForCompare[], ctx: AgentContext,
): Array<{ candidate: PartForCompare; result: CompareResult; rank: number }> {
  const rows = candidates.map((c) => {
    const result = compareForReplacement(base, c, ctx);
    const geomScore = result.geometry === 'same' ? 1 : result.geometry === 'unknown' ? 0.4 : 0;
    const covered = result.params.filter((p) => p.verdict === 'covered').length;
    const total = Math.max(result.params.length, 1);
    const conflictPenalty = result.params.some((p) => p.verdict === 'conflict') ? 0 : 1;
    return { candidate: c, result, rank: geomScore * 0.5 + (covered / total) * 0.3 + conflictPenalty * 0.2 };
  });
  return rows.sort((a, b) => b.rank - a.rank);
}
