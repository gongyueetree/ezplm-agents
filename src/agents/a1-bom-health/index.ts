import { filterRenderable } from '../../core/suggestion';
import type { Suggestion } from '../../core/types';
import { parseRefs } from '../../core/normalize/parseRefs';
import { RULES, PHASE1_CODES, isNonPurchase } from './rules';
import type { BomInput, HealthReport, PartSnapshot, RuleEnv } from './types';
import type { AgentContext } from '../../core/types';

export * from './types';
export { RULES, PHASE1_CODES, isNonPurchase } from './rules';

export interface RunOptions {
  /** 只跑这些规则码。灰度时用 PHASE1_CODES。 */
  only?: string[];
  parts?: Map<string, PartSnapshot>;
}

/**
 * A1 主入口。纯函数：同样的 BOM 进去，同样的报告出来，不读网络不写库。
 * 这一点很重要：体检结果必须可复现，否则用户报错时你无法重现。
 */
export function runBomHealthCheck(bom: BomInput, ctx: AgentContext, opts: RunOptions = {}): HealthReport {
  const parts = opts.parts ?? new Map<string, PartSnapshot>();

  const allRefs: string[] = [];
  for (const l of bom.lines) allRefs.push(...parseRefs(l.refs).refs);

  const env: RuleEnv = { bom, ctx, allRefs, parts };

  const raw: Array<Suggestion<unknown>> = [];
  const skippedRules: Array<{ code: string; reason: string }> = [];

  for (const rule of RULES) {
    if (opts.only && !opts.only.includes(rule.code)) continue;

    // 后端字段缺失时直接不启用，并且**告知用户**。
    // 不告知的后果是用户以为体检完整，实际上有两条规则从未运行过。
    if (rule.requires && !ctx.flags[rule.requires]) {
      skippedRules.push({ code: rule.code, reason: '依赖后端能力 ' + rule.requires + ' 尚未就绪' });
      continue;
    }

    try {
      if (rule.runBom) raw.push(...rule.runBom(env));
      if (rule.runLine) {
        for (const line of bom.lines) raw.push(...rule.runLine(line, env));
      }
    } catch (err) {
      // 单条规则抛错不能带倒整个体检。
      skippedRules.push({ code: rule.code, reason: '规则执行异常：' + (err as Error).message });
    }
  }

  const filtered = filterRenderable(raw);
  const suggestions = filtered.ok.sort(bySeverityThenRow);

  return {
    bomId: bom.id,
    version: bom.version,
    totalLines: bom.lines.length,
    auditedLines: bom.lines.filter((l) => !isNonPurchase(l)).length,
    blocking: suggestions.filter((s) => s.severity === 'block').length,
    warning: suggestions.filter((s) => s.severity === 'warn').length,
    info: suggestions.filter((s) => s.severity === 'info').length,
    suggestions,
    skippedRules,
    dropped: filtered.dropped,
  };
}

const SEVERITY_ORDER: Record<string, number> = { block: 0, warn: 1, info: 2 };

function bySeverityThenRow(a: Suggestion<unknown>, b: Suggestion<unknown>): number {
  const sa = SEVERITY_ORDER[a.severity] ?? 9;
  const sb = SEVERITY_ORDER[b.severity] ?? 9;
  if (sa !== sb) return sa - sb;
  return (a.target.rowRef ?? '').localeCompare(b.target.rowRef ?? '');
}

/**
 * 版本发布门禁。
 *
 * 注意这个能力排在最后一期，不是因为它难，而是因为它是一个权力动作。
 * 在用户还不信任规则的阶段就拿它卡发布，会直接引发反感，
 * 结果是运维被要求关掉1。先让人信，再许它拦。
 */
export function evaluateReleaseGate(report: HealthReport): { pass: boolean; reasons: string[] } {
  const blockers = report.suggestions.filter((s) => s.severity === 'block');
  return {
    pass: blockers.length === 0,
    reasons: blockers.map((s) => s.code + ' ' + s.title + (s.target.rowRef ? '（' + s.target.rowRef + '）' : '')),
  };
}
