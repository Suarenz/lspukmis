"use client";

import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BookOpen, Search, Upload, FileText } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

interface QuickActionProps {
  title: string;
  description: string;
  icon: React.ElementType;
  href: string;
  variant: "primary" | "outline";
  delay?: number;
}

const QuickActionCard = ({ action, delay }: { action: QuickActionProps; delay?: number }) => {
  const Icon = action.icon;
  const style = delay !== undefined ? { animationDelay: `${delay}s` } : {};
  const [hovered, setHovered] = useState(false);
  
  return (
    <Link key={action.title} href={action.href}>
      <Card
        className="animate-fade-in hover:shadow-lg transition-all hover:scale-[1.02] cursor-pointer"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          ...style,
          backgroundColor: hovered ? '#2B4385' : '#ffffff',
          borderColor: '#2B4385',
          borderWidth: '1.5px',
          borderStyle: 'solid',
        }}
      >
        <CardHeader>
          <div className="flex items-center gap-3">
            <div style={{
              padding: '10px',
              borderRadius: '12px',
              backgroundColor: hovered ? 'rgba(255,255,255,0.2)' : 'rgba(43, 67, 133, 0.08)',
            }}>
              <Icon 
                className="w-6 h-6" 
                style={{ color: hovered ? '#ffffff' : '#2B4385' }} 
                aria-hidden="true" 
              />
            </div>
            <div>
              <CardTitle className="text-lg" style={{ color: hovered ? '#ffffff' : '#1F2937' }}>
                {action.title}
              </CardTitle>
              <CardDescription style={{ color: hovered ? 'rgba(255,255,255,0.85)' : '#4B5563' }}>
                {action.description}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
};

export default function QuickActionsSection() {
  const quickActions: QuickActionProps[] = [
    {
      title: "Browse Repository",
      description: "Explore documents and resources",
      icon: BookOpen,
      href: "/repository",
      variant: "primary",
    },
    {
      title: "Search Knowledge",
      description: "Find what you need quickly",
      icon: Search,
      href: "/search",
      variant: "primary",
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-gray-900">Quick Actions</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {quickActions.map((action, index) => (
          <QuickActionCard key={action.title} action={action} delay={index * 0.1} />
        ))}
      </div>
    </div>
  );
}