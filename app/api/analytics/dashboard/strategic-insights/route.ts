import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth-middleware";

// Strip markdown formatting artifacts from LLM-generated text
const stripMarkdown = (text: string): string => {
  return text
    .replace(/^[-*•]\s*/, '')                      // leading bullets
    .replace(/#{1,6}\s*/g, '')                      // heading markers
    .replace(/\*{1,3}(.*?)\*{1,3}/g, '$1')         // bold/italic with asterisks
    .replace(/_{1,2}(.*?)_{1,2}/g, '$1')            // bold/italic with underscores
    .replace(/`([^`]+)`/g, '$1')                    // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')        // link syntax -> keep text
    .trim();
};

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if ("status" in authResult) return authResult;
    const { user } = authResult;

    const { searchParams } = new URL(request.url);
    const filterUnitId = searchParams.get('unitId');
    const filterYear = searchParams.get('year') ? parseInt(searchParams.get('year') as string) : undefined;
    const filterQuarter = searchParams.get('quarter') ? parseInt(searchParams.get('quarter') as string) : undefined;

    // Build the query where clause
    const where: any = {
      status: "APPROVED",
      // Only include records that have opportunities or recommendations
      OR: [
        { AND: [{ opportunities: { not: null } }, { opportunities: { not: "" } }] },
        { AND: [{ recommendations: { not: null } }, { recommendations: { not: "" } }] }
      ]
    };

    if (filterUnitId) {
      where.unitId = filterUnitId;
    } else if (user.role !== "ADMIN" && user.role !== "SUPERADMIN") {
      // If not admin, maybe restrict to user's unit? 
      // Based on typical RBAC requirements:
      if (user.unitId) {
        where.unitId = user.unitId;
      }
    }

    if (filterYear) where.year = filterYear;
    if (filterQuarter) where.quarter = filterQuarter;

    // Fetch the analyses
    const analyses = await prisma.qPROAnalysis.findMany({
      where,
      select: {
        id: true,
        documentTitle: true,
        opportunities: true,
        recommendations: true,
        year: true,
        quarter: true,
        createdAt: true,
        unit: {
          select: {
            id: true,
            name: true,
            code: true
          }
        }
      },
      orderBy: {
        createdAt: "desc"
      },
      take: 20
    });

    // Transform string data into array points for easier UI rendering
    const insights = analyses.flatMap(analysis => {
      const result = [];
      
      if (analysis.opportunities) {
        // Split on newlines, filter empty lines, map to object
        const opps = analysis.opportunities
          .split('\n')
          .map(line => stripMarkdown(line))
          .filter(Boolean)
          .map(point => ({
            id: `${analysis.id}-opp-${Math.random().toString(36).substr(2, 9)}`,
            qproId: analysis.id,
            type: 'OPPORTUNITY',
            content: point,
            documentTitle: analysis.documentTitle,
            unitAcronym: analysis.unit?.code || 'LSPU',
            unitName: analysis.unit?.name,
            year: analysis.year,
            quarter: analysis.quarter,
            date: analysis.createdAt
          }));
        result.push(...opps);
      }

      if (analysis.recommendations) {
        // Split on newlines, filter empty lines, map to object
        const recs = analysis.recommendations
          .split('\n')
          .map(line => stripMarkdown(line))
          .filter(Boolean)
          .map(point => ({
            id: `${analysis.id}-rec-${Math.random().toString(36).substr(2, 9)}`,
            qproId: analysis.id,
            type: 'RECOMMENDATION',
            content: point,
            documentTitle: analysis.documentTitle,
            unitAcronym: analysis.unit?.code || 'LSPU',
            unitName: analysis.unit?.name,
            year: analysis.year,
            quarter: analysis.quarter,
            date: analysis.createdAt
          }));
        result.push(...recs);
      }
      
      return result;
    });

    return NextResponse.json(insights);
  } catch (error) {
    console.error("Error fetching strategic insights:", error);
    return NextResponse.json(
      { error: "Failed to fetch strategic insights" },
      { status: 500 }
    );
  }
}
