"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import AuthService from "@/lib/services/auth-service";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loader2, CheckCircle2, TrendingUp, XCircle, Activity } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface GaugeData {
  overallScore: number;
  metCount: number;
  onTrackCount: number;
  missedCount: number;
  notApplicableCount: number;
  totalKPIs: number;
  analysisCount: number;
  dataSource: "aggregated" | "analyses" | "none";
  year: number;
  quarter: number | null;
  unitName: string | null;
}

// ─── SVG arc constants ──────────────────────────────────────────────
// The gauge is a semi-circle arc drawn on a 200×115 viewBox.
// Center: (100, 100), radius: 80
// Arc goes counterclockwise (sweep-flag=0) from left (20,100)
// through the visual top (100,20) to right (180,100).
const CX = 100;
const CY = 100;
const R = 80;
const STROKE_WIDTH = 16;

/** Full background semi-circle path */
const BG_PATH = `M ${CX - R},${CY} A ${R},${R} 0 0 0 ${CX + R},${CY}`;

/**
 * Builds the SVG arc path proportional to the given score (0–100).
 * Returns an empty string for score ≤ 0; returns the full background
 * path for score ≥ 100.
 */
function buildScorePath(score: number): string {
  if (score <= 0) return "";
  if (score >= 100) return BG_PATH;

  // Map score 0–100 to SVG angle 180°–360°.
  // At 180° (score=0)  → left  point (CX−R, CY)
  // At 270° (score=50) → top   point (CX, CY−R)  [y-axis is flipped in SVG]
  // At 360° (score=100)→ right point (CX+R, CY)
  const endAngleDeg = 180 + (score / 100) * 180;
  const endAngleRad = (endAngleDeg * Math.PI) / 180;
  const endX = (CX + R * Math.cos(endAngleRad)).toFixed(3);
  const endY = (CY + R * Math.sin(endAngleRad)).toFixed(3);

  // Arc angle = score/100 * 180°, which is always ≤ 180°, so large-arc-flag = 0.
  return `M ${CX - R},${CY} A ${R},${R} 0 0 0 ${endX},${endY}`;
}

function getScoreColor(score: number): string {
  if (score >= 75) return "#16a34a"; // green-600
  if (score >= 50) return "#d97706"; // amber-600
  return "#dc2626"; // red-600
}

function getScoreLabel(score: number): string {
  if (score >= 75) return "On Track";
  if (score >= 50) return "Needs Attention";
  return "At Risk";
}

// ─── Component ──────────────────────────────────────────────────────

export function PerformanceGauge() {
  const [data, setData] = useState<GaugeData | null>(null);
  const [loading, setLoading] = useState(true);
  const { isAuthenticated } = useAuth();
  const { toast } = useToast();

  useEffect(() => {
    async function fetchData() {
      if (!isAuthenticated) return;
      try {
        setLoading(true);
        const token = await AuthService.getAccessToken();
        const response = await fetch(
          "/api/analytics/dashboard/performance-gauge",
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!response.ok) throw new Error("Failed to fetch gauge data");
        const json: GaugeData = await response.json();
        setData(json);
      } catch (err) {
        console.error("Performance gauge error:", err);
        toast({
          title: "Error",
          description: "Could not load performance data.",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [isAuthenticated, toast]);

  // ── Derived values ────────────────────────────────────────────────
  const score = data?.overallScore ?? 0;
  const color = getScoreColor(score);
  const scorePath = buildScorePath(score);
  const hasData = data !== null && data.dataSource !== "none";

  const scopeLabel = data?.unitName ?? "Institution-wide";
  const quarterLabel = data?.quarter ? `Q${data.quarter}` : "All Quarters";
  const yearLabel = data?.year ?? new Date().getFullYear();

  // ── Loading skeleton ──────────────────────────────────────────────
  if (loading) {
    return (
      <Card className="col-span-1 border-t-4 border-t-emerald-500">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-500" />
            Performance Health
          </CardTitle>
          <CardDescription>Overall Achievement Score</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-[310px]">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="col-span-1 border-t-4 border-t-emerald-500">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-emerald-500" />
          Performance Health
        </CardTitle>
        <CardDescription>
          {scopeLabel} · {yearLabel} · {quarterLabel}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col items-center gap-4 pt-0">
        {/* ── SVG Gauge ─────────────────────────────────────────── */}
        <div className="w-full max-w-[200px]">
          <svg
            viewBox="0 0 200 115"
            className="w-full"
            aria-label={`Performance score: ${score}%`}
            role="img"
          >
            {/* Soft glow behind the score arc */}
            {hasData && scorePath && (
              <path
                d={scorePath}
                fill="none"
                stroke={color}
                strokeWidth={STROKE_WIDTH + 8}
                strokeLinecap="round"
                opacity="0.12"
              />
            )}

            {/* Background track */}
            <path
              d={BG_PATH}
              fill="none"
              stroke="#e5e7eb"
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
            />

            {/* Score arc */}
            {hasData && scorePath && (
              <path
                d={scorePath}
                fill="none"
                stroke={color}
                strokeWidth={STROKE_WIDTH}
                strokeLinecap="round"
              />
            )}

            {/* Tick markers at 25 %, 50 %, 75 % */}
            {[25, 50, 75].map((pct) => {
              const angleDeg = 180 + (pct / 100) * 180;
              const angleRad = (angleDeg * Math.PI) / 180;
              const innerR = R - STROKE_WIDTH / 2 - 4;
              const outerR = R + STROKE_WIDTH / 2 + 4;
              const x1 = (CX + innerR * Math.cos(angleRad)).toFixed(2);
              const y1 = (CY + innerR * Math.sin(angleRad)).toFixed(2);
              const x2 = (CX + outerR * Math.cos(angleRad)).toFixed(2);
              const y2 = (CY + outerR * Math.sin(angleRad)).toFixed(2);
              return (
                <line
                  key={pct}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="#d1d5db"
                  strokeWidth="1.5"
                />
              );
            })}

            {/* Score number */}
            <text
              x={CX}
              y={CY - 14}
              textAnchor="middle"
              style={{
                fontSize: "36px",
                fontWeight: 700,
                fill: hasData ? color : "#9ca3af",
              }}
            >
              {hasData ? `${score}` : "—"}
            </text>

            {/* Percent sign and label */}
            {hasData && (
              <text
                x={CX}
                y={CY + 6}
                textAnchor="middle"
                style={{ fontSize: "11px", fill: "#6b7280", fontWeight: 500 }}
              >
                out of 100%
              </text>
            )}

            {/* Status label */}
            <text
              x={CX}
              y={CY + 20}
              textAnchor="middle"
              style={{
                fontSize: "10px",
                fontWeight: 600,
                fill: hasData ? color : "#9ca3af",
              }}
            >
              {hasData ? getScoreLabel(score) : "No data yet"}
            </text>
          </svg>
        </div>

        {/* ── Status pills (aggregated data only) ───────────────── */}
        {hasData && data.dataSource === "aggregated" && data.totalKPIs > 0 && (
          <div className="flex items-center gap-2 flex-wrap justify-center w-full">
            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium bg-green-50 text-green-700 border border-green-200">
              <CheckCircle2 className="w-3 h-3" />
              {data.metCount} Met
            </span>
            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
              <TrendingUp className="w-3 h-3" />
              {data.onTrackCount} On Track
            </span>
            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium bg-red-50 text-red-700 border border-red-200">
              <XCircle className="w-3 h-3" />
              {data.missedCount} Missed
            </span>
          </div>
        )}

        {/* ── Fallback copy for analysis-based scores ───────────── */}
        {hasData && data.dataSource === "analyses" && (
          <p className="text-xs text-muted-foreground text-center">
            Based on{" "}
            <span className="font-medium text-foreground">
              {data.analysisCount}
            </span>{" "}
            submitted {data.analysisCount === 1 ? "report" : "reports"}
          </p>
        )}

        {/* ── Empty state ───────────────────────────────────────── */}
        {!hasData && (
          <div className="flex flex-col items-center gap-1 text-center px-4">
            <p className="text-sm font-medium text-muted-foreground">
              No performance data yet
            </p>
            <p className="text-xs text-muted-foreground">
              Submit QPRO reports to see your institutional health score.
            </p>
          </div>
        )}

        {/* ── Footer metadata ───────────────────────────────────── */}
        {hasData && (
          <p className="text-[10px] text-muted-foreground/60 text-center">
            {data.dataSource === "aggregated"
              ? `${data.totalKPIs} KPI${data.totalKPIs !== 1 ? "s" : ""} tracked`
              : `Average across ${data.analysisCount} ${data.analysisCount === 1 ? "report" : "reports"}`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
