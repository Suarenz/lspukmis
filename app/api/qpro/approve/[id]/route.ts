import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';
import targetAggregationService from '@/lib/services/target-aggregation-service';
import strategicPlanService from '@/lib/services/strategic-plan-service';
import { qproCacheService } from '@/lib/services/qpro-cache-service';
import { normalizeKraId } from '@/lib/utils/qpro-aggregation';

/**
 * POST /api/qpro/approve/[id]
 * 
 * Approves a QPro analysis and commits staged activities to the live dashboard.
 * This endpoint:
 * 1. Updates the QPROAnalysis status from DRAFT to APPROVED
 * 2. Creates/updates KRAggregation records for each KRA
 * 3. Links staged AggregationActivity records to the live aggregation
 * 4. Recalculates achievement percentages
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    console.log('[Approve API] POST request received');
    
    // Authenticate user
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;

    const { user } = authResult;
    const { id: analysisId } = await params;
    
    console.log(`[Approve API] Approving analysis ${analysisId} by user ${user.email} (${user.role})`);

    // Check permissions - only ADMIN and FACULTY can approve
    if (!['ADMIN', 'FACULTY', 'PERSONNEL'].includes(user.role)) {
      return NextResponse.json(
        { error: 'Insufficient permissions. Only ADMIN, FACULTY, or PERSONNEL can approve analyses.' },
        { status: 403 }
      );
    }

    // Fetch the analysis to approve
    const analysis = await prisma.qPROAnalysis.findUnique({
      where: { id: analysisId },
      include: {
        unit: true,
        user: true
      }
    });

    if (!analysis) {
      return NextResponse.json(
        { error: 'Analysis not found' },
        { status: 404 }
      );
    }

    // Check if already approved
    if (analysis.status === 'APPROVED') {
      return NextResponse.json(
        { error: 'Analysis is already approved' },
        { status: 400 }
      );
    }

    // Get the staged activities for this analysis
    const stagedActivities = await prisma.aggregationActivity.findMany({
      where: {
        qpro_analysis_id: analysisId,
        isApproved: false
      }
    });

    const toFiniteNumber = (raw: unknown): number | null => {
      if (raw === null || raw === undefined) return null;
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, '').trim());
      return Number.isFinite(n) ? n : null;
    };

    // Normalize a percentage measurement from a staged activity.
    // - Accept 0..100 as-is
    // - If reported is a count and target is a denominator, convert to percent
    const normalizePercentFromActivity = (reportedRaw: unknown, denomRaw: unknown): number | null => {
      const reported = toFiniteNumber(reportedRaw);
      if (reported === null) return null;

      if (reported >= 0 && reported <= 100) return reported;

      const denom = toFiniteNumber(denomRaw);
      if (denom !== null && denom > 0 && reported >= 0) {
        const pct = (reported / denom) * 100;
        if (pct >= 0 && pct <= 100) return pct;
      }

      return null;
    };

    console.log(`[Approve API] Approving analysis ${analysisId} with ${stagedActivities.length} staged activities`);

    // Parse KRAs from the analysis (for reference only)
    const kras = analysis.kras as any[];

    if (stagedActivities.length === 0) {
      return NextResponse.json(
        { error: 'No staged activities found to approve' },
        { status: 400 }
      );
    }

    // Build unique KRA+initiative pairs from staged activities (the actual source of truth)
    const kraInitiativePairs = new Map<string, { kraId: string; initiativeId: string }>();
    for (const activity of stagedActivities) {
      if (activity.initiative_id) {
        // Extract KRA ID from initiative_id (e.g., "KRA3-KPI5" -> "KRA3")
        const kraMatch = activity.initiative_id.match(/^(KRA\s?\d+)/i);
        const kraId = kraMatch ? kraMatch[1] : null;
        
        if (kraId) {
          const key = `${kraId}|${activity.initiative_id}`;
          if (!kraInitiativePairs.has(key)) {
            kraInitiativePairs.set(key, {
              kraId: kraId,
              initiativeId: activity.initiative_id,
            });
          }
        }
      }
    }

    console.log(`[Approve API] Found ${kraInitiativePairs.size} unique KRA+initiative pairs from staged activities`);

    // Begin transaction to update aggregation tables
    await prisma.$transaction(async (tx) => {
      // 1. Update analysis status to APPROVED
      // CRITICAL: Explicitly preserve prescriptiveAnalysis field by not including it in update
      // (Prisma only updates specified fields, so omitting it keeps existing value)
      console.log(`[Approve API] Preserving prescriptiveAnalysis:`, 
        analysis.prescriptiveAnalysis ? 'exists' : 'null',
        typeof analysis.prescriptiveAnalysis
      );
      
      await tx.qPROAnalysis.update({
        where: { id: analysisId },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approvedById: user.id,
          // Explicitly preserve prescriptiveAnalysis to ensure it's not lost
          // This is a safety measure - Prisma shouldn't clear it, but we're being explicit
          prescriptiveAnalysis: analysis.prescriptiveAnalysis || undefined
        }
      });

      // 2. Process each unique KRA+initiative pair and update aggregation
      console.log(`[Approve API] Processing ${kraInitiativePairs.size} unique KRA+Initiative pairs`);
      
      for (const [, pair] of kraInitiativePairs) {
        const { kraId, initiativeId } = pair;

        const normalizedKraId = normalizeKraId(kraId);
        
        console.log(`[Approve API] Processing pair: KRA=${kraId} (normalized: ${normalizedKraId}), Initiative=${initiativeId}`);

        // Phase 3: Query KPITarget table for target_type (database-backed targets)
        // Fall back to strategic plan if no database target exists
        const reportYear = analysis.year || 2025;
        const reportQuarter = analysis.quarter || 1;
        
        const dbTarget = await tx.kPITarget.findFirst({
          where: {
            kra_id: normalizedKraId,
            initiative_id: initiativeId,
            year: reportYear,
            quarter: reportQuarter
          }
        });

        // Get target metadata from strategic plan (fallback)
        const target = await strategicPlanService.getInitiative(normalizedKraId, initiativeId);
        
        // Use database target_type if available, otherwise fall back to strategic plan
        const targetType = dbTarget 
          ? dbTarget.target_type.toLowerCase() 
          : (target?.targets?.type || 'count').toLowerCase();

        // Calculate reported value for this initiative from STAGED aggregation activities (source of truth)
        const stagedForInitiative = stagedActivities.filter(
          (a) => a.initiative_id === initiativeId
        );

        const numericReportedValues = stagedForInitiative
          .map((a) => (typeof a.reported === 'number' ? a.reported : null))
          .filter((v): v is number => v != null);

        const reportedDelta = (() => {
          if (targetType === 'percentage') {
            const percentValues = stagedForInitiative
              .map((a) => normalizePercentFromActivity(a.reported, a.target))
              .filter((v): v is number => v !== null);

            if (percentValues.length === 0) return 0;
            const avg = percentValues.reduce((sum, v) => sum + v, 0) / percentValues.length;
            return Math.round(avg);
          }

          if (numericReportedValues.length === 0) return 0;
          return numericReportedValues.reduce((sum, v) => sum + v, 0);
        })();

        const existingAggregation = await tx.kRAggregation.findUnique({
          where: {
            unique_aggregation: {
              year: reportYear,
              quarter: reportQuarter,
              kra_id: normalizedKraId,
              initiative_id: initiativeId,
            },
          },
        });

        const previousTotal = existingAggregation?.total_reported ?? 0;
        const previousCount = existingAggregation?.submission_count ?? 0;
        const previousParticipating =
          (existingAggregation?.participating_units as string[] | null) || [];

        const participatingUnits = (() => {
          if (!analysis.unitId) return previousParticipating;
          if (previousParticipating.includes(analysis.unitId)) return previousParticipating;
          return [...previousParticipating, analysis.unitId];
        })();

        const newTotalReported = (() => {
          // Phase 3: Updated aggregation logic for new target types
          
          // SNAPSHOT: Latest value only (faculty count, student population)
          // Don't sum - just take the most recent value
          if (targetType === 'snapshot') {
            return reportedDelta; // Always use latest value, ignore previous
          }

          // For ALL other types (COUNT, RATE, PERCENTAGE, FINANCIAL):
          // Store the cumulative SUM of all contributions
          // The kpi-progress API will calculate average for rate/percentage when displaying
          return previousTotal + reportedDelta;
        })();

        const targetValue = dbTarget
          ? dbTarget.target_value.toNumber() // Use database target if available
          : (target?.targets?.timeline_data?.find((t: any) => t.year === reportYear)?.target_value || 1);

        // For RATE/PERCENTAGE types, calculate the AVERAGE to pass to aggregation calculation
        // This is because calculatePercentageAggregation expects a value 0-100, not cumulative sum
        const newSubmissionCount = (existingAggregation?.submission_count ?? 0) + 1;
        const valueForCalculation = (() => {
          const type = targetType.toLowerCase();
          if (type === 'rate' || type === 'percentage') {
            // Pass average value for rate/percentage types
            return newTotalReported / newSubmissionCount;
          }
          // For all other types, pass the cumulative value
          return newTotalReported;
        })();

        const metrics = await targetAggregationService.calculateAggregation(
          normalizedKraId,
          initiativeId,
          reportYear,
          valueForCalculation,
          targetType
        );

        // Get KRA title from strategic plan - find the KRA that contains this initiative
        const kraData = kras?.find((k: any) => {
          const normalizedId = normalizeKraId(k.kra_id || k.kraId);
          return normalizedId === normalizedKraId;
        });
        const kraTitle = kraData?.kra_title || kraData?.kraTitle || normalizedKraId;

        const aggregation = await (async () => {
          if (!existingAggregation) {
            return tx.kRAggregation.create({
              data: {
                year: reportYear,
                quarter: reportQuarter,
                kra_id: normalizedKraId,
                kra_title: kraTitle,
                initiative_id: initiativeId,
                total_reported: newTotalReported,
                target_value: targetValue,
                target_type: targetType.toUpperCase() as any, // Store the target type
                achievement_percent: metrics.achievementPercent,
                submission_count: 1,
                participating_units: participatingUnits,
                status: metrics.status as any,
                updated_by: user.id,
              },
            });
          }

          return tx.kRAggregation.update({
            where: { id: existingAggregation.id },
            data: {
              total_reported: newTotalReported,
              submission_count: { increment: 1 },
              target_type: targetType.toUpperCase() as any, // Update target type in case it changed
              achievement_percent: metrics.achievementPercent,
              status: metrics.status as any,
              last_updated: new Date(),
              updated_by: user.id,
              participating_units: participatingUnits,
            },
          });
        })();

        // 3. Link staged activities to the aggregation
        await tx.aggregationActivity.updateMany({
          where: {
            qpro_analysis_id: analysisId,
            initiative_id: initiativeId,
            isApproved: false,
          },
          data: {
            aggregation_id: aggregation.id,
            isApproved: true,
          },
        });

        // 4. Create KPIContribution record to track this document's contribution
        // This enables accurate deduction when a document is deleted (solving "memory loss")
        
        // DEFENSIVE VALIDATION: Ensure target_type is always set and valid
        // This prevents the aggregation bug where target_type wasn't being read correctly
        if (!targetType || typeof targetType !== 'string') {
          console.error(`[Approve API] ⚠️  CRITICAL: Invalid target_type for ${initiativeId}. Got: ${targetType} (type: ${typeof targetType})`);
          throw new Error(`Invalid target_type for ${initiativeId}: expected string, got ${typeof targetType}`);
        }
        
        const normalizedTargetType = targetType.toLowerCase().trim();
        const validTypes = ['count', 'snapshot', 'rate', 'percentage', 'milestone', 'boolean', 'financial', 'text_condition'];
        
        if (!validTypes.includes(normalizedTargetType)) {
          console.warn(`[Approve API] ⚠️  Unusual target_type "${normalizedTargetType}" for ${initiativeId}, defaulting to "count"`);
        }
        
        console.log(`[Approve API] ✓ Validated target_type for ${initiativeId}: "${normalizedTargetType}" (source: ${dbTarget ? 'database' : 'strategic plan'})`);
        
        const contribution = await tx.kPIContribution.upsert({
          where: {
            unique_contribution_per_analysis_kpi: {
              analysis_id: analysisId,
              initiative_id: initiativeId,
            },
          },
          create: {
            kra_id: normalizedKraId,
            initiative_id: initiativeId,
            document_id: analysis.documentId,
            analysis_id: analysisId,
            unit_id: analysis.unitId,
            value: reportedDelta,
            year: reportYear,
            quarter: reportQuarter,
            target_type: normalizedTargetType,
            created_by: user.id,
          },
          update: {
            value: reportedDelta,
            target_type: normalizedTargetType,
          },
        });
        
        console.log(`[Approve API] ✓ Created/Updated KPIContribution: analysis=${analysisId}, unit=${analysis.unitId}, kpi=${initiativeId}, Q${reportQuarter} ${reportYear}, value=${reportedDelta}, target_type="${normalizedTargetType}", id=${contribution.id}`);
      }
    });

    console.log(`[Approve API] Successfully approved analysis ${analysisId} with ${kraInitiativePairs.size} KPI aggregations`);

    // Invalidate analysis caches when approved
    const analysisDoc = await prisma.qPROAnalysis.findUnique({
      where: { id: analysisId },
      select: { documentId: true, uploadedById: true }
    });
    
    if (analysisDoc) {
      await qproCacheService.invalidateAnalysisCache(analysisDoc.documentId);
      await qproCacheService.invalidateUserAnalysesCache(analysisDoc.uploadedById);
    }

    // Fetch updated analysis
    const updatedAnalysis = await prisma.qPROAnalysis.findUnique({
      where: { id: analysisId },
      include: {
        unit: true,
        user: true
      }
    });

    return NextResponse.json({
      success: true,
      message: 'Analysis approved and committed to dashboard',
      analysis: {
        id: updatedAnalysis?.id,
        status: updatedAnalysis?.status,
        approvedAt: updatedAnalysis?.approvedAt,
        achievementScore: updatedAnalysis?.achievementScore
      }
    });

  } catch (error) {
    console.error('[Approve API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to approve analysis' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/qpro/approve/[id]
 * 
 * Rejects a QPro analysis (sets status to REJECTED).
 * Staged activities remain but are not committed to the live dashboard.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authenticate user
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;

    const { user } = authResult;
    const { id: analysisId } = await params;

    // Check permissions
    if (!['ADMIN', 'FACULTY', 'PERSONNEL'].includes(user.role)) {
      return NextResponse.json(
        { error: 'Insufficient permissions. Only ADMIN, FACULTY, or PERSONNEL can reject analyses.' },
        { status: 403 }
      );
    }

    // Get rejection reason from body
    const body = await request.json().catch(() => ({}));
    const reason = body.reason || 'Rejected by reviewer';

    // Update analysis status to REJECTED
    const analysis = await prisma.qPROAnalysis.update({
      where: { id: analysisId },
      data: {
        status: 'REJECTED',
        // Store rejection reason in prescriptiveAnalysis if needed
        prescriptiveAnalysis: {
          rejectionReason: reason,
          rejectedBy: user.id,
          rejectedAt: new Date().toISOString()
        }
      }
    });

    // Remove staged activities (optional - or keep for audit)
    await prisma.aggregationActivity.deleteMany({
      where: {
        qpro_analysis_id: analysisId,
        isApproved: false
      }
    });

    console.log(`[Approve API] Rejected analysis ${analysisId}: ${reason}`);

    // Invalidate caches when rejected
    const analysisDoc = await prisma.qPROAnalysis.findUnique({
      where: { id: analysisId },
      select: { documentId: true, uploadedById: true }
    });
    
    if (analysisDoc) {
      await qproCacheService.invalidateAnalysisCache(analysisDoc.documentId);
      await qproCacheService.invalidateUserAnalysesCache(analysisDoc.uploadedById);
    }

    return NextResponse.json({
      success: true,
      message: 'Analysis rejected',
      analysis: {
        id: analysis.id,
        status: analysis.status
      }
    });

  } catch (error) {
    console.error('[Approve API] Reject error:', error);
    return NextResponse.json(
      { error: 'Failed to reject analysis' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/qpro/approve/[id]
 * 
 * Get staged analysis details for review before approval.
 * Returns full analysis data with activities, evidence snippets, and prescriptive insights.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authenticate user
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;

    const { id: analysisId } = await params;

    // Fetch analysis with staged activities
    const analysis = await prisma.qPROAnalysis.findUnique({
      where: { id: analysisId },
      include: {
        unit: true,
        user: true
      }
    });

    if (!analysis) {
      return NextResponse.json(
        { error: 'Analysis not found' },
        { status: 404 }
      );
    }

    // Get staged activities
    const stagedActivities = await prisma.aggregationActivity.findMany({
      where: {
        qpro_analysis_id: analysisId
      },
      orderBy: {
        created_at: 'asc'
      }
    });

    // Format response for the review modal
    const kras = analysis.kras as any[] || [];
    const activities = analysis.activities as any[] || [];
    const prescriptiveAnalysis = analysis.prescriptiveAnalysis as Record<string, any> || {};

    const reviewData = {
      id: analysis.id,
      documentTitle: analysis.documentTitle,
      documentType: analysis.documentType,
      status: analysis.status,
      uploadedBy: analysis.user?.name || 'Unknown',
      unit: analysis.unit?.name || 'Unknown',
      year: analysis.year,
      quarter: analysis.quarter,
      achievementScore: analysis.achievementScore,
      createdAt: analysis.createdAt,
      
      // KRA summary with prescriptive insights
      kras: kras.map(kra => ({
        kraId: kra.kraId,
        kraTitle: kra.kraTitle,
        initiativeId: kra.initiativeId,
        achievementRate: kra.achievementRate,
        status: kra.status,
        prescriptive: prescriptiveAnalysis[kra.kraId] || null
      })),
      
      // Activities with evidence snippets
      activities: activities.map(act => {
        const stagedAct = stagedActivities.find(
          sa => sa.initiative_id === act.initiativeId && sa.activity_name === act.name
        );
        return {
          name: act.name,
          kraId: act.kraId,
          initiativeId: act.initiativeId,
          reported: act.reported,
          target: act.target,
          achievement: act.achievement,
          status: act.status || act.suggestedStatus,
          dataType: stagedAct?.dataType || act.dataType,
          evidenceSnippet: stagedAct?.evidenceSnippet || act.evidenceSnippet,
          // Use 'confidence' field name to match frontend expectations
          confidence: stagedAct?.confidenceScore || act.confidence || 0.75,
          rootCause: act.rootCause,
          authorizedStrategy: act.authorizedStrategy
        };
      }),
      
      // Overall insights
      recommendations: analysis.recommendations,
      gaps: analysis.gaps,
      opportunities: analysis.opportunities,
      alignment: analysis.alignment,
      
      // Full prescriptive analysis object for Stage 4 display
      prescriptiveAnalysis: prescriptiveAnalysis
    };

    return NextResponse.json(reviewData);

  } catch (error) {
    console.error('[Approve API] Get error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch analysis details' },
      { status: 500 }
    );
  }
}
