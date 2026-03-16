import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { computeAggregatedAchievement, getInitiativeTargetMeta, normalizeKraId, normalizeInitiativeId } from '@/lib/utils/qpro-aggregation';
import { qproCacheService } from '@/lib/services/qpro-cache-service';
import { getKpiTypeCategory, getGapInterpretation, generateTypeSpecificLogicInstruction, inferDomainContext, buildContextAwarePromptEnrichment, generateContextAwareRecommendation } from '@/lib/utils/kpi-type-logic';

interface ActivityToRegenerate {
  name: string;
  kraId: string;
  initiativeId: string;
  reported: number;
  target: number;
  achievement: number;
  status: 'MET' | 'MISSED' | 'EXCEEDED';
  index: number;
  targetType?: string;
  aiInsight?: string;
  prescriptiveAnalysis?: string;
  dataType?: string;
  evidenceSnippet?: string;
  confidenceScore?: number;
}

/**
 * Helper function to find the target value from strategic plan based on KRA, KPI, and year
 */
function findTargetFromStrategicPlan(
  strategicPlan: any,
  kraId: string,
  initiativeId: string,
  year: number
): { target: number | null; targetType: string } {
  const kras = strategicPlan.kras || [];
  
  // Find the KRA using normalized ID for consistent lookup
  const normalizedKraIdVal = normalizeKraId(kraId);
  const kra = kras.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraIdVal);
  if (!kra) {
    console.log(`[findTargetFromStrategicPlan] KRA not found: ${kraId}`);
    return { target: null, targetType: 'unknown' };
  }
  
  console.log(`[findTargetFromStrategicPlan] Found KRA: ${kraId}, looking for initiative: ${initiativeId}`);
  console.log(`[findTargetFromStrategicPlan] Available initiatives:`, kra.initiatives?.map((i: any) => i.id));
  
  // Find the initiative/KPI within the KRA - try multiple formats
  let initiative = kra.initiatives?.find((i: any) => i.id === initiativeId);
  
  // If not found, try alternative formats (e.g., "KRA3-KPI5" vs "KRA 3-KPI5")
  if (!initiative && initiativeId) {
    // Normalize the initiative ID by removing spaces
    const normalizedId = initiativeId.replace(/\s+/g, '');
    initiative = kra.initiatives?.find((i: any) => 
      i.id.replace(/\s+/g, '') === normalizedId
    );
    
    // Also try matching just by KPI number if still not found
    if (!initiative) {
      const kpiMatch = initiativeId.match(/KPI(\d+)/i);
      if (kpiMatch) {
        const kpiNumber = kpiMatch[1];
        initiative = kra.initiatives?.find((i: any) => i.id.includes(`KPI${kpiNumber}`));
      }
    }
  }
  
  if (!initiative || !initiative.targets) {
    console.log(`[findTargetFromStrategicPlan] Initiative not found: ${initiativeId}`);
    return { target: null, targetType: 'unknown' };
  }
  
  console.log(`[findTargetFromStrategicPlan] Found initiative: ${initiative.id}`);
  
  const targetType = initiative.targets.type || 'percentage';
  const timelineData = initiative.targets.timeline_data || [];
  
  // Find the target for the specific year
  const yearTarget = timelineData.find((t: any) => t.year === year);
  if (yearTarget && typeof yearTarget.target_value === 'number') {
    console.log(`[findTargetFromStrategicPlan] Found target for year ${year}: ${yearTarget.target_value}`);
    return { target: yearTarget.target_value, targetType };
  }
  
  // If no exact year match, try to find the closest year or default
  const numericTargets = timelineData.filter((t: any) => typeof t.target_value === 'number');
  if (numericTargets.length > 0) {
    // Get the most recent target before or on the year
    const validTargets = numericTargets.filter((t: any) => t.year <= year);
    if (validTargets.length > 0) {
      const target = validTargets[validTargets.length - 1].target_value;
      console.log(`[findTargetFromStrategicPlan] Using closest target: ${target}`);
      return { target, targetType };
    }
    // Otherwise use the first available target
    const target = numericTargets[0].target_value;
    console.log(`[findTargetFromStrategicPlan] Using first available target: ${target}`);
    return { target, targetType };
  }
  
  console.log(`[findTargetFromStrategicPlan] No numeric target found for ${initiativeId}`);
  return { target: null, targetType };
}

/**
 * Calculate achievement and status based on reported and target values
 */
function calculateAchievementAndStatus(
  reported: number,
  target: number
): { achievement: number; status: 'MET' | 'MISSED' | 'EXCEEDED' } {
  if (target === 0) {
    return { achievement: 0, status: 'MISSED' };
  }
  
  const achievement = (reported / target) * 100;
  
  let status: 'MET' | 'MISSED' | 'EXCEEDED';
  if (achievement >= 100) {
    status = achievement > 100 ? 'EXCEEDED' : 'MET';
  } else {
    status = 'MISSED';
  }
  
  return { achievement, status };
}

/**
 * Helper function to intelligently match an activity to the best KPI within a KRA
 * Uses LLM to analyze activity description and find the most appropriate KPI
 */
async function matchActivityToKPI(
  llm: ChatOpenAI,
  activityName: string,
  activityDescription: string,
  kraId: string,
  kraTitle: string,
  kra: any,
  strategicPlan: any
): Promise<{ initiativeId: string; matchedKPI: any } | null> {
  try {
    if (!kra || !kra.initiatives || kra.initiatives.length === 0) {
      console.log(`[matchActivityToKPI] No initiatives found for KRA ${kraId}`);
      return null;
    }

    // Build a menu of available KPIs for this KRA
    const kpiMenu = kra.initiatives
      .map((initiative: any, idx: number) => {
        const description = initiative.description || initiative.kpi_title || '';
        const targetType = initiative.targets?.type || 'numeric';
        const targets = (initiative.targets?.timeline_data || [])
          .slice(-2)
          .map((t: any) => `Year ${t.year}: ${t.target_value}`)
          .join(', ');
        
        return `${idx + 1}. **${initiative.id}**: ${description}\n   Type: ${targetType}\n   Recent targets: ${targets}`;
      })
      .join('\n\n');

    const matchingPrompt = `
You are a strategic planning expert at a university. Your task is to match a reported activity to the MOST APPROPRIATE Key Performance Indicator (KPI) within a Key Result Area (KRA).

**Activity Being Matched:**
Name: ${activityName}
Description: ${activityDescription}

**Target KRA:**
${kraId}: ${kraTitle}

**Available KPIs within this KRA:**
${kpiMenu}

**Task:** 
Analyze the activity name and description. Determine which KPI BEST matches this activity based on:
1. Semantic similarity (does the activity description match the KPI description?)
2. Metric alignment (is the reported value consistent with what this KPI measures?)
3. Strategic fit (does this activity contribute to this KPI's objective?)

**Response Format (JSON):**
{
  "selectedKPINumber": <number 1-${kra.initiatives.length}>,
  "selectedKPIId": "<KPI ID>",
  "confidenceScore": <0.0-1.0>,
  "reason": "<brief explanation of why this KPI was selected>"
}

Select the BEST matching KPI. If none are good matches, still select the closest one.`;

    const messages = [
      new SystemMessage('You are a university performance analyst. Respond only with valid JSON.'),
      new HumanMessage(matchingPrompt),
    ];

    const response = await llm.invoke(messages);
    const responseText = response.content?.toString() || '';

    // Parse the JSON response
    let matchResult;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        matchResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.log(`[matchActivityToKPI] Failed to parse LLM response: ${responseText}`);
      // Fallback: return the first KPI
      return {
        initiativeId: kra.initiatives[0].id,
        matchedKPI: kra.initiatives[0],
      };
    }

    const selectedIndex = (matchResult.selectedKPINumber || 1) - 1;
    if (selectedIndex < 0 || selectedIndex >= kra.initiatives.length) {
      console.log(`[matchActivityToKPI] Invalid index ${selectedIndex}, using first KPI`);
      return {
        initiativeId: kra.initiatives[0].id,
        matchedKPI: kra.initiatives[0],
      };
    }

    const matchedKPI = kra.initiatives[selectedIndex];
    console.log(
      `[matchActivityToKPI] Matched activity "${activityName}" to KPI: ${matchedKPI.id} (confidence: ${matchResult.confidenceScore})`
    );
    console.log(`[matchActivityToKPI] Reason: ${matchResult.reason}`);

    return {
      initiativeId: matchedKPI.id,
      matchedKPI,
    };
  } catch (error) {
    console.error('[matchActivityToKPI] Error during KPI matching:', error);
    return null;
  }
}

/**
 * POST /api/qpro/regenerate-insights
 *
 * Regenerates KPI/target/achievement for activities with corrected KRAs
 * This endpoint:
 * 1. Takes activities with updated KRAs
 * 2. Uses LLM to intelligently match activities to best KPI within the new KRA
 * 3. Looks up the correct target from strategic plan for the matched KPI
 * 4. Recalculates achievement and status based on new target
 * 5. Generates ONE document-level insight + ONE prescriptive analysis (no per-activity AI blocks)
 * 6. Updates all related fields and saves to database
 * 7. Returns regenerated activities and updated document-level fields
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;

    const { user } = authResult;
    const { analysisId, activities, fullRegeneration } = await request.json();

    if (!analysisId || !activities || !Array.isArray(activities)) {
      return NextResponse.json(
        { error: 'Missing analysisId or activities' },
        { status: 400 }
      );
    }

    // Check permissions
    if (!['ADMIN', 'FACULTY', 'PERSONNEL'].includes(user.role)) {
      return NextResponse.json(
        { error: 'Insufficient permissions to regenerate insights' },
        { status: 403 }
      );
    }

    // Fetch the analysis
    const analysis = await prisma.qPROAnalysis.findUnique({
      where: { id: analysisId },
    });

    if (!analysis) {
      return NextResponse.json(
        { error: 'Analysis not found' },
        { status: 404 }
      );
    }

    // Get strategic plan for KRA context
    const strategicPlanJson = require('@/lib/data/strategic_plan.json');
    const allKRAs = strategicPlanJson.kras || [];
    const reportYear = analysis.year || 2025;

    // Initialize OpenAI LLMs — separate instances for different tasks
    // KPI matching needs short JSON output (~100-200 tokens) — 500 is adequate
    const matchingLlm = new ChatOpenAI({
      model: 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY,
      temperature: 0,
      maxTokens: 500,
    });

    // Prescriptive analysis needs rich JSON output (~600-1300 tokens)
    // Previous 500-token limit caused truncation -> JSON parse failure -> always fell back to hardcoded logic
    const prescriptiveLlm = new ChatOpenAI({
      model: 'gpt-4o-mini',
      apiKey: process.env.OPENAI_API_KEY,
      temperature: 0.2, // Low temp for structured JSON, slight creativity for insights
      maxTokens: 2000,
      modelKwargs: {
        response_format: { type: "json_object" },
      },
    });

    // Regenerate KPI/target/achievement for each activity (document-level insights only)
    const regeneratedActivities: ActivityToRegenerate[] = [];

    for (const activity of activities) {
      try {
        // Find the KRA in strategic plan using normalized ID
        const normalizedActivityKraId = normalizeKraId(activity.kraId);
        const kra = allKRAs.find((k: any) => normalizeKraId(k.kra_id) === normalizedActivityKraId);
        const kraTitle = kra?.kra_title || activity.kraId;

        if (!kra) {
          console.log(`[Regenerate] KRA not found: ${activity.kraId}`);
          regeneratedActivities.push({
            ...activity,
            aiInsight: null as any,
            prescriptiveAnalysis: null as any,
          });
          continue;
        }

        console.log(`[Regenerate] Processing activity: ${activity.name}`);
        console.log(`[Regenerate] Original KRA: ${activity.initiativeId}, New KRA: ${activity.kraId}`);

        // Check if a specific KPI/Initiative was explicitly selected by the user
        const userSelectedKPI = (activity as any).userSelectedKPI === true;
        let newInitiativeId = activity.initiativeId;

        // If user explicitly selected a KPI, use it
        if (userSelectedKPI) {
          console.log(`[Regenerate] Using user-selected KPI: ${newInitiativeId}`);
        } else {
          // Otherwise, use LLM to match the activity to the best KPI within the selected KRA
          const kpiMatch = await matchActivityToKPI(
            matchingLlm,
            activity.name,
            activity.description || activity.name,
            activity.kraId,
            kraTitle,
            kra,
            strategicPlanJson
          );

          if (kpiMatch) {
            newInitiativeId = kpiMatch.initiativeId;
            console.log(`[Regenerate] Matched to KPI: ${newInitiativeId}`);
          } else {
            console.log(`[Regenerate] Could not match to KPI, using first available for KRA`);
            // Fallback: use first KPI in the KRA
            if (kra.initiatives && kra.initiatives.length > 0) {
              newInitiativeId = kra.initiatives[0].id;
            }
          }
        }

        // Look up the correct target from the strategic plan using the matched KPI
        const { target: newTarget, targetType } = findTargetFromStrategicPlan(
          strategicPlanJson,
          activity.kraId,
          newInitiativeId,
          reportYear
        );

        console.log(`[Regenerate] Found target for ${activity.name}: ${newTarget} (type: ${targetType})`);

        // Use the new target if found, otherwise keep the original
        const finalTarget = newTarget !== null ? newTarget : activity.target;
        
        // Recalculate achievement and status based on the new target
        const { achievement: newAchievement, status: newStatus } = calculateAchievementAndStatus(
          activity.reported,
          finalTarget
        );

        console.log(`[Regenerate] Final target: ${finalTarget}, Achievement: ${newAchievement.toFixed(2)}%, Status: ${newStatus}`);

        const regeneratedActivity = {
          ...activity,
          kraId: activity.kraId,
          initiativeId: newInitiativeId,
          target: finalTarget,
          achievement: newAchievement,
          status: newStatus,
          targetType,
          // Requirement: document-level only (no per-activity AI insight/prescriptive analysis)
          aiInsight: null as any,
          prescriptiveAnalysis: null as any,
        };
        console.log(`[Regenerate] Pushing activity with target:`, regeneratedActivity.target);
        regeneratedActivities.push(regeneratedActivity);
      } catch (activityError) {
        console.error(`Error regenerating insights for activity: ${activity.name}`, activityError);
        // Still include the activity but with empty insights
        regeneratedActivities.push({
          ...activity,
          aiInsight: null as any,
          prescriptiveAnalysis: null as any,
        });
      }
    }

    // Save the updated activities with new KRAs, targets, achievements, and insights to the database
    const existingActivities = (analysis.activities as any[]) || [];

    // Merge regenerated insights into existing activities
    const updatedActivities = existingActivities.map((existingAct: any) => {
      const regeneratedAct = regeneratedActivities.find(
        (regen: any) => regen.name === existingAct.name || regen.index === existingAct.index
      );
      if (regeneratedAct) {
        return {
          ...existingAct,
          kraId: regeneratedAct.kraId,
          initiativeId: regeneratedAct.initiativeId,
          target: regeneratedAct.target,
          achievement: regeneratedAct.achievement,
          status: regeneratedAct.status,
          targetType: regeneratedAct.targetType,
          // Clear any legacy per-activity insight fields
          aiInsight: null,
          prescriptiveAnalysis: null,
        };
      }
      return existingAct;
    });

    // Recalculate overall achievement score at KPI-level (prevents averaging tiny per-item % for count KPIs)
    const year = Number((analysis as any).year ?? reportYear ?? 2025);
    const groups = new Map<string, { kraId: string; initiativeId: string; activities: any[] }>();
    for (const act of updatedActivities) {
      const kraId = String(act.kraId || '').trim();
      const initiativeId = String(act.initiativeId || '').trim();
      if (!kraId || !initiativeId) continue;

      const key = `${kraId}::${initiativeId}`;
      if (!groups.has(key)) {
        groups.set(key, { kraId, initiativeId, activities: [] });
      }
      groups.get(key)!.activities.push(act);
    }

    const kpiSummaries: Array<{ totalTarget: number; totalReported: number; achievementPercent: number; isRateMetric: boolean }> = [];
    for (const g of groups.values()) {
      const meta = getInitiativeTargetMeta({ kras: allKRAs } as any, g.kraId, g.initiativeId, year);

      const fallbackTarget = typeof g.activities?.[0]?.initiativeTarget === 'number'
        ? g.activities[0].initiativeTarget
        : (typeof g.activities?.[0]?.target === 'number' ? g.activities[0].target : Number(g.activities?.[0]?.target || 0));
      const targetValue = meta.targetValue ?? (Number.isFinite(fallbackTarget) && fallbackTarget > 0 ? fallbackTarget : 0);

      const aggregated = computeAggregatedAchievement({
        targetType: meta.targetType || g.activities?.[0]?.targetType,
        targetValue,
        targetScope: meta.targetScope,
        activities: g.activities,
      });

      const isRateMetric = String(meta.targetType || g.activities?.[0]?.targetType || '').toLowerCase() === 'percentage';
      kpiSummaries.push({
        totalTarget: aggregated.totalTarget,
        totalReported: aggregated.totalReported,
        achievementPercent: aggregated.achievementPercent,
        isRateMetric,
      });
    }

    const overallAchievementScore =
      kpiSummaries.length > 0
        ? (kpiSummaries.reduce((sum, k) => sum + (k.achievementPercent || 0), 0) / kpiSummaries.length)
        : 0;

    // Recalculate gaps for activities that missed their targets
    const gapsData: Record<string, { target: number; actual: number; gap: number }> = {};
    
    for (const act of updatedActivities) {
      if (act.status === 'MISSED' || (act.achievement && act.achievement < 100)) {
        const gapValue = act.target - act.reported;
        const gapPercentage = act.target > 0 ? ((act.target - act.reported) / act.target) * 100 : 0;
        gapsData[act.name] = {
          target: act.target,
          actual: act.reported,
          gap: gapPercentage,
        };
      }
    }

    // Add overall summary to gaps
    if (kpiSummaries.length > 0) {
      const allRate = kpiSummaries.every((k) => k.isRateMetric);
      const overallTarget = allRate
        ? (kpiSummaries.reduce((sum, k) => sum + (k.totalTarget || 0), 0) / kpiSummaries.length)
        : kpiSummaries.reduce((sum, k) => sum + (k.totalTarget || 0), 0);
      const overallActual = allRate
        ? (kpiSummaries.reduce((sum, k) => sum + (k.totalReported || 0), 0) / kpiSummaries.length)
        : kpiSummaries.reduce((sum, k) => sum + (k.totalReported || 0), 0);

      const overallGap = overallTarget > 0 ? ((overallTarget - overallActual) / overallTarget) * 100 : 0;
      gapsData['Overall Achievement'] = {
        target: overallTarget,
        actual: overallActual,
        gap: overallGap,
      };
    }

    // Generate overall alignment and opportunities text
    const metActivities = updatedActivities.filter((a: any) => a.status === 'MET' || a.status === 'EXCEEDED' || (a.achievement && a.achievement >= 100));
    const missedActivities = updatedActivities.filter((a: any) => a.status === 'MISSED' || (a.achievement && a.achievement < 100));
    
    // Collect unique KRAs
    const kraIds = [...new Set(updatedActivities.map((a: any) => a.kraId))];
    const kraList = kraIds.map((kraId: any) => {
      const normalizedKraIdForList = normalizeKraId(kraId);
      const kra = allKRAs.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraIdForList);
      return kra?.kra_title || kraId;
    }).join(', ');

    // Create document insight text (markdown-friendly) for legacy fields
    const overallSummary = gapsData['Overall Achievement']
      ? gapsData['Overall Achievement']
      : null;
    const isRateSummary = overallSummary
      ? overallSummary.target <= 100 && overallSummary.actual <= 100
      : false;

    const alignmentText =
      `### Summary\n` +
      `- Activities analyzed: ${updatedActivities.length}\n` +
      `- KRAs covered: ${kraIds.length}${kraList ? ` (${kraList})` : ''}\n` +
      `- Activities met/exceeded: ${metActivities.length}\n` +
      `- Activities missed: ${missedActivities.length}\n` +
      `- Overall achievement score: ${overallAchievementScore.toFixed(2)}%\n` +
      (overallSummary
        ? (`- ${isRateSummary ? 'Average reported rate' : 'Total reported'}: ${overallSummary.actual.toFixed(2)}${isRateSummary ? '%' : ''}\n` +
           `- ${isRateSummary ? 'Target rate' : 'Total target'}: ${overallSummary.target.toFixed(2)}${isRateSummary ? '%' : ''}\n`)
        : '');

    // Create detailed opportunities text based on actual results
    let opportunitiesText = '';
    if (metActivities.length > 0) {
      const successSummary = metActivities
        .map((a: any) => `- ${a.name} (${(a.achievement || 0).toFixed(1)}% achievement)`)
        .join('\n');
      opportunitiesText =
        `### High-performing activities\n` +
        `${successSummary}\n`;
    }
    
    if (missedActivities.length > 0) {
      const improvementArea = missedActivities
        .map((a: any) => {
          const gapPct = a.target > 0 ? ((a.target - a.reported) / a.target * 100) : 0;
          const suffix = (a.target <= 100 && a.reported <= 100) ? '%' : '';
          return `- ${a.name}: Target ${Number(a.target || 0).toFixed(2)}${suffix}, Reported ${Number(a.reported || 0).toFixed(2)}${suffix} (Gap ${gapPct.toFixed(1)}%)`;
        })
        .join('\n');
      opportunitiesText += (opportunitiesText ? '\n\n' : '') +
        `### Improvement opportunities\n` +
        `${improvementArea}\n`;
    }

    // =========================================================================
    // LLM-BASED PRESCRIPTIVE ANALYSIS GENERATION
    // =========================================================================
    
    console.log('[Regenerate] Generating fresh prescriptive analysis via LLM...');
    
    // Build context for LLM with KPI type information
    const activitiesContext = updatedActivities.map((act: any) => {
      const normalizedKraIdForType = normalizeKraId(act.kraId);
      const kra = allKRAs.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraIdForType);
      const normalizedInitId = normalizeInitiativeId(String(act.initiativeId || ''));
      let initiative = kra?.initiatives?.find((i: any) => normalizeInitiativeId(String(i.id)) === normalizedInitId);
      if (!initiative && act.initiativeId) {
        const kpiMatch = String(act.initiativeId).match(/KPI(\d+)/i);
        if (kpiMatch) {
          initiative = kra?.initiatives?.find((i: any) => String(i.id).includes(`KPI${kpiMatch[1]}`));
        }
      }
      const kpiType = initiative?.targets?.type || act.targetType || 'count';
      const kpiCategory = getKpiTypeCategory(kpiType);
      const gapInterpretation = getGapInterpretation(kpiCategory);
      
      return {
        name: act.name,
        kraTitle: kra?.kra_title || act.kraId,
        kpiId: act.initiativeId,
        kpiType,
        kpiCategory,
        reported: act.reported,
        target: act.target,
        achievement: act.achievement,
        status: act.status,
        gapType: gapInterpretation.gapType,
        actionArchetype: gapInterpretation.actionArchetype,
        antiPattern: gapInterpretation.antiPattern,
      };
    });

    // Infer domain context from activity names
    const allActivityNames = updatedActivities.map((a: any) => String(a.name || '').trim()).filter(Boolean);
    const kraNames = [...new Set(activitiesContext.map((a: any) => a.kraTitle))];
    const domainContext = inferDomainContext(allActivityNames, undefined, kraNames.join(', '));
    const domainPromptEnrichment = buildContextAwarePromptEnrichment(allActivityNames, undefined, kraNames.join(', '));
    console.log(`[Regenerate] Domain context inferred: ${domainContext.domain} (${domainContext.domainLabel})`);

    // Build type-specific instructions
    const typeInstructions = activitiesContext.map((act: any) =>
      generateTypeSpecificLogicInstruction(act.kpiType)
    ).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).join('\n');

    // Build KPI type change notices for the LLM (critical for breaking old patterns)
    const kpiTypeNotices = activitiesContext
      .filter((act: any) => act.kpiCategory === 'EFFICIENCY')
      .map((act: any) => `- "${act.name}": Type is ${act.kpiType.toUpperCase()} (RATE/PERCENTAGE) - diagnose as QUALITY issue, NOT volume/pipeline issue`)
      .join('\n');

    // Build KPI-level aggregate groups for LLM prompt.
    // Individual activity names (paper titles, event names) must NOT appear as bottleneck
    // identifiers in the document insight. We group by KPI ID and compute aggregates so the
    // LLM only sees "KRA5-KPI9 – faculty research outputs: 3 / 150" rather than a paper title.
    const kpiGroupMap = new Map<string, {
      kpiId: string; kraTitle: string; kpiType: string; kpiCategory: string;
      totalReported: number; target: number; achievement: number; status: string;
      gapType: string; actionArchetype: string; antiPattern: string | undefined;
      itemCount: number; kpiOutputDescription: string; kpiOutcomeDescription: string;
    }>();
    for (const act of activitiesContext) {
      const key = String(act.kpiId || 'unknown');
      const existing = kpiGroupMap.get(key);
      if (existing) {
        existing.totalReported += Number(act.reported || 0);
        existing.itemCount += 1;
        existing.achievement = existing.target > 0
          ? Math.min(100, (existing.totalReported / existing.target) * 100)
          : 0;
        existing.status = existing.achievement >= 100 ? 'MET' : existing.achievement >= 80 ? 'ON_TRACK' : 'MISSED';
      } else {
        const normalizedKraForLookup = normalizeKraId(String(act.kpiId || '').split('-KPI')[0]);
        const kraForLookup = allKRAs.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraForLookup);
        const normInitId = normalizeInitiativeId(String(act.kpiId || ''));
        const initiativeForLookup = kraForLookup?.initiatives?.find((i: any) => normalizeInitiativeId(String(i.id)) === normInitId);
        kpiGroupMap.set(key, {
          kpiId: act.kpiId,
          kraTitle: act.kraTitle,
          kpiType: act.kpiType,
          kpiCategory: act.kpiCategory,
          totalReported: Number(act.reported || 0),
          target: Number(act.target || 0),
          achievement: Number(act.achievement || 0),
          status: act.status,
          gapType: act.gapType,
          actionArchetype: act.actionArchetype,
          antiPattern: act.antiPattern,
          itemCount: 1,
          kpiOutputDescription: initiativeForLookup?.key_performance_indicator?.outputs || 'KPI output',
          kpiOutcomeDescription: Array.isArray(initiativeForLookup?.key_performance_indicator?.outcomes)
            ? initiativeForLookup.key_performance_indicator.outcomes.join('; ')
            : (initiativeForLookup?.key_performance_indicator?.outcomes || ''),
        });
      }
    }
    const kpiGroups = Array.from(kpiGroupMap.values());

    // Call LLM for fresh prescriptive analysis
    let llmPrescriptiveResult: { documentInsight: string; prescriptiveItems: any[] } | null = null;

    try {
      // Build strategic plan enrichment for each covered KRA
      const coveredKraIds = [...new Set(updatedActivities.map((a: any) => a.kraId))];
      const strategicEnrichment = coveredKraIds.map((kraId: any) => {
        const normalizedKid = normalizeKraId(kraId);
        const kra = allKRAs.find((k: any) => normalizeKraId(k.kra_id) === normalizedKid);
        if (!kra) return '';

        const initiatives = (kra.initiatives || []).map((init: any) => {
          const yearTarget = init.targets?.timeline_data?.find((t: any) => t.year === reportYear);
          return `  - ${init.id}:
    Output: ${init.key_performance_indicator?.outputs || 'N/A'}
    Outcome: ${init.key_performance_indicator?.outcomes || 'N/A'}
    Target (${reportYear}): ${yearTarget?.target_value ?? 'N/A'} (${init.targets?.type || 'count'})
    Strategies: ${(init.strategies || []).join('; ')}
    Authorized Programs: ${(init.programs_activities || []).join('; ')}
    Responsible Offices: ${(init.responsible_offices || []).join(', ')}
    Timeline Scope: ${init.targets?.target_time_scope || 'N/A'}`;
        }).join('\n');

        return `KRA: ${kra.kra_id} - ${kra.kra_title}\n${initiatives}`;
      }).filter(Boolean).join('\n\n');

      // Build fresh start system message with explicit type constraints
      const systemPrompt = `[SYSTEM INSTRUCTION: FRESH START]
You are LSPU's Strategic Planning Analyst generating a fresh prescriptive analysis. Disregard all previous analyses.

CRITICAL METADATA UPDATE - KPI TYPES HAVE BEEN CORRECTED:
${kpiTypeNotices || 'All KPIs are count/volume based.'}

${domainPromptEnrichment}

STRICT CONSTRAINTS:
1. For KPIs marked as RATE, PERCENTAGE, or EFFICIENCY type:
   - You are FORBIDDEN from diagnosing as "data collection", "pipeline", "reporting workflow", or "scale" issues
   - You MUST diagnose as "quality", "performance", "curriculum alignment", "training effectiveness", or "conversion" issues
   - Recommendations must focus on IMPROVING QUALITY, not increasing volume

2. For KPIs marked as COUNT or VOLUME type:
   - You may diagnose as scaling, capacity, or collection issues
   - Recommendations can focus on increasing volume or streamlining processes

3. NEVER output meta-system warnings like "Ensure KPI types are correctly classified" or "Validate that rate KPIs focus on quality". Every recommendation must be an actionable business/operational prescription.
4. Use domain-appropriate language for ${domainContext.domainLabel}. Do NOT use generic manufacturing/sales terminology for academic, IT, or governance contexts.

OUTPUT QUALITY RULES:
- documentInsight: Start with the overall achievement %, then name the bottleneck KPI by its ID and official output measure ONLY (e.g., "KRA5-KPI9 – faculty research outputs: 3 submitted vs target of 150"). ⚠️ NEVER use individual activity, paper, or event names as the bottleneck identifier. Then identify the systemic pattern grounded in the strategic plan.
- prescriptiveItems: Generate exactly 2-3 items. Each must have a DIFFERENT root cause. Do not repeat "low achievement" as the issue for multiple items. Diagnose WHY: staff capacity? budget allocation? process bottleneck? timeline delay? quality standards?
- action: Must name a SPECIFIC program/strategy from the strategic plan. Include a quantitative target where possible (e.g., "increase from 3 to 7 by Q3").
- Never use filler phrases like "further enhance", "continue to improve", or "strengthen efforts". Be direct and specific.

Respond with valid JSON only.`;

      const prescriptivePrompt = `[FRESH ANALYSIS REQUIRED - NEW KPI CLASSIFICATIONS]

**STRATEGIC PLAN CONTEXT (AUTHORITATIVE - use this to ground your recommendations):**
${strategicEnrichment}

**GROUNDING RULES:**
- Every prescriptive item MUST reference a specific KPI ID (e.g., KRA5-KPI9) and its official output measure
- Every "action" MUST directly cite or derive from a specific authorized strategy or program in the STRATEGIC PLAN CONTEXT above — direct quotes preferred. Do NOT generate generic actions that could apply to any institution.
- The "responsibleOffice" MUST match one of the offices listed in the plan for the relevant KPI
- Priority: HIGH = achievement < 50%, MEDIUM = 50-80%, LOW = > 80%
- Use the "Strategic Outcome" for each KPI to frame WHY closing this gap matters (institutional impact)
- Do NOT invent strategies, programs, or offices that are not in the strategic plan context

**KPI Type Rules (MUST FOLLOW):**
${typeInstructions}

**ANTI-PATTERNS TO AVOID:**
- NEVER suggest "Scale up production capacity" for academic or IT contexts
- NEVER output "Ensure KPI types are correctly classified" - this is a system concern, not a business prescription
- Use terminology appropriate for ${domainContext.domainLabel} at a state university

**Summary:** ${overallAchievementScore.toFixed(2)}% achievement across ${updatedActivities.length} activities. KRAs: ${kraList}

**KPIs with CORRECTED Types (aggregate view — individual item names omitted to avoid misidentification):**
${kpiGroups.map((kpi: any, i: number) =>
  `${i+1}. KPI: ${kpi.kpiId} — "${kpi.kpiOutputDescription}"
   - KPI Type: ${kpi.kpiType.toUpperCase()} (Category: ${kpi.kpiCategory})
   - Aggregate: ${kpi.totalReported} reported vs ${kpi.target} target = ${kpi.achievement.toFixed(1)}%
   - Items Submitted: ${kpi.itemCount}
   - Status: ${kpi.status}
   - Strategic Outcome: ${kpi.kpiOutcomeDescription || 'N/A'}
   - Required Action Type: ${kpi.actionArchetype}
   ${kpi.antiPattern ? `- FORBIDDEN: ${kpi.antiPattern}` : ''}`
).join('\n\n')}

Return JSON with this exact structure. Generate exactly 2-3 prescriptive items, each addressing a DIFFERENT root cause:
{
  "documentInsight": "<2-4 sentences: Start with overall achievement %. Name the bottleneck KPI by its ID and official output measure (e.g., 'KRA5-KPI9 – faculty research outputs: 3 submitted vs target of 150'). NEVER use individual paper/activity/event names. Identify the systemic gap pattern grounded in the strategic plan strategies.>",
  "prescriptiveItems": [
    {
      "title": "<short action title - 3-6 words, domain-specific>",
      "issue": "<One sentence: Name the KPI ID, state the gap numerically, diagnose the root cause (NOT just 'low achievement'). Different root cause per item.>",
      "action": "<Cite a specific authorized strategy/program from the plan. Include a quantitative target or milestone.>",
      "nextStep": "<Concrete immediate action with specific timeframe (e.g., 'Within 14 days, convene...')>",
      "relatedKpiId": "<KRAx-KPIy>",
      "responsibleOffice": "<office from strategic plan>",
      "priority": "<HIGH|MEDIUM|LOW>",
      "authorizedStrategy": "<exact strategy text from the plan>",
      "timeframe": "<recommended timeframe>"
    }
  ]
}

REMEMBER: For RATE/PERCENTAGE KPIs, the issue is NEVER about "collecting more data" or "scaling pipelines". It's about IMPROVING QUALITY.`;

      const llmResponse = await prescriptiveLlm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(prescriptivePrompt),
      ]);

      const jsonMatch = (llmResponse.content?.toString() || '').match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        llmPrescriptiveResult = JSON.parse(jsonMatch[0]);
        console.log('[Regenerate] LLM prescriptive analysis generated with fresh KPI types and strategic plan context');
      }
    } catch (llmError) {
      console.error('[Regenerate] LLM failed, using fallback:', llmError);
    }

    // Fallback or use LLM result - now type-aware based on KPI classification
    const prescriptiveItems = llmPrescriptiveResult?.prescriptiveItems || (() => {
      const items: Array<{ title: string; issue: string; action: string; nextStep?: string }> = [];

      // Use KPI-level bottleneck (NOT activity-level) to avoid surfacing paper/event titles
      const sortedForFallback = kpiGroups.slice().sort((a, b) => a.achievement - b.achievement);
      const kpiBottleneckFallback = sortedForFallback[0];
      const kpiStrongestFallback = kpiGroups.filter(k => k.achievement > 80).sort((a, b) => b.achievement - a.achievement)[0];

      if (kpiBottleneckFallback?.kpiId) {
        const bottleneckCategory = kpiBottleneckFallback.kpiCategory;
        let issueDescription = '';
        let actionRecommendation = '';

        if (bottleneckCategory === 'EFFICIENCY') {
          issueDescription = `${kpiBottleneckFallback.kpiId} (${kpiBottleneckFallback.kpiOutputDescription}) is at ${kpiBottleneckFallback.achievement.toFixed(1)}% of target. This is a rate/percentage KPI measuring quality/efficiency, NOT volume.`;
          actionRecommendation = 'Focus on improving quality of outcomes, process efficiency, curriculum alignment, or training effectiveness. Review compliance criteria and conversion rates rather than increasing volume.';
        } else if (bottleneckCategory === 'VOLUME') {
          const fallbackDomain = inferDomainContext(
            updatedActivities.map((a: any) => String(a.name || '').trim()).filter(Boolean),
            kpiBottleneckFallback.kpiId,
            kpiBottleneckFallback.kraTitle
          );
          if (fallbackDomain.domain === 'ACADEMIC_RESEARCH') {
            issueDescription = `${kpiBottleneckFallback.kpiId} (${kpiBottleneckFallback.kpiOutputDescription}) shows ${kpiBottleneckFallback.totalReported} submitted vs a target of ${kpiBottleneckFallback.target} (${kpiBottleneckFallback.achievement.toFixed(1)}%). This count-based KPI is tracking research/academic outputs.`;
            actionRecommendation = 'Intensify research output through faculty research load adjustments, expanded research grants, streamlined review processes, and research mentoring programs aligned with KRA strategies.';
          } else if (fallbackDomain.domain === 'IT_INFRASTRUCTURE') {
            issueDescription = `${kpiBottleneckFallback.kpiId} (${kpiBottleneckFallback.kpiOutputDescription}) shows ${kpiBottleneckFallback.totalReported} completed vs a target of ${kpiBottleneckFallback.target} (${kpiBottleneckFallback.achievement.toFixed(1)}%). This count-based KPI is tracking IT infrastructure deliverables.`;
            actionRecommendation = 'Accelerate IT project completion by securing procurement timelines, deploying additional technical personnel, and establishing project milestone tracking.';
          } else {
            issueDescription = `${kpiBottleneckFallback.kpiId} (${kpiBottleneckFallback.kpiOutputDescription}) shows ${kpiBottleneckFallback.totalReported} vs a target of ${kpiBottleneckFallback.target} (${kpiBottleneckFallback.achievement.toFixed(1)}%). This count-based KPI requires volume scaling.`;
            actionRecommendation = 'Increase output frequency, allocate additional resources, and streamline processes to meet the volume target in the remaining reporting period.';
          }
        } else {
          issueDescription = `${kpiBottleneckFallback.kpiId} (${kpiBottleneckFallback.kpiOutputDescription}) is at ${kpiBottleneckFallback.achievement.toFixed(1)}% of target (${kpiBottleneckFallback.totalReported} vs ${kpiBottleneckFallback.target}).`;
          actionRecommendation = 'Conduct root cause analysis and implement targeted interventions aligned with the authorized strategies in the strategic plan.';
        }

        items.push({
          title: 'Address the primary performance gap',
          issue: issueDescription,
          action: actionRecommendation,
        });
      } else {
        items.push({
          title: 'Address the primary performance gap',
          issue: 'At least one KPI area remains below target, limiting overall performance.',
          action: 'Prioritize the lowest-performing KPI and implement targeted interventions with clear owners and deadlines by the next reporting cycle.',
        });
      }

      // Only add Sustain when there is actually a high-performing KPI (not activity)
      if (kpiStrongestFallback?.kpiId) {
        items.push({
          title: 'Sustain and operationalize high performers',
          issue: `${kpiStrongestFallback.kpiId} (${kpiStrongestFallback.kpiOutputDescription}) is performing well at ${kpiStrongestFallback.achievement.toFixed(1)}% and should be protected from regression as attention shifts to gaps.`,
          action: 'Standardize the execution approach, document evidence artifacts, and transition outputs into ongoing utilization/operations within the next quarter.',
          nextStep: 'Assign an owner to compile evidence and standard operating steps within 2 weeks.',
        });
      }

      items.push({
        title: 'Strengthen evidence documentation and reporting',
        issue: 'Consistent evidence documentation ensures accurate performance tracking and supports data-driven institutional decisions.',
        action: 'Standardize evidence collection templates, establish clear submission deadlines, and assign unit-level data custodians for complete and accurate reporting.',
      });

      // If no high performers exist, we intentionally return only 2 items.
      return items.slice(0, 3);
    })();

    const prescriptiveTextFormatted = prescriptiveItems
      .map((x: any, idx: number) => {
        const lines = [
          `${idx + 1}. ${x.title}`,
          `- Issue: ${x.issue}`,
          `- Action: ${x.action}`,
        ];
        if (x.nextStep) lines.push(`- Next Step: ${x.nextStep}`);
        if (x.relatedKpiId) lines.push(`- KPI: ${x.relatedKpiId}`);
        if (x.responsibleOffice) lines.push(`- Responsible Office: ${x.responsibleOffice}`);
        return lines.join('\n');
      })
      .join('\n\n');

    // Build document-level prescriptive analysis JSON for database
    // Use LLM-generated insight or create type-aware fallback using KPI-level aggregates
    const typeAwareDocumentInsight = llmPrescriptiveResult?.documentInsight || (() => {
      const parts: string[] = [];
      parts.push(`The report indicates an overall achievement score of ${overallAchievementScore.toFixed(2)}% across ${updatedActivities.length} tracked activities.`);
      if (kraList) {
        parts.push(`Coverage spans ${kraIds.length} KRA(s): ${kraList}.`);
      }
      // Use KPI-level bottleneck/strongest — never surface individual activity/paper/event names
      const sortedKpiGroups = kpiGroups.slice().sort((a, b) => a.achievement - b.achievement);
      const kpiBottleneck = sortedKpiGroups[0];
      const kpiStrongest = kpiGroups.filter(k => k.achievement > 80).sort((a, b) => b.achievement - a.achievement)[0];

      if (kpiStrongest?.kpiId) {
        parts.push(`A relative strength is ${kpiStrongest.kpiId} (${kpiStrongest.kpiOutputDescription}: ${kpiStrongest.totalReported} reported, ${kpiStrongest.achievement.toFixed(1)}% of target).`);
      }
      if (kpiBottleneck?.kpiId) {
        if (kpiBottleneck.kpiCategory === 'EFFICIENCY') {
          parts.push(`Performance is constrained by ${kpiBottleneck.kpiId} (${kpiBottleneck.kpiOutputDescription}: ${kpiBottleneck.totalReported} vs target of ${kpiBottleneck.target}, ${kpiBottleneck.achievement.toFixed(1)}%), a rate/percentage KPI indicating a quality or conversion gap that requires process optimization, not volume scaling.`);
        } else {
          parts.push(`Performance is primarily constrained by ${kpiBottleneck.kpiId} (${kpiBottleneck.kpiOutputDescription}: ${kpiBottleneck.totalReported} submitted vs target of ${kpiBottleneck.target}, ${kpiBottleneck.achievement.toFixed(1)}%), indicating an output volume gap requiring strategic intervention aligned with the university's strategic plan.`);
        }
      }
      return parts.join(' ');
    })();

    const prescriptiveAnalysisData = {
      documentInsight: typeAwareDocumentInsight,
      prescriptiveAnalysis: prescriptiveTextFormatted,
      prescriptiveItems,
      summary: {
        totalActivities: updatedActivities.length,
        metCount: metActivities.length,
        missedCount: missedActivities.length,
        overallAchievement: overallAchievementScore,
      },
      generatedAt: new Date().toISOString(),
      source: 'regenerated',
    };

    // Update the analysis in the database
    await prisma.qPROAnalysis.update({
      where: { id: analysisId },
      data: {
        activities: updatedActivities,
        achievementScore: overallAchievementScore,
        gaps: JSON.stringify(gapsData),
        alignment: alignmentText,
        opportunities: opportunitiesText,
        recommendations: prescriptiveTextFormatted,
        prescriptiveAnalysis: prescriptiveAnalysisData,
        updatedAt: new Date(),
      },
    });

    // CRITICAL: Invalidate all cached data for this analysis to ensure fresh data on next fetch
    // This fixes the stale data issue when user corrects KPI/KRA classifications
    console.log(`[Regenerate] Invalidating cache for analysis: ${analysisId}`);
    try {
      // Invalidate analysis cache by analysisId
      await qproCacheService.invalidateAnalysisCache(analysisId);
      // Also invalidate by documentId if we have it
      if (analysis.documentId) {
        await qproCacheService.invalidateAnalysisCache(analysis.documentId);
      }
      // Invalidate processing status
      await qproCacheService.invalidateProcessingStatus(analysisId);
      // Invalidate the uploader's user cache so their analyses list refreshes
      if (analysis.uploadedById) {
        await qproCacheService.invalidateUserAnalysesCache(analysis.uploadedById);
      }
      console.log(`[Regenerate] Cache invalidation complete`);
    } catch (cacheError) {
      // Log but don't fail the request if cache invalidation fails
      console.error('[Regenerate] Cache invalidation error (non-fatal):', cacheError);
    }

    // Log final response before sending
    console.log(`[Regenerate] Sending response with ${regeneratedActivities.length} activities:`);
    regeneratedActivities.forEach((act: any, idx: number) => {
      console.log(`  [${idx}] ${act.name} - Target: ${act.target}, Achievement: ${act.achievement?.toFixed(2) || 'N/A'}%`);
    });

    return NextResponse.json({ 
      activities: regeneratedActivities,
      overallAchievementScore,
      gaps: gapsData,
      alignment: alignmentText,
      opportunities: opportunitiesText,
      recommendations: prescriptiveTextFormatted,
      prescriptiveAnalysis: prescriptiveAnalysisData,
      // Include timestamp to help frontend detect fresh data
      regeneratedAt: new Date().toISOString(),
    }, { 
      status: 200,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (error) {
    console.error('Error regenerating insights:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to regenerate insights',
      },
      { status: 500 }
    );
  }
}
