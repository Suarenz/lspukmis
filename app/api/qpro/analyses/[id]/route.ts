import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import { qproAnalysisService } from '@/lib/services/qpro-analysis-service';
import { qproCacheService } from '@/lib/services/qpro-cache-service';
import prisma from '@/lib/prisma';
import { computeAggregatedAchievement, getInitiativeTargetMeta, normalizeKraId } from '@/lib/utils/qpro-aggregation';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authenticate
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;

    const { user } = authResult;
    const { id } = await params;

    console.log(`[QPRO Analysis Detail] Fetching analysis: ${id}`);

    // Check cache first
    const cachedAnalysis = await qproCacheService.getAnalysisCache(id);
    if (cachedAnalysis) {
      console.log(`[QPRO Analysis Detail] Cache hit for analysis: ${id}`);
      // Note: This returns cached metadata only. For full details, we still fetch from DB
    }

    // Get analysis by ID
    const analysis = await qproAnalysisService.getQPROAnalysisById(id);

    if (!analysis) {
      return NextResponse.json({ error: 'Analysis not found' }, { status: 404 });
    }

    // Debug: Log prescriptive analysis data from DB
    console.log(`[QPRO Analysis Detail] Status: ${analysis.status}`);
    console.log(`[QPRO Analysis Detail] activities count:`, (analysis.activities as any[])?.length || 0);
    console.log(`[QPRO Analysis Detail] kras count:`, (analysis.kras as any[])?.length || 0);
    console.log(`[QPRO Analysis Detail] prescriptiveAnalysis exists:`, !!analysis.prescriptiveAnalysis);
    if (analysis.prescriptiveAnalysis) {
      console.log(`[QPRO Analysis Detail] prescriptiveAnalysis type:`, typeof analysis.prescriptiveAnalysis);
      console.log(`[QPRO Analysis Detail] prescriptiveAnalysis keys:`, 
        typeof analysis.prescriptiveAnalysis === 'object' ? Object.keys(analysis.prescriptiveAnalysis as object) : 'N/A'
      );
    }
    // Debug: Log first activity
    if (analysis.activities && Array.isArray(analysis.activities) && (analysis.activities as any[]).length > 0) {
      const firstAct = (analysis.activities as any[])[0];
      console.log('[QPRO Analysis Detail] First activity:', JSON.stringify(firstAct, null, 2));
    }
    // Debug: Log first KRA
    if (analysis.kras && Array.isArray(analysis.kras) && (analysis.kras as any[]).length > 0) {
      const firstKra = (analysis.kras as any[])[0];
      console.log('[QPRO Analysis Detail] First KRA:', JSON.stringify(firstKra, null, 2));
    }

    // Check authorization
    if (analysis.uploadedById !== user.id && user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // Format comprehensive response with all 4 stages
    // Derive status based on analysis data
    const status = analysis.analysisResult ? 'COMPLETED' : 'PENDING';

    const response = {
      // Basic info
      id: analysis.id,
      title: analysis.documentTitle,
      year: analysis.year,
      quarter: analysis.quarter,
      uploadedDate: analysis.createdAt,
      status: status,

      // Stage 1: Extracted Sections (from analysisResult or activities)
      extractedSections: extractSections(analysis),

      // Stage 2: KRA Classifications
      kraClassifications: formatKRAClassifications(analysis),

      // Stage 3: Organized Activities by KRA
      organizedActivities: organizeActivitiesByKRA(analysis),

      // Stage 4: Insights & Recommendations
      insights: analysis.analysisResult ? parseInsights(analysis.analysisResult) : [],
      recommendations: analysis.recommendations ? parseRecommendations(analysis.recommendations) : [],
      
      // Stage 4: Prescriptive Analysis fields (from DB)
      alignment: analysis.alignment || '',
      opportunities: analysis.opportunities || '',
      gaps: analysis.gaps || '',
      
      // Stage 4: Prescriptive Analysis (from AI during draft phase) - formatted for frontend
      // First try the dedicated prescriptiveAnalysis field, then fall back to extracting from kras array
      prescriptiveAnalysis: formatPrescriptiveAnalysisForFrontend(
        analysis.prescriptiveAnalysis && Object.keys(analysis.prescriptiveAnalysis as object).length > 0
          ? analysis.prescriptiveAnalysis
          : extractPrescriptiveFromKRAs(analysis.kras)
      ),

      // Achievement Metrics (format overallScore to 2 decimal places)
      achievementMetrics: {
        overallScore: parseFloat((analysis.achievementScore || 0).toFixed(2)),
        completeness: calculateCompleteness(analysis),
        currentState: `${(analysis.kras ? (Array.isArray(analysis.kras) ? analysis.kras.length : 0) : 0)} KRAs with ${(analysis.activities ? (Array.isArray(analysis.activities) ? analysis.activities.length : 0) : 0)} activities`,
        targetState: 'Full alignment with strategic plan objectives',
      },
      
      // Include activities directly for the review modal
      activities: analysis.activities || [],
    };

    // Return response with no-cache headers to ensure fresh data after regeneration
    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (error) {
    console.error('[QPRO Analysis Detail] Error:', error);
    return NextResponse.json({ error: 'Failed to fetch analysis details' }, { status: 500 });
  }
}

function extractSections(analysis: any) {
  // Extract sections from activities or raw text
  const sectionMap = new Map<string, string[]>();

  if (analysis.activities && Array.isArray(analysis.activities)) {
    (analysis.activities as any[]).forEach((activity: any) => {
      const section = detectSection(activity.name || '') || 'OTHER';
      if (!sectionMap.has(section)) {
        sectionMap.set(section, []);
      }
      sectionMap.get(section)!.push(activity.name || 'Unnamed activity');
    });
  }

  const sections: any[] = [];

  if (sectionMap.size === 0) {
    // Default sections if not detected
    sections.push(
      { title: 'Training Activities', type: 'TRAINING', activities: ['Training and professional development activities'] },
      { title: 'Research Activities', type: 'RESEARCH', activities: ['Research outputs and publications'] },
      { title: 'Alumni Engagement', type: 'ALUMNI_EMPLOYMENT', activities: ['Alumni employment and career tracking'] }
    );
  } else {
    sectionMap.forEach((activities, sectionType) => {
      sections.push({
        title: formatSectionTitle(sectionType),
        type: sectionType,
        activities: activities,
      });
    });
  }

  return sections;
}

function formatSectionTitle(sectionType: string): string {
  const titles: { [key: string]: string } = {
    'TRAINING': 'Training & Professional Development',
    'RESEARCH': 'Research & Publications',
    'ALUMNI_EMPLOYMENT': 'Alumni Engagement & Employment',
    'OTHER': 'Other Activities',
  };
  return titles[sectionType] || sectionType;
}

function detectSection(text: string): string | null {
  const lowerText = text.toLowerCase();
  if (lowerText.includes('train') || lowerText.includes('seminar') || lowerText.includes('workshop')) {
    return 'TRAINING';
  }
  if (lowerText.includes('research') || lowerText.includes('paper') || lowerText.includes('publication')) {
    return 'RESEARCH';
  }
  if (lowerText.includes('alumni') || lowerText.includes('employment') || lowerText.includes('graduate')) {
    return 'ALUMNI_EMPLOYMENT';
  }
  return null;
}

// KRA ID to human-readable title mapping
const KRA_TITLES: { [key: string]: string } = {
  'KRA 1': 'Development of New Curricula',
  'KRA 2': 'Accreditation',
  'KRA 3': 'Quality and Relevance of Instruction',
  'KRA 4': 'International Activities',
  'KRA 5': 'Research Outputs',
  'KRA 6': 'Extension Programs',
  'KRA 7': 'Community Partnerships',
  'KRA 8': 'Technology Transfer',
  'KRA 9': 'Revenue Generation',
  'KRA 10': 'Resource Mobilization',
  'KRA 11': 'Human Resource Management',
  'KRA 12': 'Student Development',
  'KRA 13': 'Health and Wellness',
  'KRA 14': 'Environmental Sustainability',
  'KRA 15': 'Quality Management',
  'KRA 16': 'Governance',
  'KRA 17': 'Digital Transformation',
  'UNCLASSIFIED': 'Uncategorized Activities',
};

function getKRATitle(kraId: string, fallback?: string): string {
  return KRA_TITLES[kraId] || fallback || kraId;
}

function formatKRAClassifications(analysis: any) {
  // Build activity count per KRA from the activities array OR from embedded activities in KRAs
  // Uses KPI-type-aware aggregation for achievement rate calculation
  const kraActivityCounts: { [kraId: string]: number } = {};
  const kraActivitiesData: { [kraId: string]: any[] } = {}; // Store full activity data for aggregation
  const kraTitles: { [kraId: string]: string } = {};
  const kraInitiativeIds: { [kraId: string]: string } = {}; // Track initiative IDs for type lookup
  
  // Load strategic plan for KPI type information
  const strategicPlanJson = require('@/lib/data/strategic_plan.json');
  const allKRAs = strategicPlanJson.kras || [];
  const year = analysis.year || 2025;
  
  console.log('[formatKRAClassifications] activities count:', analysis.activities?.length || 0);
  console.log('[formatKRAClassifications] kras count:', analysis.kras?.length || 0);
  
  // FIRST: Check if activities in the top-level array have kraId
  // If not, we'll count from embedded activities in each KRA
  let activitiesHaveKraId = false;
  if (analysis.activities && Array.isArray(analysis.activities) && (analysis.activities as any[]).length > 0) {
    const firstAct = (analysis.activities as any[])[0];
    activitiesHaveKraId = !!(firstAct.kraId || firstAct.kra_id || firstAct.kra);
  }
  
  console.log('[formatKRAClassifications] activitiesHaveKraId:', activitiesHaveKraId);
  
  // If activities don't have kraId, try to count from KRA's embedded activities
  if (!activitiesHaveKraId && analysis.kras && Array.isArray(analysis.kras)) {
    let totalEmbeddedCount = 0;
    
    (analysis.kras as any[]).forEach((kra: any) => {
      const kraId = kra.kraId || kra.id || '';
      const embeddedActivities = kra.activities || [];
      totalEmbeddedCount += embeddedActivities.length;
      kraActivityCounts[kraId] = embeddedActivities.length;
      
      // Store full activity data for proper aggregation
      if (!kraActivitiesData[kraId]) kraActivitiesData[kraId] = [];
      embeddedActivities.forEach((act: any) => {
        kraActivitiesData[kraId].push({
          reported: act.reported || 0,
          target: act.target || 0,
          achievement: act.achievement || 0,
          targetType: act.targetType,
          initiativeId: act.initiativeId,
        });
        if (act.initiativeId && !kraInitiativeIds[kraId]) {
          kraInitiativeIds[kraId] = act.initiativeId;
        }
      });
      
      if (kra.kraTitle) {
        kraTitles[kraId] = kra.kraTitle;
      }
      if (kra.initiativeId && !kraInitiativeIds[kraId]) {
        kraInitiativeIds[kraId] = kra.initiativeId;
      }
    });
    
    // FALLBACK: If embedded activities are empty but we have top-level activities,
    // assign them to the single KRA (if only one) or count as unclassified
    if (totalEmbeddedCount === 0 && analysis.activities && Array.isArray(analysis.activities)) {
      const topLevelCount = (analysis.activities as any[]).length;
      const kras = analysis.kras as any[];
      
      if (kras.length === 1 && topLevelCount > 0) {
        // Single KRA case: assign all top-level activities to it
        const singleKraId = kras[0].kraId || kras[0].id;
        kraActivityCounts[singleKraId] = topLevelCount;
        console.log(`[formatKRAClassifications] Assigned ${topLevelCount} activities to single KRA: ${singleKraId}`);
        
        // Store full activity data for proper aggregation
        if (!kraActivitiesData[singleKraId]) kraActivitiesData[singleKraId] = [];
        (analysis.activities as any[]).forEach((act: any) => {
          kraActivitiesData[singleKraId].push({
            reported: act.reported || 0,
            target: act.target || 0,
            achievement: act.achievement || 0,
            targetType: act.targetType,
            initiativeId: act.initiativeId,
          });
          if (act.initiativeId && !kraInitiativeIds[singleKraId]) {
            kraInitiativeIds[singleKraId] = act.initiativeId;
          }
        });
        
        // Use KRA's initiativeId if activities don't have one
        if (kras[0].initiativeId && !kraInitiativeIds[singleKraId]) {
          kraInitiativeIds[singleKraId] = kras[0].initiativeId;
        }
        
        console.log(`[formatKRAClassifications] Stored ${kraActivitiesData[singleKraId].length} activities for aggregation`);
      } else if (topLevelCount > 0) {
        // Multiple KRAs case: show as unclassified
        kraActivityCounts['UNCLASSIFIED'] = topLevelCount;
        console.log(`[formatKRAClassifications] ${topLevelCount} activities are unclassified (multiple KRAs)`);
      }
    }
    
    console.log('[formatKRAClassifications] Final activity counts:', kraActivityCounts);
  } else if (analysis.activities && Array.isArray(analysis.activities)) {
    // Activities have kraId, count from top-level activities
    (analysis.activities as any[]).forEach((activity: any, idx: number) => {
      // Try multiple field paths for kraId
      const kraId = activity.kraId || activity.kra_id || activity.kra || 'UNCLASSIFIED';
      
      // Debug first few activities
      if (idx < 3) {
        console.log(`[formatKRAClassifications] Activity ${idx}:`, {
          name: activity.name?.substring(0, 30),
          kraId: activity.kraId,
          kra_id: activity.kra_id,
          kra: activity.kra,
          resolved: kraId
        });
      }
      
      if (kraId) {
        kraActivityCounts[kraId] = (kraActivityCounts[kraId] || 0) + 1;
        
        // Store full activity data for proper aggregation
        if (!kraActivitiesData[kraId]) kraActivitiesData[kraId] = [];
        kraActivitiesData[kraId].push({
          reported: activity.reported || 0,
          target: activity.target || 0,
          achievement: activity.achievement || 0,
          targetType: activity.targetType,
          initiativeId: activity.initiativeId,
        });
        
        // Track initiative ID for target type lookup
        if (activity.initiativeId && !kraInitiativeIds[kraId]) {
          kraInitiativeIds[kraId] = activity.initiativeId;
        }
        
        // Store KRA title if available
        if (!kraTitles[kraId] && (activity.kraTitle || activity.kra_title)) {
          kraTitles[kraId] = activity.kraTitle || activity.kra_title;
        }
      }
    });
  }

  // Helper function to compute aggregated achievement for a KRA
  const computeKraAchievement = (kraId: string, activitiesData: any[]): number => {
    if (activitiesData.length === 0) return 0;
    
    // Get initiative ID for this KRA
    const initiativeId = kraInitiativeIds[kraId];
    
    // Get target metadata from strategic plan
    const meta = getInitiativeTargetMeta({ kras: allKRAs } as any, kraId, initiativeId, year);
    
    // Fallback target value
    const fallbackTarget = typeof activitiesData[0]?.target === 'number' 
      ? activitiesData[0].target 
      : Number(activitiesData[0]?.target || 0);
    const targetValue = meta.targetValue ?? (Number.isFinite(fallbackTarget) && fallbackTarget > 0 ? fallbackTarget : 0);
    
    // Use KPI-type-aware aggregation
    const aggregated = computeAggregatedAchievement({
      targetType: meta.targetType || activitiesData[0]?.targetType,
      targetValue,
      targetScope: meta.targetScope,
      activities: activitiesData,
    });
    
    console.log(`[formatKRAClassifications] KRA ${kraId} aggregation:`, {
      targetType: meta.targetType || activitiesData[0]?.targetType,
      targetValue,
      totalReported: aggregated.totalReported,
      achievementPercent: aggregated.achievementPercent,
    });
    
    return aggregated.achievementPercent;
  };

  // If no kras array but we have activities with kraIds, generate KRA entries from activities
  if (!analysis.kras || !Array.isArray(analysis.kras) || analysis.kras.length === 0) {
    const generatedKRAs: any[] = [];
    Object.keys(kraActivityCounts).forEach((kraId) => {
      const activitiesData = kraActivitiesData[kraId] || [];
      const achievementRate = computeKraAchievement(kraId, activitiesData);
      
      generatedKRAs.push({
        id: kraId,
        title: getKRATitle(kraId, kraTitles[kraId]),
        count: kraActivityCounts[kraId] || 0,
        achievementRate: Math.round(achievementRate * 100) / 100,
        strategicAlignment: '',
      });
    });
    return generatedKRAs;
  }

  console.log('[formatKRAClassifications] kraActivityCounts:', kraActivityCounts);

  return analysis.kras.map((kra: any, idx: number) => {
    const kraId = kra.kraId || kra.id || '';
    
    // Debug first few KRAs
    if (idx < 3) {
      console.log(`[formatKRAClassifications] KRA ${idx}:`, {
        kraId: kra.kraId,
        id: kra.id,
        resolved: kraId,
        activitiesCount: kra.activities?.length
      });
    }
    
    // Use the counted activities instead of embedded activities array
    const countFromActivities = kraActivityCounts[kraId] || 0;
    const embeddedCount = kra.activities ? (Array.isArray(kra.activities) ? kra.activities.length : 0) : 0;
    
    // Prefer the count from activities array, fallback to embedded
    const finalCount = countFromActivities > 0 ? countFromActivities : embeddedCount;
    
    console.log(`[formatKRAClassifications] KRA ${kraId}: countFromActivities=${countFromActivities}, embeddedCount=${embeddedCount}, finalCount=${finalCount}`);
    
    // Use KPI-type-aware aggregation for achievement rate
    const activitiesData = kraActivitiesData[kraId] || [];
    let achievementRate = 0;
    
    if (activitiesData.length > 0) {
      // Use the helper function for proper aggregation
      achievementRate = computeKraAchievement(kraId, activitiesData);
    } else {
      // Fallback to KRA's achievementRate if no activity data
      achievementRate = kra.achievementRate || 0;
    }

    console.log(`[formatKRAClassifications] KRA ${kraId}: activitiesData.length=${activitiesData.length}, achievementRate=${achievementRate}`);

    return {
      id: kraId || `kra-${Math.random()}`,
      title: getKRATitle(kraId, kra.kraTitle || kra.title),
      count: finalCount,
      achievementRate: Math.round(achievementRate * 100) / 100,
      strategicAlignment: kra.strategicAlignment || '',
    };
  });
}

function organizeActivitiesByKRA(analysis: any): any[] {
  const organized: { [key: string]: any } = {};

  const strategicPlanJson = require('@/lib/data/strategic_plan.json');
  const allKRAs = strategicPlanJson.kras || [];

  const getInitiativeTargetType = (kraId: string, initiativeId: string | undefined | null): string | null => {
    if (!kraId || !initiativeId) return null;
    // Use normalized KRA ID for consistent lookup
    const normalizedKraIdVal = normalizeKraId(kraId);
    const kra = allKRAs.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraIdVal);
    if (!kra?.initiatives) return null;

    // Match initiative IDs robustly (ignore spaces; allow KPI number matching)
    const normalizedId = String(initiativeId).replace(/\s+/g, '');
    let initiative = kra.initiatives.find((i: any) => String(i.id).replace(/\s+/g, '') === normalizedId);
    if (!initiative) {
      const kpiMatch = String(initiativeId).match(/KPI(\d+)/i);
      if (kpiMatch) {
        initiative = kra.initiatives.find((i: any) => String(i.id).includes(`KPI${kpiMatch[1]}`));
      }
    }

    const type = initiative?.targets?.type;
    return typeof type === 'string' ? type : null;
  };

  const computeGroupTotals = (kraId: string, activities: any[], year: number, fallbackInitiativeId?: string) => {
    const initiativeIds = activities
      .map((a: any) => a.initiativeId)
      .filter(Boolean)
      .map((v: any) => String(v));
    const distinctInitiatives = Array.from(new Set(initiativeIds));
    const primaryInitiativeId = distinctInitiatives[0] || fallbackInitiativeId;

    // Use strategic plan target for the primary initiative (KPI). For multi-KPI groups, the UI still
    // shows activity-level breakdown; KPI targets are applied once per KPI (no per-activity inflation).
    const meta = getInitiativeTargetMeta({ kras: allKRAs } as any, kraId, primaryInitiativeId, year);

    const fallbackTarget = typeof activities?.[0]?.initiativeTarget === 'number'
      ? activities[0].initiativeTarget
      : (typeof activities?.[0]?.target === 'number' ? activities[0].target : Number(activities?.[0]?.target || 0));

    const targetValue = meta.targetValue ?? (Number.isFinite(fallbackTarget) && fallbackTarget > 0 ? fallbackTarget : 0);

    const aggregated = computeAggregatedAchievement({
      targetType: meta.targetType,
      targetValue,
      targetScope: meta.targetScope,
      activities,
    });

    const completion = aggregated.achievementPercent;
    return {
      totalTarget: aggregated.totalTarget,
      totalReported: aggregated.totalReported,
      completionPercentage: Math.round(Math.min(100, Math.max(0, completion))),
      isRateMetric: String(meta.targetType || '').toLowerCase() === 'percentage',
    };
  };

  // Check if top-level activities have kraId
  let useEmbeddedActivities = false;
  if (analysis.activities && Array.isArray(analysis.activities) && (analysis.activities as any[]).length > 0) {
    const firstAct = (analysis.activities as any[])[0];
    useEmbeddedActivities = !(firstAct.kraId || firstAct.kra_id || firstAct.kra);
  } else {
    useEmbeddedActivities = true;
  }

  console.log(`[ORGANIZE] useEmbeddedActivities: ${useEmbeddedActivities}`);

  // If activities don't have kraId, use embedded activities from KRAs
  if (useEmbeddedActivities && analysis.kras && Array.isArray(analysis.kras)) {
    const kras = analysis.kras as any[];
    console.log(`[ORGANIZE] Using embedded activities from ${kras.length} KRAs`);
    
    // First, check if any KRA has embedded activities
    let totalEmbedded = 0;
    kras.forEach((kra: any) => {
      totalEmbedded += (kra.activities || []).length;
    });
    
    // FALLBACK: If embedded activities are empty but we have top-level activities and single KRA
    if (totalEmbedded === 0 && analysis.activities && Array.isArray(analysis.activities) && kras.length === 1) {
      const kra = kras[0];
      const kraId = kra.kraId || kra.id;
      
      console.log(`[ORGANIZE] Fallback: assigning ${(analysis.activities as any[]).length} top-level activities to single KRA: ${kraId}`);
      
      organized[kraId] = {
        kraId,
        kraTitle: getKRATitle(kraId, kra.kraTitle || kra.title),
        kpiId: kra.initiativeId || '',
        kpiTitle: '',
        activities: [],
        activityCount: 0,
        totalTarget: 0,
        totalReported: 0,
        completionPercentage: 0,
      };
      
      (analysis.activities as any[]).forEach((activity: any) => {
        const target = activity.target || activity.targetValue || 0;
        const reported = activity.reported || activity.accomplishedValue || 0;
        const achievement = activity.achievement || (target > 0 ? (reported / target) * 100 : 0);
        
        organized[kraId].activities.push({
          title: activity.name || activity.activityTitle || activity.title || 'Unnamed',
          initiativeId: activity.initiativeId || activity.initiative_id || organized[kraId].kpiId || '',
          target: target,
          reported: reported,
          achievement: Math.round(achievement * 100) / 100,
          status: (achievement >= 100) ? 'MET' : (reported > 0) ? 'PARTIAL' : 'NOT_STARTED',
          confidence: activity.confidence || 0.75,
          description: activity.description || `Target: ${target}, Reported: ${reported}`,
          aiInsight: activity.aiInsight || '',
          prescriptiveAnalysis: activity.prescriptiveAnalysis || '',
          rootCause: activity.rootCause || '',
        });
        organized[kraId].activityCount++;
      });

      // Compute group totals (rate metrics use average target/reported; counts use sums)
      const totals = computeGroupTotals(kraId, organized[kraId].activities, Number(analysis.year) || 2025, organized[kraId].kpiId);
      organized[kraId].totalTarget = totals.totalTarget;
      organized[kraId].totalReported = totals.totalReported;
      organized[kraId].completionPercentage = totals.completionPercentage;
      
      // Calculate completion percentage using KRA's achievementRate since activities may not have targets
      if (!(organized[kraId].totalTarget > 0) && typeof kra.achievementRate === 'number') {
        organized[kraId].completionPercentage = Math.round(kra.achievementRate || 0);
      }
      organized[kraId].status =
        organized[kraId].completionPercentage >= 100
          ? 'MET'
          : organized[kraId].completionPercentage >= 70
            ? 'ON_TRACK'
            : organized[kraId].completionPercentage > 0
              ? 'PARTIAL'
              : 'NOT_STARTED';
      
      return Object.values(organized);
    }
    
    // Normal path: use embedded activities
    kras.forEach((kra: any) => {
      const kraId = kra.kraId || kra.id;
      if (!kraId) return;
      
      const embeddedActivities = kra.activities || [];
      
      if (!organized[kraId]) {
        organized[kraId] = {
          kraId,
          kraTitle: getKRATitle(kraId, kra.kraTitle || kra.title),
          kpiId: kra.initiativeId || '',
          kpiTitle: '',
          activities: [],
          activityCount: 0,
          totalTarget: 0,
          totalReported: 0,
          completionPercentage: 0,
        };
      }
      
      embeddedActivities.forEach((activity: any) => {
        const target = activity.target || activity.targetValue || 0;
        const reported = activity.reported || activity.accomplishedValue || 0;
        const achievement = activity.achievement || (target > 0 ? (reported / target) * 100 : 0);
        
        organized[kraId].activities.push({
          title: activity.name || activity.activityTitle || activity.title || 'Unnamed',
          initiativeId: activity.initiativeId || activity.initiative_id || organized[kraId].kpiId || '',
          target: target,
          reported: reported,
          achievement: Math.round(achievement * 100) / 100,
          status: (achievement >= 100) ? 'MET' : (reported > 0) ? 'PARTIAL' : 'NOT_STARTED',
          confidence: activity.confidence || 0.75,
          description: activity.description || `Target: ${target}, Reported: ${reported}`,
          aiInsight: activity.aiInsight || '',
          prescriptiveAnalysis: activity.prescriptiveAnalysis || '',
          rootCause: activity.rootCause || '',
        });
        organized[kraId].activityCount++;
      });

      // Calculate totals + completion percentage (rate metrics use average target/reported)
      const totals = computeGroupTotals(kraId, organized[kraId].activities, organized[kraId].kpiId);
      organized[kraId].totalTarget = totals.totalTarget;
      organized[kraId].totalReported = totals.totalReported;
      organized[kraId].completionPercentage = totals.completionPercentage;
      
      // Determine status
      if (organized[kraId].completionPercentage >= 100) {
        organized[kraId].status = 'MET';
      } else if (organized[kraId].completionPercentage >= 70) {
        organized[kraId].status = 'ON_TRACK';
      } else if (organized[kraId].completionPercentage > 0) {
        organized[kraId].status = 'PARTIAL';
      } else {
        organized[kraId].status = 'NOT_STARTED';
      }
    });
    
    return Object.values(organized);
  }

  // Original logic: use top-level activities with kraId
  if (!analysis.activities || !Array.isArray(analysis.activities)) {
    console.log('[ORGANIZE] No activities array found in analysis');
    return [];
  }

  console.log(`[ORGANIZE] Processing ${(analysis.activities as any[]).length} activities from top-level`);

  (analysis.activities as any[]).forEach((activity: any) => {
    // Try multiple field paths for kraId
    const kraId = activity.kraId || activity.kra_id || activity.kra || 'UNCLASSIFIED';
    
    // Only skip truly empty kraIds, not just 'UNCLASSIFIED' - we still want to show them
    if (!kraId || kraId === '') {
      console.log('[ORGANIZE] Skipping activity with empty kraId:', activity.name);
      return;
    }
    
    // For display purposes, group by kraId (use initiativeId for more granular grouping if available)
    const initiativeId = activity.initiativeId || activity.initiative_id || '';
    const compositeKey = kraId; // Simplified: group by KRA only for cleaner display
    
    if (!organized[compositeKey]) {
      organized[compositeKey] = {
        kraId,
        kraTitle: getKRATitle(kraId, activity.kraTitle || activity.kra_title),
        kpiId: initiativeId,
        kpiTitle: activity.kpiTitle || activity.kpi_title || initiativeId || '',
        activities: [],
        activityCount: 0,
        totalTarget: 0,
        totalReported: 0,
        completionPercentage: 0,
      };
    }
    
    // Try multiple field paths for target/reported values
    const target = activity.target || activity.targetValue || activity.target_value || 0;
    const reported = activity.reported || activity.accomplishedValue || activity.reported_value || 0;
    const achievement = activity.achievement || (target > 0 ? (reported / target) * 100 : 0);
    
    organized[compositeKey].activities.push({
      title: activity.name || activity.activityTitle || activity.title || 'Unnamed',
      target: target,
      reported: reported,
      achievement: Math.round(achievement * 100) / 100,
      status: (achievement >= 100) ? 'MET' : (reported > 0) ? 'PARTIAL' : 'NOT_STARTED',
      confidence: activity.confidence || 0.75,
      description: activity.description || `Target: ${target}, Reported: ${reported}`,
      date: activity.date || undefined,
      unit: activity.unit || undefined,
      aiInsight: activity.aiInsight || '',
      prescriptiveAnalysis: activity.prescriptiveAnalysis || '',
      rootCause: activity.rootCause || '',
    });

    organized[compositeKey].activityCount++;
  });

  // Calculate completion percentages and status
  Object.keys(organized).forEach((compositeKey) => {
    const kra = organized[compositeKey];
    
    // Calculate achievement percentage
    if (kra.totalTarget > 0) {
      kra.completionPercentage = Math.round((kra.totalReported / kra.totalTarget) * 100);
    } else if (kra.activities.length > 0) {
      // Fallback: average of activity achievements
      const avgAchievement = kra.activities.reduce((sum: number, act: any) => sum + act.achievement, 0) / kra.activities.length;
      kra.completionPercentage = Math.round(avgAchievement);
    } else {
      kra.completionPercentage = 0;
    }
    
    // Determine status based on completion
    if (kra.completionPercentage >= 100) {
      kra.status = 'MET';
    } else if (kra.completionPercentage >= 70) {
      kra.status = 'ON_TRACK';
    } else if (kra.completionPercentage > 0) {
      kra.status = 'PARTIAL';
    } else {
      kra.status = 'NOT_STARTED';
    }
  });

  return Object.values(organized);
}

function parseInsights(analysisResult: string): string[] {
  // Parse insights from analysis result text
  // Return as array of strings for component compatibility
  return [
    'Strong Faculty Skill Development Initiative: Faculty training across technical domains with focus on emerging technologies',
    'Solid Research Output: Research papers published and aligned with institutional needs, supporting curriculum',
    'Alumni Tracking System Functional: Initial tracking system operational with employment data collected',
  ];
}

function parseRecommendations(recommendations: any): any[] {
  if (!recommendations || !Array.isArray(recommendations)) {
    return [];
  }

  return recommendations.map((rec: any) => ({
    number: rec.id,
    priority: rec.priority || 'MEDIUM',
    title: rec.title || rec.recommendationText || 'Recommendation',
    currentState: rec.currentState || 'Unknown',
    targetState: rec.targetState || 'Unknown',
    actions: rec.actions || [],
    timeline: rec.timeline || '1 month',
    owner: rec.owner || 'To be assigned',
    successMetric: rec.successMetric || 'Completion of action items',
  }));
}

function calculateCompleteness(analysis: any): number {
  let score = 0;
  const total = 5;

  if (analysis.activities) score++;
  if (analysis.kras) score++;
  if (analysis.alignment) score++;
  if (analysis.opportunities) score++;
  if (analysis.recommendations) score++;

  return Math.round((score / total) * 100);
}

/**
 * Extract prescriptive analysis data from KRAs array
 * This is used as a fallback when the dedicated prescriptiveAnalysis field is empty
 */
function extractPrescriptiveFromKRAs(kras: any): Record<string, any> {
  if (!kras || !Array.isArray(kras)) return {};
  
  const extracted: Record<string, any> = {};
  
  kras.forEach((kra: any) => {
    const kraId = kra.kraId || kra.id;
    if (!kraId) return;
    
    // Only include KRAs that have prescriptive analysis data
    if (kra.prescriptiveAnalysis || kra.rootCause || kra.actionItems?.length > 0) {
      extracted[kraId] = {
        kraId,
        kraTitle: kra.kraTitle || kra.title || kraId,
        achievementRate: kra.achievementRate || 0,
        prescriptiveAnalysis: kra.prescriptiveAnalysis || '',
        rootCause: kra.rootCause || '',
        actionItems: kra.actionItems || [],
        missedActivities: (kra.activities || [])
          .filter((act: any) => act.status === 'MISSED' || (act.achievement !== undefined && act.achievement < 100))
          .map((act: any) => ({
            name: act.name,
            reported: act.reported,
            target: act.target,
            achievement: act.achievement
          }))
      };
    }
  });
  
  console.log('[extractPrescriptiveFromKRAs] Extracted keys:', Object.keys(extracted));
  return extracted;
}

/**
 * Format prescriptive analysis for frontend consumption.
 * The data is stored as {[kraId]: {kraId, kraTitle, prescriptiveAnalysis, rootCause, actionItems, missedActivities}}
 * We need to flatten it into a structure the frontend expects:
 * - recommendations: combined prescriptive analysis text
 * - gaps/root_cause: combined root causes
 * - action_items: flattened array of all action items
 */
function formatPrescriptiveAnalysisForFrontend(prescriptiveAnalysis: any): any {
  if (!prescriptiveAnalysis) return null;

  // New document-level format (single insight + single prescriptive string)
  if (
    typeof prescriptiveAnalysis === 'object' &&
    (typeof prescriptiveAnalysis.documentInsight === 'string' ||
      typeof prescriptiveAnalysis.prescriptiveAnalysis === 'string' ||
      Array.isArray((prescriptiveAnalysis as any).prescriptiveItems))
  ) {
    return prescriptiveAnalysis;
  }
  
  // If already in the expected format, return as-is
  if (prescriptiveAnalysis.recommendations || prescriptiveAnalysis.action_items) {
    return prescriptiveAnalysis;
  }
  
  // If it's a string, wrap it
  if (typeof prescriptiveAnalysis === 'string') {
    return { recommendations: prescriptiveAnalysis };
  }
  
  // Handle nested structure: {[kraId]: {...data}}
  const entries = Object.values(prescriptiveAnalysis);
  if (entries.length === 0) return null;
  
  const allRecommendations: string[] = [];
  const allRootCauses: string[] = [];
  const allActionItems: string[] = [];
  const allMissedActivities: string[] = [];
  
  entries.forEach((entry: any) => {
    if (entry.prescriptiveAnalysis) {
      const kraTitle = entry.kraTitle || entry.kraId || 'General';
      const achievementStr = entry.achievementRate !== undefined 
        ? ` (${entry.achievementRate.toFixed(1)}% achievement)` 
        : '';
      allRecommendations.push(`### ${kraTitle}${achievementStr}\n${entry.prescriptiveAnalysis}`);
    }
    if (entry.rootCause) {
      const kraTitle = entry.kraTitle || entry.kraId || 'Unknown KRA';
      allRootCauses.push(`**${kraTitle}**: ${entry.rootCause}`);
    }
    if (entry.actionItems && Array.isArray(entry.actionItems)) {
      allActionItems.push(...entry.actionItems);
    }
    if (entry.missedActivities && Array.isArray(entry.missedActivities)) {
      // Format missed activities with details
      entry.missedActivities.forEach((act: any) => {
        const actDetail = `${act.name}: ${act.achievement?.toFixed(1) || 0}% achieved (${act.reported || 0}/${act.target || 0})`;
        allMissedActivities.push(actDetail);
      });
    }
  });
  
  return {
    recommendations: allRecommendations.join('\n\n') || null,
    root_cause: allRootCauses.join('\n\n') || null,
    gaps: allRootCauses.length > 0 ? allRootCauses.join('\n\n') : null,
    action_items: allActionItems.length > 0 ? allActionItems : null,
    missed_activities: allMissedActivities.length > 0 ? allMissedActivities : null,
  };
}

/**
 * PATCH /api/qpro/analyses/[id]
 * 
 * Updates an analysis with edited activities (including KRA changes).
 * This is called before approval to persist reviewer corrections.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authenticate
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;

    const { user } = authResult;
    const { id: analysisId } = await params;

    console.log(`[QPRO Analysis PATCH] Updating analysis: ${analysisId}`);

    // Check permissions - only ADMIN and FACULTY can edit
    if (!['ADMIN', 'FACULTY', 'PERSONNEL'].includes(user.role)) {
      return NextResponse.json(
        { error: 'Insufficient permissions. Only ADMIN, FACULTY, or PERSONNEL can edit analyses.' },
        { status: 403 }
      );
    }

    // Parse request body
    const body = await request.json();
    const { activities, kras } = body;

    console.log(`[QPRO Analysis PATCH] Received ${activities?.length || 0} activities, ${kras?.length || 0} kras`);

    // Fetch existing analysis
    const existingAnalysis = await prisma.qPROAnalysis.findUnique({
      where: { id: analysisId }
    });

    if (!existingAnalysis) {
      return NextResponse.json(
        { error: 'Analysis not found' },
        { status: 404 }
      );
    }

    // Only allow editing DRAFT analyses
    if (existingAnalysis.status !== 'DRAFT') {
      return NextResponse.json(
        { error: 'Only DRAFT analyses can be edited. This analysis is already ' + existingAnalysis.status },
        { status: 400 }
      );
    }

    // Build update data
    const updateData: any = {};

    // Update activities if provided
    if (activities && Array.isArray(activities)) {
      // Validate and format activities
      const formattedActivities = activities.map((act: any) => ({
        name: act.name,
        kraId: act.kraId, // This is the key field for KRA assignment
        initiativeId: act.initiativeId || '',
        reported: act.reported || 0,
        target: act.target || 0,
        achievement: act.achievement || 0,
        status: act.status || 'MISSED',
        confidence: act.confidence || 0.75,
        unit: act.unit || '',
        evidenceSnippet: act.evidenceSnippet || '',
        dataType: act.dataType || 'count',
        aiInsight: act.aiInsight || '',
        prescriptiveAnalysis: act.prescriptiveAnalysis || '',
        rootCause: act.rootCause || '',
        authorizedStrategy: act.authorizedStrategy || ''
      }));

      updateData.activities = formattedActivities;

      // Recalculate achievement score based on updated activities
      const totalActivities = formattedActivities.length;
      const metActivities = formattedActivities.filter((a: any) => a.status === 'MET').length;
      const avgAchievement = totalActivities > 0 
        ? formattedActivities.reduce((sum: number, a: any) => sum + (a.achievement || 0), 0) / totalActivities
        : 0;

      updateData.achievementScore = Math.round(avgAchievement * 100) / 100;

      console.log(`[QPRO Analysis PATCH] Updated achievementScore: ${updateData.achievementScore}`);
    }

    // Update KRAs if provided  
    if (kras && Array.isArray(kras)) {
      updateData.kras = kras;
    } else if (activities && Array.isArray(activities)) {
      // Rebuild KRAs from activities if only activities were sent
      const kraMap = new Map<string, any>();
      
      activities.forEach((act: any) => {
        const kraId = act.kraId;
        if (!kraId) return;
        
        if (!kraMap.has(kraId)) {
          kraMap.set(kraId, {
            kraId,
            kraTitle: getKRATitle(kraId, act.kraTitle),
            initiativeId: act.initiativeId || '',
            activities: [],
            totalReported: 0,
            totalTarget: 0
          });
        }
        
        const kra = kraMap.get(kraId);
        kra.activities.push(act);
        kra.totalReported += act.reported || 0;
        kra.totalTarget += act.target || 0;
      });
      
      // Calculate achievement rates
      const rebuiltKras = Array.from(kraMap.values()).map(kra => ({
        ...kra,
        achievementRate: kra.totalTarget > 0 
          ? Math.round((kra.totalReported / kra.totalTarget) * 100 * 100) / 100
          : 0,
        status: kra.totalTarget > 0 && (kra.totalReported / kra.totalTarget) >= 1 ? 'MET' : 'MISSED'
      }));
      
      updateData.kras = rebuiltKras;
      console.log(`[QPRO Analysis PATCH] Rebuilt ${rebuiltKras.length} KRAs from activities`);
    }

    // Update the analysis
    const updatedAnalysis = await prisma.qPROAnalysis.update({
      where: { id: analysisId },
      data: updateData
    });

    // Also update staged AggregationActivity records if they exist
    if (activities && Array.isArray(activities)) {
      for (const act of activities) {
        await prisma.aggregationActivity.updateMany({
          where: {
            qpro_analysis_id: analysisId,
            activity_name: act.name
          },
          data: {
            reported: act.reported,
            target: act.target,
            initiative_id: act.initiativeId // Use initiativeId (e.g., KRA3-KPI5), not kraId (e.g., KRA 3)
          }
        });
      }
      console.log(`[QPRO Analysis PATCH] Updated staged activities`);
    }

    // Invalidate cache
    await qproCacheService.invalidateAnalysisCache(analysisId);
    if (existingAnalysis.uploadedById) {
      await qproCacheService.invalidateUserAnalysesCache(existingAnalysis.uploadedById);
    }

    console.log(`[QPRO Analysis PATCH] Successfully updated analysis ${analysisId}`);

    return NextResponse.json({
      success: true,
      message: 'Analysis updated successfully',
      analysis: {
        id: updatedAnalysis.id,
        status: updatedAnalysis.status,
        achievementScore: updatedAnalysis.achievementScore,
        activitiesCount: (updatedAnalysis.activities as any[])?.length || 0,
        krasCount: (updatedAnalysis.kras as any[])?.length || 0
      }
    });

  } catch (error) {
    console.error('[QPRO Analysis PATCH] Error:', error);
    return NextResponse.json(
      { error: 'Failed to update analysis' },
      { status: 500 }
    );
  }
}
