import type { Suggestion, AgentId, Confidence, Evidence, EvidenceKind } from './types';

let seq = 0;

function nextId(agent: AgentId, code: string): string {
  seq += 1;
  return agent + '-' + code + '-' + Date.now().toString(36) + '-' + seq;
}

export type SuggestionDraft<T> = Omit<Suggestion<T>, 'id' | 'autoApplyForbidden' | 'createdAt'>;

export function makeSuggestion<T>(draft: SuggestionDraft<T>, now?: Date): Suggestion<T> {
  return {
    ...draft,
    id: nextId(draft.agent, draft.code),
    autoApplyForbidden: true,
    createdAt: (now ?? new Date()).toISOString(),
  };
}

/**
 * 渲染前必须过这一关。
 *
 * 这不是防御性编程，是产品红线：没有证据的建议一旦露出，
 * 用户第一次被坑之后就再也不看这个面板了，之后做得再准也没人用。
 */
export function assertRenderable(s: Suggestion<unknown>): void {
  const at = '[' + s.agent + '/' + s.code + '] ';
  if (!s.evidence || s.evidence.length === 0) {
    throw new Error(at + 'evidence 为空，禁止渲染');
  }
  for (const e of s.evidence) {
    if (!e.ref) throw new Error(at + 'evidence.ref 为空，用户无法定位');
  }
  if (s.confidence === 'high') {
    if (s.proposed === undefined) throw new Error(at + 'high 置信必须给出唯一 proposed');
    if (s.candidates && s.candidates.length > 0) throw new Error(at + 'high 置信不应同时给候选列表');
  }
  if (s.confidence === 'medium') {
    if (!s.candidates || s.candidates.length < 2) {
      throw new Error(at + 'medium 置信必须给出 >=2 个候选，由人来选');
    }
    if (s.proposed !== undefined) throw new Error(at + 'medium 置信不许预设答案');
  }
  if (s.confidence === 'low') {
    if (s.proposed !== undefined || (s.candidates && s.candidates.length > 0)) {
      throw new Error(at + 'low 置信只许提示风险，不许给结论');
    }
  }
}

export interface FilterResult {
  ok: Array<Suggestion<unknown>>;
  dropped: Array<{ code: string; reason: string }>;
}

/** 宿主 UI 只渲染 ok。dropped 应当上报到内部监控，它代表 Agent 自身有 bug。 */
export function filterRenderable(list: Array<Suggestion<unknown>>): FilterResult {
  const ok: Array<Suggestion<unknown>> = [];
  const dropped: Array<{ code: string; reason: string }> = [];
  for (const s of list) {
    try {
      assertRenderable(s);
      ok.push(s);
    } catch (err) {
      dropped.push({ code: s.agent + '/' + s.code, reason: (err as Error).message });
    }
  }
  return { ok, dropped };
}

export type Interaction =
  | 'ghost_prefill'  // 灰字默认填好，一键撤销
  | 'pick_one'       // 展开候选，人必须点一个
  | 'flag_only';     // 只标记，不给答案

export function confidenceToInteraction(c: Confidence): Interaction {
  if (c === 'high') return 'ghost_prefill';
  if (c === 'medium') return 'pick_one';
  return 'flag_only';
}

export interface Vote {
  value: string;
  source: EvidenceKind;
}

/**
 * 交叉验证：两条**不同来源**的证据链指向同一个值，才允许升到 high。
 * 同一来源重复出现不算两条 —— 那只是同一个错误被读了两遍。
 */
export function crossValidate(votes: Vote[]): Confidence {
  if (votes.length === 0) return 'low';
  const values = new Set(votes.map((v) => v.value.trim().toLowerCase()));
  if (values.size > 1) return 'medium';
  const sources = new Set(votes.map((v) => v.source));
  return sources.size >= 2 ? 'high' : 'medium';
}

/** 常用的证据构造器，避免各 Agent 各拼一套 ref 格式。 */
export const ref = {
  bomLine(lineId: string, rowNo: number, field?: string): string {
    return 'bomLine:' + lineId + '/row:' + rowNo + (field ? '/field:' + field : '');
  },
  bom(bomId: string, version?: string): string {
    return 'bom:' + bomId + (version ? '@' + version : '');
  },
  part(partId: string, field?: string): string {
    return 'part:' + partId + (field ? '/field:' + field : '');
  },
  dictEntry(tab: string, key: string): string {
    return 'dict:' + tab + '/key:' + key;
  },
};

export function evidence(kind: EvidenceKind, r: string, excerpt?: string): Evidence {
  const e: Evidence = { kind, ref: r };
  if (excerpt !== undefined) e.excerpt = excerpt;
  return e;
}
