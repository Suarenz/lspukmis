import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import { qproAnalysisService } from '@/lib/services/qpro-analysis-service';
import { targetAggregationService } from '@/lib/services/target-aggregation-service';
import { strategicPlanService } from '@/lib/services/strategic-plan-service';
import { BlobServiceClient } from '@azure/storage-blob';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { computeAggregatedAchievement, getInitiativeTargetMeta, normalizeKraId } from '@/lib/utils/qpro-aggregation';
import { qproCacheService } from '@/lib/services/qpro-cache-service';

const prisma = new PrismaClient();

// Initialize Azure Blob Storage client
const blobServiceClient = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING!
);

/**
 * POST /api/qpro-with-aggregation
 * 
 * Complete QPRO analysis + aggregation workflow
 * Analyzes document AND calculates achievement metrics
 * Returns both insights AND aggregation results for dashboard display
 */
export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const authResult = await requireAuth(request);
    if ('status' in authResult) {
      return authResult;
    }

    const { user } = authResult;
    const formData = await request.formData();

    const file = formData.get('file') as File;
    const documentTitle = formData.get('documentTitle') as string;
    const requestedUnitId = formData.get('unitId') as string | null;
    const year = parseInt(formData.get('year') as string) || 2025;
    const quarter = parseInt(formData.get('quarter') as string) || 1;

    // Enforce unitId based on role
    const unitId = user.role === 'ADMIN' ? requestedUnitId : user.unitId;

    // Debug logging
    console.log('[QPRO-WITH-AGGREGATION] Request received:', {
      file: file ? `File: ${file.name}` : 'NO FILE',
      documentTitle: documentTitle ? `Title: ${documentTitle}` : 'NO TITLE',
      unitId,
      year,
      quarter,
    });

    // Validate required fields
    if (!file || !(file instanceof File) || !documentTitle) {
      console.error('[QPRO-WITH-AGGREGATION] Validation failed:', {
        hasFile: !!file,
        isFile: file instanceof File,
        hasDocumentTitle: !!documentTitle,
      });
      return NextResponse.json(
        { error: 'Missing required fields: file, documentTitle' },
        { status: 400 }
      );
    }

    // Validate file type (support both PDF and DOCX)
    if (!file.type || (file.type !== 'application/pdf' && file.type !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')) {
      return NextResponse.json({ error: 'Only PDF and DOCX files are allowed' }, { status: 400 });
    }

    // Validate file size (limit to 10MB)
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: 'File size exceeds 10MB limit' }, { status: 400 });
    }

    // Step 1: Upload file to Azure Blob Storage using user-based organization
    const containerName = 'qpro-files';
    const fileName = `${uuidv4()}_${file.name}`;
    const blobName = `${user.id}/${fileName}`; // User-based path without container prefix
    
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    // Convert File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Upload the file to Azure Blob Storage
    console.log('[QPRO-WITH-AGGREGATION] Uploading file to blob storage:', { containerName, blobName });
    await blockBlobClient.uploadData(buffer, {
      blobHTTPHeaders: {
        blobContentType: file.type
      }
    });
    console.log('[QPRO-WITH-AGGREGATION] File uploaded successfully to:', blobName);

    // Step 2: Create Document record in database (required for foreign key)
    // The document is also added to the repository section for proper document organization
    const documentId = uuidv4();
    const document = await prisma.document.create({
      data: {
        id: documentId,
        title: documentTitle,
        description: `QPRO document uploaded by ${user.name || user.email} for Q${quarter} ${year}`,
        category: 'QPRO',
        tags: [],
        uploadedBy: user.name || user.email,
        uploadedById: user.id,
        fileUrl: blockBlobClient.url, // Use the Azure Blob URL
        fileName: fileName,
        fileType: file.type,
        fileSize: file.size,
        blobName: blobName, // Store the blob path for file operations
        unitId: unitId || user.unitId || null,
        year: year, // Reporting year (2025-2029)
        quarter: quarter, // Reporting quarter (1-4)
        isQproDocument: true, // Flag for QPRO documents
        colivaraProcessingStatus: 'PENDING', // Set initial Colivara processing status
        status: 'ACTIVE', // Mark as ACTIVE so it appears in search results
      }
    });
    console.log('[QPRO-WITH-AGGREGATION] Document record created:', documentId, `for Q${quarter} ${year} in unit:`, unitId || user.unitId);

    // Step 2.5: Trigger Colivara indexing for AI-powered search
    // This runs asynchronously and doesn't block the QPRO analysis
    try {
      console.log(`[QPRO-WITH-AGGREGATION] Starting Colivara indexing for document ${documentId}`);
      const base64Content = buffer.toString('base64');
      
      const ColivaraService = (await import('@/lib/services/colivara-service')).default;
      const colivaraService = new ColivaraService();
      await colivaraService.initialize();
      
      // Start indexing in background - this will update document status automatically
      colivaraService.indexDocument(documentId, base64Content).then((success) => {
        if (success) {
          console.log(`[QPRO-WITH-AGGREGATION] ✅ Colivara indexing started for document ${documentId}`);
        } else {
          console.error(`[QPRO-WITH-AGGREGATION] ❌ Colivara indexing failed for document ${documentId}`);
        }
      }).catch((error) => {
        console.error(`[QPRO-WITH-AGGREGATION] ❌ Colivara indexing error:`, error);
      });
    } catch (colivaraError) {
      console.error(`[QPRO-WITH-AGGREGATION] ❌ Error starting Colivara indexing:`, colivaraError);
      // Don't fail the upload if Colivara fails - the document is still created
    }

    // Step 3: Create QPRO analysis with aggregation calculation
    const qproAnalysis = await qproAnalysisService.createQPROAnalysis({
      documentId: document.id,
      documentTitle: document.title,
      documentPath: blobName, // Use the correct blob path without container prefix
      documentType: file.type,
      uploadedById: user.id,
      unitId: unitId || undefined,
      year,
      quarter,
    });

    console.log('[QPRO-WITH-AGGREGATION] QPROAnalysis created:', {
      id: qproAnalysis.id,
      documentId: qproAnalysis.documentId,
      documentTitle: qproAnalysis.documentTitle,
      hasKras: !!qproAnalysis.kras,
    });

    // Step 4: Get calculated aggregation metrics for dashboard display
    const aggregationMetrics = await getAggregationMetricsForDisplay(
      qproAnalysis.kras as any,
      year,
      quarter
    );

    // Step 5: Build comprehensive response with both insights + metrics
    const response = {
      success: true,
      analysis: {
        id: qproAnalysis.id,
        title: qproAnalysis.documentTitle,
        alignment: qproAnalysis.alignment,
        opportunities: qproAnalysis.opportunities,
        gaps: qproAnalysis.gaps,
        recommendations: qproAnalysis.recommendations,
        achievementScore: qproAnalysis.achievementScore,
        createdAt: qproAnalysis.createdAt,
      },
      kras: qproAnalysis.kras,
      aggregation: {
        metrics: aggregationMetrics.summary,
        byKra: aggregationMetrics.byKra,
        dashboard: {
          totalKRAs: aggregationMetrics.summary.totalKRAs,
          metKRAs: aggregationMetrics.summary.metKRAs,
          missedKRAs: aggregationMetrics.summary.missedKRAs,
          onTrackKRAs: aggregationMetrics.summary.onTrackKRAs,
          overallAchievementPercent: aggregationMetrics.summary.overallAchievementPercent,
        },
      },
      message:
        'QPRO analysis completed with aggregation metrics calculated and dashboard ready for display',
    };

    console.log('[QPRO-WITH-AGGREGATION] Response about to be sent:', {
      success: response.success,
      analysisId: response.analysis.id,
      hasAggregation: !!response.aggregation,
    });

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    console.error('========== ERROR IN QPRO WITH AGGREGATION ==========');
    console.error('Error type:', error instanceof Error ? error.constructor.name : typeof error);
    console.error('Error message:', error instanceof Error ? error.message : String(error));
    console.error('Full error:', error);
    if (error instanceof Error && error.stack) {
      console.error('Stack trace:', error.stack);
    }
    console.error('====================================================');
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorDetails = error instanceof Error ? error.message : 'Unknown error occurred';
    
    return NextResponse.json(
      {
        error: 'Failed to process QPRO analysis',
        details: errorDetails,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      },
      { status: 500 }
    );
  }
}

/**
 * Helper function to calculate aggregation metrics for dashboard display
 */
async function getAggregationMetricsForDisplay(
  kras: any[],
  year: number,
  quarter: number
) {
  try {
    const plan = await strategicPlanService.getStrategicPlan();

    const byKra: any[] = [];
    let totalKRAs = 0;
    let metKRAs = 0;
    let missedKRAs = 0;
    let onTrackKRAs = 0;
    let totalAchievement = 0;

    // Process each KRA to calculate aggregation.
    // IMPORTANT: derive a SINGLE target per KPI from the strategic plan (do not sum per-activity targets).
    for (const kra of kras || []) {
      const kraId = kra.kraId || kra.kra_id;
      const kraTitle = kra.kraTitle || kra.kra_title || 'Unknown';
      
      if (!kraId) continue;

      try {
        const activities = Array.isArray(kra.activities) ? kra.activities : [];

        // Group by initiativeId so target is applied once per KPI
        const byInitiative = new Map<string, any[]>();
        for (const act of activities) {
          const initiativeId = String(act.initiativeId || act.initiative_id || '').trim() || `${kraId}-KPI1`;
          if (!byInitiative.has(initiativeId)) byInitiative.set(initiativeId, []);
          byInitiative.get(initiativeId)!.push(act);
        }

        const initiativeMetrics = Array.from(byInitiative.entries()).map(([initiativeId, acts]) => {
          const meta = getInitiativeTargetMeta(plan as any, String(kraId), initiativeId, year);
          const fallbackTarget = typeof acts[0]?.initiativeTarget === 'number'
            ? acts[0].initiativeTarget
            : (typeof acts[0]?.target === 'number' ? acts[0].target : Number(acts[0]?.target || 0));
          const targetValue = meta.targetValue ?? (Number.isFinite(fallbackTarget) && fallbackTarget > 0 ? fallbackTarget : 0);

          const aggregated = computeAggregatedAchievement({
            targetType: meta.targetType,
            targetValue,
           targetScope: meta.targetScope,
            activities: acts,
          });

          return {
            initiativeId,
            targetType: meta.targetType,
            totalReported: aggregated.totalReported,
            totalTarget: aggregated.totalTarget,
            achievementPercent: aggregated.achievementPercent,
          };
        });

        const achievementRate = initiativeMetrics.length > 0
          ? initiativeMetrics.reduce((sum, m) => sum + (m.achievementPercent || 0), 0) / initiativeMetrics.length
          : 0;

        // For display, total targets/reporteds sum across KPIs (not across activities)
        const totalReported = initiativeMetrics.reduce((sum, m) => sum + (typeof m.totalReported === 'number' ? m.totalReported : 0), 0);
        const targetValue = initiativeMetrics.reduce((sum, m) => sum + (typeof m.totalTarget === 'number' ? m.totalTarget : 0), 0);

        // Determine status based on achievement rate
        let status: 'MET' | 'MISSED' | 'ON_TRACK' = 'MISSED';
        if (achievementRate >= 100) {
          status = 'MET';
        } else if (achievementRate >= 80) {
          status = 'ON_TRACK';
        }

        // Create message based on status and metrics
        let message = '';
        if (status === 'MET') {
          message = `Target exceeded with ${achievementRate.toFixed(1)}% achievement (Reported: ${totalReported}, Target: ${targetValue})`;
        } else if (status === 'ON_TRACK') {
          message = `On track with ${achievementRate.toFixed(1)}% achievement (Reported: ${totalReported}, Target: ${targetValue})`;
        } else {
          const gap = targetValue - totalReported;
          message = `Gap of ${gap} units to target (${achievementRate.toFixed(1)}% achievement, Reported: ${totalReported}, Target: ${targetValue})`;
        }

        byKra.push({
          kraId,
          kraTitle,
          reported: totalReported,
          target: targetValue,
          achieved: totalReported,
          achievementPercent: achievementRate,
          status,
          message,
        });

        totalKRAs++;
        totalAchievement += achievementRate;

        switch (status) {
          case 'MET':
            metKRAs++;
            break;
          case 'MISSED':
            missedKRAs++;
            break;
          case 'ON_TRACK':
            onTrackKRAs++;
            break;
        }
      } catch (kraError) {
        console.error(`Error processing KRA ${kraId}:`, kraError);
        // Continue processing other KRAs
      }
    }

    const overallAchievementPercent = totalKRAs > 0 ? totalAchievement / totalKRAs : 0;

    console.log('[AGGREGATION METRICS] Calculation complete:', {
      totalKRAs,
      metKRAs,
      onTrackKRAs,
      missedKRAs,
      overallAchievementPercent: Math.round(overallAchievementPercent * 100) / 100,
    });

    return {
      summary: {
        totalKRAs,
        metKRAs,
        missedKRAs,
        onTrackKRAs,
        overallAchievementPercent: Math.round(overallAchievementPercent * 100) / 100,
        year,
        quarter,
      },
      byKra,
    };
  } catch (error) {
    console.error('Error in getAggregationMetricsForDisplay:', error);
    return {
      summary: {
        totalKRAs: 0,
        metKRAs: 0,
        missedKRAs: 0,
        onTrackKRAs: 0,
        overallAchievementPercent: 0,
        year,
        quarter,
      },
      byKra: [],
    };
  }
}
