"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Zap, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import AuthService from "@/lib/services/auth-service";

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

function PriorityBadge({ priority }: { priority: PriorityInsight['priority'] }) {
  const styles: Record<PriorityInsight['priority'], string> = {
    HIGH:   'bg-red-600 text-white',
    MEDIUM: 'bg-amber-500 text-white',
    LOW:    'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  };
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${styles[priority]}`}>
      {priority}
    </span>
  );
}

function AchievementPill({ score }: { score: number | null }) {
  if (score === null) return null;
  let cls = 'font-bold text-red-600 dark:text-red-400';
  if (score >= 80) cls = 'font-semibold text-green-600 dark:text-green-400';
  else if (score >= 60) cls = 'font-semibold text-amber-600 dark:text-amber-400';
  return (
    <span className={`text-[11px] ${cls}`}>
      {score}%
    </span>
  );
}

function InsightCard({ insight }: { insight: PriorityInsight }) {
  const hasFooter = !!(insight.responsibleOffice || insight.timeframe);

  return (
    <div className="p-3 border rounded-lg bg-card/50 hover:border-primary/40 transition-colors">
      {/* Row 1: priority badge | unit + score | kra tag | quarter/year */}
      <div className="flex items-center flex-wrap gap-1.5 mb-2">
        <PriorityBadge priority={insight.priority} />
        <div className="flex items-center gap-1">
          <span className="text-[11px] font-semibold text-foreground/80">
            {insight.unitAcronym}
          </span>
          <AchievementPill score={insight.achievementScore} />
        </div>
        {insight.kraName && (
          <span className="text-[10px] bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-200 px-1.5 py-0.5 rounded font-medium">
            {insight.kraName}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground ml-auto whitespace-nowrap">
          Q{insight.quarter} {insight.year}
        </span>
      </div>

      {/* Row 2: title */}
      <p className="text-sm font-semibold text-foreground mb-1">
        {insight.title}
      </p>

      {/* Row 3: action */}
      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">
        {insight.action}
      </p>

      {/* Footer: office and timeframe */}
      {hasFooter && (
        <div className="text-xs text-muted-foreground border-t border-border/40 pt-1.5 mt-1">
          {[
            insight.responsibleOffice ? `Office: ${insight.responsibleOffice}` : null,
            insight.timeframe ? `Due: ${insight.timeframe}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
    </div>
  );
}

const EMPTY_SUMMARY: InsightsApiResponse['summary'] = {
  totalAnalyses: 0,
  unitsBelowThreshold: 0,
  averageAchievement: 0,
};

export function StrategicInsightsFeed() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [insights, setInsights] = useState<PriorityInsight[]>([]);
  const [summary, setSummary] = useState<InsightsApiResponse['summary']>(EMPTY_SUMMARY);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || authLoading) return;

    const fetchInsights = async () => {
      try {
        setIsLoading(true);
        const token = await AuthService.getAccessToken();
        const response = await fetch("/api/analytics/dashboard/strategic-insights", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error("Failed to fetch strategic insights");
        }

        const data: InsightsApiResponse = await response.json();
        setInsights(data.insights ?? []);
        setSummary(data.summary ?? EMPTY_SUMMARY);
        setError(null);
      } catch (err) {
        console.error("Error fetching insights:", err);
        setError("Failed to load priority actions.");
      } finally {
        setIsLoading(false);
      }
    };

    fetchInsights();
  }, [isAuthenticated, authLoading]);

  const cardHeader = (
    <CardHeader className="pb-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-500" />
            Priority Actions
          </CardTitle>
          <CardDescription>Top recommended actions from approved unit analyses</CardDescription>
        </div>
        {summary.totalAnalyses > 0 && (
          <span className="text-[11px] text-muted-foreground whitespace-nowrap pt-1 shrink-0">
            {summary.totalAnalyses} analysed&nbsp;&middot;&nbsp;Avg {Math.round(summary.averageAchievement)}%
          </span>
        )}
      </div>
    </CardHeader>
  );

  if (isLoading || authLoading) {
    return (
      <Card className="h-full">
        {cardHeader}
        <CardContent className="flex justify-center items-center py-10">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="h-full">
        {cardHeader}
        <CardContent>
          <div className="p-4 text-center text-sm text-destructive bg-destructive/10 rounded-lg">
            {error}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (insights.length === 0) {
    return (
      <Card className="h-full">
        {cardHeader}
        <CardContent>
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
            <Zap className="w-10 h-10 mb-3 opacity-20" />
            <p className="text-sm font-medium">No priority actions yet.</p>
            <p className="text-sm">Approve more QPRO analyses to generate insights.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full w-full flex flex-col">
      {cardHeader}
      <CardContent className="flex-1 overflow-hidden px-4 pb-4 flex flex-col">
        <div className="flex-1 overflow-auto pr-1 custom-scrollbar min-h-0">
          <div className="space-y-3">
            {insights.slice(0, 6).map((insight) => (
              <InsightCard key={insight.id} insight={insight} />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
