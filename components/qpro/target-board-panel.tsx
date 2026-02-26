"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Loader2, Target, CheckCircle2, AlertCircle, Clock } from "lucide-react"
import strategicPlan from "@/lib/data/strategic_plan.json"
import AuthService from "@/lib/services/auth-service"

interface TargetBoardPanelProps {
  year: number
  quarter: number
  unitId: string
  unitName: string
  refreshTrigger?: number
}

interface Initiative {
  id: string
  key_performance_indicator: {
    outputs: string
    outcomes: string
  }
  strategies: string[]
  programs_activities: string[]
  responsible_offices: string[]
  targets: {
    type: string
    timeline_data: Array<{
      year: number
      target_value: string | number
      milestones?: string[]
    }>
  }
}

interface KRA {
  kra_id: string
  kra_title: string
  guiding_principle: string
  initiatives: Initiative[]
}

interface AnalysisData {
  id: string
  kras: any[]
  achievementScore?: number
}

const KRA_COLORS: { [key: string]: string } = {
  "KRA 1": "bg-blue-50 text-blue-700",
  "KRA 2": "bg-emerald-50 text-emerald-700",
  "KRA 3": "bg-purple-50 text-purple-700",
  "KRA 4": "bg-orange-50 text-orange-700",
  "KRA 5": "bg-rose-50 text-rose-700",
  "KRA 6": "bg-teal-50 text-teal-700",
  "KRA 7": "bg-indigo-50 text-indigo-700",
  "KRA 8": "bg-pink-50 text-pink-700",
  "KRA 9": "bg-cyan-50 text-cyan-700",
  "KRA 10": "bg-lime-50 text-lime-700",
  "KRA 11": "bg-amber-50 text-amber-700",
  "KRA 12": "bg-emerald-50 text-emerald-700",
  "KRA 13": "bg-violet-50 text-violet-700",
  "KRA 14": "bg-fuchsia-50 text-fuchsia-700",
  "KRA 15": "bg-rose-50 text-rose-700",
  "KRA 16": "bg-sky-50 text-sky-700",
  "KRA 17": "bg-yellow-50 text-yellow-700",
  "KRA 18": "bg-blue-100 text-blue-800",
  "KRA 19": "bg-emerald-100 text-emerald-800",
  "KRA 20": "bg-purple-100 text-purple-800",
  "KRA 21": "bg-orange-100 text-orange-800",
  "KRA 22": "bg-rose-100 text-rose-800",
}

export function TargetBoardPanel({ year, quarter, unitId, unitName, refreshTrigger }: TargetBoardPanelProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [analysisData, setAnalysisData] = useState<AnalysisData | null>(null)

  useEffect(() => {
    const fetchAnalysis = async () => {
      if (!unitId) return

      setLoading(true)
      try {
        const token = await AuthService.getAccessToken()
        const response = await fetch(
          `/api/qpro-analyses?unitId=${unitId}&year=${year}&quarter=${quarter}&limit=1`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        )
        if (response.ok) {
          const data = await response.json()
          if (data.analyses && data.analyses.length > 0) {
            setAnalysisData(data.analyses[0])
          } else {
            setAnalysisData(null)
          }
        }
      } catch (error) {
        console.error("Error fetching analysis:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchAnalysis()
  }, [unitId, year, quarter, refreshTrigger])

  const getStatusForKRA = (kraId: string): "pending" | "achieved" | "missed" => {
    if (!analysisData || !analysisData.kras || analysisData.kras.length === 0) {
      return "pending"
    }

    const kraMatch = analysisData.kras.find((k: any) => k.kraId === kraId)
    if (!kraMatch) return "pending"

    // Check achievement based on matched activities
    const achievementRate = kraMatch.achievementRate || 0
    if (achievementRate >= 80) return "achieved"
    if (achievementRate > 0) return "missed"
    return "pending"
  }

  const getStatusIcon = (status: "pending" | "achieved" | "missed") => {
    switch (status) {
      case "achieved":
        return <CheckCircle2 className="w-5 h-5 text-green-500" />
      case "missed":
        return <AlertCircle className="w-5 h-5 text-red-500" />
      case "pending":
      default:
        return <Clock className="w-5 h-5 text-gray-400" />
    }
  }

  const getStatusBorderColor = (status: "pending" | "achieved" | "missed") => {
    switch (status) {
      case "achieved":
        return "border-green-500"
      case "missed":
        return "border-red-500"
      case "pending":
      default:
        return "border-gray-300"
    }
  }

  // Filter KRAs relevant to the selected unit
  // Expanded canonical unit name mapping for normalization
  const canonicalUnits: { [key: string]: string } = {
    "hrmo": "human resource management office",
    "human resource management office": "human resource management office",
    "office of the vice president for academic affairs": "office of the vice president for academic affairs",
    "ovpaa": "office of the vice president for academic affairs",
    "curriculum and instruction development unit": "curriculum and instruction development unit",
    "deans": "deans",
    "faculty": "faculty",
    "budget office": "budget office",
    "budget and finance": "budget office",
    "gender and development office": "gender and development",
    "gender and development": "gender and development",
    "research, extension and innovation": "research and development services",
    "research and development services": "research and development services",
    "research, extension and innovation unit": "research and development services",
    "extension and training services": "extension and training services",
    "extension and innovation unit": "extension and training services",
    "information communication and technology services": "management information systems",
    "management information systems": "management information systems",
    "alumni affairs and placement services": "alumni affairs and placement services",
    "alumni affairs and placement services, curriculum and instruction development unit": "alumni affairs and placement services",
    "international/local affairs": "international affairs",
    "international affairs": "international affairs",
    // Add more mappings as needed
  };

  function normalizeUnitName(name: string) {
    if (!name) return "";
    const key = name.trim().toLowerCase().replace(/\s+/g, " ");
    return canonicalUnits[key] || key;
  }

  const kras = strategicPlan.kras as KRA[];
  const relevantKRAs = kras;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Target className="w-6 h-6 text-primary" />
          Strategic Commitments (Q{quarter} {year})
        </h2>
        {loading && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}
      </div>

      <p className="text-sm text-muted-foreground">
        Key Result Areas aligned with LSPU Strategic Plan 2025-2029
      </p>

      {/* Objective Cards */}
      <div className="space-y-3 max-h-[calc(100vh-300px)] overflow-y-auto pr-2">
        {relevantKRAs.map((kra, index) => {
          const status = getStatusForKRA(kra.kra_id)

          return (
            <div key={`${kra.kra_id}-${index}`}>
              <Card
                className={`p-4 border-l-4 ${getStatusBorderColor(status)} hover:shadow-md transition-shadow cursor-pointer`}
                onClick={() => router.push(`/qpro/kra/${kra.kra_id}`)}
              >
                <div className="space-y-3">
                  {/* Header with KRA Badge and Expand Button */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 flex-1">
                      <Badge className={`${KRA_COLORS[kra.kra_id]} border-0 font-semibold`}>
                        {kra.kra_id}
                      </Badge>
                      <h3 className="font-medium text-sm text-gray-800 line-clamp-2">{kra.kra_title}</h3>
                    </div>
                    <div className="flex items-center gap-2">
                      {getStatusIcon(status)}
                    </div>
                  </div>

                  {/* Guiding Principle */}
                  {kra.guiding_principle && (
                    <div className="text-xs text-gray-500 border-l-2 border-primary pl-3">
                      <span className="font-medium">Guiding Principle: </span>
                      {kra.guiding_principle}
                    </div>
                  )}
                </div>
              </Card>
            </div>
          )
        })}
      </div>

      {relevantKRAs.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Target className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>No strategic objectives found for this period.</p>
        </div>
      )}
    </div>
  )
}
