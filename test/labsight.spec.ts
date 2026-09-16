import { describe, expect, it } from 'vitest';
import {
  LABSIGHT_AGENT_MANIFEST,
  buildEcoDraftSuggestion,
  buildIssueDraftSuggestion,
  buildLabSightInvocation,
} from '../src/agents/a6-labsight-debug';

const evidence = [
  { kind: 'kicad' as const, ref: 'project:P1/ref:U3', excerpt: 'U3 = 3.3V LDO' },
  { kind: 'measurement' as const, ref: 'capture:C1/net:3V3', excerpt: '实测 2.71 V' },
];

describe('A6 LabSight', () => {
  it('publishes a project-level suggest-only manifest', () => {
    expect(LABSIGHT_AGENT_MANIFEST.id).toBe('A6');
    expect(LABSIGHT_AGENT_MANIFEST.mountPoint).toBe('project/labsight');
    expect(LABSIGHT_AGENT_MANIFEST.policy.writes).toBe('suggest_only');
    expect(LABSIGHT_AGENT_MANIFEST.policy.humanConfirmationRequired).toBe(true);
  });

  it('validates invocation inputs', () => {
    expect(buildLabSightInvocation({ projectId: ' P1 ', action: 'chat', question: ' 下一步测哪里？ ' })).toEqual({
      projectId: 'P1',
      action: 'chat',
      question: '下一步测哪里？',
    });
    expect(() => buildLabSightInvocation({ projectId: 'P1', action: 'analyze_photo' })).toThrow(/photoId/);
  });

  it('creates Issue/ECO only as human-confirmed Suggestions with evidence', () => {
    const issue = buildIssueDraftSuggestion({
      projectId: 'P1',
      designVersion: 'REV A',
      evidence,
      now: new Date('2026-09-16T00:00:00Z'),
      draft: {
        title: '3V3 rail undervoltage',
        symptom: '3V3 实测 2.71 V',
        expected: '3.30 V ±5%',
        observed: '2.71 V',
        relatedRefs: ['U3'],
        relatedNets: ['3V3'],
      },
    });
    expect(issue.agent).toBe('A6');
    expect(issue.autoApplyForbidden).toBe(true);
    expect(issue.proposed?.observed).toBe('2.71 V');

    const eco = buildEcoDraftSuggestion({
      projectId: 'P1',
      evidence,
      draft: {
        title: '调整 U3 供电设计',
        reason: '调试证据指向 3V3 输出异常',
        proposedChange: '工程师确认后再填写实际设计变更',
        affectedRefs: ['U3'],
        verificationPlan: ['复测 3V3', '回归启动波形'],
      },
    });
    expect(eco.autoApplyForbidden).toBe(true);
  });

  it('refuses write drafts with a single evidence kind', () => {
    expect(() =>
      buildIssueDraftSuggestion({
        projectId: 'P1',
        evidence: [evidence[0]],
        draft: { title: 'x', symptom: 'y' },
      }),
    ).toThrow(/两类独立证据/);
  });
});
