"use client";

import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Activity } from "@/lib/types";
import AuthService from "@/lib/services/auth-service";
import { Upload, Pencil, Trash2, Eye, Download } from "lucide-react";

// Helper function to format dates in a readable way
const formatDate = (timestamp: string | Date) => {
  const date = new Date(timestamp);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  
  if (diffInSeconds < 60) return 'Just now';
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
  if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d ago`;
  
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
};

// Get user initials from name
const getUserInitials = (name: string) => {
  if (!name || name === 'Unknown') return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return parts[0][0].toUpperCase();
};

// Get a consistent color for a user based on their name
const getUserColor = (name: string) => {
  const colors = [
    { bg: 'rgba(43, 67, 133, 0.12)', text: '#2B4385' },
    { bg: 'rgba(46, 139, 87, 0.12)', text: '#2E8B57' },
    { bg: 'rgba(192, 78, 58, 0.12)', text: '#C04E3A' },
    { bg: 'rgba(99, 102, 241, 0.12)', text: '#6366F1' },
    { bg: 'rgba(245, 158, 11, 0.12)', text: '#D97706' },
    { bg: 'rgba(236, 72, 153, 0.12)', text: '#EC4899' },
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

// Get icon based on activity type
const getActivityIcon = (description: string) => {
  const lowerDesc = description.toLowerCase();
  if (lowerDesc.includes('upload') || lowerDesc.includes('added')) {
    return { icon: Upload, color: '#2B4385' };
  }
  if (lowerDesc.includes('edit') || lowerDesc.includes('update') || lowerDesc.includes('modified')) {
    return { icon: Pencil, color: '#C04E3A' };
  }
  if (lowerDesc.includes('delete') || lowerDesc.includes('removed')) {
    return { icon: Trash2, color: '#EF4444' };
  }
  if (lowerDesc.includes('view')) {
    return { icon: Eye, color: '#2E8B57' };
  }
  if (lowerDesc.includes('download')) {
    return { icon: Download, color: '#2B4385' };
  }
  return { icon: Upload, color: '#2B4385' };
};

const ActivityItem = ({ activity, delay }: { activity: Activity; delay?: number }) => {
  const style = delay !== undefined ? { animationDelay: `${delay}s` } : {};
  const { icon: Icon, color: iconColor } = getActivityIcon(activity.description);
  const userColor = getUserColor(activity.user);
  const initials = getUserInitials(activity.user);
  
  return (
    <div
      key={activity.id}
      className="flex items-start gap-3 pb-3 border-b border-gray-100 last:border-0 last:pb-0 animate-fade-in"
      style={style}
    >
      {/* User avatar with initials */}
      <div 
        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold"
        style={{ backgroundColor: userColor.bg, color: userColor.text }}
        title={activity.user}
      >
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 line-clamp-2 leading-snug">{activity.description}</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <Icon className="w-3 h-3 shrink-0" style={{ color: iconColor }} />
          <p className="text-xs text-gray-600 truncate">
            {activity.user}
          </p>
          <span className="text-xs text-gray-400">·</span>
          <p className="text-xs text-gray-500 shrink-0">
            {formatDate(activity.timestamp)}
          </p>
        </div>
      </div>
    </div>
  );
};

export default function ActivitySection() {
  const [recentActivity, setRecentActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRecentActivity = async () => {
      try {
        // Get the access token to ensure it's still valid
        const token = await AuthService.getAccessToken();
        if (!token) {
          // If no token is available, don't make the API call
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
          setRecentActivity(data.recentActivity || []);
        } else if (response.status === 401) {
          // If we get a 401 (unauthorized) error, the token might have expired
          console.error('Authentication token expired, logging out user');
          // Log out the user since token is no longer valid
          await AuthService.logout();
        } else if (response.status === 403) {
          // If we get a 403 (forbidden) error, user doesn't have permission
          console.error('User does not have permission to access recent activity');
          // Set empty array for users without permission
          setRecentActivity([]);
        } else {
          console.error('Failed to fetch recent activity:', response.status);
          // Set empty array if API call fails
          setRecentActivity([]);
        }
      } catch (error) {
        console.error('Error fetching recent activity:', error);
        // Set empty array if there's an error
        setRecentActivity([]);
      } finally {
        setLoading(false);
      }
    };

    fetchRecentActivity();
  }, []);

  if (loading) {
    return (
      <div className="animate-pulse">
        <h2 className="text-2xl font-bold mb-4 text-gray-900">Recent Activity</h2>
        <Card className="border-0 bg-white">
          <CardContent className="pt-6 space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-gray-100"></div>
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-gray-100 rounded w-3/4"></div>
                  <div className="h-3 bg-gray-100 rounded w-1/2"></div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <Card className="border-0 bg-white h-full w-full max-h-[420px] overflow-hidden flex flex-col shadow-sm">
      <div className="px-6 py-4 border-b">
        <h2 className="text-lg font-semibold text-gray-900">Recent Activity</h2>
      </div>
      <CardContent className="pt-6 overflow-y-auto custom-scrollbar flex-1">
          <div className="space-y-4">
            {recentActivity.length > 0 ? (
              recentActivity.map((activity, index) => (
                <ActivityItem key={activity.id} activity={activity} delay={index * 0.1} />
              ))
            ) : (
              <p className="text-sm text-gray-500">No recent activity to display.</p>
            )}
          </div>
        </CardContent>
      </Card>
  );
}
