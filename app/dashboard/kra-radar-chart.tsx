"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import AuthService from "@/lib/services/auth-service";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface RadarData {
  kra: string;
  title: string;
  achievement: number;
  fullAchievement: number;
}

export function KraRadarChart() {
  const [data, setData] = useState<RadarData[]>([]);
  const [loading, setLoading] = useState(true);
  const { isAuthenticated } = useAuth();
  const { toast } = useToast();

  useEffect(() => {
    async function fetchData() {
      if (!isAuthenticated) return;
      try {
        setLoading(true);
        const token = await AuthService.getAccessToken();
        const response = await fetch("/api/analytics/dashboard/kra-radar", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error("Failed to fetch KRA radar data");
        }

        const json = await response.json();
        setData(json);
      } catch (error) {
        console.error("Error fetching KRA radar data:", error);
        toast({
          title: "Error",
          description: "Failed to load KRA radar data",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [isAuthenticated, toast]);

  if (loading) {
    return (
      <Card className="col-span-1 border-t-4 border-t-amber-500">
        <CardHeader>
          <CardTitle>Key Result Areas</CardTitle>
          <CardDescription>Overall Achievement Distribution</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-[300px]">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card className="col-span-1 border-t-4 border-t-amber-500">
        <CardHeader>
          <CardTitle>Key Result Areas</CardTitle>
          <CardDescription>Overall Achievement Distribution</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-[300px] text-muted-foreground">
          No KRA data available
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="col-span-1 border-t-4 border-t-amber-500">
      <CardHeader>
        <CardTitle>Key Result Areas</CardTitle>
        <CardDescription>Overall Achievement Distribution</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart cx="50%" cy="50%" outerRadius="80%" data={data}>
              <PolarGrid />
              <PolarAngleAxis dataKey="kra" tick={{ fill: 'currentColor' }} />
              <PolarRadiusAxis angle={30} domain={[0, 100]} />
              <Tooltip
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const data = payload[0].payload as RadarData;
                    return (
                      <div className="rounded-lg border bg-background p-2 shadow-sm">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="flex flex-col">
                            <span className="text-[0.70rem] uppercase text-muted-foreground">
                              {data.kra}
                            </span>
                            <span className="font-bold text-muted-foreground">
                              {data.title}
                            </span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[0.70rem] uppercase text-muted-foreground">
                              Achievement
                            </span>
                            <span className="font-bold">
                              {data.fullAchievement}%
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  }
                  return null;
                }}
              />
              <Radar
                name="Achievement"
                dataKey="achievement"
                stroke="#f59e0b"
                fill="#f59e0b"
                fillOpacity={0.6}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
