import type { AgentContext, FeatureFlags, Suggestion } from '../../core/types';

/**
 * A1 的输入模型。
 *
 * 字段名有意用中立命名，由 adapters/ezplm/mappers 负责从真实接口映射过来。
 * 这样后端字段改名时只需改 adapter，不需要改 18 条规则。
 */
export interface BomLineInput {
  id: string;
  rowNo: number;
  refs?: string | null;
  qty?: string | number | null;
  partCode?: string | null;
  mpn?: string | null;
  manufacturer?: string | null;
  description?: string | null;
  footprint?: string | null;
  category?: string | null;
  value?: string | null;
  unitPrice?: string | number | null;
  /** 未关联零件的行无法加入购物车，是硬采购阻塞 */
  partId?: string | null;
  /** 采购属性：采购/虚拟/自制/客供/不装。后端待加字段。 */
  purchaseType?: string | null;
  /** 生命周期状态。后端待加字段（现有枚举只有 正常/禁用）。 */
  lifecycle?: string | null;
  confirmed?: boolean;
}

export interface BomInput {
  id: string;
  code: string;
  version: string;
  projectId: string;
  lines: BomLineInput[];
}

/** 零件主数据的快照，用于与 BOM 行做交叉比对。 */
export interface PartSnapshot {
  id: string;
  code?: string | null;
  mpn?: string | null;
  footprint?: string | null;
  category?: string | null;
  lifecycle?: string | null;
  description?: string | null;
}

export interface RuleEnv {
  bom: BomInput;
  ctx: AgentContext;
  /** 整张 BOM 的位号并集。R15 必须用它，不能逐行算。 */
  allRefs: string[];
  parts: Map<string, PartSnapshot>;
}

export interface Rule {
  code: string;
  title: string;
  /** 首发波次。phase 1 的七条必须零歧义：第一印象必须是“它说的都对”。 */
  phase: 1 | 3 | 4;
  requires?: keyof FeatureFlags;
  runLine?(line: BomLineInput, env: RuleEnv): Array<Suggestion<unknown>>;
  runBom?(env: RuleEnv): Array<Suggestion<unknown>>;
}

export interface HealthReport {
  bomId: string;
  version: string;
  totalLines: number;
  /** 参与体检的行数（排除虚拟/不装/客供） */
  auditedLines: number;
  blocking: number;
  warning: number;
  info: number;
  suggestions: Array<Suggestion<unknown>>;
  /** 因后端字段缺失而未启用的规则，必须告知，否则用户不知道体检是不完整的 */
  skippedRules: Array<{ code: string; reason: string }>;
  /** 自身 bug 导致被丢弃的建议，上报内部监控 */
  dropped: Array<{ code: string; reason: string }>;
}
