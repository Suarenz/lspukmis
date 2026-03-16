import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth } from "@/lib/middleware/auth-middleware";

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;
    const { user } = authResult;

    // Get all units with document counts and QPRO analysis counts
    const units = await prisma.unit.findMany({
      select: {
        id: true,
        name: true,
        code: true,
        _count: {
          select: {
            documents: true,
            qproAnalyses: true,
          }
        }
      },
    });

    // Format and sort by score descending
    const leaderboard = units.map(unit => ({
      id: unit.id,
      name: unit.name,
      code: unit.code,
      documentCount: unit._count.documents,
      qproCount: unit._count.qproAnalyses,
      score: unit._count.documents + (unit._count.qproAnalyses * 5), // arbitrary scoring: 1 pt per doc, 5 per QPRO
    })).sort((a, b) => b.score - a.score);

    return NextResponse.json({
      leaderboard,
      userUnitId: user.unitId || null,
    });
  } catch (error) {
    console.error("Error fetching unit leaderboard:", error);
    return NextResponse.json(
      { error: "Failed to fetch unit leaderboard" },
      { status: 500 }
    );
  }
}