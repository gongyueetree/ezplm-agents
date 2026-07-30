import { makeSuggestion, evidence, ref } from '../../core/suggestion';
import type { AgentContext, Suggestion } from '../../core/types';
import { preclean } from '../../core/normalize/preclean';
import { parseRefs } from '../../core/normalize/parseRefs';

/**
 * A3 缺料与采购建议。
 *
 * 职责边界很硬：它只算数并起草，**绝不下单、绝不发邮件**。
 * 下单是要花钱的动作，必须由人按钮。
 *
 * 一个容易被忽略的前提：如果 BOM 行没关联零件（A1/R12），它根本无法进入采购流程。
 * 所以 A3 的第一件事不是算缺口，而是把这些行单独括出来——
 * 它们不是“缺料 0”，而是“算不了”。这两个状态在报表上必须分开。
 */

export interface ShortageBomLine {
  id: string;
  rowNo: number;
  refs?: string | null;
  qty?: string | number | null;
  partId?: string | null;
  mpn?: string | null;
  description?: string | null;
  purchaseType?: string | null;
}

export interface InventorySnapshot {
  onHand: number;
  /** 已被其他工单分配。不扣这一块是缺料计算最常见的错。 */
  allocated?: number;
  safetyStock?: number;
}

export interface InTransitLot {
  qty: number;
  /** ISO 日期。比需求日期晩到的在途不能算可用。 */
  eta: string;
  poNo?: string;
}

export interface PurchaseTerms {
  moq?: number;
  /** 包装倍数（整盘/整盒） */
  spq?: number;
  supplier?: string;
  leadTimeDays?: number;
}

export interface ShortageInput {
  bomId: string;
  bomVersion: string;
  lines: ShortageBomLine[];
  /** 计划生产数量 */
  plannedQty: number;
  /** 损耗率，0.02 = 2%。不填则不加损耗，不自作主张。 */
  scrapRate?: number;
  needDate?: string;
  inventory: Map<string, InventorySnapshot>;
  inTransit: Map<string, InTransitLot[]>;
  terms: Map<string, PurchaseTerms>;
}

export interface ShortageRow {
  lineId: string;
  rowNo: number;
  partId: string | null;
  mpn: string;
  perUnit: number;
  required: number;
  onHand: number;
  allocated: number;
  availableNow: number;
  inTransitUsable: number;
  gap: number;
  /** 向上取到 MOQ / 包装倍数之后的建议采购量 */
  suggestQty: number;
  supplier?: string;
  notes: string[];
  status: 'ok' | 'shortage' | 'uncomputable';
}

export interface RequisitionDraftLine {
  partId: string;
  mpn: string;
  qty: number;
  supplier?: string;
  needDate?: string;
  sourceRows: number[];
}

export interface ShortageResult {
  rows: ShortageRow[];
  /** 按供应商分组的采购申请草稿。草稿就是草稿，不提交。 */
  requisitionDraft: Map<string, RequisitionDraftLine[]>;
  totals: { lines: number; shortageLines: number; uncomputableLines: number };
  suggestions: Array<Suggestion<unknown>>;
}

const NON_PURCHASE = new Set(['虚拟', '不装', '客供']);

function roundUpTo(qty: number, moq?: number, spq?: number): { qty: number; notes: string[] } {
  const notes: string[] = [];
  let out = qty;
  if (moq !== undefined && out < moq) {
    notes.push('不足最小起订量 ' + moq + '，已抬到 MOQ');
    out = moq;
  }
  if (spq !== undefined && spq > 1) {
    const rounded = Math.ceil(out / spq) * spq;
    if (rounded !== out) {
      notes.push('按包装倍数 ' + spq + ' 向上取整');
      out = rounded;
    }
  }
  return { qty: out, notes };
}

export function computeShortage(input: ShortageInput, ctx: AgentContext): ShortageResult {
  const scrap = input.scrapRate ?? 0;
  const needDate = input.needDate;
  const rows: ShortageRow[] = [];

  for (const l of input.lines) {
    if (NON_PURCHASE.has(preclean(l.purchaseType))) continue;

    const parsedRefs = parseRefs(l.refs);
    const declared = Number(l.qty);
    // 用量取值优先用位号数（A1/R01 已经把不一致报出来了），
    // 但如果位号为空则退回声明用量，并在 notes 里说清楚。
    const notes: string[] = [];
    let perUnit: number;
    if (parsedRefs.count > 0) {
      perUnit = parsedRefs.count;
      if (Number.isFinite(declared) && declared !== parsedRefs.count) {
        notes.push('声明用量 ' + declared + ' 与位号数 ' + parsedRefs.count + ' 不一致，本次按位号数计算');
      }
    } else if (Number.isFinite(declared) && declared > 0) {
      perUnit = declared;
      notes.push('位号为空，按声明用量计算');
    } else {
      rows.push({
        lineId: l.id, rowNo: l.rowNo, partId: preclean(l.partId) || null, mpn: preclean(l.mpn),
        perUnit: 0, required: 0, onHand: 0, allocated: 0, availableNow: 0, inTransitUsable: 0,
        gap: 0, suggestQty: 0, notes: ['用量与位号都不可用，无法计算'], status: 'uncomputable',
      });
      continue;
    }

    const partId = preclean(l.partId);
    if (partId.length === 0) {
      rows.push({
        lineId: l.id, rowNo: l.rowNo, partId: null, mpn: preclean(l.mpn),
        perUnit, required: Math.ceil(perUnit * input.plannedQty * (1 + scrap)),
        onHand: 0, allocated: 0, availableNow: 0, inTransitUsable: 0, gap: 0, suggestQty: 0,
        notes: ['未关联零件，无库存与价格依据，无法计算缺口（见 A1/R12）'],
        status: 'uncomputable',
      });
      continue;
    }

    const required = Math.ceil(perUnit * input.plannedQty * (1 + scrap));
    const inv = input.inventory.get(partId) ?? { onHand: 0 };
    const allocated = inv.allocated ?? 0;
    const safety = inv.safetyStock ?? 0;
    const availableNow = Math.max(inv.onHand - allocated - safety, 0);
    if (safety > 0) notes.push('已扣除安全库存 ' + safety);

    const lots = input.inTransit.get(partId) ?? [];
    let inTransitUsable = 0;
    for (const lot of lots) {
      if (needDate === undefined || lot.eta <= needDate) inTransitUsable += lot.qty;
      else notes.push('在途 ' + lot.qty + ' 预计 ' + lot.eta + ' 到，晚于需求日期，本次不计入可用');
    }

    const gap = Math.max(required - availableNow - inTransitUsable, 0);
    const t = input.terms.get(partId) ?? {};
    const rounded = gap > 0 ? roundUpTo(gap, t.moq, t.spq) : { qty: 0, notes: [] };

    rows.push({
      lineId: l.id, rowNo: l.rowNo, partId, mpn: preclean(l.mpn), perUnit, required,
      onHand: inv.onHand, allocated, availableNow, inTransitUsable, gap,
      suggestQty: rounded.qty, supplier: t.supplier,
      notes: notes.concat(rounded.notes),
      status: gap > 0 ? 'shortage' : 'ok',
    });
  }

  // 同一零件在多行出现时必须合并采购，否则会重复下单。
  const draft = new Map<string, RequisitionDraftLine[]>();
  const byPart = new Map<string, ShortageRow[]>();
  for (const r of rows) {
    if (r.status !== 'shortage' || r.partId === null) continue;
    const arr = byPart.get(r.partId);
    if (arr) arr.push(r); else byPart.set(r.partId, [r]);
  }
  for (const entry of byPart) {
    const list = entry[1];
    const first = list[0]!;
    const totalGap = list.reduce((s, r) => s + r.gap, 0);
    const t = input.terms.get(entry[0]) ?? {};
    const rounded = roundUpTo(totalGap, t.moq, t.spq);
    const supplier = first.supplier ?? '未指定供应商';
    const line: RequisitionDraftLine = {
      partId: entry[0], mpn: first.mpn, qty: rounded.qty, supplier: first.supplier,
      needDate: input.needDate, sourceRows: list.map((r) => r.rowNo),
    };
    const bucket = draft.get(supplier);
    if (bucket) bucket.push(line); else draft.set(supplier, [line]);
  }

  const shortageLines = rows.filter((r) => r.status === 'shortage').length;
  const uncomputableLines = rows.filter((r) => r.status === 'uncomputable').length;

  const suggestions: Array<Suggestion<unknown>> = [];

  if (uncomputableLines > 0) {
    const bad = rows.filter((r) => r.status === 'uncomputable');
    suggestions.push(makeSuggestion({
      agent: 'A3', code: 'A3.UNCOMPUTABLE', severity: 'block', confidence: 'high',
      target: { objectType: 'bom', objectId: input.bomId, version: input.bomVersion },
      title: '有 ' + uncomputableLines + ' 行无法计算缺口',
      detail: '这些行不是“不缺料”，而是“算不了”，两者在报表上必须分开。行号：'
        + bad.map((r) => r.rowNo).join(', '),
      evidence: bad.map((r) => evidence('row', ref.bomLine(r.lineId, r.rowNo), r.notes.join('；'))),
    }));
  }

  if (shortageLines > 0) {
    suggestions.push(makeSuggestion({
      agent: 'A3', code: 'A3.REQUISITION_DRAFT', severity: 'warn', confidence: 'medium',
      target: { objectType: 'requisition', objectId: input.bomId },
      title: '已按供应商归并出 ' + draft.size + ' 份采购申请草稿，共 ' + shortageLines + ' 行缺料',
      detail: '草稿不会自动提交。数量已考虑最小起订量与包装倍数，请逐行确认后再提交。',
      candidates: Array.from(draft).map((e) => ({
        value: e[0] + '（' + e[1].length + ' 行）',
        score: 0.5,
        evidence: e[1].map((d) => evidence('row', 'part:' + d.partId, d.mpn + ' x ' + d.qty)),
      })),
      evidence: rows.filter((r) => r.status === 'shortage').map((r) =>
        evidence('inventory', 'part:' + String(r.partId),
          '需求 ' + r.required + ' / 可用 ' + r.availableNow + ' / 在途可用 ' + r.inTransitUsable + ' / 缺口 ' + r.gap)),
    }));
  }

  return {
    rows,
    requisitionDraft: draft,
    totals: { lines: rows.length, shortageLines, uncomputableLines },
    suggestions,
  };
}
