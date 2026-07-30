import type { Suggestion, FieldOrigin, Evidence } from './types';

export type AuditAction = 'accepted' | 'rejected' | 'edited' | 'undone';

/**
 * 审计记录。只能 append，不提供删除接口。
 *
 * 为什么必须存 evidenceSnapshot：证据源（系统库、字典、描述串）后来会变，
 * 几个月后复盘“当时为什么接受了这个建议”时，必须能看到当时的证据，
 * 而不是重新去读一遍已经变了的数据源。
 */
export interface AuditRecord {
  id: string;
  suggestionId: string;
  agent: string;
  code: string;
  userId: string;
  action: AuditAction;
  objectType: string;
  objectId: string;
  objectVersion?: string;
  field?: string;
  before: unknown;
  after: unknown;
  evidenceSnapshot: Evidence[];
  /** 落库时写进业务表的 origin 值 */
  originWritten: FieldOrigin;
  at: string;
}

export interface AuditSink {
  append(record: AuditRecord): Promise<void>;
}

export function buildAudit(
  s: Suggestion<unknown>,
  userId: string,
  action: AuditAction,
  after: unknown,
  now?: Date,
): AuditRecord {
  const writesData = action === 'accepted' || action === 'edited';
  const rec: AuditRecord = {
    id: 'AUD-' + s.id + '-' + action,
    suggestionId: s.id,
    agent: s.agent,
    code: s.code,
    userId,
    action,
    objectType: s.target.objectType,
    objectId: s.target.objectId,
    before: s.current,
    after,
    evidenceSnapshot: s.evidence,
    // 关键：接受建议产生的写入必须标为 ai_suggested_accepted，
    // 这样「批量同步系统库字段 / 仅同步未修改的字段」才会绕开它。
    originWritten: writesData ? 'ai_suggested_accepted' : 'manual',
    at: (now ?? new Date()).toISOString(),
  };
  if (s.target.version !== undefined) rec.objectVersion = s.target.version;
  if (s.target.field !== undefined) rec.field = s.target.field;
  return rec;
}

/** 内存实现，仅用于测试。生产环境必须接真实的持久化 sink。 */
export class InMemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];
  async append(record: AuditRecord): Promise<void> {
    this.records.push(record);
  }
}

/**
 * 采纳率统计。验收指标看的是这个，不是调用量。
 * 调用量高只能证明入口好找，采纳率高才能证明建议有用。
 */
export function adoptionByCode(records: AuditRecord[]): Record<string, { accepted: number; rejected: number; rate: number }> {
  const out: Record<string, { accepted: number; rejected: number; rate: number }> = {};
  for (const r of records) {
    const key = r.agent + '/' + r.code;
    const bucket = out[key] ?? { accepted: 0, rejected: 0, rate: 0 };
    if (r.action === 'accepted' || r.action === 'edited') bucket.accepted += 1;
    if (r.action === 'rejected') bucket.rejected += 1;
    out[key] = bucket;
  }
  for (const key of Object.keys(out)) {
    const b = out[key]!;
    const total = b.accepted + b.rejected;
    b.rate = total === 0 ? 0 : b.accepted / total;
  }
  return out;
}
