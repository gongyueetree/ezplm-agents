/**
 * ezplm-agents 的唯一对外契约。
 *
 * 五个 Agent 的输出全部收敛到 Suggestion 上，宿主 UI 只需要认识这一个结构。
 * 新增 Agent 不允许新增出口类型 —— 否则前端会长出五套互不相通的渲染逻辑。
 */

export type AgentId = 'A1' | 'A2' | 'A3' | 'A4' | 'A5';

/** 置信度直接决定交互形态，见 confidenceToInteraction()。 */
export type Confidence = 'high' | 'medium' | 'low';

/** block 会挡住版本发布/下单，warn 只提示，info 是可以长期存在的观察项。 */
export type Severity = 'block' | 'warn' | 'info';

/**
 * 字段来源标记 —— 后端必须补的字段之一。
 *
 * eZ-PLM 现有的「批量同步系统库字段」会提示“同步后本地数据将被覆盖”，
 * 并提供“仅同步未修改的字段”。如果 A5 写入的字段没有 origin 标记，
 * 一次全量同步就会静默抹掉用户已经接受过的全部建议，而用户不会知道。
 * 所以：ai_suggested_accepted 必须与 manual 同等地被当作“已修改”。
 */
export type FieldOrigin = 'system_sync' | 'ai_suggested_accepted' | 'manual';

/**
 * 价格四层责任。UI 必须按层区分视觉，禁止混为一谈。
 * L1 真实采购单价 > L2 系统库参考现货价 > L3 同族插值 > L4 模型估价。
 * 现有的「AI 智能估价」产出的是 L4，它不该覆盖 L1/L2。
 */
export type PriceSource = 'po_actual' | 'system_library' | 'interpolated' | 'model_estimate';

export const PRICE_SOURCE_RANK: Record<PriceSource, number> = {
  po_actual: 1,
  system_library: 2,
  interpolated: 3,
  model_estimate: 4,
};

export type EvidenceKind =
  | 'field'      // 某个对象的某个字段
  | 'row'        // BOM 的某一行
  | 'dict'       // 工程文件导入映射字典的某条记录
  | 'library'    // 系统库/云端元件库
  | 'doc'        // 数据手册
  | 'rule'       // 规则本身（仅用于纯逻辑推导）
  | 'mpn'        // 型号解码结果
  | 'inventory'  // 库存/在途
  | 'po';        // 历史采购单

export interface Evidence {
  kind: EvidenceKind;
  /** 稳定可跳转的定位串，例如 bomLine:<ID>/row:37/field:规格描述 */
  ref: string;
  /** 原文片段，UI 悬浮展示。禁止在这里做二次加工。 */
  excerpt?: string;
  url?: string;
}

export type ObjectType =
  | 'bom' | 'bomLine' | 'part' | 'package' | 'attribute' | 'dictEntry' | 'requisition';

export interface SuggestionTarget {
  objectType: ObjectType;
  objectId: string;
  /** BOM 版本号。建议必须绑版本，否则换版之后旧建议会飘到新数据上。 */
  version?: string;
  /** 指向字段级才能做 diff 预览。整对象级的建议无法被安全地一键接受。 */
  field?: string;
  /** BOM 行位号，纯粹为了让用户能立刻定位 */
  rowRef?: string;
}

export interface Candidate<T> {
  value: T;
  /** 0..1，仅用于排序，不要展示成百分比准确率 */
  score: number;
  evidence: Evidence[];
  label?: string;
}

export interface Suggestion<T = unknown> {
  id: string;
  agent: AgentId;
  /** 规则码，如 R01 / A5.CREATE.FOOTPRINT。用户反馈时报这个码。 */
  code: string;
  target: SuggestionTarget;
  severity: Severity;
  confidence: Confidence;
  /** 中性表述。禁止“你填错了”这类句式，只陈述两个值的差异。 */
  title: string;
  detail: string;
  current?: T;
  /** 只有 high 允许给出唯一 proposed */
  proposed?: T;
  /** medium 必须给出 >=2 个候选，由人来选 */
  candidates?: Array<Candidate<T>>;
  /** 硬约束：不可为空。assertRenderable 会拦。 */
  evidence: Evidence[];
  /** 推导过程中做过的假设，必须显式告知用户 */
  assumed?: string[];
  /** 类型层面锁死：永不自动落库 */
  autoApplyForbidden: true;
  createdAt: string;
}

/**
 * 后端能力开关。缺字段时对应规则自动降级为不启用，
 * 而不是拿空值去硬算然后乱报 —— 乱报一次，用户就再也不信这个面板。
 */
export interface FeatureFlags {
  /** BOM 行「采购属性」枚举（采购/虚拟/自制/客供/不装）。最紧急的一个。 */
  purchaseTypeField: boolean;
  /** 物料生命周期状态。现有枚举只有 正常/禁用，不足以支撑 R16。 */
  lifecycleField: boolean;
  /** 参考价格表（物料, 供应商, 量档, 单价, 币种, 报价日期, 来源） */
  priceTable: boolean;
  /** 字段级 origin 标记 */
  fieldOrigin: boolean;
  /** 库存/在途查询可用 */
  inventoryQuery: boolean;
}

export const ALL_FLAGS_OFF: FeatureFlags = {
  purchaseTypeField: false,
  lifecycleField: false,
  priceTable: false,
  fieldOrigin: false,
  inventoryQuery: false,
};

export interface AgentContext {
  /** 工作区标识，运行时注入，代码里不写死 */
  workspace: string;
  userId: string;
  now(): Date;
  flags: FeatureFlags;
}
