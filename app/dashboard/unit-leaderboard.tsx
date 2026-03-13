"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import AuthService from "@/lib/services/auth-service";
import { Trophy, FileText, Activity } from "lucide-react";

interface UnitLeaderboardData {
  id: string;
  name: string;
  code: string;
  documentCount: number;
  qproCount: number;
  score: number;
}

export function UnitLeaderboard() {
  const [data, setData] = useState<UnitLeaderboardData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    async function fetchLeaderboard() {
      try {
        const token = await AuthService.getAccessToken();
        const response = await fetch("/api/analytics/dashboard/unit-leaderboard", {
          headers: {
            Authorization: `Bearer ${token}`
          }
        });

        if (!response.ok) {
          throw new Error("Failed to fetch leaderboard");
        }

        const result = await response.json();
        setData(result);
      } catch (error) {
        console.error("Leaderboard error:", error);
        toast({
          title: "Error",
          description: "Could not load unit leaderboard.",
          variant: "destructive"
        });
      } finally {
        setIsLoading(false);
      }
    }

    fetchLeaderboard();
  }, [toast]);

  if (isLoading) {
    return (
      <Card className="h-full w-full max-h-[400px]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="h-5 w-5 text-yellow-500" />
            Unit Leaderboard
          </CardTitle>
          <CardDescription>Top contributing units</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center p-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full w-full max-h-[400px] overflow-hidden flex flex-col">
      <CardHeader className="pb-3 border-b">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Trophy className="h-5 w-5 text-yellow-500" />
              Unit Leaderboard
            </CardTitle>
            <CardDescription className="mt-1">Top units by document and analysis activity</CardDescription>
          </div>
          <div className="flex items-center gap-4 text-xs font-medium text-muted-foreground mr-2">
            <span className="w-10 text-center" title="Documents Uploaded">Docs</span>
            <span className="w-10 text-center" title="QPRO Analyses">Activity</span>
            <span className="w-12 text-right">Rank ✨</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="overflow-y-auto pt-3 custom-scrollbar flex-1">
        <div className="space-y-3">
          {data.slice(0, 5).map((unit, index) => (
            <div key={unit.id} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-3">
                <div className={`flex items-center justify-center w-8 h-8 rounded-full font-bold text-sm ${
                  index === 0 ? "bg-yellow-100 text-yellow-700" :
                  index === 1 ? "bg-gray-200 text-gray-700" :
                  index === 2 ? "bg-orange-100 text-orange-700" :
                  "bg-muted-foreground/20 text-muted-foreground"
                }`}>
                  {index + 1}
                </div>
                <div>
                  <p className="font-semibold text-sm leading-none mb-1">{unit.code}</p>
                  <p className="text-xs text-muted-foreground max-w-[120px] sm:max-w-[200px] truncate" title={unit.name}>
                    {unit.name}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs font-medium mr-2">
                 <div className="w-10 flex items-center justify-center gap-1.5" title="Documents Uploaded">
                   <FileText className="h-3.5 w-3.5 text-blue-500" />
                   <span>{unit.documentCount}</span>
                 </div>
                 <div className="w-10 flex items-center justify-center gap-1.5" title="QPRO Analyses">
                   <Activity className="h-3.5 w-3.5 text-green-500" />
                   <span>{unit.qproCount}</span>
                 </div>
                 <div className="w-12 text-right font-bold text-sm tabular-nums text-primary/80">
                   {unit.score}
                 </div>
              </div>
            </div>
          ))}
          {data.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">No unit activity data available yet.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}