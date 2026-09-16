import { assertRenderable, makeSuggestion } from '../../core/suggestion';
import type { Evidence, Suggestion } from '../../core/types';

export type LabSightAction =
  | 'chat'
  | 'measure_guide'
  | 'design_review'
  | 'analyze_photo'
  | 'assembly_align'
  | 'assembly_inspect'
  | 'analyze_capture';

export interface LabSightInvocation {
  projectId: string;
  action: LabSightAction;
  question?: string;
  photoId?: string;
  captureId?: string;
  persist?: boolean;
}

export interface LabSightRuntimeResponse<T = unknown> {
  ok: boolean;
  agent: 'A6';
  action: LabSightAction;
  narration?: string;
  meta?: unknown;
  tools?: unknown[];
  cards?: unknown[];
  result?: T;
}

export interface LabSightTransport {
  invoke<T = unknown>(input: LabSightInvocation): Promise<LabSightRuntimeResponse<T>>;
}

export interface LabSightCapability {
  id: string;
  label: string;
  available: boolean;
  phase?: string;
}

export const LABSIGHT_AGENT_MANIFEST = {
  id: 'A6' as const,
  slug: 'labsight-debug',
  name: 'LabSight 调试 Agent',
  version: '0.1.0',
  mountPoint: 'project/labsight',
  modes: ['live_debug', 'pcb_compare'] as const,
  context: [
    'project',
    'design_version',
    'components',
    'nets',
    'test_points',
    'photos',
    'captures',
    'diagnoses',
    'debug_steps',
    'activity_timeline',
  ] as const,
  capabilities: [
    { id: 'chat', label: '工程上下文问答', available: true },
    { id: 'measure_guide', label: '下一测量点建议', available: true },
    { id: 'design_review', label: '设计审查', available: true },
    { id: 'analyze_photo', label: 'PCB / 仪器照片分析', available: true },
    { id: 'assembly_align', label: 'KiCad ↔ 实物 PCB 配准', available: true },
    { id: 'assembly_inspect', label: 'Footprint 装配检查', available: true },
    { id: 'analyze_capture', label: '波形 / 测量诊断', available: true },
    { id: 'create_issue_draft', label: '生成 Issue 草稿', available: false, phase: 'P1' },
    { id: 'create_eco_draft', label: '生成 ECO 草稿', available: false, phase: 'P1' },
    { id: 'golden_board_compare', label: 'Golden Board 对比', available: false, phase: 'P2' },
  ] satisfies LabSightCapability[],
  policy: {
    writes: 'suggest_only' as const,
    humanConfirmationRequired: true,
    evidenceRequired: true,
  },
};

export function buildLabSightInvocation(input: LabSightInvocation): LabSightInvocation {
  const projectId = input.projectId.trim();
  if (!projectId) throw new Error('A6 LabSight invocation 缺少 projectId');
  const out: LabSightInvocation = { projectId, action: input.action };
  if (input.question?.trim()) out.question = input.question.trim();
  if (input.photoId?.trim()) out.photoId = input.photoId.trim();
  if (input.captureId?.trim()) out.captureId = input.captureId.trim();
  if (input.persist !== undefined) out.persist = input.persist;

  if (['chat', 'measure_guide'].includes(out.action) && !out.question) {
    throw new Error(`A6/${out.action} 需要 question`);
  }
  if (['analyze_photo', 'assembly_align', 'assembly_inspect'].includes(out.action) && !out.photoId) {
    throw new Error(`A6/${out.action} 需要 photoId`);
  }
  if (out.action === 'analyze_capture' && !out.captureId) {
    throw new Error('A6/analyze_capture 需要 captureId');
  }
  return out;
}

export async function invokeLabSight<T = unknown>(
  transport: LabSightTransport,
  input: LabSightInvocation,
): Promise<LabSightRuntimeResponse<T>> {
  return transport.invoke<T>(buildLabSightInvocation(input));
}

export interface IssueDraft {
  title: string;
  symptom: string;
  expected?: string;
  observed?: string;
  reproduction?: string[];
  relatedRefs?: string[];
  relatedNets?: string[];
}

export interface EcoDraft {
  title: string;
  reason: string;
  proposedChange: string;
  affectedRefs?: string[];
  verificationPlan?: string[];
}

function requireIndependentEvidence(evidence: Evidence[]): void {
  if (!evidence.length) throw new Error('A6 草稿没有证据，禁止生成');
  const kinds = new Set(evidence.map((e) => e.kind));
  if (kinds.size < 2) {
    throw new Error('A6 草稿至少需要两类独立证据（例如 KiCad + 测量、照片 + 波形）');
  }
}

export function buildIssueDraftSuggestion(input: {
  projectId: string;
  designVersion?: string;
  draft: IssueDraft;
  evidence: Evidence[];
  now?: Date;
}): Suggestion<IssueDraft> {
  requireIndependentEvidence(input.evidence);
  const s = makeSuggestion<IssueDraft>({
    agent: 'A6',
    code: 'A6.ISSUE.DRAFT',
    target: { objectType: 'issue', objectId: input.projectId, version: input.designVersion },
    severity: 'warn',
    confidence: 'high',
    title: '生成调试 Issue 草稿',
    detail: 'LabSight 已把现场证据整理成 Issue 草稿；提交前必须由工程师复核并确认。',
    proposed: input.draft,
    evidence: input.evidence,
  }, input.now);
  assertRenderable(s);
  return s;
}

export function buildEcoDraftSuggestion(input: {
  projectId: string;
  designVersion?: string;
  draft: EcoDraft;
  evidence: Evidence[];
  now?: Date;
}): Suggestion<EcoDraft> {
  requireIndependentEvidence(input.evidence);
  const s = makeSuggestion<EcoDraft>({
    agent: 'A6',
    code: 'A6.ECO.DRAFT',
    target: { objectType: 'eco', objectId: input.projectId, version: input.designVersion },
    severity: 'warn',
    confidence: 'high',
    title: '生成 ECO 草稿',
    detail: 'LabSight 已根据调试证据整理工程变更草稿；任何设计写入仍需人工 diff 确认。',
    proposed: input.draft,
    evidence: input.evidence,
  }, input.now);
  assertRenderable(s);
  return s;
}
