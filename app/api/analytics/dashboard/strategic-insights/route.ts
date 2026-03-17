import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth-middleware";

interface PriorityInsight {
  id: string;
  qproId: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  action: string;
  relatedKpiId?: string;
  kraName?: string;
  responsibleOffice?: string;
  timeframe?: string;
  achievementScore: number | null;
  unitAcronym: string;
  unitName: string;
  year: number;
  quarter: number;
  date: string;
}

interface InsightsApiResponse {
  insights: PriorityInsight[];
  summary: {
    totalAnalyses: number;
    unitsBelowThreshold: number;
    averageAchievement: number;
  };
}

const PRIORITY_ORDER: Record<string, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
};

export async function GET(request: NextRequest): Promise<NextResponse<InsightsApiResponse | { error: string }>> {
  try {
    const authResult = await requireAuth(request);
    if ("status" in authResult) return authResult as NextResponse<{ error: string }>;
    const { user } = authResult;

    const { searchParams } = new URL(request.url);
    const filterUnitId = searchParams.get('unitId');
    const filterYear = searchParams.get('year') ? parseInt(searchParams.get('year') as string) : undefined;
    const filterQuarter = searchParams.get('quarter') ? parseInt(searchParams.get('quarter') as string) : undefined;

    // Build the query where clause
    const where: any = {
      status: "APPROVED",
    };

    if (filterUnitId) {
      where.unitId = filterUnitId;
    } else if (user.role !== "ADMIN" && user.role !== "SUPERADMIN") {
      if (user.unitId) {
        where.unitId = user.unitId;
      }
    }

    if (filterYear) where.year = filterYear;
    if (filterQuarter) where.quarter = filterQuarter;

    // Fetch the analyses with structured prescriptive data
    const analyses = await prisma.qPROAnalysis.findMany({
      where,
      select: {
        id: true,
        documentTitle: true,
        achievementScore: true,
        prescriptiveAnalysis: true,
        kras: true,
        year: true,
        quarter: true,
        createdAt: true,
        unit: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    });

    // Build the flat insights array from prescriptiveItems
    const allInsights: PriorityInsight[] = [];

    for (const analysis of analyses) {
      const prescriptive = analysis.prescriptiveAnalysis as any;
      if (!prescriptive || !Array.isArray(prescriptive.prescriptiveItems) || prescriptive.prescriptiveItems.length === 0) {
        continue;
      }

      const krasArray = (analysis.kras as any[]) ?? [];

      prescriptive.prescriptiveItems.forEach((item: any, index: number) => {
        const title: string = item.title ?? '';
        const action: string = item.action ?? '';

        // Skip items that lack meaningful content
        if (!title || !action) return;

        const rawPriority = (item.priority ?? 'MEDIUM').toString().toUpperCase();
        const priority = (['HIGH', 'MEDIUM', 'LOW'].includes(rawPriority) ? rawPriority : 'MEDIUM') as 'HIGH' | 'MEDIUM' | 'LOW';

        const relatedKpiId: string | undefined = item.relatedKpiId || undefined;
        const responsibleOffice: string | undefined = item.responsibleOffice || undefined;
        const timeframe: string | undefined = item.timeframe || undefined;

        // Derive kraName from relatedKpiId (e.g. "KRA3-KPI2" -> "KRA3")
        let kraName: string | undefined;
        if (relatedKpiId) {
          const kraIdMatch = relatedKpiId.match(/^(KRA\d+)/i);
          if (kraIdMatch) {
            const kraIdPart = kraIdMatch[1].toUpperCase().replace(/\s+/g, '');
            const matchedKra = krasArray.find((k: any) => {
              const normalised = (k.kraId ?? '').toString().toUpperCase().replace(/\s+/g, '');
              return normalised === kraIdPart;
            });
            if (matchedKra) {
              kraName = matchedKra.kraTitle;
            }
          }
        }

        allInsights.push({
          id: `${analysis.id}-item-${index}`,
          qproId: analysis.id,
          priority,
          title,
          action,
          relatedKpiId,
          kraName,
          responsibleOffice,
          timeframe,
          achievementScore: (analysis.achievementScore as number | null) ?? null,
          unitAcronym: analysis.unit?.code || 'LSPU',
          unitName: analysis.unit?.name || '',
          year: analysis.year,
          quarter: analysis.quarter,
          date: analysis.createdAt.toISOString(),
        });
      });
    }

    // Sort: priority HIGH -> MEDIUM -> LOW, then achievementScore ascending (null treated as 100)
    allInsights.sort((a, b) => {
      const priorityDiff = (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1);
      if (priorityDiff !== 0) return priorityDiff;
      const scoreA = a.achievementScore ?? 100;
      const scoreB = b.achievementScore ?? 100;
      return scoreA - scoreB;
    });

    // Cap at 8 items
    const insights = allInsights.slice(0, 8);

    // Compute summary from the full analyses array (before the 8-item cap)
    const scores = analyses
      .map((a) => a.achievementScore as number | null)
      .filter((s): s is number => s !== null);

    const summary = {
      totalAnalyses: analyses.length,
      unitsBelowThreshold: scores.filter((s) => s < 60).length,
      averageAchievement:
        scores.length > 0
          ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
          : 0,
    };

    return NextResponse.json({ insights, summary });
  } catch (error) {
    console.error("Error fetching strategic insights:", error);
    return NextResponse.json(
      { error: "Failed to fetch strategic insights" },
      { status: 500 }
    );
  }
}
