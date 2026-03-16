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

    // Filter by user role if not admin
    let userUnitFilter: any = {};
    if (user.role !== 'ADMIN' && user.unitId) {
      // Non-admins can only see their unit's data or overall data if explicitly requested
      // Depending on requirements, we restrict to their unit
      userUnitFilter = {
        participating_units: {
          path: '$[*]',
          array_contains: user.unitId,
        }
      };
    }

    if (unitId && user.role === 'ADMIN') {
      userUnitFilter = {
        participating_units: {
          path: '$[*]',
          array_contains: unitId,
        }
      };
    }

    const whereClause: any = {
      year,
      ...(quarter ? { quarter } : {}),
      // We can add JSON array filtering for unit if needed based on `participating_units`
    };

    // Note: JSON filtering on 'participating_units' may require raw queries in Prisma for some dialects,
    // but Prisma supports array_contains for JSON arrays in PostgreSQL since version 4.
    if (Object.keys(userUnitFilter).length > 0) {
      whereClause.participating_units = userUnitFilter.participating_units;
    }

    // Fetch aggregations
    const aggregations = await prisma.kRAggregation.findMany({
      where: whereClause,
      select: {
        kra_id: true,
        kra_title: true,
        achievement_percent: true,
      }
    });

    // Group by KRA and calculate average achievement
    const kraMap = new Map<string, { total: number; count: number; title: string }>();

    for (const agg of aggregations) {
      const kraId = agg.kra_id || 'Unknown';
      const achievement = agg.achievement_percent ? Number(agg.achievement_percent) : 0;
      
      if (!kraMap.has(kraId)) {
        kraMap.set(kraId, { total: 0, count: 0, title: agg.kra_title || kraId });
      }
      
      const current = kraMap.get(kraId)!;
      current.total += achievement;
      current.count += 1;
    }

    // Format for radar chart
    const radarData = Array.from(kraMap.entries()).map(([kraId, data]) => {
      // Calculate average (max 100 for display, though it could be higher)
      const avgAchievement = data.count > 0 ? (data.total / data.count) : 0;
      
      return {
        kra: kraId,
        title: data.title,
        achievement: Math.min(Math.round(avgAchievement * 10) / 10, 100),
        fullAchievement: Math.round(avgAchievement * 10) / 10 // preserve values > 100 if needed
      };
    });

    // Sort by KRA ID for consistent display (e.g., KRA 1, KRA 2, ...)
    radarData.sort((a, b) => a.kra.localeCompare(b.kra, undefined, { numeric: true }));

    // Fill gaps: ensure all KRAs up to the max in use are represented
    // This prevents missing KRA labels on the radar chart (e.g., KRA 4 missing when 1,2,3,5 have data)
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