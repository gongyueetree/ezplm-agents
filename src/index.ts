/**
 * ezplm-agents 对外入口。
 *
 * 宿主只需要认识两个东西：Suggestion 结构，以及下面这几个入口函数。
 */

export * from './core/types';
export * from './core/suggestion';
export * from './core/audit';
export * from './core/normalize';

export { runBomHealthCheck, evaluateReleaseGate, RULES, PHASE1_CODES } from './agents/a1-bom-health';
export type { BomInput, BomLineInput, HealthReport, PartSnapshot } from './agents/a1-bom-health';

export { compareForReplacement, compareMany } from './agents/a2-footprint-check';
export type { PartForCompare, CompareResult, ParamCheck } from './agents/a2-footprint-check';

export { computeShortage } from './agents/a3-shortage';
export type { ShortageInput, ShortageResult, ShortageRow, RequisitionDraftLine } from './agents/a3-shortage';

export { auditDictionary, suggestMapping } from './agents/a4-import-mapper';
export type { DictEntry, ImportRow, PartCandidate } from './agents/a4-import-mapper';

export {
  extractAttrs, buildCreateSuggestions, scoreCandidates, buildSelectSuggestion,
  decidePrice, auditAttributeNames, TEMPLATES, templateFor, canonAttrName, validateAttrName,
} from './agents/a5-part-assistant';
export type {
  ExtractResult, CreateDraftInput, SelectCandidate, SelectQuery, ScoredCandidate,
  PriceOffer, PriceDecision, CategoryTemplate, AttrSpec,
} from './agents/a5-part-assistant';

export type { EzplmClient, EzplmConfig } from './adapters/ezplm/client';
export { NoopEzplmClient, buildContext } from './adapters/ezplm/client';

/** 版本号。建议把它跟着审计记录一起存，日后复盘能知道当时跑的是哪一版规则。 */
export const AGENTS_VERSION = '0.1.0';
