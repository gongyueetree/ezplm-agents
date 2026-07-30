import { makeSuggestion, evidence, ref, crossValidate } from '../../core/suggestion';
import type { AgentContext, PriceSource, Suggestion } from '../../core/types';
import { PRICE_SOURCE_RANK } from '../../core/types';
import { preclean, dedupeBilingual, stripNoise, foldKey } from '../../core/normalize/preclean';
import { parseValue, hintFromDesignator } from '../../core/normalize/parseValue';
import type { ValueHint } from '../../core/normalize/parseValue';
import { canonFootprint } from '../../core/normalize/canonFootprint';
import { decodeMPN, valuesAgree } from '../../core/normalize/decodeMPN';
import { templateFor, templateByDesignator, canonAttrName, TEMPLATES } from './templates';
import type { AttrSpec, CategoryTemplate } from './templates';

export * from './templates';

/**
 * A5 物料建档与选型。
 *
 * 三个入口(全部寄生在现有控件上,不新增菜单):
 *   1. 新建物料对话框  —— 打开即预填,人改完再保存
 *   2. 搜索系统库      —— 把参数化查询做进去,而不是只能按型号精确搜
 *   3. 全局搜索        —— 支持"0603 100nF 50V X7R"这类参数式提问
 *
 * 一条重要的自我限制:对于已经关联系统库的零件,**不要重复造轮子**。
 * 系统已有「批量同步系统库字段」,并且明确处理属性参数(已存在则覆盖,不存在则添加)。
 * A5 该做的是补上系统库覆盖不到的那部分,以及处理同步会带来的冲突。
 */

// ─────────────────────────── 属性抽取 ───────────────────────────

export interface ExtractedAttr {
  name: string;
  value: string;
  /** 抽取依据的原始片段 */
  from: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ExtractResult {
  template: CategoryTemplate | null;
  attrs: ExtractedAttr[];
  /** 模板要求但没抽出来的必填项 */
  missingRequired: string[];
  /** 描述里剩下的、没能归入任何属性的片段。人工看一眼往往能发现新属性。 */
  residual: string[];
  cleanedDescription: string;
  notes: string[];
}

function tryValue(token: string, kind: ValueHint) {
  const p = parseValue(token, kind);
  return p.si !== null ? p : null;
}

/** 从一段描述里抽属性。抽不出来就不抽,绝不用"最像的那个"凑数。 */
export function extractAttrs(description: string | null | undefined, hintCategory?: string | null, designator?: string | null): ExtractResult {
  const notes: string[] = [];
  const noise = stripNoise(String(description ?? ''));
  if (noise.removed.length > 0) notes.push('已剥离疑似污染串:' + noise.removed.join('、'));
  const bi = dedupeBilingual(noise.text);
  if (bi.dropped !== undefined) notes.push('描述中英重复,已取较长的一段;另一段:' + bi.dropped);
  const cleaned = bi.text;

  const prefix = preclean(designator).match(/^([A-Za-z]{1,4})/);
  const template = templateFor(hintCategory, cleaned)
    ?? (prefix ? templateByDesignator(prefix[1]!) : null);

  if (template === null) {
    return {
      template: null, attrs: [], missingRequired: [],
      residual: cleaned.split(/[\s,;]+/).filter((x) => x.length > 0),
      cleanedDescription: cleaned,
      notes: notes.concat(['未匹配到品类模板,不做属性抽取。宁可不填,不可乱填。']),
    };
  }

  const tokens = cleaned.split(/[\s,;()\[\]]+/).filter((t) => t.length > 0);
  const used = new Set<number>();
  const attrs: ExtractedAttr[] = [];

  for (const spec of template.attrs) {
    const got = matchAttr(spec, tokens, used, cleaned);
    if (got !== null) attrs.push(got);
  }

  const residual = tokens.filter((_, i) => !used.has(i));
  const missingRequired = template.attrs
    .filter((a) => a.required && !attrs.some((x) => x.name === a.name))
    .map((a) => a.name);

  return { template, attrs, missingRequired, residual, cleanedDescription: cleaned, notes };
}

function matchAttr(spec: AttrSpec, tokens: string[], used: Set<number>, whole: string): ExtractedAttr | null {
  // 枚举型:整串里找枚举值,命中即高置信(枚举值本身就是强信号)
  if (spec.kind === 'enum' && spec.enumValues) {
    for (const v of spec.enumValues) {
      if (whole.toUpperCase().includes(v.toUpperCase())) {
        const idx = tokens.findIndex((t) => t.toUpperCase().includes(v.toUpperCase()));
        if (idx >= 0) used.add(idx);
        return { name: spec.name, value: v, from: v, confidence: 'high' };
      }
    }
    return null;
  }
  if (spec.kind === 'text') return null; // 文本属性不猜,交给人或系统库

  // 数值型:找第一个能解析成对应量纲、且带显式单位的 token
  for (let i = 0; i < tokens.length; i += 1) {
    if (used.has(i)) continue;
    const t = tokens[i]!;
    const p = tryValue(t, spec.kind as ValueHint);
    if (p === null) continue;
    // 只有带显式单位才敢给 high。裸数字靠 hint 猜出来的一律 medium。
    const explicit = p.assumed.length === 0;
    used.add(i);
    return { name: spec.name, value: p.display, from: t, confidence: explicit ? 'high' : 'medium' };
  }
  return null;
}

// ─────────────────────────── 建档 ───────────────────────────

export interface CreateDraftInput {
  mpn?: string | null;
  manufacturer?: string | null;
  description?: string | null;
  footprint?: string | null;
  category?: string | null;
  designator?: string | null;
  /** 若已从系统库命中,把系统库的字段传进来做交叉验证 */
  fromLibrary?: { partId?: string; mpn?: string; description?: string; footprint?: string; attrs?: Record<string, string> } | null;
}

export function buildCreateSuggestions(input: CreateDraftInput, ctx: AgentContext): Array<Suggestion<unknown>> {
  const out: Array<Suggestion<unknown>> = [];
  const ex = extractAttrs(input.description, input.category, input.designator);
  const objectId = 'draft:' + (preclean(input.mpn) || 'new');

  // 1) 封装归一化
  const fp = canonFootprint(input.footprint ?? input.fromLibrary?.footprint);
  if (!fp.canon.startsWith('UNKNOWN')) {
    out.push(makeSuggestion<string>({
      agent: 'A5', code: 'A5.CREATE.FOOTPRINT', severity: 'info', confidence: 'high',
      target: { objectType: 'part', objectId, field: '封装' },
      title: '封装归一化为 ' + fp.canon,
      detail: '归一化只用于比较与检索,不改变你填写的原始封装名。' + (fp.hasExposedPad ? ' 该封装含散热焊盘。' : ''),
      current: preclean(input.footprint), proposed: fp.canon,
      assumed: fp.notes,
      evidence: [evidence('field', objectId + '/field:封装', preclean(input.footprint))],
    }));
  }

  // 2) 属性预填
  for (const a of ex.attrs) {
    out.push(makeSuggestion<string>({
      agent: 'A5', code: 'A5.CREATE.ATTR', severity: 'info', confidence: a.confidence === 'low' ? 'low' : a.confidence,
      target: { objectType: 'part', objectId, field: a.name },
      title: a.name + ' = ' + a.value,
      detail: '来自规格描述中的片段「' + a.from + '」。' + (a.confidence === 'medium' ? ' 该片段没有显式单位,量纲是按品类推断的,请确认。' : ''),
      proposed: a.confidence === 'low' ? undefined : a.value,
      evidence: [evidence('field', objectId + '/field:规格描述', a.from)],
    }));
  }

  // 3) 型号解码交叉验证:两条独立证据链一致才升 high
  const mpn = preclean(input.mpn);
  if (mpn.length > 0) {
    const decoded = decodeMPN(mpn, 'R');
    const valueAttr = ex.attrs.find((a) => a.name === '阻值');
    if (decoded.ok && decoded.valueSi !== null && decoded.valueSi !== undefined) {
      const descSi = valueAttr ? parseValue(valueAttr.value, 'R').si : null;
      const agree = valuesAgree(descSi, decoded.valueSi);
      const conf = crossValidate([
        { value: String(decoded.valueSi), source: 'mpn' },
        { value: String(descSi ?? decoded.valueSi), source: 'field' },
      ]);
      out.push(makeSuggestion<string>({
        agent: 'A5', code: agree ? 'A5.CREATE.MPN_CONFIRM' : 'A5.CREATE.MPN_CONFLICT',
        severity: agree ? 'info' : 'block',
        confidence: agree ? conf : 'medium',
        target: { objectType: 'part', objectId, field: '阻值' },
        title: agree
          ? '型号解码与描述一致:' + String(decoded.valueDisplay)
          : '型号解码为 ' + String(decoded.valueDisplay) + ',描述里写的是 ' + String(valueAttr?.value ?? '(未写)'),
        detail: agree
          ? '两条独立证据链一致(厂商编码规则 + 人写的描述),可以放心预填。'
          : '两边不一致,必须由人决定采信哪一边。改描述还是换型号,结论完全不同。',
        proposed: agree ? decoded.valueDisplay : undefined,
        candidates: agree ? undefined : [
          { value: String(decoded.valueDisplay), score: 0.5, evidence: [evidence('mpn', 'mpn:' + mpn, String(decoded.matchedBy))] },
          { value: String(valueAttr?.value ?? ''), score: 0.5, evidence: [evidence('field', objectId + '/field:规格描述', String(valueAttr?.from ?? ''))] },
        ],
        evidence: [evidence('mpn', 'mpn:' + mpn, String(decoded.valueDisplay))],
      }));
    }
  }

  // 4) 必填项缺口 —— 只提示,不编造
  if (ex.missingRequired.length > 0) {
    out.push(makeSuggestion({
      agent: 'A5', code: 'A5.CREATE.MISSING', severity: 'warn', confidence: 'low',
      target: { objectType: 'part', objectId },
      title: '还差 ' + ex.missingRequired.length + ' 个必填属性:' + ex.missingRequired.join('、'),
      detail: '这些值没能从描述里可靠抽出。可以去系统库同步,或手工补。不会替你猜。',
      evidence: [evidence('rule', 'template:' + String(ex.template?.key))],
    }));
  }

  // 5) 残余片段 —— 这是发现新属性的唯一途径
  if (ex.residual.length > 0) {
    out.push(makeSuggestion({
      agent: 'A5', code: 'A5.CREATE.RESIDUAL', severity: 'info', confidence: 'low',
      target: { objectType: 'part', objectId, field: '规格描述' },
      title: '描述里有 ' + ex.residual.length + ' 个片段未归入任何属性',
      detail: '未归入的片段:' + ex.residual.join(' | ') + '。如果其中某个反复出现,说明模板缺了一个属性,应该加进受控词表而不是让它一直漂着。',
      evidence: [evidence('field', objectId + '/field:规格描述', ex.residual.join(' '))],
      assumed: ex.notes,
    }));
  }

  // 6) 同步冲突预警 —— 这是最容易被忽略、后果最难查的一条
  if (input.fromLibrary && ctx.flags.fieldOrigin === false) {
    out.push(makeSuggestion({
      agent: 'A5', code: 'A5.SYNC_RISK', severity: 'block', confidence: 'high',
      target: { objectType: 'part', objectId },
      title: '当前缺少字段级 origin 标记,本次写入可能被后续「批量同步系统库字段」静默覆盖',
      detail: '系统同步提示为"同步后本地数据将被覆盖",并提供"仅同步未修改的字段"。'
        + '若 A5 接受的写入没有被标记为"已修改",一次全量同步就会抹掉它,而且没有任何提示。'
        + '在 origin 字段上线前,建议只用 A5 填系统库不覆盖的属性。',
      evidence: [evidence('rule', 'flags:fieldOrigin=false')],
    }));
  }

  return out;
}

// ─────────────────────────── 选型排序 ───────────────────────────

export interface SelectCandidate {
  partId: string;
  mpn: string;
  manufacturer?: string | null;
  description?: string | null;
  footprint?: string | null;
  category?: string | null;
  lifecycle?: string | null;
  onHand?: number;
  inTransit?: number;
  usageCount?: number;
  price?: { value: number; source: PriceSource } | null;
  supplierCount?: number;
}

export interface SelectQuery {
  /** 参数式查询,如 "0603 100nF 50V X7R" */
  text: string;
  designator?: string | null;
  category?: string | null;
}

export interface ScoredCandidate {
  candidate: SelectCandidate;
  score: number;
  reasons: string[];
  /** 硬门槛未通过的原因。非空则不进候选。 */
  blockers: string[];
}

/**
 * 打分函数。权重的取法是刻意的:
 *   参数匹配与封装匹配占大头(选错了就是选错了),
 *   历史用量与库存占小头(它们只是"更省事",不是"更对"),
 *   价格占最小头,并且**只在同一 priceSource 层内比较**——
 *   拿模型估价去和真实采购价比大小是没有意义的。
 */
export function scoreCandidates(query: SelectQuery, candidates: SelectCandidate[], ctx: AgentContext): ScoredCandidate[] {
  const hint = hintFromDesignator(query.designator);
  const wantFp = canonFootprint(firstFootprintToken(query.text));
  const wantTokens = query.text.split(/[\s,;]+/).filter((t) => t.length > 0);

  const rows = candidates.map((c) => {
    const reasons: string[] = [];
    const blockers: string[] = [];
    let score = 0;

    const cFp = canonFootprint(c.footprint);
    if (!wantFp.canon.startsWith('UNKNOWN')) {
      if (wantFp.canon === cFp.canon) { score += 0.35; reasons.push('封装一致 ' + cFp.canon); }
      else if (cFp.canon.startsWith('UNKNOWN')) { reasons.push('候选封装信息不足'); }
      else { blockers.push('封装不一致:要求 ' + wantFp.canon + ',候选为 ' + cFp.canon); }
    }

    let hits = 0;
    let checked = 0;
    for (const t of wantTokens) {
      const p = parseValue(t, hint);
      if (p.si === null) continue;
      checked += 1;
      const desc = preclean(c.description);
      for (const dt of desc.split(/[\s,;()\[\]]+/)) {
        const dp = parseValue(dt, hint);
        if (dp.si !== null && valuesAgree(dp.si, p.si)) { hits += 1; break; }
      }
    }
    if (checked > 0) {
      score += 0.35 * (hits / checked);
      reasons.push('参数命中 ' + hits + '/' + checked);
      if (hits === 0) blockers.push('没有任何一个数值参数对得上');
    }

    if (/(停产|EOL|停售)/i.test(preclean(c.lifecycle))) blockers.push('生命周期为 ' + preclean(c.lifecycle));
    else if (/NRND|不推荐/i.test(preclean(c.lifecycle))) { score -= 0.1; reasons.push('厂商标记为不推荐新设计'); }

    const stock = (c.onHand ?? 0) + (c.inTransit ?? 0);
    if (stock > 0) { score += 0.1; reasons.push('有现货或在途 ' + stock); }
    if ((c.usageCount ?? 0) > 0) { score += Math.min((c.usageCount ?? 0) / 200, 0.1); reasons.push('历史用过 ' + c.usageCount + ' 次'); }
    if ((c.supplierCount ?? 0) >= 2) { score += 0.05; reasons.push('至少两家可供'); }

    if (c.price && c.price.value > 0) {
      // 只在真实价格层(L1/L2)给分。L3/L4 是推算值,不参与排序。
      if (PRICE_SOURCE_RANK[c.price.source] <= 2) { score += 0.05; reasons.push('有可信价格(' + c.price.source + ')'); }
      else reasons.push('价格为推算值(' + c.price.source + '),不计入排序');
    }

    return { candidate: c, score: Number(score.toFixed(4)), reasons, blockers };
  });

  return rows
    .sort((a, b) => (a.blockers.length - b.blockers.length) || (b.score - a.score));
}

function firstFootprintToken(text: string): string {
  const m = preclean(text).match(/\b(0201|0402|0603|0805|1206|1210|2010|2512|SOT-?\d{2,3}|SOD-?\d{2,3}|SOIC-?\d+|QFN-?\d+|SOP-?\d+|TSSOP-?\d+|MSOP-?\d+|SMA|SMB|SMC)\b/i);
  return m ? m[1]! : '';
}

export function buildSelectSuggestion(query: SelectQuery, scored: ScoredCandidate[], ctx: AgentContext): Suggestion<string> {
  const usable = scored.filter((s) => s.blockers.length === 0);
  if (usable.length === 0) {
    return makeSuggestion<string>({
      agent: 'A5', code: 'A5.SELECT.NONE', severity: 'warn', confidence: 'low',
      target: { objectType: 'part', objectId: 'query:' + foldKey(query.text) },
      title: '没有候选通过硬门槛',
      detail: scored.length === 0
        ? '库里没有可比的候选。'
        : '被排除的原因:' + scored.slice(0, 5).map((s) => s.candidate.mpn + '(' + s.blockers.join('/') + ')').join(';'),
      evidence: [evidence('rule', 'query:' + query.text)],
    });
  }
  return makeSuggestion<string>({
    agent: 'A5', code: 'A5.SELECT.PICK', severity: 'info', confidence: 'medium',
    target: { objectType: 'part', objectId: 'query:' + foldKey(query.text) },
    title: '找到 ' + usable.length + ' 个可用候选,按匹配度排序',
    detail: '排序不等于推荐。每一项都列出了它为什么排在这里,请自行判断。',
    candidates: usable.slice(0, 8).map((s) => ({
      value: s.candidate.partId,
      label: s.candidate.mpn + '  ' + preclean(s.candidate.description),
      score: s.score,
      evidence: [evidence('library', ref.part(s.candidate.partId), s.reasons.join(';') || '无明确匹配依据')],
    })),
    evidence: [evidence('rule', 'query:' + query.text)],
  });
}

// ─────────────────────────── 价格四层 ───────────────────────────

export interface PriceOffer {
  value: number;
  source: PriceSource;
  supplier?: string;
  qtyBreak?: number;
  quotedAt?: string;
}

export interface PriceDecision {
  chosen: PriceOffer | null;
  /** 必须原样展示给用户,不能只显示一个数字 */
  sourceLabel: string;
  alternatives: PriceOffer[];
  warnings: string[];
}

const SOURCE_LABEL: Record<PriceSource, string> = {
  po_actual: 'L1 真实采购单价',
  system_library: 'L2 系统库参考现货价',
  interpolated: 'L3 同族插值(推算)',
  model_estimate: 'L4 模型估价(推算)',
};

/**
 * 选价格。规则很简单但必须守住:
 *   1. ¥0 一律当作"未知",不当作 0 元。写 0 会让成本汇总看起来是对的,实际是错的。
 *   2. 层级低的永远不覆盖层级高的。模型估价不许盖掉真实采购价。
 *   3. 推算值必须带视觉区分。现有「AI 智能估价」已经用标红表示"暂无估价信息",
 *      这个思路是对的,要延续:推算值和真实值在界面上必须一眼能分开。
 */
export function decidePrice(offers: PriceOffer[]): PriceDecision {
  const warnings: string[] = [];
  const clean = offers.filter((o) => {
    if (!Number.isFinite(o.value) || o.value <= 0) {
      warnings.push('已忽略一条非正价格(' + SOURCE_LABEL[o.source] + '),0 与未知不是一回事');
      return false;
    }
    return true;
  });
  if (clean.length === 0) {
    return { chosen: null, sourceLabel: '无可用价格', alternatives: [], warnings };
  }
  const sorted = clean.slice().sort((a, b) => {
    const r = PRICE_SOURCE_RANK[a.source] - PRICE_SOURCE_RANK[b.source];
    if (r !== 0) return r;
    return (b.quotedAt ?? '').localeCompare(a.quotedAt ?? '');
  });
  const chosen = sorted[0]!;
  if (PRICE_SOURCE_RANK[chosen.source] >= 3) {
    warnings.push('当前采用的是推算价格,不可用于对外报价');
  }
  return { chosen, sourceLabel: SOURCE_LABEL[chosen.source], alternatives: sorted.slice(1), warnings };
}

/** 供 A1/R13 复用:列出所有品类模板的键,便于前端做筛选器。 */
export const TEMPLATE_KEYS = TEMPLATES.map((t) => t.key);

/** 属性名治理:批量检查存量属性库,输出需要人工裁决的清单。 */
export function auditAttributeNames(existing: string[]): Array<{ raw: string; canon: string | null; problems: string[] }> {
  return existing.map((raw) => {
    const c = canonAttrName(raw);
    const problems: string[] = [];
    if (c === null) problems.push('未命中受控词表,需人工决定是新增受控属性还是合并到已有属性');
    return { raw, canon: c ? c.name : null, problems };
  });
}
