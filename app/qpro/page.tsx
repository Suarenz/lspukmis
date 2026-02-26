"use client"

import { useEffect, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { useRouter } from "next/navigation"
import { Navbar } from "@/components/navbar"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2, Building2 } from "lucide-react"
import { TargetBoardPanel } from "@/components/qpro/target-board-panel"
import { ActionZonePanel } from "@/components/qpro/action-zone-panel"
import AuthService from "@/lib/services/auth-service"
import type { Unit } from "@/lib/api/types"

export default function QPROPage() {
  const { user, isLoading: authLoading, isAuthenticated } = useAuth()
  const router = useRouter()
  
  const [selectedYear, setSelectedYear] = useState(2025)
  const [selectedQuarter, setSelectedQuarter] = useState(1)
  const [analysisRefreshTrigger, setAnalysisRefreshTrigger] = useState(0)
  const [units, setUnits] = useState<Unit[]>([])
  const [selectedUnitId, setSelectedUnitId] = useState<string>("")
  const [selectedUnitName, setSelectedUnitName] = useState<string>("")
  const [unitsLoading, setUnitsLoading] = useState(true)

  // Fetch units for admin selection
  useEffect(() => {
    const fetchUnits = async () => {
      if (!isAuthenticated || !user) return
      
      try {
        setUnitsLoading(true)
        const token = await AuthService.getAccessToken()
        if (!token) return
        
        const response = await fetch('/api/units', {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          }
        })
        
        if (response.ok) {
          const data = await response.json()
          setUnits(data.units || [])
          
          // Set default selected unit
          if (user.role === "ADMIN" && data.units?.length > 0) {
            // Admin can select any unit, default to first one if no unitId assigned
            const defaultUnit = user.unitId 
              ? data.units.find((u: Unit) => u.id === user.unitId) || data.units[0]
              : data.units[0]
            setSelectedUnitId(defaultUnit.id)
            setSelectedUnitName(defaultUnit.name)
          } else if (user.unitId) {
            // Faculty uses their assigned unit
            const userUnit = data.units.find((u: Unit) => u.id === user.unitId)
            if (userUnit) {
              setSelectedUnitId(userUnit.id)
              setSelectedUnitName(userUnit.name)
            }
          }
        }
      } catch (error) {
        console.error('Error fetching units:', error)
      } finally {
        setUnitsLoading(false)
      }
    }
    
    fetchUnits()
  }, [isAuthenticated, user])

  // Redirect if not authenticated or not authorized
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push("/")
    }
    if (!authLoading && user && user.role !== "ADMIN" && user.role !== "FACULTY") {
      router.push("/dashboard")
    }
  }, [authLoading, isAuthenticated, user, router])

  const handleAnalysisComplete = () => {
    // Trigger refresh of target board to update statuses
    setAnalysisRefreshTrigger(prev => prev + 1)
  }

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!user || (user.role !== "ADMIN" && user.role !== "FACULTY")) {
    return null
  }

  const years = [2025, 2026, 2027, 2028, 2029]
  const quarters = [1, 2, 3, 4]
  const isAdminUser = user.role === "ADMIN"

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-slate-50">
      {/* Header Section */}
      <div className="bg-white border-b">
        <div className="container mx-auto px-4 py-6">
          <div className="flex flex-col gap-4">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Quarterly Physical Report of Operations</h1>
            </div>

            {/* Filter Bar - "Context Bar" */}
            <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center flex-wrap">
              {/* Unit Selector - Admin can select any unit, Faculty sees their unit */}
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-muted-foreground" />
                <label className="text-sm font-medium whitespace-nowrap">Unit:</label>
                {isAdminUser ? (
                  <Select 
                    value={selectedUnitId} 
                    onValueChange={(val) => {
                      setSelectedUnitId(val)
                      const unit = units.find(u => u.id === val)
                      setSelectedUnitName(unit?.name || "")
                    }}
                    disabled={unitsLoading}
                  >
                    <SelectTrigger className="w-[200px]">
                      <SelectValue placeholder={unitsLoading ? "Loading..." : "Select unit"} />
                    </SelectTrigger>
                    <SelectContent>
                      {units.map((unit) => (
                        <SelectItem key={unit.id} value={unit.id}>
                          {unit.code} - {unit.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-sm text-muted-foreground bg-muted px-3 py-1.5 rounded-md">
                    {selectedUnitName || user?.unit || "No unit assigned"}
                  </span>
                )}
              </div>

              {/* Year Selector */}
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium whitespace-nowrap">Year:</label>
                <Select value={selectedYear.toString()} onValueChange={(val) => setSelectedYear(parseInt(val))}>
                  <SelectTrigger className="w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {years.map((year) => (
                      <SelectItem key={year} value={year.toString()}>
                        {year}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Quarter Tabs - Pills style */}
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium whitespace-nowrap">Quarter:</label>
                <Tabs value={selectedQuarter.toString()} onValueChange={(val) => setSelectedQuarter(parseInt(val))}>
                  <TabsList className="bg-gray-100">
                    {quarters.map((q) => (
                      <TabsTrigger key={q} value={q.toString()} className="px-4 data-[state=active]:bg-blue-600 data-[state=active]:text-white data-[state=active]:shadow-sm">
                        Q{q}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Dashboard - Target Board & Action Zone */}
      <div className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Target Board */}
          <Card className="p-6 bg-white border-none shadow-md">
            <TargetBoardPanel 
              year={selectedYear}
              quarter={selectedQuarter}
              unitId={selectedUnitId}
              unitName={selectedUnitName}
              refreshTrigger={analysisRefreshTrigger}
            />
          </Card>

          {/* Action Zone */}
          <Card className="p-6 bg-white border-none shadow-md">
            <ActionZonePanel 
              year={selectedYear}
              quarter={selectedQuarter}
              unitId={selectedUnitId}
              unitName={selectedUnitName}
              onAnalysisComplete={handleAnalysisComplete}
            />
          </Card>
        </div>
      </div>
    </div>
    </>
  )
}
