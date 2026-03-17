import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';

interface GaugeResponse {
  overallScore: number;
  metCount: number;
  onTrackCount: number;
  missedCount: number;
  notApplicableCount: number;
  totalKPIs: number;
  analysisCount: number;
  dataSource: 'aggregated' | 'analyses' | 'none';
  year: number;
  quarter: number | null;
  unitName: string | null;
}

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;

    const { user } = authResult;
    const { searchParams } = new URL(request.url);

    const requestedYear = searchParams.get('year')
      ? parseInt(searchParams.get('year') as string)
      : new Date().getFullYear();
    const quarterParam = searchParams.get('quarter');
    const quarter = quarterParam ? parseInt(quarterParam) : null;
    const unitIdParam = searchParams.get('unitId');

    // ADMIN can query any unit; others are always scoped to their own unit
    const effectiveUnitId =
      user.role === 'ADMIN' ? (unitIdParam || null) : (user.unitId || null);

    // Resolve unit display name
    let unitName: string | null = null;
    if (effectiveUnitId) {
      const unit = await prisma.unit.findUnique({
        where: { id: effectiveUnitId },
        select: { name: true, code: true },
      });
      unitName = unit?.code ?? unit?.name ?? null;
    }

    // Try the requested year first; fall back to the previous year when empty
    // (handles the case where data was stored in 2025 but the dashboard is viewed in 2026)
    const yearsToTry = [requestedYear];
    if (requestedYear > 2025) yearsToTry.push(requestedYear - 1);

    for (const year of yearsToTry) {
      // ── Strategy 1: KRAggregation (populated on QPRO approval) ──
      const aggregations = await prisma.kRAggregation.findMany({
        where: {
          year,
          ...(quarter ? { quarter } : {}),
        },
        select: {
          kra_id: true,
          achievement_percent: true,
          status: true,
          participating_units: true,
        },
      });

      // In-memory unit filter (same pattern as the kra-radar route)
      const filtered = effectiveUnitId
        ? aggregations.filter((agg) => {
            const units = agg.participating_units;
            if (!units || !Array.isArray(units)) return false;
            return (units as string[]).includes(effectiveUnitId);
          })
        : aggregations;

      if (filtered.length > 0) {
        const metCount = filtered.filter((a) => a.status === 'MET').length;
        const onTrackCount = filtered.filter((a) => a.status === 'ON_TRACK').length;
        const missedCount = filtered.filter((a) => a.status === 'MISSED').length;
        const notApplicableCount = filtered.filter(
          (a) => a.status === 'NOT_APPLICABLE',
        ).length;

        // Average achievement across scorable KPIs (exclude NOT_APPLICABLE)
        const scorable = filtered.filter(
          (a) => a.achievement_percent !== null && a.status !== 'NOT_APPLICABLE',
        );
        const overallScore =
          scorable.length > 0
            ? Math.round(
                scorable.reduce((sum, a) => sum + Number(a.achievement_percent), 0) /
                  scorable.length,
              )
            : 0;

        return NextResponse.json<GaugeResponse>({
          overallScore: Math.min(overallScore, 100),
          metCount,
          onTrackCount,
          missedCount,
          notApplicableCount,
          totalKPIs: filtered.length,
          analysisCount: filtered.length,
          dataSource: 'aggregated',
          year,
          quarter,
          unitName,
        });
      }

      // ── Strategy 2: QPROAnalysis average achievementScore (draft + approved) ──
      const analysesWhere: Record<string, unknown> = {
        year,
        ...(quarter ? { quarter } : {}),
        achievementScore: { not: null },
      };
      if (effectiveUnitId) {
        analysesWhere.unitId = effectiveUnitId;
      }

      const analyses = await prisma.qPROAnalysis.findMany({
        where: analysesWhere,
        select: { achievementScore: true },
      });

      if (analyses.length > 0) {
        const total = analyses.reduce(
          (sum, a) => sum + (a.achievementScore ?? 0),
          0,
        );
        const avgScore = Math.round(total / analyses.length);

        return NextResponse.json<GaugeResponse>({
          overallScore: Math.min(avgScore, 100),
          metCount: 0,
          onTrackCount: 0,
          missedCount: 0,
          notApplicableCount: 0,
          totalKPIs: 0,
          analysisCount: analyses.length,
          dataSource: 'analyses',
          year,
          quarter,
          unitName,
        });
      }
    }

    // No data found across all tried years
    return NextResponse.json<GaugeResponse>({
      overallScore: 0,
      metCount: 0,
      onTrackCount: 0,
      missedCount: 0,
      notApplicableCount: 0,
      totalKPIs: 0,
      analysisCount: 0,
      dataSource: 'none',
      year: requestedYear,
      quarter,
      unitName,
    });
  } catch (error) {
    console.error('[Performance Gauge API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch performance gauge data' },
      { status: 500 },
    );
  }
}
