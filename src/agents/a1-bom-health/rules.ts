import { makeSuggestion, evidence, ref } from '../../core/suggestion';
import type { Suggestion } from '../../core/types';
import { preclean, stripNoise } from '../../core/normalize/preclean';
import { parseRefs, findGaps, findCrossRowDuplicates } from '../../core/normalize/parseRefs';
import { parseValue, hintFromDesignator } from '../../core/normalize/parseValue';
import { canonFootprint } from '../../core/normalize/canonFootprint';
import { decodeMPN, valuesAgree } from '../../core/normalize/decodeMPN';
import type { BomLineInput, Rule, RuleEnv } from './types';

/** 位号前缀与物料分类的对应关系。仅用于"提请核对",不用于自动改数据。 */
const PREFIX_EXPECT: Record<string, string[]> = {
  R: ['电阻'], C: ['电容'], L: ['电感'], FB: ['电感', '磁珠'],
  D: ['二极管', 'LED', '发光'], Q: ['三极管', 'MOS', '晶体管'],
  U: ['IC', '芯片', '集成'], Y: ['晶振', '振荡'], X: ['晶振', '振荡'],
  J: ['连接器', '接插'], P: ['连接器', '接插'], SW: ['开关', '按键'],
  F: ['保险', '熔断'],
};

const NON_PURCHASE_TYPES = new Set(['虚拟', '不装', '客供']);
const NON_PURCHASE_PREFIX = /^(TP|MH|LOGO|FID|NP|MK)\d*$/i;

/**
 * 这一行是否参与"采购相关"的阻塞判定。
 *
 * 为什么必须有这个判定:TestPoint、LOGO、M3 螺丝孔这类行永远不可能有型号和价格,
 * 如果它们一直留在"待处理"计数里,计数器永远归不了零,用户就学会了忽略它。
 * 一个永远不归零的计数器,等于没有计数器。
 */
export function isNonPurchase(l: BomLineInput): boolean {
  if (NON_PURCHASE_TYPES.has(preclean(l.purchaseType))) return true;
  const first = parseRefs(l.refs).refs[0];
  return first !== undefined && NON_PURCHASE_PREFIX.test(first);
}

/** 从描述串里取第一个能解析成数值的 token,用于与型号解码交叉比对。 */
function firstValueToken(description: string | null | undefined, hint: ReturnType<typeof hintFromDesignator>) {
  const s = preclean(description);
  for (const token of s.split(/[\s,;()\[\]/]+/)) {
    if (token.length === 0) continue;
    const p = parseValue(token, hint);
    if (p.si !== null) return { token, parsed: p };
  }
  return null;
}

export const RULES: Rule[] = [

  // ─────────── 第一波:七条零歧义规则 ───────────

  {
    code: 'R01', title: '位号数量与用量不一致', phase: 1,
    runLine(l, env) {
      const r = parseRefs(l.refs);
      const qty = Number(l.qty);
      if (r.count === 0 || !Number.isFinite(qty) || qty <= 0) return [];
      if (r.count === qty) return [];
      return [makeSuggestion<number>({
        agent: 'A1', code: 'R01', severity: 'block', confidence: 'high',
        target: { objectType: 'bomLine', objectId: l.id, version: env.bom.version, field: 'qty', rowRef: preclean(l.refs) },
        title: '位号解析出 ' + r.count + ' 个,用量填的是 ' + qty,
        detail: '位号:' + r.refs.join(', ') + (r.expandedFrom.length ? '(其中 ' + r.expandedFrom.join('、') + ' 为区间展开)' : ''),
        current: qty, proposed: r.count,
        assumed: r.expandedFrom.length ? ['按区间展开 ' + r.expandedFrom.join('、')] : [],
        evidence: [
          evidence('field', ref.bomLine(l.id, l.rowNo, '位号'), preclean(l.refs)),
          evidence('field', ref.bomLine(l.id, l.rowNo, '用量'), String(l.qty)),
        ],
      })];
    },
  },

  {
    code: 'R02', title: '本行位号重复', phase: 1,
    runLine(l, env) {
      const r = parseRefs(l.refs);
      if (r.duplicates.length === 0) return [];
      return [makeSuggestion<string>({
        agent: 'A1', code: 'R02', severity: 'block', confidence: 'high',
        target: { objectType: 'bomLine', objectId: l.id, version: env.bom.version, field: 'refs', rowRef: preclean(l.refs) },
        title: '位号重复:' + r.duplicates.join(', '),
        detail: '去重后用量会随之变化,请连同用量一起确认。',
        current: preclean(l.refs), proposed: r.refs.join(','),
        evidence: [evidence('field', ref.bomLine(l.id, l.rowNo, '位号'), preclean(l.refs))],
      })];
    },
  },

  {
    code: 'R04', title: '同一型号出现在多行', phase: 1,
    runBom(env) {
      const byMpn = new Map<string, BomLineInput[]>();
      for (const l of env.bom.lines) {
        const key = preclean(l.mpn).toUpperCase();
        if (key.length === 0) continue;
        const arr = byMpn.get(key);
        if (arr) arr.push(l); else byMpn.set(key, [l]);
      }
      const out: Array<Suggestion<unknown>> = [];
      for (const entry of byMpn) {
        if (entry[1].length < 2) continue;
        out.push(makeSuggestion({
          agent: 'A1', code: 'R04', severity: 'warn', confidence: 'high',
          target: { objectType: 'bom', objectId: env.bom.id, version: env.bom.version },
          title: '型号 ' + entry[0] + ' 出现在 ' + entry[1].length + ' 行',
          detail: '行号:' + entry[1].map((x) => x.rowNo).join(', ') + '。若为有意拆行(不同用途或不同采购属性)可忽略。',
          evidence: entry[1].map((x) => evidence('row', ref.bomLine(x.id, x.rowNo), preclean(x.refs) + ' x ' + String(x.qty ?? ''))),
        }));
      }
      return out;
    },
  },

  {
    code: 'R05', title: '关键字段为空', phase: 1,
    runLine(l, env) {
      const checks: Array<[string, string]> = [['位号', preclean(l.refs)], ['用量', String(l.qty ?? '')], ['规格描述', preclean(l.description)], ['封装', preclean(l.footprint)]];
      const missing = checks.filter((c) => c[1].length === 0).map((c) => c[0]);
      if (missing.length === 0) return [];
      // 虚拟/不装行只要求位号和用量,其余允许为空
      if (isNonPurchase(l) && missing.every((m) => m !== '位号' && m !== '用量')) return [];
      return [makeSuggestion({
        agent: 'A1', code: 'R05', severity: 'block', confidence: 'high',
        target: { objectType: 'bomLine', objectId: l.id, version: env.bom.version, rowRef: preclean(l.refs) },
        title: '缺少必填字段:' + missing.join('、'),
        detail: '这些字段缺失会直接卡住后续的采购与生产环节。',
        evidence: [evidence('row', ref.bomLine(l.id, l.rowNo))],
      })];
    },
  },

  {
    code: 'R06', title: '同一位号被多行占用', phase: 1,
    runBom(env) {
      const dups = findCrossRowDuplicates(env.bom.lines.map((l) => ({ id: l.id, rowNo: l.rowNo, refs: l.refs })));
      return dups.map((d) => makeSuggestion({
        agent: 'A1', code: 'R06', severity: 'block', confidence: 'high',
        target: { objectType: 'bom', objectId: env.bom.id, version: env.bom.version, rowRef: d.ref },
        title: '位号 ' + d.ref + ' 同时出现在第 ' + d.rows.map((r) => r.rowNo).join('、') + ' 行',
        detail: '一个位号只能对应一颗物料。这是硬冲突,必须由人决定保留哪一行。',
        evidence: d.rows.map((r) => evidence('row', ref.bomLine(r.id, r.rowNo))),
      }));
    },
  },

  {
    code: 'R12', title: '未关联零件,无法进入采购', phase: 1,
    runLine(l, env) {
      if (isNonPurchase(l)) return [];
      if (preclean(l.partId).length > 0) return [];
      return [makeSuggestion({
        agent: 'A1', code: 'R12', severity: 'block', confidence: 'high',
        target: { objectType: 'bomLine', objectId: l.id, version: env.bom.version, field: 'partId', rowRef: preclean(l.refs) },
        title: '本行未关联零件',
        detail: '未关联零件的行无法加入购物车、无法生成采购申请。这是整条采购链路的第一个断点。可交给 A5 建档,或手动关联已有零件。',
        evidence: [evidence('row', ref.bomLine(l.id, l.rowNo), preclean(l.description))],
      })];
    },
  },

  {
    code: 'R14', title: '用量不是正整数', phase: 1,
    runLine(l, env) {
      const s = preclean(String(l.qty ?? ''));
      if (s.length === 0) return [];
      const n = Number(s);
      if (Number.isInteger(n) && n > 0) return [];
      const canRound = Number.isFinite(n) && n > 0;
      return [makeSuggestion<number>({
        agent: 'A1', code: 'R14', severity: 'block', confidence: canRound ? 'high' : 'low',
        target: { objectType: 'bomLine', objectId: l.id, version: env.bom.version, field: 'qty', rowRef: preclean(l.refs) },
        title: '用量 "' + s + '" 不是正整数',
        detail: canRound ? '建议取整。' : '无法推断意图,需人工填写。',
        current: Number.isFinite(n) ? n : undefined,
        proposed: canRound ? Math.round(n) : undefined,
        evidence: [evidence('field', ref.bomLine(l.id, l.rowNo, '用量'), s)],
      })];
    },
  },

  // ─────────── 第三波:需要判断力的规则 ───────────

  {
    code: 'R03', title: '位号片段无法识别', phase: 3,
    runLine(l, env) {
      const r = parseRefs(l.refs);
      if (r.malformed.length === 0) return [];
      return [makeSuggestion({
        agent: 'A1', code: 'R03', severity: 'warn', confidence: 'low',
        target: { objectType: 'bomLine', objectId: l.id, version: env.bom.version, field: 'refs', rowRef: preclean(l.refs) },
        title: '位号中有 ' + r.malformed.length + ' 个片段无法识别',
        detail: '无法识别的片段:' + r.malformed.join(' | ') + '。常见原因是分隔符混用、区间写法或中文字符。',
        evidence: [evidence('field', ref.bomLine(l.id, l.rowNo, '位号'), preclean(l.refs))],
      })];
    },
  },

  {
    code: 'R07', title: '位号前缀与物料分类不一致', phase: 3,
    runLine(l, env) {
      const first = parseRefs(l.refs).refs[0];
      const category = preclean(l.category);
      if (first === undefined || category.length === 0) return [];
      const prefix = (first.match(/^([A-Za-z]{1,4})/) ?? [])[1];
      if (prefix === undefined) return [];
      const expect = PREFIX_EXPECT[prefix.toUpperCase()];
      if (!expect) return [];
      if (expect.some((k) => category.includes(k))) return [];
      return [makeSuggestion({
        agent: 'A1', code: 'R07', severity: 'warn', confidence: 'low',
        target: { objectType: 'bomLine', objectId: l.id, version: env.bom.version, rowRef: preclean(l.refs) },
        // 中性表述:只并列两个事实,不下"你错了"的判断。
        title: '位号前缀 ' + prefix + ' 通常对应' + expect.join('/') + ',本行物料分类为「' + category + '」',
        detail: '两者不一致有可能是合法的(例如磁珠用 FB 也用 L,排阻用 RN),也有可能是关联错了物料。请核对。',
        evidence: [
          evidence('field', ref.bomLine(l.id, l.rowNo, '位号'), first),
          evidence('field', ref.bomLine(l.id, l.rowNo, '分类'), category),
        ],
      })];
    },
  },

  {
    code: 'R08', title: '描述参数与型号解码不一致', phase: 3,
    runLine(l, env) {
      const mpn = preclean(l.mpn);
      if (mpn.length === 0) return [];
      const hint = hintFromDesignator(l.refs);
      if (hint !== 'R') return [];
      const decoded = decodeMPN(mpn, 'R');
      if (!decoded.ok || decoded.valueSi === null || decoded.valueSi === undefined) return [];
      const fromDesc = firstValueToken(l.description, hint);
      if (!fromDesc) return [];
      if (valuesAgree(fromDesc.parsed.si, decoded.valueSi)) return [];
      return [makeSuggestion<string>({
        agent: 'A1', code: 'R08', severity: 'block', confidence: 'high',
        target: { objectType: 'bomLine', objectId: l.id, version: env.bom.version, field: 'description', rowRef: preclean(l.refs) },
        title: '描述写的是 ' + fromDesc.parsed.display + ',型号 ' + mpn + ' 解码出来是 ' + String(decoded.valueDisplay),
        detail: '这是两条独立证据链的冲突:一条来自人写的描述,一条来自厂商编码规则。必须由人确认哪一个是对的——改描述还是换型号,结论完全不同。',
        current: fromDesc.token,
        proposed: decoded.valueDisplay,
        evidence: [
          evidence('field', ref.bomLine(l.id, l.rowNo, '规格描述'), fromDesc.token),
          evidence('mpn', 'mpn:' + mpn + '/decoder:' + String(decoded.matchedBy), String(decoded.valueDisplay)),
        ],
      })];
    },
  },

  {
    code: 'R09', title: '封装为空但已关联零件有封装', phase: 3,
    runLine(l, env) {
      if (preclean(l.footprint).length > 0) return [];
      const partId = preclean(l.partId);
      if (partId.length === 0) return [];
      const part = env.parts.get(partId);
      const fp = preclean(part?.footprint);
      if (fp.length === 0) return [];
      return [makeSuggestion<string>({
        agent: 'A1', code: 'R09', severity: 'warn', confidence: 'high',
        target: { objectType: 'bomLine', objectId: l.id, version: env.bom.version, field: 'footprint', rowRef: preclean(l.refs) },
        title: '可从已关联零件回填封装:' + fp,
        detail: '接受后该字段 origin 记为 ai_suggested_accepted,不会被后续「批量同步系统库字段」静默覆盖。',
        current: '', proposed: fp,
        evidence: [evidence('library', ref.part(partId, '封装'), fp)],
      })];
    },
  },

  {
    code: 'R10', title: '同型号在不同行的封装不一致', phase: 3,
    runBom(env) {
      const byMpn = new Map<string, BomLineInput[]>();
      for (const l of env.bom.lines) {
        const key = preclean(l.mpn).toUpperCase();
        if (key.length === 0) continue;
        const arr = byMpn.get(key);
        if (arr) arr.push(l); else byMpn.set(key, [l]);
      }
      const out: Array<Suggestion<unknown>> = [];
      for (const entry of byMpn) {
        const canons = new Set(entry[1].map((l) => canonFootprint(l.footprint).canon).filter((c) => !c.startsWith('UNKNOWN')));
        if (canons.size < 2) continue;
        out.push(makeSuggestion({
          agent: 'A1', code: 'R10', severity: 'warn', confidence: 'medium',
          target: { objectType: 'bom', objectId: env.bom.id, version: env.bom.version },
          title: '型号 ' + entry[0] + ' 在不同行用了 ' + canons.size + ' 种封装',
          detail: '归一化后的封装键:' + Array.from(canons).join(' / ') + '。同一型号一般只有一种焊盘,请确认是否有一行关联错了。',
          candidates: Array.from(canons).map((c) => ({ value: c, score: 0.5, evidence: [evidence('rule', 'canonFootprint:' + c)] })),
          evidence: entry[1].map((l) => evidence('field', ref.bomLine(l.id, l.rowNo, '封装'), preclean(l.footprint))),
        }));
      }
      return out;
    },
  },

  {
    code: 'R11', title: '同一族封装混用散热焊盘版本', phase: 3,
    runBom(env) {
      const byFamily = new Map<string, Array<{ line: BomLineInput; ep: boolean; canon: string }>>();
      for (const l of env.bom.lines) {
        const cf = canonFootprint(l.footprint);
        if (cf.kind !== 'SO' && cf.kind !== 'QFN') continue;
        const family = cf.canon.replace('-1EP', '');
        const arr = byFamily.get(family);
        const item = { line: l, ep: cf.hasExposedPad, canon: cf.canon };
        if (arr) arr.push(item); else byFamily.set(family, [item]);
      }
      const out: Array<Suggestion<unknown>> = [];
      for (const entry of byFamily) {
        const withEp = entry[1].filter((x) => x.ep);
        const withoutEp = entry[1].filter((x) => !x.ep);
        if (withEp.length === 0 || withoutEp.length === 0) continue;
        out.push(makeSuggestion({
          agent: 'A1', code: 'R11', severity: 'info', confidence: 'low',
          target: { objectType: 'bom', objectId: env.bom.id, version: env.bom.version },
          title: entry[0] + ' 同时存在带散热焊盘与不带散热焊盘的版本',
          detail: '这本身通常是合法的,列出来只是为了让你确认 PCB 上对应的焊盘画对了。注意:带 EP 与不带 EP 永远不可互换。',
          evidence: entry[1].map((x) => evidence('field', ref.bomLine(x.line.id, x.line.rowNo, '封装'), x.canon)),
        }));
      }
      return out;
    },
  },

  {
    code: 'R13', title: '参考单价缺失或为零', phase: 3, requires: 'priceTable',
    runLine(l, env) {
      if (isNonPurchase(l)) return [];
      const raw = preclean(String(l.unitPrice ?? ''));
      const n = Number(raw);
      const isZero = raw.length > 0 && Number.isFinite(n) && n === 0;
      if (raw.length > 0 && !isZero) return [];
      return [makeSuggestion({
        agent: 'A1', code: 'R13', severity: 'warn', confidence: 'low',
        target: { objectType: 'bomLine', objectId: l.id, version: env.bom.version, field: 'unitPrice', rowRef: preclean(l.refs) },
        title: isZero ? '参考单价为 0' : '参考单价为空',
        detail: isZero
          ? '0 与"未知"是两件事。0 会让成本汇总看起来是正确的,实际上是错的。建议把 0 清成空值,再由带来源标记的估价填充。'
          : '缺少参考单价。价格应带 priceSource 标记:真实采购价 / 系统库参考价 / 同族插值 / 模型估价,四层视觉必须可区分。',
        evidence: [evidence('field', ref.bomLine(l.id, l.rowNo, '参考单价'), raw.length ? raw : '(空)')],
      })];
    },
  },

  {
    code: 'R15', title: '位号断号', phase: 3,
    runBom(env) {
      // 必须用整张 BOM 的位号并集。逐行算会把"FB6/FB7 在另一行"误报成缺号。
      const gaps = findGaps(env.allRefs);
      return gaps.map((g) => makeSuggestion({
        agent: 'A1', code: 'R15', severity: 'info', confidence: 'low',
        target: { objectType: 'bom', objectId: env.bom.id, version: env.bom.version },
        title: '位号 ' + g.prefix + ' 在 ' + g.range[0] + '-' + g.range[1] + ' 区间内缺 ' + g.missing.length + ' 个',
        detail: '缺失编号:' + g.prefix + g.missing.join(', ' + g.prefix) + '。断号很多时候是设计过程中删器件的正常结果,这里只提示,不建议改。',
        evidence: [evidence('rule', ref.bom(env.bom.id, env.bom.version) + '/refs-union')],
      }));
    },
  },

  {
    code: 'R16', title: '物料生命周期风险', phase: 4, requires: 'lifecycleField',
    runLine(l, env) {
      const partId = preclean(l.partId);
      const lifecycle = preclean(l.lifecycle) || preclean(env.parts.get(partId)?.lifecycle);
      if (lifecycle.length === 0) return [];
      if (!/(停产|EOL|NRND|不推荐|停售)/i.test(lifecycle)) return [];
      return [makeSuggestion({
        agent: 'A1', code: 'R16', severity: 'warn', confidence: 'high',
        target: { objectType: 'bomLine', objectId: l.id, version: env.bom.version, rowRef: preclean(l.refs) },
        title: '该物料生命周期状态为「' + lifecycle + '」',
        detail: '建议在量产前评估替代方案。替代料是否可用请走 A2 的封装与参数核对,本规则不做兼容性结论。',
        evidence: [evidence('field', partId.length ? ref.part(partId, '生命周期') : ref.bomLine(l.id, l.rowNo, '生命周期'), lifecycle)],
      })];
    },
  },

  {
    code: 'R17', title: '物料分类为空', phase: 3,
    runLine(l, env) {
      if (isNonPurchase(l)) return [];
      if (preclean(l.category).length > 0) return [];
      return [makeSuggestion({
        agent: 'A1', code: 'R17', severity: 'warn', confidence: 'low',
        target: { objectType: 'bomLine', objectId: l.id, version: env.bom.version, field: 'category', rowRef: preclean(l.refs) },
        title: '物料分类为空',
        detail: '分类为空会连带影响属性模板、筛选和替代料检索。可由 A5 按位号前缀与描述给出分类候选,由人确认。',
        evidence: [evidence('row', ref.bomLine(l.id, l.rowNo), preclean(l.description))],
      })];
    },
  },

  {
    code: 'R18', title: '描述含不可见字符或污染串', phase: 3,
    runLine(l, env) {
      const raw = String(l.description ?? '');
      const invisible = /[\u200B-\u200F\uFEFF\u00AD]/.test(raw);
      const noise = stripNoise(raw);
      if (!invisible && noise.removed.length === 0) return [];
      const parts: string[] = [];
      if (invisible) parts.push('含零宽/不可见字符');
      if (noise.removed.length > 0) parts.push('含疑似污染串 ' + noise.removed.join('、'));
      return [makeSuggestion<string>({
        agent: 'A1', code: 'R18', severity: 'warn', confidence: 'high',
        target: { objectType: 'bomLine', objectId: l.id, version: env.bom.version, field: 'description', rowRef: preclean(l.refs) },
        title: '规格描述' + parts.join(','),
        detail: '不可见字符会让两个"看起来一样"的型号永远匹配不上,也会让去重和检索静默失效。清洗后的结果已给出。',
        current: raw, proposed: noise.text,
        evidence: [evidence('field', ref.bomLine(l.id, l.rowNo, '规格描述'), JSON.stringify(raw))],
      })];
    },
  },
];

/** 第一期只上这七条。它们全部零歧义,目的是让用户的第一印象是"它说的都对"。 */
export const PHASE1_CODES = RULES.filter((r) => r.phase === 1).map((r) => r.code);
