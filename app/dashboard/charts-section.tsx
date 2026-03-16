"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts"
import AuthService from "@/lib/services/auth-service"
import { Upload, FolderOpen } from "lucide-react"

import { lazy, Suspense } from "react"
const KraRadarChart = lazy(() => import('./kra-radar-chart').then(m => ({ default: m.KraRadarChart })))

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

const PIE_COLORS = ["#2B4385", "#2E8B57", "#C04E3A", "#6366F1", "#F59E0B", "#EC4899"]

const areaChartConfig = {
  count: {
    label: "Uploads",
    color: "#2B4385",
  },
} satisfies ChartConfig

interface UploadHistoryItem {
  date: string
  count: number
}

interface CategoryItem {
  [key: string]: string | number
  category: string
  count: number
}

function formatMonth(dateStr: string): string {
  const parts = dateStr.split("-")
  if (parts.length < 2) return dateStr
  const monthIndex = parseInt(parts[1], 10) - 1
  return MONTH_LABELS[monthIndex] ?? dateStr
}

export default function ChartsSection() {
  const [uploadHistory, setUploadHistory] = useState<UploadHistoryItem[]>([])
  const [categoryDistribution, setCategoryDistribution] = useState<CategoryItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const token = await AuthService.getAccessToken()
        if (!token) return

        const response = await fetch("/api/analytics", {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) return

        const data = await response.json()

        if (Array.isArray(data.uploadHistory)) {
          setUploadHistory(data.uploadHistory)
        }
        if (Array.isArray(data.categoryDistribution)) {
          setCategoryDistribution(data.categoryDistribution)
        }
      } catch (error) {
        console.error("[ChartsSection] Failed to fetch analytics:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Card className="lg:col-span-3 border-0 bg-white">
          <CardHeader>
            <div className="h-5 w-48 bg-muted rounded animate-pulse" />
          </CardHeader>
          <CardContent>
            <div className="h-[280px] bg-muted rounded animate-pulse" />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2 border-0 bg-white">
          <CardHeader>
            <div className="h-5 w-40 bg-muted rounded animate-pulse" />
          </CardHeader>
          <CardContent>
            <div className="h-[280px] bg-muted rounded animate-pulse" />
          </CardContent>
        </Card>
      </div>
    )
  }

  const areaData = uploadHistory.map((item) => ({
    ...item,
    month: formatMonth(item.date),
  }))

  const pieChartConfig = categoryDistribution.reduce<ChartConfig>(
    (acc, item, index) => {
      acc[item.category] = {
        label: item.category,
        color: PIE_COLORS[index % PIE_COLORS.length],
      }
      return acc
    },
    {} as ChartConfig,
  )

  const hasAreaData = areaData.length > 0
  const hasPieData = categoryDistribution.length > 0

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      {/* Area Chart — Document Uploads Over Time */}
      <Card className="lg:col-span-3 border-0 bg-white hover:shadow-lg transition-shadow h-full flex flex-col">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-gray-500">
            Document Uploads Over Time
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 w-full relative">
          {hasAreaData ? (
            <ChartContainer config={areaChartConfig} className="absolute inset-0 h-full w-full">
              <AreaChart data={areaData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2B4385" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#2B4385" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="month"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 12, fill: "#6B7280" }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  tick={{ fontSize: 12, fill: "#6B7280" }}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  type="linear"
                  dataKey="count"
                  stroke="#2B4385"
                  strokeWidth={2}
                  fill="url(#areaGradient)"
                  animationDuration={800}
                />
              </AreaChart>
            </ChartContainer>
          ) : (
            <div className="h-[280px] flex flex-col items-center justify-center text-gray-400 text-sm">
              <Upload className="w-10 h-10 mb-3 opacity-20" />
              <p className="font-medium">No upload history yet</p>
              <p className="text-xs mt-1">Upload documents to see trends over time.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pie / Donut Chart — Documents by Category */}
      <Card className="lg:col-span-2 border-0 bg-white hover:shadow-lg transition-shadow h-full flex flex-col">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-gray-500">
            Documents by Category
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 flex flex-col justify-center">
          {hasPieData ? (
            <ChartContainer config={pieChartConfig} className="h-[280px] w-full">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent />} />
                <Pie
                  data={categoryDistribution}
                  dataKey="count"
                  nameKey="category"
                  cx="50%"
                  cy="45%"
                  innerRadius={55}
                  outerRadius={90}
                  paddingAngle={3}
                  animationDuration={800}
                >
                  {categoryDistribution.map((entry, index) => (
                    <Cell
                      key={entry.category}
                      fill={PIE_COLORS[index % PIE_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '12px' }} />
              </PieChart>
            </ChartContainer>
          ) : (
            <div className="h-[280px] flex flex-col items-center justify-center text-gray-400 text-sm">
              <FolderOpen className="w-10 h-10 mb-3 opacity-20" />
              <p className="font-medium">No category data yet</p>
              <p className="text-xs mt-1">Categorize uploaded documents to see distribution.</p>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  )
}
