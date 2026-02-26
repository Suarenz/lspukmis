'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { ArrowLeft, AlertCircle, Save, TrendingUp, CheckCircle2, FileText, RefreshCw, ListChecks, Building2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import strategicPlan from '@/lib/data/strategic_plan.json';
import { useAuth } from '@/lib/auth-context';
import AuthService from '@/lib/services/auth-service';
import {
  parseNumericValue,
} from '@/lib/utils/target-type-detector';
import { DynamicInput, type TargetType } from '@/components/ui/dynamic-input';
import { mapTargetType } from '@/lib/utils/target-type-utils';
import { getTargetValueForYear, isCumulativeTarget } from '@/lib/utils/qpro-aggregation';

// KPI Progress types
interface KPIProgressItem {
  initiativeId: string;
  year: number;
  quarter: number;
  targetValue: string | number;
  currentValue: number | string;
  achievementPercent: number;
  status: 'MET' | 'ON_TRACK' | 'MISSED' | 'PENDING';
  submissionCount: number;
  participatingUnits: string[];
  targetType: TargetType;
  // Manual override fields
  manualOverride?: number | string | null;
  manualOverrideReason?: string | null;
  manualOverrideBy?: string | null;
  manualOverrideAt?: string | null;
  valueSource: 'qpro' | 'manual' | 'none';
  // Cumulative target tracking (progress carries forward across years)
  isCumulative?: boolean;
  contributingYears?: number[];
}

interface KPIProgressData {
  kraId: string;
  kraTitle: string;
  initiatives: {
    id: string;
    outputs: string;
    outcomes: string;
    targetType: string;
    progress: KPIProgressItem[];
  }[];
}

interface KPIProgressApiResponse {
  success: boolean;
  year: number;
  quarter?: number;
  data: KPIProgressData;
}

interface KRA {
  kra_id: string;
  kra_title: string;
  guiding_principle: string;
  initiatives: Initiative[];
}

interface TimelineItem {
  year: number;
  target_value: string | number;
  current_value?: string | number;
}

interface Targets {
  type: string;
  currency?: string;
  unit_basis?: string;
  low_count_threshold?: number;
  timeline_data: TimelineItem[];
  target_time_scope?: 'annual' | 'cumulative';
}

interface Initiative {
  id: string;
  key_performance_indicator: {
    outputs: string;
    outcomes: string;
  };
  strategies: string[];
  programs_activities: string[];
  responsible_offices: string[];
  targets: Targets;
}

// Type for storing current values in state
type CurrentValuesMap = Record<string, string | number>;

// Type for pending saves (values being edited but not yet saved to DB)
type PendingEditsMap = Record<string, { value: string | number; reason?: string }>;

const kraColors = [
  'bg-red-100 text-red-800',
  'bg-blue-100 text-blue-800',
  'bg-green-100 text-green-800',
  'bg-yellow-100 text-yellow-800',
  'bg-purple-100 text-purple-800',
  'bg-pink-100 text-pink-800',
  'bg-indigo-100 text-indigo-800',
  'bg-cyan-100 text-cyan-800',
  'bg-orange-100 text-orange-800',
  'bg-teal-100 text-teal-800',
  'bg-lime-100 text-lime-800',
  'bg-rose-100 text-rose-800',
  'bg-sky-100 text-sky-800',
  'bg-violet-100 text-violet-800',
  'bg-amber-100 text-amber-800',
  'bg-emerald-100 text-emerald-800',
  'bg-fuchsia-100 text-fuchsia-800',
  'bg-cyan-100 text-cyan-800',
  'bg-red-200 text-red-900',
  'bg-blue-200 text-blue-900',
  'bg-green-200 text-green-900',
  'bg-purple-200 text-purple-900',
];

// Helper function to normalize data - convert strings to arrays if needed
const normalizeToArray = (value: any): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  return [];
};

export default function KRADetailPage() {
  const params = useParams();
  const router = useRouter();
  const { isAuthenticated, isLoading, user } = useAuth();
  const kraIdRaw = params.kraId as string;
  
  // Decode the URL parameter - useParams returns encoded values
  const kraId = decodeURIComponent(kraIdRaw);

  const [analysisData, setAnalysisData] = useState<any>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  
  // KPI Progress state (from QPRO uploaded documents)
  const [kpiProgress, setKpiProgress] = useState<KPIProgressData | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(false);
  const [selectedProgressYear, setSelectedProgressYear] = useState<number>(2025);
  const [refreshTrigger, setRefreshTrigger] = useState<number>(0); // Used to force re-fetch

  // QPRO-derived current values for the Targets-by-Year table
  const [qproDerivedValues, setQproDerivedValues] = useState<CurrentValuesMap>({});
  
  // Pending edits that haven't been saved to DB yet (keyed by "{initiativeId}-{year}-{quarter}")
  const [pendingEdits, setPendingEdits] = useState<PendingEditsMap>({});
  const [savingOverride, setSavingOverride] = useState<string | null>(null); // Track which item is being saved

  // Phase 3: KPI Target Management State
  const [kpiTargets, setKpiTargets] = useState<Record<string, any>>({});
  const [editingTarget, setEditingTarget] = useState<string | null>(null); // "{initiativeId}-{year}-{quarter}"
  const [pendingTargetEdits, setPendingTargetEdits] = useState<Record<string, number>>({});
  const [savingTarget, setSavingTarget] = useState<string | null>(null);

  // NOTE: We no longer use localStorage for persistence - all saves go to database
  // The old localStorage-based currentValues state is replaced by database-backed values
  
  // Get the effective current value for a specific initiative-year-quarter from API data
  const getCurrentValueFromProgress = useCallback((initiativeId: string, year: number, quarter?: number): number | string => {
    if (!kpiProgress) return 0;
    const initiative = kpiProgress.initiatives?.find(i => i.id === initiativeId);
    if (!initiative) return 0;
    
    if (quarter) {
      // Get specific quarter value
      const progressItem = initiative.progress?.find(p => p.year === year && p.quarter === quarter);
      return progressItem?.currentValue ?? 0;
    } else {
      // Sum all quarters for the year (only for numeric types)
      const yearItems = initiative.progress?.filter(p => p.year === year) || [];
      return yearItems.reduce((sum, item) => {
        const val = typeof item.currentValue === 'number' ? item.currentValue : parseFloat(String(item.currentValue)) || 0;
        return sum + val;
      }, 0);
    }
  }, [kpiProgress]);

  // Get the value source for a specific initiative-year-quarter from API data
  const getValueSourceFromProgress = useCallback((initiativeId: string, year: number, quarter?: number): 'qpro' | 'manual' | 'none' => {
    if (!kpiProgress) return 'none';
    const initiative = kpiProgress.initiatives?.find(i => i.id === initiativeId);
    if (!initiative) return 'none';
    
    if (quarter) {
      const progressItem = initiative.progress?.find(p => p.year === year && p.quarter === quarter);
      return progressItem?.valueSource || 'none';
    } else {
      // If any quarter has a value, return the highest priority source
      const yearItems = initiative.progress?.filter(p => p.year === year) || [];
      if (yearItems.some(item => item.valueSource === 'manual')) return 'manual';
      if (yearItems.some(item => item.valueSource === 'qpro')) return 'qpro';
      return 'none';
    }
  }, [kpiProgress]);

  // Check if a KPI has cumulative progress (contributions carry forward across years)
  const getCumulativeInfo = useCallback((initiativeId: string, year: number): { isCumulative: boolean; contributingYears: number[] } | null => {
    if (!kpiProgress) return null;
    const initiative = kpiProgress.initiatives?.find(i => i.id === initiativeId);
    if (!initiative) return null;
    
    const yearItems = initiative.progress?.filter(p => p.year === year) || [];
    const cumulativeItem = yearItems.find(item => item.isCumulative);
    if (cumulativeItem) {
      return {
        isCumulative: true,
        contributingYears: cumulativeItem.contributingYears || []
      };
    }
    return null;
  }, [kpiProgress]);

  // Save a manual override value to the database
  const saveManualOverride = useCallback(async (
    initiativeId: string,
    year: number,
    quarter: number,
    value: number | string | null,
    reason?: string,
    targetType?: TargetType
  ) => {
    const key = `${initiativeId}-${year}-${quarter}`;
    setSavingOverride(key);
    
    try {
      const token = await AuthService.getAccessToken();
      const response = await fetch('/api/kpi-progress', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          kraId: kraId,
          initiativeId,
          year,
          quarter,
          value,
          reason,
          targetType,
        }),
      });
      
      if (!response.ok) {
        let error: any = {};
        try {
          error = await response.json();
        } catch {
          // If response body is not JSON, try to get text
          error = { message: `HTTP ${response.status}` };
        }
        console.error('Failed to save override:', error, 'Status:', response.status);
        return false;
      }
      
      // Remove from pending edits on success
      setPendingEdits(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      
      // Always refresh KPI progress for the whole year (all quarters)
      const params = new URLSearchParams({
        kraId: kraId,
        year: selectedProgressYear.toString(),
        _t: Date.now().toString(), // cache bust
      });
      const refreshResponse = await fetch(`/api/kpi-progress?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (refreshResponse.ok) {
        const api = await refreshResponse.json();
        setKpiProgress(api.data);
      }
      
      return true;
    } catch (error) {
      console.error('Error saving manual override:', error);
      return false;
    } finally {
      setSavingOverride(null);
    }
  }, [kraId, selectedProgressYear]);

  // Update a pending edit (before saving to DB)
  const updatePendingEdit = useCallback((initiativeId: string, year: number, quarter: number, value: string | number) => {
    const key = `${initiativeId}-${year}-${quarter}`;
    // Keep as-is (string or number) based on input type
    const finalValue = value === '' ? 0 : value;
    setPendingEdits(prev => ({
      ...prev,
      [key]: { value: finalValue },
    }));
  }, []);

  // Get current value for display (pending edit → API value → 0)
  const getDisplayValue = useCallback((initiativeId: string, year: number, quarter: number): string | number => {
    const key = `${initiativeId}-${year}-${quarter}`;
    if (pendingEdits[key] !== undefined) {
      return pendingEdits[key].value;
    }
    return getCurrentValueFromProgress(initiativeId, year, quarter);
  }, [pendingEdits, getCurrentValueFromProgress]);

  // Check if there's a pending edit for this item
  const hasPendingEdit = useCallback((initiativeId: string, year: number, quarter: number): boolean => {
    const key = `${initiativeId}-${year}-${quarter}`;
    return pendingEdits[key] !== undefined;
  }, [pendingEdits]);

  // Clear all pending edits and reset to API values
  const clearPendingEdits = useCallback(() => {
    setPendingEdits({});
  }, []);

  // Phase 3: KPI Target Management Functions
  
  // Fetch KPI targets from database for this KRA
  const fetchKpiTargets = useCallback(async () => {
    try {
      const token = await AuthService.getAccessToken();
      const params = new URLSearchParams({ kraId });
      const response = await fetch(`/api/kpi-targets?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (response.ok) {
        const data = await response.json();
        // Index targets by key for quick lookup
        const targetsMap: Record<string, any> = {};
        data.targets?.forEach((t: any) => {
          const key = `${t.initiative_id}-${t.year}-${t.quarter || 'annual'}`;
          targetsMap[key] = t;
        });
        setKpiTargets(targetsMap);
      }
    } catch (error) {
      console.error('Error fetching KPI targets:', error);
    }
  }, [kraId]);

  // Get target value for display (pending edit → DB target → strategic plan)
  const getTargetValue = useCallback((initiativeId: string, year: number, quarter: number, fallbackValue: number | string): number | string => {
    const key = `${initiativeId}-${year}-${quarter}`;
    
    // 1. Check pending edit
    if (pendingTargetEdits[key] !== undefined) {
      return pendingTargetEdits[key];
    }
    
    // 2. Check database target
    const dbTarget = kpiTargets[key];
    if (dbTarget) {
      return dbTarget.target_value;
    }
    
    // 3. Fallback to strategic plan value
    return fallbackValue;
  }, [pendingTargetEdits, kpiTargets]);

  // Get annual target value for display in the annual overview
  // IMPORTANT: The DB stores QUARTERLY targets which are DERIVED from the annual target:
  // - COUNT >= 4: quarterly = annual / 4 (e.g., annual=6 → Q1-Q4 = 2,2,2,2 → sum=8, not 6!)
  // - COUNT < 4: quarterly = Q1-Q3=0, Q4=annual (e.g., annual=1 → Q1-Q4 = 0,0,0,1)
  // - RATE/PERCENTAGE/SNAPSHOT: quarterly = annual (same value each quarter)
  // 
  // Because the quarterly targets may not perfectly sum to the annual (due to rounding),
  // we ALWAYS use the strategic plan annual value as the source of truth.
  // The DB quarterly targets are only used for progress tracking, not display.
  const getAnnualTargetValue = useCallback((initiativeId: string, year: number, strategicPlanAnnualTarget: number | string, targetType?: string): number => {
    // For MILESTONE and TEXT_CONDITION, the target is always 1 (complete the milestone)
    const mappedType = targetType ? mapTargetType(targetType) : undefined;
    if (mappedType === 'MILESTONE' || mappedType === 'TEXT_CONDITION') {
      return 1;
    }
    
    // Always use strategic plan annual value as the source of truth
    const annualValue = typeof strategicPlanAnnualTarget === 'number' 
      ? strategicPlanAnnualTarget 
      : parseFloat(String(strategicPlanAnnualTarget)) || 0;
    
    return annualValue;
  }, []);

  // Update pending target edit
  const updateTargetEdit = useCallback((initiativeId: string, year: number, quarter: number, value: number) => {
    const key = `${initiativeId}-${year}-${quarter}`;
    setPendingTargetEdits(prev => ({
      ...prev,
      [key]: value
    }));
  }, []);

  // Save target to database
  const saveTarget = useCallback(async (
    initiativeId: string,
    year: number,
    quarter: number,
    targetValue: number,
    targetType: string,
    description?: string
  ) => {
    const key = `${initiativeId}-${year}-${quarter}`;
    setSavingTarget(key);
    
    try {
      const token = await AuthService.getAccessToken();
      const response = await fetch('/api/kpi-targets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          kra_id: kraId,
          initiative_id: initiativeId,
          year,
          quarter,
          target_value: targetValue,
          target_type: targetType,
          description
        })
      });
      
      if (response.ok) {
        // Clear pending edit
        setPendingTargetEdits(prev => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        
        // Refresh targets
        await fetchKpiTargets();
        setEditingTarget(null);
        return true;
      } else {
        const error = await response.json();
        console.error('Failed to save target:', error);
        return false;
      }
    } catch (error) {
      console.error('Error saving target:', error);
      return false;
    } finally {
      setSavingTarget(null);
    }
  }, [kraId, fetchKpiTargets]);

  // Cancel target editing
  const cancelTargetEdit = useCallback(() => {
    setPendingTargetEdits({});
    setEditingTarget(null);
  }, []);

  // Direct access to KRA - use normalized ID comparison for URL-encoded values
  const allKras = (strategicPlan as any).kras || [];
  // Normalize KRA ID for comparison: handles "KRA%201" -> "KRA 1", "KRA1" -> "KRA 1"
  const normalizeKraIdLocal = (id: string): string => {
    const decoded = decodeURIComponent(id);
    const match = decoded.match(/KRA\s*(\d+)/i);
    return match ? `KRA ${match[1]}` : decoded;
  };
  const normalizedKraId = normalizeKraIdLocal(kraId as string);
  const kra = allKras.find((k: KRA) => normalizeKraIdLocal(k.kra_id) === normalizedKraId) || null;

  const kraColorClass = kra 
    ? kraColors[(parseInt(kra.kra_id.split(' ')[1]) - 1) % kraColors.length]
    : kraColors[0];

  // Get all unique years from all initiatives
  const availableYears = useMemo(() => {
    if (!kra) return [new Date().getFullYear()];
    const years = new Set<number>();
    kra.initiatives.forEach((initiative: Initiative) => {
      initiative.targets?.timeline_data?.forEach((t: TimelineItem) => years.add(t.year));
    });
    const sortedYears = Array.from(years).sort();
    return sortedYears.length > 0 ? sortedYears : [new Date().getFullYear()];
  }, [kra]);

  // Ensure selectedProgressYear is in availableYears
  useEffect(() => {
    if (availableYears.length > 0 && !availableYears.includes(selectedProgressYear)) {
      setSelectedProgressYear(availableYears[0]);
    }
  }, [availableYears, selectedProgressYear]);

  useEffect(() => {
    if (!isAuthenticated || isLoading) return;

    const fetchAnalysisData = async () => {
      try {
        setLoadingAnalysis(true);
        const token = await AuthService.getAccessToken();
        const response = await fetch(`/api/qpro-analyses?kraId=${kraId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (response.ok) {
          const data = await response.json();
          setAnalysisData(data);
        }
      } catch (error) {
        console.error('Error fetching analysis data:', error);
      } finally {
        setLoadingAnalysis(false);
      }
    };

    fetchAnalysisData();
  }, [kraId, isAuthenticated, isLoading]);

  // Fetch KPI progress from QPRO documents - fetches all quarters for the year
  useEffect(() => {
    if (!isAuthenticated || isLoading || !kraId) return;

    const fetchKPIProgress = async () => {
      try {
        setLoadingProgress(true);
        const token = await AuthService.getAccessToken();
        // Fetch without quarter param to get all quarters for the year
        // Add cache-busting param to ensure fresh data
        const params = new URLSearchParams({
          kraId: kraId,
          year: selectedProgressYear.toString(),
          _t: Date.now().toString(), // Cache bust
        });
        
        const response = await fetch(`/api/kpi-progress?${params}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Cache-Control': 'no-cache',
          },
        });
        
        if (response.ok) {
          const api = (await response.json()) as KPIProgressApiResponse;
          setKpiProgress(api.data);
          
          // Build QPRO-derived values map for the per-quarter table
          const derived: CurrentValuesMap = {};
          for (const initiative of api.data.initiatives || []) {
            const progressItems = (initiative.progress || []).filter((p) => p.year === selectedProgressYear);
            for (const pItem of progressItems) {
              const key = `${initiative.id}-${pItem.year}-${pItem.quarter}`;
              derived[key] = pItem.currentValue || 0;
            }
          }
          setQproDerivedValues(derived);
        }
      } catch (error) {
        console.error('Error fetching KPI progress:', error);
      } finally {
        setLoadingProgress(false);
      }
    };

    fetchKPIProgress();
    // Phase 3: Also fetch KPI targets from database
    fetchKpiTargets();
  }, [kraId, isAuthenticated, isLoading, selectedProgressYear, fetchKpiTargets, refreshTrigger]);

  // Auto-refresh when page becomes visible (user returns from approval)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isAuthenticated && !isLoading) {
        // Trigger a refresh when user returns to this page
        setRefreshTrigger(prev => prev + 1);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isAuthenticated, isLoading]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-lg text-gray-600">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-lg text-gray-600">Please log in to view this page.</div>
      </div>
    );
  }

  if (!kra) {
    return (
      <div className="min-h-screen bg-gray-50 p-8">
        <Button
          variant="outline"
          onClick={() => router.back()}
          className="mb-4"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Strategic Commitments
        </Button>
        <div className="bg-white rounded-lg border border-gray-300 p-8">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-6 h-6 text-red-500" />
            <div>
              <h2 className="text-xl font-semibold text-gray-900">KRA Not Found</h2>
              <p className="text-gray-600 mt-1">The requested KRA could not be found.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 sm:p-8">
      <Button
        variant="outline"
        onClick={() => router.back()}
        className="mb-6"
      >
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to Strategic Commitments
      </Button>

      {/* KRA Header */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 sm:p-8 mb-8">
        <div className="flex flex-col sm:flex-row sm:items-start gap-4">
          <Badge className={`${kraColorClass} text-lg font-bold w-fit`}>
            {kra.kra_id}
          </Badge>
          <div className="flex-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-3">
              {kra.kra_title}
            </h1>
            <div className="bg-gray-100 rounded p-4">
              <p className="text-gray-700 text-sm sm:text-base">
                <span className="font-semibold">Guiding Principle: </span>
                {kra.guiding_principle}
              </p>
            </div>
          </div>
        </div>
      </div>


      {/* Year Tabs */}
      <div className="mb-8">
        <div className="flex items-center gap-2 overflow-x-auto pb-2 no-scrollbar">
          {availableYears.map(year => (
            <button
              key={year}
              onClick={() => setSelectedProgressYear(year)}
              className={cn(
                "px-6 py-2 rounded-full text-sm font-medium transition-all whitespace-nowrap",
                selectedProgressYear === year
                  ? "bg-blue-600 text-white shadow-md ring-2 ring-blue-600 ring-offset-2"
                  : "bg-white text-gray-600 hover:bg-gray-100 border border-gray-200 hover:border-gray-300"
              )}
            >
              {year}
            </button>
          ))}
        </div>
      </div>

      {/* KPIs Section */}
      <div className="space-y-6">
        <h2 className="text-2xl font-bold text-gray-900">Key Performance Indicators (KPIs)</h2>

        {kra.initiatives && kra.initiatives.length > 0 ? (
          <div className="grid gap-6">
            {kra.initiatives.map((initiative: Initiative, index: number) => {
              const initiativeProgress = kpiProgress?.initiatives?.find((i) => i.id === initiative.id);
              
              // Find timeline data for selected year
              // For cumulative KPIs with only 2029 target, use that target for ALL years
              let timelineItem = initiative.targets?.timeline_data?.find(t => t.year === selectedProgressYear);
              
              // If no exact match, find the nearest target (fallback logic)
              // Works for cumulative targets AND non-cumulative KPIs with sparse timeline data
              // (e.g., milestone KPIs that only have a 2028 or 2029 target)
              if (!timelineItem && initiative.targets?.timeline_data?.length > 0) {
                const fallbackValue = getTargetValueForYear(initiative.targets?.timeline_data, selectedProgressYear);
                if (fallbackValue !== null) {
                  // Find the source year (e.g., 2029) to get other metadata
                  const sourceEntry = initiative.targets?.timeline_data?.find(t => 
                    parseNumericValue(t.target_value) === fallbackValue
                  ) || initiative.targets?.timeline_data?.[0];
                  
                  // Create a virtual timeline item for the selected year
                  timelineItem = {
                    year: selectedProgressYear,
                    target_value: fallbackValue,
                    current_value: sourceEntry?.current_value
                  };
                } else {
                  // For milestone/text_condition with non-numeric target values, use the first entry
                  const mappedType = mapTargetType(initiative.targets?.type || 'count');
                  if (mappedType === 'MILESTONE' || mappedType === 'TEXT_CONDITION') {
                    const firstEntry = initiative.targets?.timeline_data?.[0];
                    if (firstEntry) {
                      timelineItem = {
                        year: selectedProgressYear,
                        target_value: firstEntry.target_value,
                        current_value: firstEntry.current_value
                      };
                    }
                  }
                }
              }
              
              // Calculate annual progress
              const yearItems = initiativeProgress?.progress?.filter(p => p.year === selectedProgressYear) || [];
              const dynamicType = mapTargetType(initiative.targets?.type || 'count');
              
              // For MILESTONE and TEXT_CONDITION, use special aggregation (max, not sum)
              let yearTotal: number;
              if (dynamicType === 'MILESTONE') {
                // MILESTONE: 1 if any quarter is achieved, 0 otherwise
                yearTotal = yearItems.some(item => item.currentValue === 1 || item.currentValue === '1') ? 1 : 0;
              } else if (dynamicType === 'TEXT_CONDITION') {
                // TEXT_CONDITION: Convert text to numeric and take the max
                // Met = 1, In Progress = 0.5, Not Met / other = 0
                // Also handle numeric values (1, 0.5, 0) from cumulative path
                yearTotal = yearItems.reduce((max, item) => {
                  let val = 0;
                  const cv = String(item.currentValue);
                  if (cv === 'Met') val = 1;
                  else if (cv === 'In Progress') val = 0.5;
                  else if (cv === 'Not Met') val = 0;
                  else {
                    // Fallback: handle numeric values from API
                    const numVal = typeof item.currentValue === 'number'
                      ? item.currentValue
                      : parseFloat(cv);
                    if (!isNaN(numVal) && numVal > 0) val = numVal;
                  }
                  return Math.max(max, val);
                }, 0);
              } else {
                yearTotal = yearItems.reduce((sum, item) => {
                  const val = typeof item.currentValue === 'number' ? item.currentValue : parseFloat(String(item.currentValue)) || 0;
                  return sum + val;
                }, 0);
              }
              
              // For MILESTONE and TEXT_CONDITION, target is always 1 ("complete the milestone")
              const targetNum = (dynamicType === 'MILESTONE' || dynamicType === 'TEXT_CONDITION')
                ? 1
                : (timelineItem ? parseNumericValue(timelineItem.target_value) : 0);
              const yearPct = targetNum > 0 ? Math.min(100, Math.round((yearTotal / targetNum) * 100)) : 0;

              return (
                <div key={index} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-8">
                  {/* Header & Metadata */}
                  <div className="p-6 border-b border-gray-100">
                    <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-6">
                      <div className="flex-1">
                        <h3 className="text-xl font-bold text-gray-900">{initiative.id}</h3>
                        <div className="mt-3 space-y-2">
                          <div className="bg-blue-50/50 p-3 rounded-md border border-blue-100">
                            <p className="text-sm text-gray-800">
                              <span className="font-bold text-blue-800 uppercase text-xs tracking-wide block mb-1">Output</span>
                              {Array.isArray(initiative.key_performance_indicator?.outputs)
                                ? (initiative.key_performance_indicator.outputs as unknown as string[]).join('; ')
                                : initiative.key_performance_indicator?.outputs}
                            </p>
                          </div>
                          <div className="bg-green-50/50 p-3 rounded-md border border-green-100">
                            <p className="text-sm text-gray-800">
                              <span className="font-bold text-green-800 uppercase text-xs tracking-wide block mb-1">Outcome</span>
                              {Array.isArray(initiative.key_performance_indicator?.outcomes)
                                ? (initiative.key_performance_indicator.outcomes as unknown as string[]).join('; ')
                                : initiative.key_performance_indicator?.outcomes}
                            </p>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                         {/* Refresh Button */}
                         <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setRefreshTrigger(prev => prev + 1)}
                            disabled={loadingProgress}
                            className="flex items-center gap-1 text-blue-600 border-blue-300 hover:bg-blue-50"
                          >
                            <RefreshCw className={`h-3 w-3 ${loadingProgress ? 'animate-spin' : ''}`} />
                            Refresh
                          </Button>
                      </div>
                    </div>

                    {/* Context Cards */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {/* Strategies */}
                      <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-purple-500 h-full">
                        <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                          <TrendingUp className="w-3 h-3" /> Strategies
                        </h4>
                        <ul className="text-sm text-gray-700 space-y-2 pl-1">
                          {normalizeToArray(initiative.strategies).map((s, i) => (
                            <li key={i} className="flex gap-2">
                              <span className="text-purple-400 mt-1">•</span>
                              <span>{s}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      
                      {/* Activities */}
                      <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-blue-500 h-full">
                        <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                          <ListChecks className="w-3 h-3" /> Activities
                        </h4>
                        <ul className="text-sm text-gray-700 space-y-2 pl-1">
                          {normalizeToArray(initiative.programs_activities).map((a, i) => (
                            <li key={i} className="flex gap-2">
                              <span className="text-blue-400 mt-1">•</span>
                              <span>{a}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      {/* Responsible Offices */}
                      <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-green-500 h-full">
                        <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                          <Building2 className="w-3 h-3" /> Responsible Offices
                        </h4>
                        <ul className="text-sm text-gray-700 space-y-2 pl-1">
                          {normalizeToArray(initiative.responsible_offices).map((o, i) => (
                            <li key={i} className="flex gap-2">
                              <span className="text-green-400 mt-1">•</span>
                              <span>{o}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>

                  {/* Hero Summary */}
                  {timelineItem ? (
                    <div className="bg-blue-50/50 p-6 border-b border-gray-100">
                      <div className="flex flex-col md:flex-row items-center justify-between gap-8">
                        <div className="flex items-center gap-6">
                          {/* Progress Circle */}
                          <div className="relative w-24 h-24 flex items-center justify-center">
                            <svg className="w-full h-full transform -rotate-90">
                              <circle
                                cx="48"
                                cy="48"
                                r="40"
                                stroke="currentColor"
                                strokeWidth="8"
                                fill="transparent"
                                className="text-gray-200"
                              />
                              <circle
                                cx="48"
                                cy="48"
                                r="40"
                                stroke="currentColor"
                                strokeWidth="8"
                                fill="transparent"
                                strokeDasharray={251.2}
                                strokeDashoffset={251.2 - (251.2 * yearPct) / 100}
                                className={yearPct >= 100 ? "text-green-500" : "text-blue-500"}
                              />
                            </svg>
                            <div className="absolute inset-0 flex items-center justify-center flex-col">
                              <span className="text-xl font-bold text-gray-900">{yearPct}%</span>
                            </div>
                          </div>
                          
                          <div>
                            <div className="flex items-center gap-2">
                              <h4 className="text-lg font-semibold text-gray-900">{selectedProgressYear} Overview</h4>
                              {/* Cumulative indicator - shows when progress includes contributions from earlier years */}
                              {(() => {
                                const cumulativeInfo = getCumulativeInfo(initiative.id, selectedProgressYear);
                                if (cumulativeInfo?.isCumulative && cumulativeInfo.contributingYears.length > 1) {
                                  const yearsStr = cumulativeInfo.contributingYears.join(', ');
                                  return (
                                    <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200 text-xs">
                                      <TrendingUp className="w-3 h-3 mr-1" />
                                      Cumulative ({yearsStr})
                                    </Badge>
                                  );
                                }
                                return null;
                              })()}
                            </div>
                            <div className="flex items-baseline gap-2 mt-1">
                              <span className={`text-3xl font-bold ${
                                dynamicType === 'TEXT_CONDITION'
                                  ? yearTotal >= 1 ? 'text-green-600' : yearTotal >= 0.5 ? 'text-yellow-600' : 'text-gray-400'
                                  : 'text-gray-900'
                              }`}>{
                                dynamicType === 'TEXT_CONDITION'
                                  ? (yearTotal >= 1 ? 'Met' : yearTotal >= 0.5 ? 'In Progress' : 'Not Met')
                                  : dynamicType === 'MILESTONE'
                                    ? (yearTotal >= 1 ? 1 : 0)
                                    : yearTotal
                              }</span>
                              {dynamicType !== 'TEXT_CONDITION' && <span className="text-gray-500">/</span>}
                              
                              {/* Editable Target - uses annual target value (sum of quarterly targets or strategic plan fallback) */}
                              {dynamicType !== 'TEXT_CONDITION' && (() => {
                                // For annual overview, we display the sum of all quarterly targets
                                // but editing is done per-quarter (Q4 for COUNT < 4)
                                const annualTargetValue = getAnnualTargetValue(initiative.id, timelineItem.year, timelineItem.target_value, initiative.targets?.type);
                                const canEditTarget = user && (user.role === 'ADMIN' || user.role === 'FACULTY');
                                
                                // For editing, we'll target Q4 since that's where the annual target lives for COUNT < 4
                                const editQuarter = 4;
                                const targetKey = `${initiative.id}-${timelineItem.year}-${editQuarter}`;
                                const isEditingThisTarget = editingTarget === targetKey;
                                const isSavingThisTarget = savingTarget === targetKey;

                                if (isEditingThisTarget) {
                                  return (
                                    <div className="flex items-center gap-2">
                                      <input
                                        type="number"
                                        className="w-24 px-2 py-1 border border-blue-500 rounded text-lg font-bold focus:outline-none"
                                        value={pendingTargetEdits[targetKey] ?? annualTargetValue}
                                        onChange={(e) => updateTargetEdit(initiative.id, timelineItem.year, editQuarter, parseFloat(e.target.value) || 0)}
                                        autoFocus
                                      />
                                      <Button size="sm" onClick={() => saveTarget(initiative.id, timelineItem.year, editQuarter, typeof (pendingTargetEdits[targetKey] ?? annualTargetValue) === 'number' ? (pendingTargetEdits[targetKey] ?? annualTargetValue) : parseFloat(String(pendingTargetEdits[targetKey] ?? annualTargetValue)) || 0, mapTargetType(initiative.targets?.type || 'count'), initiative.key_performance_indicator?.outputs)} disabled={isSavingThisTarget}>Save</Button>
                                      <Button size="sm" variant="ghost" onClick={cancelTargetEdit}>Cancel</Button>
                                    </div>
                                  );
                                }

                                return (
                                  <div className="flex items-center gap-2 group">
                                    <span className="text-xl font-medium text-gray-600">{annualTargetValue.toLocaleString()}</span>
                                    {canEditTarget && (
                                      <button 
                                        onClick={() => setEditingTarget(targetKey)}
                                        className="opacity-0 group-hover:opacity-100 text-blue-600 hover:text-blue-800 transition-opacity"
                                      >
                                        <FileText className="w-4 h-4" />
                                      </button>
                                    )}
                                  </div>
                                );
                              })()}
                              
                              {dynamicType !== 'TEXT_CONDITION' && <span className="text-sm text-gray-500 ml-1">{initiative.targets.unit_basis}</span>}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="p-6 text-center text-gray-500">No target data for {selectedProgressYear}</div>
                  )}

                  {/* Quarter Input Cards */}
                  {timelineItem && (
                    <div className="p-6 bg-gray-50">
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        {[1, 2, 3, 4].map(quarter => {
                          const quarterItem = yearItems.find(q => q.quarter === quarter);
                          const displayValue = getDisplayValue(initiative.id, timelineItem.year, quarter);
                          const valueSource = quarterItem?.valueSource || getValueSourceFromProgress(initiative.id, timelineItem.year, quarter);
                          const isPending = hasPendingEdit(initiative.id, timelineItem.year, quarter);
                          const cellKey = `${initiative.id}-${timelineItem.year}-${quarter}`;
                          const isSaving = savingOverride === cellKey;
                          
                          const targetConfig = {
                            type: initiative.targets.type,
                            currency: initiative.targets.currency,
                            low_count_threshold: initiative.targets.low_count_threshold,
                          };
                          const dynamicTargetType = mapTargetType(initiative.targets?.type || 'count');
                          
                          // Determine card state
                          const hasValue = displayValue !== 0 && displayValue !== '0' && displayValue !== '';
                          const isCompleted = hasValue && !isPending;
                          const isActive = true; // Logic for active/locked could be added here based on dates

                          return (
                            <div 
                              key={quarter}
                              className={cn(
                                "bg-white rounded-lg border p-4 transition-all",
                                isCompleted ? "border-green-200 shadow-sm" : "border-gray-200 shadow-sm",
                                isActive ? "hover:border-blue-300 hover:shadow-md" : "opacity-75 bg-gray-50"
                              )}
                            >
                              <div className="flex justify-between items-start mb-3">
                                <span className={cn(
                                  "text-xs font-bold px-2 py-1 rounded uppercase",
                                  isCompleted ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"
                                )}>
                                  Q{quarter}
                                </span>
                                {valueSource === 'qpro' && (
                                  <span className="text-xs text-green-600 font-medium flex items-center gap-1">
                                    <CheckCircle2 className="w-3 h-3" /> QPRO
                                  </span>
                                )}
                              </div>
                              
                              <div className="space-y-3">
                                <label className="text-xs font-medium text-gray-500 uppercase">Actual Value</label>
                                <div className="flex items-center gap-2">
                                  <DynamicInput
                                    targetType={dynamicTargetType}
                                    value={displayValue ?? ''}
                                    onChange={(val) => updatePendingEdit(initiative.id, timelineItem.year, quarter, val)}
                                    placeholder="0"
                                    className="text-lg font-semibold h-10"
                                  />
                                </div>
                                
                                {isPending && (
                                  <Button
                                    size="sm"
                                    className="w-full mt-2"
                                    onClick={() => {
                                       // Save logic (copied from original)
                                       const editValue = pendingEdits[`${initiative.id}-${timelineItem.year}-${quarter}`]?.value;
                                       let valueToSave: number | string | null = null;
                                       if (dynamicTargetType === 'MILESTONE') {
                                         valueToSave = editValue === 1 || editValue === '1' ? 1 : 0;
                                       } else if (dynamicTargetType === 'TEXT_CONDITION') {
                                         valueToSave = editValue ? String(editValue) : null;
                                       } else {
                                         const numValue = typeof editValue === 'string' ? parseFloat(editValue.replace(/,/g, '')) : editValue;
                                         valueToSave = (typeof numValue === 'number' && !Number.isNaN(numValue)) ? numValue : null;
                                       }
                                       const qproVal = getCurrentValueFromProgress(initiative.id, timelineItem.year, quarter);
                                       if (typeof valueToSave === 'number' && valueToSave === 0 && qproVal === 0) {
                                         valueToSave = null;
                                       }
                                       saveManualOverride(initiative.id, timelineItem.year, quarter, valueToSave, undefined, dynamicTargetType);
                                    }}
                                    disabled={isSaving}
                                  >
                                    {isSaving ? 'Saving...' : 'Save Changes'}
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-300 p-8 text-center">
            <p className="text-gray-600">No KPIs found for this KRA.</p>
          </div>
        )}
      </div>
    </div>
  );
}
