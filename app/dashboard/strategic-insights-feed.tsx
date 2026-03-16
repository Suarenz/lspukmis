"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Lightbulb, ArrowUpRight, Loader2, Target, CalendarDays } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import AuthService from "@/lib/services/auth-service";
import { formatDistanceToNow } from "date-fns";

interface Insight {
  id: string;
  qproId: string;
  type: 'OPPORTUNITY' | 'RECOMMENDATION';
  content: string;
  documentTitle: string;
  unitAcronym: string;
  unitName: string;
  year: number;
  quarter: number;
  date: string;
}

// Client-side safety net for any markdown artifacts that slip through the API
const stripMarkdownArtifacts = (text: string): string => {
  return text
    .replace(/#{1,6}\s*/g, '')
    .replace(/\*{1,3}(.*?)\*{1,3}/g, '$1')
    .replace(/_{1,2}(.*?)_{1,2}/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
};

export function StrategicInsightsFeed() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [insights, setInsights] = useState<Insight[]>([]);
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
            Authorization: `Bearer ${token}`
          }
        });

        if (!response.ok) {
          throw new Error("Failed to fetch strategic insights");
        }

        const data: Insight[] = await response.json();
        setInsights(data);
        setError(null);
      } catch (err) {
        console.error("Error fetching insights:", err);
        setError("Failed to load strategic insights.");
      } finally {
        setIsLoading(false);
      }
    };

    fetchInsights();
  }, [isAuthenticated, authLoading]);

  // Handle Loading State
  if (isLoading || authLoading) {
    return (
      <Card className="h-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-amber-500" />
            Strategic Insights & Opportunities
          </CardTitle>
          <CardDescription>AI-extracted insights from approved unit reports</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center items-center py-10">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  // Handle Error State
  if (error) {
    return (
      <Card className="h-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-amber-500" />
            Strategic Insights & Opportunities
          </CardTitle>
          <CardDescription>AI-extracted insights from approved unit reports</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="p-4 text-center text-sm text-destructive bg-destructive/10 rounded-lg">
            {error}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Handle Empty State
  if (insights.length === 0) {
    return (
      <Card className="h-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-amber-500" />
            Strategic Insights & Opportunities
          </CardTitle>
          <CardDescription>AI-extracted insights from approved unit reports</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
            <Target className="w-10 h-10 mb-3 opacity-20" />
            <p>No recent insights found.</p>
            <p className="text-sm">Approve more QPRO analyses to generate insights.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full w-full max-h-[400px] flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Lightbulb className="w-5 h-5 text-amber-500" />
          Strategic Insights & Opportunities
        </CardTitle>
        <CardDescription>AI-extracted insights from approved unit reports</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 overflow-auto pr-2 custom-scrollbar">
        <div className="space-y-4">
          {insights.map((insight) => (
            <div 
              key={insight.id} 
              className="group flex flex-col gap-2 p-3 text-sm border rounded-lg hover:border-primary/50 transition-colors bg-card/50"
            >
              <div className="flex items-center justify-between gap-2">
                <Badge variant={insight.type === 'OPPORTUNITY' ? 'default' : 'secondary'} className="text-[10px] h-5 px-1.5 font-medium">
                  {insight.type === 'OPPORTUNITY' ? (
                    <ArrowUpRight className="w-3 h-3 mr-1" />
                  ) : (
                    <Target className="w-3 h-3 mr-1" />
                  )}
                  {insight.type}
                </Badge>
                <div className="flex items-center text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground/80 mr-2">{insight.unitAcronym}</span>
                  <CalendarDays className="w-3 h-3 mr-1" />
                  <span>Q{insight.quarter} {insight.year}</span>
                </div>
              </div>
              
              <p className="text-foreground/90 leading-relaxed font-medium">
                &ldquo;{stripMarkdownArtifacts(insight.content)}&rdquo;
              </p>
              
              <div className="flex justify-between items-center mt-1 pt-2 border-t border-border/50 text-xs text-muted-foreground">
                <span className="truncate max-w-[70%]" title={insight.documentTitle}>
                  Ref: {insight.documentTitle}
                </span>
                <span>
                  {formatDistanceToNow(new Date(insight.date), { addSuffix: true })}
                </span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
