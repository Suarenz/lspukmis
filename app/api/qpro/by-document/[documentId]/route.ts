import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';

/**
 * GET /api/qpro/by-document/[documentId]
 * 
 * Fetches QPRO analysis associated with a specific document
 * Used in the repository preview to show analysis below the document content
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  try {
    // Authenticate
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;

    const { user } = authResult;
    const { documentId } = await params;

    if (!documentId || typeof documentId !== 'string') {
      return NextResponse.json(
        { error: 'Invalid document ID' },
        { status: 400 }
      );
    }

    // Check if document exists and user has access
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, title: true }
    });

    if (!document) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 404 }
      );
    }

    // Find QPRO analysis for this document
    const analysis = await prisma.qPROAnalysis.findFirst({
      where: {
        documentId: documentId
      }
    });

    if (!analysis) {
      // No analysis found - return null to indicate no QPRO analysis
      return NextResponse.json({ analysis: null }, { status: 200 });
    }

    // Check authorization - user must be ADMIN, FACULTY, or the uploader
    if (user.role !== 'ADMIN' && user.role !== 'FACULTY' && user.role !== 'PERSONNEL' && analysis.uploadedById !== user.id) {
      return NextResponse.json(
        { error: 'Unauthorized to view this analysis' },
        { status: 403 }
      );
    }

    // Return analysis with all data needed for display
    return NextResponse.json({
      analysis: {
        id: analysis.id,
        documentId: analysis.documentId,
        documentTitle: analysis.documentTitle,
        status: analysis.status,
        year: analysis.year,
        quarter: analysis.quarter,
        achievementScore: analysis.achievementScore,
        alignment: analysis.alignment,
        opportunities: analysis.opportunities,
        gaps: analysis.gaps,
        recommendations: analysis.recommendations,
        kras: analysis.kras,
        activities: analysis.activities,
        prescriptiveAnalysis: analysis.prescriptiveAnalysis,
        createdAt: analysis.createdAt,
        updatedAt: analysis.updatedAt
      }
    }, { status: 200 });
  } catch (error) {
    console.error('[QPRO by Document] Error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch QPRO analysis' },
      { status: 500 }
    );
  }
}
