import { PrismaClient } from '@prisma/client';
import { analysisEngineService, QPROAnalysisOutput } from './analysis-engine-service';
import { BlobServiceClient } from '@azure/storage-blob';
import { targetAggregationService } from './target-aggregation-service';
import { strategicPlanService } from './strategic-plan-service';
import { computeAggregatedAchievement, getInitiativeTargetMeta, normalizeKraId } from '@/lib/utils/qpro-aggregation';

const prisma = new PrismaClient();

// ========== PRISMA HELPERS ==========
/**
 * Convert undefined to null for Prisma compatibility.
 * Prisma/SQL doesn't accept JavaScript `undefined` - must be `null`.
 */
const toPrisma = <T>(val: T | undefined): T | null => val === undefined ? null : val;

/**
 * Ensure a value is an array (for JSON array fields).
 */
const toArray = <T>(val: T[] | undefined | null): T[] => Array.isArray(val) ? val : [];

/**
 * Convert array or object to string for String fields in Prisma.
 * Handles arrays of strings, arrays of objects, or plain strings.
 */
const toString = (val: any): string | null => {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    if (val.length === 0) return null; // Empty array -> null
    // If array of objects with 'action' field (recommendations), format them
    if (val.length > 0 && typeof val[0] === 'object' && val[0].action) {
      return val.map((item: any) => `• ${item.action}${item.timeline ? ` (${item.timeline})` : ''}`).join('\n');
    }
    // Otherwise, join array items with bullet points
    return val.map((item: any) => `• ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n');
  }
  // For plain objects, convert to JSON string
  return JSON.stringify(val);
};

// Initialize Azure Blob Storage client
const blobServiceClient = BlobServiceClient.fromConnectionString(
 process.env.AZURE_STORAGE_CONNECTION_STRING!
);

interface QPROAnalysisInput {
  documentId: string;
  documentTitle: string;
  documentPath: string;
  documentType: string;
  uploadedById: string;
  unitId?: string | null;
  year?: number;
  quarter?: number;
}

interface QPROAnalysesFilter {
  unitId?: string;
  year?: number;
  quarter?: number;
  userId?: string;
  limit?: number;
}

export class QPROAnalysisService {
  /**
   * Calculate type detection score based on keyword presence and importance
   * Gives higher weight to primary keywords and phrases
   */
  private calculateTypeScore(text: string, keywords: string[], primaryKeywords: string[]): number {
    let score = 0;
    const textLower = text.toLowerCase();
    
    // Primary keywords get 2 points each
    for (const pkw of primaryKeywords) {
      if (textLower.includes(pkw.toLowerCase())) {
        score += 2;
      }
    }
    
    // Secondary keywords get 1 point each
    for (const kw of keywords) {
      if (!primaryKeywords.includes(kw) && textLower.includes(kw.toLowerCase())) {
        score += 1;
      }
    }
    
    return score;
  }
  
  /**
   * Calculate semantic similarity score between activity and KRA content
   * Considers word overlap, phrase matching, and contextual relevance
   */
  private calculateSemanticScore(activityText: string, kraText: string): number {
    const activityLower = activityText.toLowerCase();
    const kraLower = kraText.toLowerCase();
    
    const activityWords = new Set(activityLower.split(/\s+/).filter(w => w.length > 3));
    const kraWords = new Set(kraLower.split(/\s+/).filter(w => w.length > 3));
    
    // Calculate Jaccard similarity
    let commonWords = 0;
    activityWords.forEach(word => {
      if (kraWords.has(word)) {
        commonWords++;
      }
    });
    
    const totalUnique = activityWords.size + kraWords.size - commonWords;
    const jaccardScore = totalUnique > 0 ? (commonWords / totalUnique) * 10 : 0;
    
    // Bonus for phrase matches (2+ word sequences)
    let phraseBonus = 0;
    const activityPhrases = this.extractPhrases(activityLower);
    const kraPhrases = this.extractPhrases(kraLower);
    
    for (const phrase of activityPhrases) {
      if (kraLower.includes(phrase)) {
        phraseBonus += 3; // Phrases are worth more
      }
    }
    
    return jaccardScore + phraseBonus;
  }
  
  /**
   * Extract meaningful phrases from text (2-3 word sequences)
   */
  private extractPhrases(text: string): string[] {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const phrases: string[] = [];
    
    for (let i = 0; i < words.length - 1; i++) {
      phrases.push(words.slice(i, i + 2).join(' '));
      if (i < words.length - 2) {
        phrases.push(words.slice(i, i + 3).join(' '));
      }
    }
    
    return phrases;
  }

  /**
   * Validate and fix KRA assignments based on activity type matching rules
   * Post-processes LLM output to enforce strict type-to-KRA mapping
   */
  private validateAndFixActivityKRAMatches(activities: any[], strategicPlan: any): any[] {
    const correctedActivities = activities.map(activity => {
      const activityName = activity.name.toLowerCase();
      const currentKraId = activity.kraId;
      
      // Enrich all activities with KRA and KPI titles from strategic plan
      const enrichActivity = (act: any, kraIdToEnrich: string, initiativeId?: string): any => {
        const strategicPlanKras = (strategicPlan && strategicPlan.kras) || [];
        // Use normalized KRA ID for consistent lookup
        const normalizedKraIdToEnrich = normalizeKraId(kraIdToEnrich);
        const kra = strategicPlanKras.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraIdToEnrich);
        
        const enrichedData: any = { ...act };
        
        if (kra) {
          enrichedData.kraTitle = kra.kra_title || kraIdToEnrich;
          
          // If we have an initiativeId, find the matching initiative
          if (initiativeId && kra.initiatives) {
            const initiative = kra.initiatives.find((init: any) => init.id === initiativeId);
            if (initiative) {
              enrichedData.kpiTitle = initiative.key_performance_indicator?.outputs || initiativeId;
            }
          }
        }
        
        return enrichedData;
      };
      
      // Enhanced Activity type detection with semantic understanding
      const detectionScores = {
        training: this.calculateTypeScore(activityName, ['train', 'seminar', 'workshop', 'course', 'capacity', 'upskill', 'certification', 'program'], ['training', 'seminar', 'workshop']),
        curriculum: this.calculateTypeScore(activityName, ['curriculum', 'course content', 'syllabus', 'learning material', 'instructional'], ['curriculum', 'syllabus']),
        digital: this.calculateTypeScore(activityName, ['digital', 'system', 'platform', 'portal', 'infrastructure', 'technology', 'e-', 'cyber', 'electronic'], ['digital', 'portal', 'platform']),
        research: this.calculateTypeScore(activityName, ['research', 'study', 'publication', 'paper', 'journal', 'investigation', 'scholarly'], ['research', 'publication', 'journal']),
        extension: this.calculateTypeScore(activityName, ['extension', 'outreach', 'community service', 'outreach', 'engagement', 'partnership'], ['extension', 'outreach']),
      };
      
      let expectedKraTypes: string[] = [];
      let primaryType = '';
      
      // Determine expected KRA type based on highest scoring type
      const sortedTypes = Object.entries(detectionScores).sort(([,a], [,b]) => b - a);
      const [topType, topScore] = sortedTypes[0];
      
      if (topScore > 0) {
        primaryType = topType;
        
        if (topType === 'training') {
          expectedKraTypes = ['KRA 13', 'KRA 11']; // HR Development/Capacity Building
        } else if (topType === 'curriculum') {
          expectedKraTypes = ['KRA 1', 'KRA 13']; // Curriculum/Program Development
        } else if (topType === 'digital') {
          expectedKraTypes = ['KRA 17', 'KRA 4', 'KRA 5']; // Digital Transformation/Innovation
        } else if (topType === 'research') {
          expectedKraTypes = ['KRA 3', 'KRA 4', 'KRA 5']; // Research & Development KRAs
        } else if (topType === 'extension') {
          expectedKraTypes = ['KRA 6', 'KRA 7']; // Extension & Community Service
        }
      }
      
      // Check if current KRA matches expected type
      const isCorrectType = expectedKraTypes.length === 0 || expectedKraTypes.includes(currentKraId);
      
      if (!isCorrectType && expectedKraTypes.length > 0) {
        console.log(`[QPRO VALIDATION] Activity "${activity.name}" was matched to ${currentKraId} but expected type is ${expectedKraTypes.join(' or ')}`);
        console.log(`  Activity type detected: ${primaryType} (score=${topScore.toFixed(2)}) | Full scores: training=${detectionScores.training.toFixed(2)}, curriculum=${detectionScores.curriculum.toFixed(2)}, digital=${detectionScores.digital.toFixed(2)}, research=${detectionScores.research.toFixed(2)}`);
        
        // Reassign to correct KRA using semantic matching
        const strategicPlanKras = (strategicPlan && strategicPlan.kras) || [];
        const targetKra = strategicPlanKras.find((kra: any) => expectedKraTypes.includes(kra.kra_id));
        
        if (targetKra && targetKra.initiatives && targetKra.initiatives.length > 0) {
          // Find best-fit initiative/KPI within the target KRA using semantic similarity
          let bestInitiative = targetKra.initiatives[0];
          let bestScore = 0;
          
          targetKra.initiatives.forEach((initiative: any) => {
            const kraText = [
              targetKra.kra_title,
              initiative.key_performance_indicator?.outputs || '',
              Array.isArray(initiative.strategies) ? initiative.strategies.join(' ') : '',
              Array.isArray(initiative.programs_activities) ? initiative.programs_activities.join(' ') : ''
            ].join(' ').toLowerCase();
            
            // Semantic similarity: score based on content overlap and context
            const score = this.calculateSemanticScore(activityName, kraText);
            
            if (score > bestScore) {
              bestScore = score;
              bestInitiative = initiative;
            }
          });
          
          // Extract target from timeline_data
          let targetValue = 1;
          if (bestInitiative.targets && bestInitiative.targets.timeline_data) {
            const timelineData = bestInitiative.targets.timeline_data.find((t: any) => t.year === 2025);
            if (timelineData) {
              targetValue = typeof timelineData.target_value === 'number' ? timelineData.target_value : 1;
            }
          }
          
          // Calculate confidence: combine type detection score + semantic match score
          const typeConfidence = Math.min(1.0, topScore / 2); // Type detection contributes up to 0.5
          const semanticConfidence = Math.min(0.5, bestScore / 10); // Semantic match contributes up to 0.5
          const newConfidence = Math.min(0.95, Math.max(0.55, typeConfidence + semanticConfidence));
          
          // Extract KPI title from the initiative
          const kpiTitle = bestInitiative.key_performance_indicator?.outputs || bestInitiative.id || '';
          
          console.log(`  ✓ Reassigned to ${targetKra.kra_id} (${bestInitiative.id}) with target=${targetValue}, confidence=${newConfidence.toFixed(2)} (type=${typeConfidence.toFixed(2)} + semantic=${semanticConfidence.toFixed(2)})`);
          
          const reportedValue = activity.reported || 0;
          const achievementPercent = targetValue > 0 ? (reportedValue / targetValue) * 100 : 0;
          
          return {
            ...activity,
            kraId: targetKra.kra_id,
            kraTitle: targetKra.kra_title || targetKra.kra_id,
            initiativeId: bestInitiative.id,
            kpiTitle: kpiTitle,
            target: targetValue,
            confidence: newConfidence,
            achievement: achievementPercent,
            status: achievementPercent >= 100 ? 'MET' : achievementPercent > 0 ? 'PARTIAL' : 'NOT_STARTED'
          };
        }
      }
      
      // Helper function to check if initiativeId is a valid KPI format (e.g., "KRA3-KPI5")
      const isValidKpiId = (id: string | undefined): boolean => {
        if (!id) return false;
        // Valid formats: "KRA1-KPI1", "KRA 3-KPI 5", etc.
        return /^KRA\s?\d+[\s-]KPI\s?\d+$/i.test(id.trim());
      };
      
      // Helper function to find best-fit KPI for an activity within its KRA
      const findBestKpi = (act: any, targetKraId: string): { initiativeId: string; kpiTitle: string; target: number } | null => {
        const strategicPlanKras = (strategicPlan && strategicPlan.kras) || [];
        const normalizedTargetKraId = normalizeKraId(targetKraId);
        const targetKra = strategicPlanKras.find((kra: any) => normalizeKraId(kra.kra_id) === normalizedTargetKraId);
        
        if (!targetKra?.initiatives?.length) return null;
        
        let bestInitiative = targetKra.initiatives[0];
        let bestScore = 0;
        const actName = (act.name || '').toLowerCase();
        
        targetKra.initiatives.forEach((initiative: any) => {
          const kraText = [
            targetKra.kra_title,
            initiative.key_performance_indicator?.outputs || '',
            initiative.key_performance_indicator?.outcomes || '',
            Array.isArray(initiative.strategies) ? initiative.strategies.join(' ') : '',
            Array.isArray(initiative.programs_activities) ? initiative.programs_activities.join(' ') : ''
          ].join(' ').toLowerCase();
          
          const score = this.calculateSemanticScore(actName, kraText);
          if (score > bestScore) {
            bestScore = score;
            bestInitiative = initiative;
          }
        });
        
        let targetValue = 1;
        if (bestInitiative.targets?.timeline_data) {
          const timelineData = bestInitiative.targets.timeline_data.find((t: any) => t.year === 2025);
          if (timelineData) {
            targetValue = typeof timelineData.target_value === 'number' ? timelineData.target_value : 1;
          }
        }
        
        return {
          initiativeId: bestInitiative.id,
          kpiTitle: bestInitiative.key_performance_indicator?.outputs || bestInitiative.id || '',
          target: targetValue
        };
      };
      
      // If activity is already classified, enrich with KRA/KPI titles
      // BUT also validate that initiativeId is a proper KPI format
      if (currentKraId && currentKraId !== 'UNCLASSIFIED') {
        // Check if initiativeId is valid KPI format
        if (!isValidKpiId(activity.initiativeId)) {
          console.log(`[QPRO VALIDATION] Activity "${activity.name}" has invalid initiativeId "${activity.initiativeId}" - finding best KPI match`);
          
          const bestKpi = findBestKpi(activity, currentKraId);
          if (bestKpi) {
            console.log(`  ✓ Auto-assigned to KPI: ${bestKpi.initiativeId}`);
            return {
              ...enrichActivity(activity, currentKraId, bestKpi.initiativeId),
              initiativeId: bestKpi.initiativeId,
              kpiTitle: bestKpi.kpiTitle,
              target: bestKpi.target
            };
          }
        }
        
        return enrichActivity(activity, currentKraId, activity.initiativeId);
      }
      
      return activity;
    });
    
    return correctedActivities;
  }

  async createQPROAnalysis(input: QPROAnalysisInput): Promise<any> {
    try {
      console.log('[QPROAnalysisService] Creating analysis for document:', input.documentId);
      
      // Step 1: Get file buffer from blob storage
      console.log('[QPROAnalysisService] Downloading file from blob storage:', input.documentPath);
      let fileBuffer: Buffer;
      try {
        fileBuffer = await this.getFileBuffer(input.documentPath);
        console.log('[QPROAnalysisService] File downloaded successfully, size:', fileBuffer.length, 'bytes');
      } catch (blobError) {
        console.error('[QPROAnalysisService] Failed to download file:', blobError);
        throw new Error(`Failed to download file from blob storage: ${blobError instanceof Error ? blobError.message : String(blobError)}`);
      }
      
      // Step 2: Process with analysis engine
      console.log('[QPROAnalysisService] Starting PDF/DOCX analysis...');
      let analysisOutput: QPROAnalysisOutput;
      try {
        analysisOutput = await analysisEngineService.processQPRO(
          fileBuffer,
          input.documentType,
          input.unitId || undefined,
          input.year || 2025,
          true // skipPrescriptive: defer insight generation to the review step
        );
        console.log('[QPROAnalysisService] Analysis complete, extracted activities:', analysisOutput.activities?.length || 0);
      } catch (analysisError) {
        console.error('[QPROAnalysisService] Analysis engine failed:', analysisError);
        throw new Error(`Text extraction and analysis failed: ${analysisError instanceof Error ? analysisError.message : String(analysisError)}`);
      }
      
      // Load strategic plan for validation
      console.log('[QPROAnalysisService] Loading strategic plan for validation...');
      const strategicPlan = await this.loadStrategicPlan();
      
      // Post-LLM validation: fix any KRA assignments that violate type rules
      let validatedActivities = analysisOutput.activities || [];
      if (strategicPlan && strategicPlan.kras) {
        validatedActivities = this.validateAndFixActivityKRAMatches(validatedActivities, strategicPlan);
      }
      
      // Rebuild KRA summaries with corrected activities
      const correctedKras = (analysisOutput.kras || []).map((kra: any) => ({
        ...kra,
        activities: validatedActivities.filter((act: any) => act.kraId === kra.kraId)
      }));
      
      // Extract structured data from validated output
      const {
        alignment,
        opportunities,
        gaps,
        recommendations,
        overallAchievement,
        documentInsight,
        prescriptiveItems
      } = analysisOutput;

      const buildDocumentLevelAnalysis = (activities: any[], plan: any, year: number) => {
        const allKRAs = plan?.kras || [];

        // normalizeKraId is imported from qpro-aggregation.ts

        const getInitiative = (kraId: string, initiativeId: string) => {
          const normalizedKraIdVal = normalizeKraId(kraId);
          const kra = allKRAs.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraIdVal);
          if (!kra?.initiatives) return null;
          const normalizedId = String(initiativeId).replace(/\s+/g, '');
          let initiative = kra.initiatives.find((i: any) => String(i.id).replace(/\s+/g, '') === normalizedId);
          if (!initiative) {
            const kpiMatch = String(initiativeId).match(/KPI(\d+)/i);
            if (kpiMatch) {
              initiative = kra.initiatives.find((i: any) => String(i.id).includes(`KPI${kpiMatch[1]}`));
            }
          }
          return initiative || null;
        };

        const formatNumber = (n: number, digits: number = 2) => {
          if (!Number.isFinite(n)) return '0';
          return n.toFixed(digits);
        };

        // Group by KRA + initiative (KPI)
        const groups = new Map<string, {
          kraId: string;
          initiativeId: string;
          title: string;
          type: string | null;
          targetScope: 'INSTITUTIONAL' | 'PER_UNIT';
          targetValue: number | null;
          reported: number[];
          missed: number;
          met: number;
        }>();
        for (const act of activities) {
          const kraId = String(act.kraId || act.kra_id || '').trim();
          const initiativeId = String(act.initiativeId || act.initiative_id || '').trim();
          if (!kraId || !initiativeId) continue;

          const key = `${kraId}::${initiativeId}`;
          if (!groups.has(key)) {
            const initiative = getInitiative(kraId, initiativeId);
            const type = initiative?.targets?.type ? String(initiative.targets.type) : null;
            const title = initiative?.key_performance_indicator?.outputs
              ? String(initiative.key_performance_indicator.outputs)
              : initiativeId;

            const meta = getInitiativeTargetMeta(plan, kraId, initiativeId, year);

            // Fallback: if plan lookup fails, fall back to the first activity target (NOT sum)
            const fallbackTarget = (typeof act.target === 'number' ? act.target : Number(act.target));
            const targetValue = meta.targetValue ?? (Number.isFinite(fallbackTarget) && fallbackTarget > 0 ? fallbackTarget : null);

            groups.set(key, {
              kraId,
              initiativeId,
              title,
              type: (meta.targetType ? String(meta.targetType) : type),
              targetScope: meta.targetScope,
              targetValue,
              reported: [],
              missed: 0,
              met: 0,
            });
          }

          const g = groups.get(key)!;
          const reportedNum = typeof act.reported === 'number' ? act.reported : Number(act.reported);
          if (Number.isFinite(reportedNum)) g.reported.push(reportedNum);

          // IMPORTANT: For count-based institutional targets, each extracted item is not a "miss".
          // The pass/fail is computed at KPI (initiative) level; here we only track extraction volume.
          // Keep legacy counters but base them on per-activity completion, not target achievement.
          if (Number.isFinite(reportedNum) && reportedNum > 0) g.met += 1;
          else g.missed += 1;
        }

        const groupSummaries: Array<{
          kraId: string;
          initiativeId: string;
          title: string;
          type: string | null;
          target: number | null;
          actual: number | null;
          achievementPercent: number | null;
          met: number;
          missed: number;
        }> = [];

        groups.forEach((g) => {
          if (g.targetValue === null || !Number.isFinite(g.targetValue) || g.targetValue <= 0) {
            groupSummaries.push({
              kraId: g.kraId,
              initiativeId: g.initiativeId,
              title: g.title,
              type: g.type,
              target: null,
              actual: null,
              achievementPercent: null,
              met: g.met,
              missed: g.missed,
            });
            return;
          }

          const aggregated = computeAggregatedAchievement({
            targetType: g.type,
            targetValue: g.targetValue,
            targetScope: g.targetScope,
            activities: g.reported.map((r) => ({ reported: r })),
          });

          const target = aggregated.totalTarget;
          const actual = aggregated.totalReported;
          const achievementPercent = aggregated.achievementPercent;

          groupSummaries.push({
            kraId: g.kraId,
            initiativeId: g.initiativeId,
            title: g.title,
            type: g.type,
            target,
            actual,
            achievementPercent,
            met: g.met,
            missed: g.missed,
          });
        });

        // Root-cause notes (if any)
        const rootCauseNotes = Array.from(
          new Set(
            activities
              .map((a: any) => (typeof a.rootCause === 'string' ? a.rootCause.trim() : ''))
              .filter((s: string) => s.length > 0)
          )
        );

        const kraIds = Array.from(new Set(activities.map((a: any) => a.kraId).filter(Boolean)));
        const initiativeIds = Array.from(new Set(activities.map((a: any) => a.initiativeId).filter(Boolean)));

        // Document Insight: factual interpretation only (no recommendations)
        const topUnderperforming = groupSummaries
          .filter((g) => typeof g.achievementPercent === 'number')
          .sort((a, b) => (a.achievementPercent ?? 0) - (b.achievementPercent ?? 0))
          .slice(0, 5);

        const computedOverall = (() => {
          const vals = groupSummaries
            .map((g) => (typeof g.achievementPercent === 'number' ? g.achievementPercent : null))
            .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
          if (vals.length === 0) return 0;
          return vals.reduce((s, n) => s + n, 0) / vals.length;
        })();

        const insightLines: string[] = [];
        insightLines.push('### Summary');
        insightLines.push(`- Reporting period: ${year}`);
        insightLines.push(`- Activities extracted: ${activities.length}`);
        insightLines.push(`- KRAs covered: ${kraIds.length}`);
        insightLines.push(`- KPIs covered: ${initiativeIds.length}`);
        insightLines.push(`- Overall achievement score: ${formatNumber(computedOverall, 2)}%`);

        if (topUnderperforming.length > 0) {
          insightLines.push('');
          insightLines.push('### Key performance signals');
          topUnderperforming.forEach((g) => {
            const isRate = g.type === 'percentage';
            const suffix = isRate ? '%' : '';
            const targetStr = g.target === null ? 'N/A' : `${formatNumber(g.target, 2)}${suffix}`;
            const actualStr = g.actual === null ? 'N/A' : `${formatNumber(g.actual, 2)}${suffix}`;
            const achStr = g.achievementPercent === null ? 'N/A' : `${formatNumber(g.achievementPercent, 1)}% of target`;
            insightLines.push(`- ${g.kraId} / ${g.initiativeId}: Reported ${actualStr} vs Target ${targetStr} (${achStr})`);
          });
        }

        if (rootCauseNotes.length > 0) {
          insightLines.push('');
          insightLines.push('### Observed contributing factors (from extracted notes)');
          rootCauseNotes.slice(0, 5).forEach((note) => insightLines.push(`- ${note}`));
        }

        const documentInsight = insightLines.join('\n');

        // Prescriptive Analysis: actionable steps (imperative verbs + timeframes)
        let prescriptiveLines: string[] = [];
        prescriptiveLines.push('### Prescriptive analysis');
        prescriptiveLines.push('- Conduct a focused review of the lowest-performing KPI areas within 2–4 weeks.');
        prescriptiveLines.push('- Define measurable corrective actions per KPI and assign owners within 1 month.');
        prescriptiveLines.push('- Establish a monthly monitoring cadence to track movement versus target.');
        prescriptiveLines.push('- Validate that reported values match the KPI target type (percentage vs count) before final submission each quarter.');

        // Deduplicate prescriptive sections (e.g., Address the primary performance gap, Data quality review)
        // If these sections are generated elsewhere and pushed into prescriptiveLines, deduplicate here:
        prescriptiveLines = prescriptiveLines.filter((line, idx, arr) =>
          arr.findIndex(l => l.trim().toLowerCase() === line.trim().toLowerCase()) === idx
        );

        const prescriptiveAnalysis = prescriptiveLines.join('\n');

        return {
          documentInsight,
          prescriptiveAnalysis,
          summary: {
            year,
            activities: activities.length,
            kras: kraIds.length,
            kpis: initiativeIds.length,
            overallAchievement: computedOverall,
          },
        };
      };
      
      // Create full analysis result text for reference
      const analysisResult = this.formatAnalysisForStorage({
        ...analysisOutput,
        activities: validatedActivities,
        kras: correctedKras
      });

      const reportYear = input.year || 2025;
      const docLevelFallback = buildDocumentLevelAnalysis(validatedActivities, strategicPlan, reportYear);

      const formatPrescriptiveItemsAsText = (
        items: Array<{ title: string; issue: string; action: string; nextStep?: string }>
      ) => {
        return items
          .filter((x) => x && typeof x.title === 'string' && typeof x.issue === 'string' && typeof x.action === 'string')
          .slice(0, 5)
          .map((x, idx) => {
            const lines = [
              `${idx + 1}. ${x.title.trim()}`,
              `- Issue: ${x.issue.trim()}`,
              `- Action: ${x.action.trim()}`,
            ];
            if (x.nextStep && x.nextStep.trim()) {
              lines.push(`- Next Step: ${x.nextStep.trim()}`);
            }
            return lines.join('\n');
          })
          .join('\n\n');
      };

      const llmDocumentInsight = typeof documentInsight === 'string' ? documentInsight.trim() : '';
      const llmPrescriptiveItems = Array.isArray(prescriptiveItems)
        ? (prescriptiveItems as any[])
            .filter((x) => x && typeof x === 'object')
            .slice(0, 5)
            .map((x) => ({
              title: String(x.title || '').trim(),
              issue: String(x.issue || '').trim(),
              action: String(x.action || '').trim(),
              nextStep: x.nextStep ? String(x.nextStep).trim() : undefined,
            }))
            .filter((x) => x.title && x.issue && x.action)
        : [];
      const llmPrescriptiveText = llmPrescriptiveItems.length > 0
        ? formatPrescriptiveItemsAsText(llmPrescriptiveItems)
        : '';

      const insightsGenerated = analysisOutput.insightsGenerated !== false;

      const docLevel = {
        documentInsight: insightsGenerated ? (llmDocumentInsight || docLevelFallback.documentInsight) : '',
        prescriptiveAnalysis: insightsGenerated ? (llmPrescriptiveText || docLevelFallback.prescriptiveAnalysis) : '',
        prescriptiveItems: insightsGenerated ? (llmPrescriptiveItems.length > 0 ? llmPrescriptiveItems : undefined) : [],
        summary: {
          ...docLevelFallback.summary,
          year: reportYear,
          overallAchievement: Number.isFinite(overallAchievement) ? overallAchievement : docLevelFallback.summary.overallAchievement,
        },
      };
      
      // Create the QPRO analysis record in the database with DRAFT status
      // Activities are staged and not committed to live dashboard until approved
      const qproAnalysis = await prisma.qPROAnalysis.create({
        data: {
          documentId: input.documentId,
          documentTitle: input.documentTitle,
          documentPath: input.documentPath,
          documentType: input.documentType,
          analysisResult,
          // Keep these fields for backward compatibility, but ensure they remain factual (no recommendations bleeding into insight).
          alignment: insightsGenerated ? (docLevel.documentInsight || toString(alignment) || 'Analysis completed') : 'Pending - insights will be generated after KRA/KPI review',
          opportunities: '',
          gaps: '',
          recommendations: insightsGenerated ? (docLevel.prescriptiveAnalysis || toString(recommendations)) : '',
          kras: correctedKras as any,
          activities: validatedActivities as any,
          achievementScore: docLevel.summary.overallAchievement,
          prescriptiveAnalysis: {
            documentInsight: docLevel.documentInsight,
            prescriptiveAnalysis: docLevel.prescriptiveAnalysis,
            prescriptiveItems: docLevel.prescriptiveItems,
            summary: docLevel.summary,
            generatedAt: insightsGenerated ? new Date().toISOString() : null,
            source: insightsGenerated ? 'analysis-engine' : 'pending',
          } as any,
          status: 'DRAFT', // Staging workflow: start as DRAFT
          uploadedById: input.uploadedById,
          unitId: input.unitId,
          year: reportYear,
          quarter: input.quarter || 1,
        },
        include: {
          document: true,
          user: true,
          unit: true
        }
      });

      // Create staged AggregationActivity records (not linked to live aggregation yet)
      // These will be committed to the live dashboard only after approval
      try {
        for (const activity of validatedActivities) {
          if (activity.kraId && activity.initiativeId) {
            console.log(`[QPROAnalysisService] Creating staged activity: ${activity.name}`);
            console.log(`  kraId: ${activity.kraId}, initiativeId: ${activity.initiativeId}`);
            
            await prisma.aggregationActivity.create({
              data: {
                // aggregation_id is NULL for DRAFT - will be linked on approval
                aggregation_id: null,
                qpro_analysis_id: qproAnalysis.id,
                unit_id: toPrisma(input.unitId),
                activity_name: activity.name || 'Unknown Activity',
                reported: activity.reported ?? 0,
                target: activity.target ?? 0,
                achievement: activity.achievement ?? 0,
                activity_type: activity.dataType || 'count',
                initiative_id: activity.initiativeId,
                evidenceSnippet: toPrisma(activity.evidenceSnippet),
                confidenceScore: toPrisma(activity.confidence),
                suggestedStatus: toPrisma(activity.suggestedStatus || activity.status),
                dataType: toPrisma(activity.dataType),
                prescriptiveNote: toPrisma(activity.prescriptiveAnalysis),
                isApproved: false // Staged, not approved yet
              }
            });
          }
        }
        console.log('[QPROAnalysisService] Created', validatedActivities.length, 'staged activities for review');
      } catch (stagingError) {
        console.error('Error creating staged activities:', stagingError);
        // Log but don't throw - staging errors shouldn't prevent QPRO analysis from being saved
      }

      // NOTE: We no longer directly upsert to KRAggregation table here
      // That happens in the approval endpoint after user review

      return qproAnalysis;
    } catch (error) {
      console.error('========== ERROR IN QPRO ANALYSIS ==========');
      console.error('Error type:', error instanceof Error ? error.constructor.name : typeof error);
      console.error('Error message:', error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) {
        console.error('Stack trace:', error.stack);
      }
      console.error('==========================================');
      throw error;
    }
  }

  async getQPROAnalysisById(id: string) {
    try {
      const analysis = await prisma.qPROAnalysis.findUnique({
        where: { id },
        include: {
          document: {
            select: {
              title: true,
              fileName: true,
              fileType: true,
              fileUrl: true
            }
          },
          user: {
            select: {
              name: true,
              email: true
            }
          }
        }
      });
      
      return analysis;
    } catch (error) {
      console.error('Error fetching QPRO analysis:', error);
      throw error;
    }
  }

  async getQPROAnalysesByUser(userId: string) {
    try {
      const analyses = await prisma.qPROAnalysis.findMany({
        where: { uploadedById: userId },
        orderBy: { createdAt: 'desc' },
        include: {
          document: {
            select: {
              title: true,
              fileName: true
            }
          }
        }
      });
      
      return analyses;
    } catch (error) {
      console.error('Error fetching QPRO analyses for user:', error);
      throw error;
    }
  }

  async getQPROAnalysesByDocument(documentId: string) {
    try {
      const analyses = await prisma.qPROAnalysis.findMany({
        where: { documentId },
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              name: true
            }
          }
        }
      });
      
      return analyses;
    } catch (error) {
      console.error('Error fetching QPRO analyses for document:', error);
      throw error;
    }
  }

  async getQPROAnalyses(filter: QPROAnalysesFilter) {
    try {
      const whereClause: any = {};
      
      if (filter.unitId) {
        whereClause.unitId = filter.unitId;
      }
      
      if (filter.year !== undefined) {
        whereClause.year = filter.year;
      }
      
      if (filter.quarter !== undefined) {
        whereClause.quarter = filter.quarter;
      }
      
      if (filter.userId) {
        whereClause.uploadedById = filter.userId;
      }
      
      const analyses = await prisma.qPROAnalysis.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        take: filter.limit,
        include: {
          document: {
            select: {
              title: true,
              fileName: true,
              fileType: true
            }
          },
          user: {
            select: {
              name: true,
              email: true
            }
          },
          unit: {
            select: {
              name: true,
              code: true
            }
          }
        }
      });
      
      return analyses;
    } catch (error) {
      console.error('Error fetching QPRO analyses:', error);
      throw error;
    }
  }

  private async getFileBuffer(blobPath: string): Promise<Buffer> {
    try {
      // Get the blob from the QPRO-specific container
      const containerName = 'qpro-files';
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobPath);
      
      // Download the blob content
      const downloadResponse = await blobClient.download();
      
      // Read the stream into a buffer
      const buffer = await this.streamToBuffer(downloadResponse.readableStreamBody!);
      
      return buffer;
    } catch (error) {
      console.error(`Error downloading blob from path ${blobPath}:`, error);
      throw error;
    }
  }

 private async streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      
      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      
      stream.on('error', reject);
      
      stream.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });
  }

  /**
   * Format structured analysis output into readable text for storage
   */
  private formatAnalysisForStorage(analysis: QPROAnalysisOutput): string {
    const sections = [
      '# QPRO Analysis Report',
      '',
      `## Overall Achievement Score: ${(analysis.overallAchievement || 0).toFixed(2)}%`,
      '',
      '## Strategic Alignment',
      analysis.alignment || 'N/A',
      '',
      '## Opportunities',
      analysis.opportunities || 'N/A',
      '',
      '## Gaps Identified',
      analysis.gaps || 'N/A',
      '',
      '## Recommendations',
      analysis.recommendations || 'N/A',
      '',
      '## KRA Summary',
      ...(analysis.kras || []).map((kra: any) => `
### ${kra.kraId}: ${kra.kraTitle}
**Achievement Rate:** ${(kra.achievementRate || 0).toFixed(2)}%
**Activities:** ${(kra.activities || []).length}
**Alignment:** ${kra.strategicAlignment || 'N/A'}
`),
      '',
      '## Detailed Activities',
      ...(analysis.activities || []).map((activity: any) => `
- **${activity.name}**
  - KRA: ${activity.kraId || 'N/A'}
  - Target: ${activity.target || 0}, Reported: ${activity.reported || 0}
  - Achievement: ${(activity.achievement || 0).toFixed(2)}%
  - Confidence: ${((activity.confidence || 0) * 100).toFixed(0)}%
  - Unit: ${activity.unit || 'N/A'}
`)
    ];
    
    return sections.join('\n');
  }

  /**
   * Load strategic plan JSON for validation
   */
  private async loadStrategicPlan(): Promise<any> {
    try {
      // Import strategic plan JSON (works in Node.js context)
      const strategicPlan = await import('@/lib/data/strategic_plan.json').then(m => m.default).catch(() => null);
      return strategicPlan;
    } catch (error) {
      console.error('Error loading strategic plan:', error);
      return null;
    }
  }
}

export const qproAnalysisService = new QPROAnalysisService();