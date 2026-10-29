// Controlled recommendation mapping (Milestone 3 Section 4). Produces "Suggested by Rules Engine"
// recommendations only from the approved mapping and Recommendation Library. No generative AI.
import type { Pathway, RecommendationContent } from '../methodology/types';
import type { Finding } from './hga';

export interface SuggestedRecommendation {
  ruleId: string;
  pathway: Pathway;
  alsoAvailable: Pathway[];
  audience: 'athlete' | 'institution' | 'health_support';
  entryId: string;
  reassessmentTarget: string;
  priority: number;
  rank: number;
  isSafety: boolean;
}

export function suggestRecommendations(rec: RecommendationContent, findings: Finding[]): SuggestedRecommendation[] {
  const enabled = new Set(rec.pathways.filter((p) => p.enabled).map((p) => p.code));
  return findings.flatMap((f) => {
    const m = rec.mapping.find((x) => x.rule === f.ruleId);
    if (!m) return [];
    // Pathway F (product) is never selected automatically (IHS-010).
    if (!enabled.has(m.primary)) return [];
    const entry = rec.library.find((e) => e.rule === f.ruleId && e.pathway === m.primary);
    if (!entry) return [];
    return [{
      ruleId: f.ruleId,
      pathway: m.primary,
      alsoAvailable: m.alsoAvailable.filter((p) => enabled.has(p)),
      audience: m.audience,
      entryId: entry.entryId,
      reassessmentTarget: m.reassessmentTarget,
      priority: f.priority,
      rank: f.rank,
      isSafety: f.isSafety,
    }];
  });
}
