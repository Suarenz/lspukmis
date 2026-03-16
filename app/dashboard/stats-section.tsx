"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, Users, Download, Eye, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import AuthService from "@/lib/services/auth-service";

interface StatCardProps {
  title: string;
  value: string;
  icon: React.ElementType;
  color: string;
  bgColor: string;
  trend?: number;
  neutral?: boolean;
  delay?: number;
}

const TrendIndicator = ({ trend, neutral }: { trend?: number; neutral?: boolean }) => {
  if (trend === undefined || trend === null) return null;

  if (trend > 0) {
    return (
      <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${neutral ? "text-gray-500" : "text-emerald-600"}`}>
        <TrendingUp className="w-3 h-3" />
        +{trend} this week
      </span>
    );
  }
  if (trend < 0) {
    return (
      <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${neutral ? "text-gray-500" : "text-red-500"}`}>
        <TrendingDown className="w-3 h-3" />
        {trend} this week
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-xs font-medium text-gray-400">
      <Minus className="w-3 h-3" />
      No change this week
    </span>
  );
};

const StatCard = ({ stat, delay }: { stat: StatCardProps; delay: number }) => {
  const Icon = stat.icon;
  const style = { animationDelay: `${delay}s` };
  const isZero = stat.value === "0";
  
  return (
    <Card
      key={stat.title}
      className="animate-fade-in hover:shadow-lg transition-shadow border-0 bg-white h-full"
      style={style}
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-gray-500 max-w-[70%] truncate">{stat.title}</CardTitle>
        <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: stat.bgColor }}>
          {Icon ? (
            <Icon className="w-5 h-5" style={{ color: stat.color }} aria-hidden="true" />
          ) : (
            <div className="w-5 h-5 bg-gray-200 rounded-sm flex items-center justify-center">
              <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path fillRule="evenodd" d="M4 3a2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clipRule="evenodd"></path>
              </svg>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isZero ? (
          <div className="text-lg text-gray-400 font-medium">No data yet</div>
        ) : (
          <div className="text-3xl font-bold text-gray-900 truncate">{stat.value}</div>
        )}
        <div className="mt-1">
          <TrendIndicator trend={stat.trend} neutral={stat.neutral} />
        </div>
      </CardContent>
    </Card>
  );
};

export default function StatsSection() {
  const [stats, setStats] = useState<StatCardProps[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();
  const isUnitScoped = user?.role === "FACULTY" || user?.role === "PERSONNEL";

  const fetchStats = async (isPoll: boolean = false) => {
    try {
      if (!isPoll) setLoading(true);
      // Get the access token to ensure it's still valid
      const token = await AuthService.getAccessToken();
      if (!token) {
        // If no token is available, set default stats and stop loading
        setStats([
          {
            title: "Total Documents",
            value: "0",
            icon: FileText,
            color: "#2B4385",
            bgColor: "rgba(43, 67, 133, 0.1)",
          },
          {
            title: "Total Users",
            value: "0",
            icon: Users,
            color: "#2E8B57",
            bgColor: "rgba(46, 139, 87, 0.1)",
          },
          {
            title: "Total Downloads",
            value: "0",
            icon: Download,
            color: "#C04E3A",
            bgColor: "rgba(192, 78, 58, 0.1)",
          },
          {
            title: "Total Views",
            value: "0",
            icon: Eye,
            color: "#2B4385",
            bgColor: "rgba(43, 67, 133, 0.1)",
          },
        ]);
        setLoading(false);
        return;
      }

      const response = await fetch('/api/analytics', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        }
      });
      if (response.ok) {
        const data = await response.json();
        const trends = data.trends || { documents: 0, users: 0, downloads: 0, views: 0 };
        const newStats = [
          {
            title: isUnitScoped ? "Unit Documents" : "Total Documents",
            value: data.totalDocuments.toLocaleString(),
            icon: FileText,
            color: "#2B4385",
            bgColor: "rgba(43, 67, 133, 0.1)",
            trend: trends.documents,
          },
          {
            title: "Total Users",
            value: data.totalUsers.toLocaleString(),
            icon: Users,
            color: "#2E8B57",
            bgColor: "rgba(46, 139, 87, 0.1)",
            trend: trends.users,
            neutral: true,
          },
          {
            title: isUnitScoped ? "Unit Downloads" : "Total Downloads",
            value: data.totalDownloads.toLocaleString(),
            icon: Download,
            color: "#C04E3A",
            bgColor: "rgba(192, 78, 58, 0.1)",
            trend: trends.downloads,
          },
          {
            title: isUnitScoped ? "Unit Views" : "Total Views",
            value: data.totalViews.toLocaleString(),
            icon: Eye,
            color: "#2B4385",
            bgColor: "rgba(43, 67, 133, 0.1)",
            trend: trends.views,
          },
        ];
        setStats(newStats);
      } else if (response.status === 401) {
        // If we get a 401 (unauthorized) error, the token might have expired
        console.error('Authentication token expired, logging out user');
        // Log out the user since token is no longer valid
        await AuthService.logout();
      }
    } catch (error) {
      console.error('Error fetching stats:', error);
    } finally {
      if (!isPoll) setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();

    // Set up polling interval for realtime updates (every 30 seconds)
    const interval = setInterval(() => {
      fetchStats(true);
    }, 30000);

    return () => clearInterval(interval);
  }, []);

 if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8 animate-pulse">
        {[...Array(4)].map((_, index) => (
          <Card key={index} className="border-0 bg-white">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-gray-400">Loading...</CardTitle>
              <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center">
                <div className="w-4 h-4 bg-gray-200 rounded"></div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold bg-gray-100 rounded w-3/4 h-8"></div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8 w-full">
      {stats.map((stat, index) => (
        <StatCard key={stat.title} stat={stat} delay={index * 0.1} />
      ))}
    </div>
  );
}
