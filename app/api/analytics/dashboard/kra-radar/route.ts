import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';
import strategicPlan from '@/lib/data/strategic_plan.json';

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;

    const { user } = authResult;
    const { searchParams } = new URL(request.url);
    const unitId = searchParams.get('unitId');
    const year = searchParams.get('year') ? parseInt(searchParams.get('year') as string) : new Date().getFullYear();
    const quarter = searchParams.get('quarter') ? parseInt(searchParams.get('quarter') as string) : undefined;

    // Determine the effective unit filter
    const effectiveUnitId = user.role === 'ADMIN' ? (unitId || null) : (user.unitId || null);

    // ── Strategy 1: Try KRAggregation table (populated on QPRO approval) ──
    let radarData = await getFromKRAggregation(year, quarter, effectiveUnitId);

    // ── Strategy 2: Fallback to QPROAnalysis.kras JSON (works for DRAFT & APPROVED) ──
    if (radarData.length === 0) {
      radarData = await getFromQPROAnalyses(year, quarter, effectiveUnitId);
    }

    // Sort by KRA ID for consistent display
    radarData.sort((a, b) => a.kra.localeCompare(b.kra, undefined, { numeric: true }));

    // Fill gaps: ensure all KRAs up to the max in use are represented
    const kraNumbers = radarData.map(d => {
      const match = d.kra.match(/\d+/);
      return match ? parseInt(match[0]) : 0;
    });
    const maxKraInUse = Math.max(...kraNumbers, 0);

    if (maxKraInUse > 0) {
      const allKras = strategicPlan.kras;

      const fullRadarData = allKras
        .filter(kra => {
          const num = parseInt(kra.kra_id.match(/\d+/)?.[0] || '0');
          return num <= maxKraInUse;
        })
        .map(kra => {
          const existing = radarData.find(d => d.kra === kra.kra_id);
          return existing || {
            kra: kra.kra_id,
            title: kra.kra_title,
            achievement: 0,
            fullAchievement: 0,
          };
        })
        .sort((a, b) => a.kra.localeCompare(b.kra, undefined, { numeric: true }));

      return NextResponse.json(fullRadarData);
    }

    return NextResponse.json(radarData);
  } catch (error) {
    console.error('[KRA Radar API] Error generating radar data:', error);
    return NextResponse.json(
      { error: 'Failed to generate KRA radar data' },
      { status: 500 }
    );
  }
}

/**
 * Primary source: KRAggregation table (populated when QPRO analyses are approved).
 * Uses direct unitId filtering via participating_units JSON array.
 */
async function getFromKRAggregation(
  year: number,
  quarter: number | undefined,
  unitId: string | null
) {
  // Build where clause without JSON filter first, then apply in-memory filtering
  // to avoid Prisma JSON filter issues across different providers
  const whereClause: any = {
    year,
    ...(quarter ? { quarter } : {}),
  };

  const aggregations = await prisma.kRAggregation.findMany({
    where: whereClause,
    select: {
      kra_id: true,
      kra_title: true,
      achievement_percent: true,
      participating_units: true,
    }
  });

  // Filter by unit in-memory (more reliable than JSON array_contains across DB providers)
  const filtered = unitId
    ? aggregations.filter(agg => {
        const units = agg.participating_units;
        if (!units || !Array.isArray(units)) return false;
        return (units as string[]).includes(unitId);
      })
    : aggregations;

  return buildRadarData(filtered.map(a => ({
    kra_id: a.kra_id,
    kra_title: a.kra_title,
    achievement_percent: a.achievement_percent,
  })));
}

/**
 * Fallback source: QPROAnalysis records with the kras JSON field.
 * Works for both DRAFT and APPROVED analyses, ensuring the chart shows data
 * even before formal approval.
 */
async function getFromQPROAnalyses(
  year: number,
  quarter: number | undefined,
  unitId: string | null
) {
  const whereClause: any = {
    year,
    ...(quarter ? { quarter } : {}),
    kras: { not: null as any },
  };

  if (unitId) {
    whereClause.unitId = unitId;
  }

  const analyses = await prisma.qPROAnalysis.findMany({
    where: whereClause,
    select: {
      kras: true,
      achievementScore: true,
    }
  });

  // Build KRA map from QPROAnalysis.kras JSON
  const kraMap = new Map<string, { total: number; count: number; title: string }>();

  for (const analysis of analyses) {
    const kras = analysis.kras;
    if (!kras || !Array.isArray(kras)) continue;

    for (const kraRaw of kras) {
      const kra = kraRaw as Record<string, any>;
      if (!kra || typeof kra !== 'object') continue;
      const kraId = kra.kraId || kra.kra_id;
      const kraTitle = kra.kraTitle || kra.kra_title || kraId;
      const achievement = kra.achievementRate ?? kra.achievement_percent ?? analysis.achievementScore ?? 0;

      if (!kraId) continue;

      if (!kraMap.has(kraId)) {
        kraMap.set(kraId, { total: 0, count: 0, title: kraTitle });
      }

      const current = kraMap.get(kraId)!;
      current.total += Number(achievement);
      current.count += 1;
    }
  }

  return Array.from(kraMap.entries()).map(([kraId, data]) => {
    const avgAchievement = data.count > 0 ? (data.total / data.count) : 0;
    return {
      kra: kraId,
      title: data.title,
      achievement: Math.min(Math.round(avgAchievement * 10) / 10, 100),
      fullAchievement: Math.round(avgAchievement * 10) / 10,
    };
  });
}

/**
 * Shared: Convert aggregation rows into radar chart data format.
 */
function buildRadarData(
  rows: { kra_id: string; kra_title: string | null; achievement_percent: any }[]
) {
  const kraMap = new Map<string, { total: number; count: number; title: string }>();

  for (const agg of rows) {
    const kraId = agg.kra_id || 'Unknown';
    const achievement = agg.achievement_percent ? Number(agg.achievement_percent) : 0;

    if (!kraMap.has(kraId)) {
      kraMap.set(kraId, { total: 0, count: 0, title: agg.kra_title || kraId });
    }

    const current = kraMap.get(kraId)!;
    current.total += achievement;
    current.count += 1;
  }

  return Array.from(kraMap.entries()).map(([kraId, data]) => {
    const avgAchievement = data.count > 0 ? (data.total / data.count) : 0;
    return {
      kra: kraId,
      title: data.title,
      achievement: Math.min(Math.round(avgAchievement * 10) / 10, 100),
      fullAchievement: Math.round(avgAchievement * 10) / 10,
    };
  });
}
