import type { AgentContext, FeatureFlags, FieldOrigin, Suggestion } from '../../core/types';
import type { BomInput, PartSnapshot } from '../../agents/a1-bom-health/types';
import type { DictEntry } from '../../agents/a4-import-mapper';
import type { InTransitLot, InventorySnapshot, PurchaseTerms } from '../../agents/a3-shortage';
import type { AuditRecord } from '../../core/audit';

/**
 * 这是**唯一需要你们工程师改的文件**。
 *
 * 其余代码全部是纯函数，不知道 eZ-PLM 的存在。这样做的好处：
 *   - 规则可以用真实数据做 fixture 单测，不需要跑起整套系统
 *   - 后端字段改名只影响这一个文件
 *   - 可以先在前端跑（做幽灵预填），之后再搬到服务端，不用重写
 *
 * 注意：本仓库是公开仓库，所以不包含真实的 workspace 标识、内部接口路径与对象 ID。
 * 请在 EzplmConfig 里用环境变量注入，不要硬编码提交上来。
 */

export interface EzplmConfig {
  /** 形如 https://<YOUR_HOST> */
  apiBase: string;
  /** 工作区标识，形如 ws-xxxxxx */
  workspace: string;
  /** 从客户端会话里取，绝不写入代码仓库 */
  getAuthHeader: () => Promise<Record<string, string>>;
}

/**
 * 实现这个接口即可。注意所有方法都是**只读**的，
 * 除了 applyAccepted 和 appendAudit 两个——它们只能在用户点了确认之后被调用。
 */
export interface EzplmClient {
  // ── 读 ──
  getBom(bomId: string, version?: string): Promise<BomInput>;
  getParts(partIds: string[]): Promise<Map<string, PartSnapshot>>;
  searchSystemLibrary(query: string, limit?: number): Promise<PartSnapshot[]>;
  getDictionary(tab: 'mpn' | 'value'): Promise<DictEntry[]>;
  getInventory(partIds: string[]): Promise<Map<string, InventorySnapshot>>;
  getInTransit(partIds: string[]): Promise<Map<string, InTransitLot[]>>;
  getPurchaseTerms(partIds: string[]): Promise<Map<string, PurchaseTerms>>;
  getAttributeNames(): Promise<string[]>;
  getFeatureFlags(): Promise<FeatureFlags>;

  // ── 写（仅在用户确认后） ──
  /**
   * 应用一条已被用户接受的建议。
   *
   * 实现时必须做到三件事，否则不要实现：
   *   1. 写入时同时设置字段级 origin = 'ai_suggested_accepted'
   *   2. 返回一个可以一键撤销的 undoToken
   *   3. 写入前再校一次对象版本，避免用户在建议生成后又改过数据
   */
  applyAccepted(input: {
    suggestion: Suggestion<unknown>;
    finalValue: unknown;
    expectedVersion?: string;
    origin: FieldOrigin;
  }): Promise<{ ok: boolean; undoToken?: string; conflict?: boolean }>;

  undo(undoToken: string): Promise<{ ok: boolean }>;

  /** 审计只能 append。不提供 delete。 */
  appendAudit(record: AuditRecord): Promise<void>;
}

/**
 * 一个什么都不做的实现，用于本地调试与单测。
 * 把它当作接口契约的可执行文档看。
 */
export class NoopEzplmClient implements EzplmClient {
  async getBom(): Promise<BomInput> { throw new Error('not implemented'); }
  async getParts(): Promise<Map<string, PartSnapshot>> { return new Map(); }
  async searchSystemLibrary(): Promise<PartSnapshot[]> { return []; }
  async getDictionary(): Promise<DictEntry[]> { return []; }
  async getInventory(): Promise<Map<string, InventorySnapshot>> { return new Map(); }
  async getInTransit(): Promise<Map<string, InTransitLot[]>> { return new Map(); }
  async getPurchaseTerms(): Promise<Map<string, PurchaseTerms>> { return new Map(); }
  async getAttributeNames(): Promise<string[]> { return []; }
  async getFeatureFlags(): Promise<FeatureFlags> {
    return { purchaseTypeField: false, lifecycleField: false, priceTable: false, fieldOrigin: false, inventoryQuery: false };
  }
  async applyAccepted(): Promise<{ ok: boolean }> {
    // 故意报错：防止有人拿着 Noop 客户端上线。
    throw new Error('applyAccepted 未实现：绝不允许默默失败，否则用户以为已保存');
  }
  async undo(): Promise<{ ok: boolean }> { throw new Error('not implemented'); }
  async appendAudit(): Promise<void> { /* no-op */ }
}

/** 从客户端拉取 flags 并组装 AgentContext。 */
export async function buildContext(
  client: EzplmClient, cfg: EzplmConfig, userId: string,
): Promise<AgentContext> {
  const flags = await client.getFeatureFlags();
  return { workspace: cfg.workspace, userId, now: () => new Date(), flags };
}
