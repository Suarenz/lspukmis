import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';
import strategicPlan from '@/lib/data/strategic_plan.json';
import { getInitiativeTargetMeta, normalizeKraId, normalizeInitiativeId, isCumulativeTarget, findInitiative, getTargetValueForYear } from '@/lib/utils/qpro-aggregation';
import { mapTargetType } from '@/lib/utils/target-type-utils';

// Helper to map strategic plan target types
function mapTargetTypeFromPlan(planType: string): 'MILESTONE' | 'COUNT' | 'PERCENTAGE' | 'FINANCIAL' | 'TEXT_CONDITION' {
  return mapTargetType(planType);
}

interface KPIProgressItem {
  initiativeId: string;
  year: number;
  quarter: number;
  targetValue: string | number;
  currentValue: number | string; // Can be string for text_condition or numeric for others
  achievementPercent: number;
  status: 'MET' | 'ON_TRACK' | 'MISSED' | 'PENDING';
  submissionCount: number;
  participatingUnits: string[];
  targetType: 'MILESTONE' | 'COUNT' | 'PERCENTAGE' | 'FINANCIAL' | 'TEXT_CONDITION'; // Type of input
  // Manual override fields - allows users to correct QPRO-derived values
  manualOverride?: number | string | null;
  manualOverrideReason?: string | null;
  manualOverrideBy?: string | null;
  manualOverrideAt?: string | null;
  valueSource: 'qpro' | 'manual' | 'none';
  hasUnapprovedData?: boolean; // Indicates this includes unapproved/draft QPRO submissions
}

interface KPIProgress {
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

/**
 * GET /api/kpi-progress
 * 
 * Returns the progress/achievement for each KPI based on approved QPRO analyses
 * 
 * Query params:
 * - kraId: Filter by specific KRA (e.g., "KRA 1")
 * - year: Filter by year (default: current year)
 * - quarter: Filter by quarter (1-4, optional)
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;

    const { searchParams } = new URL(request.url);
    const kraId = searchParams.get('kraId');
    const year = parseInt(searchParams.get('year') || new Date().getFullYear().toString());
    const quarter = searchParams.get('quarter') ? parseInt(searchParams.get('quarter')!) : undefined;

    // Get KRA from strategic plan using normalized ID
    const allKras = (strategicPlan as any).kras || [];
    const normalizedKraIdParam = kraId ? normalizeKraId(kraId) : null;
    const targetKra = normalizedKraIdParam 
      ? allKras.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraIdParam)
      : null;

    if (kraId && !targetKra) {
      return NextResponse.json({ error: 'KRA not found' }, { status: 404 });
    }

    // Build query conditions for aggregation activities
    const whereConditions: any = {
      isApproved: true, // Only count approved activities
    };

    // Get approved aggregation activities
    const aggregationActivities = await prisma.aggregationActivity.findMany({
      where: whereConditions,
      include: {
        qproAnalysis: {
          select: {
            year: true,
            quarter: true,
            unitId: true,
            unit: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
        },
      },
    });

    // Also get from KRAggregation table for aggregated data
    // NOTE: kra_id may be stored as "KRA3" or "KRA 3" depending on historical data.
    const kraIdVariants = (() => {
      if (!kraId) return null;
      const normalized = normalizeKraId(kraId);
      const compact = normalized.replace(/\s+/g, '');
      return Array.from(new Set([kraId, normalized, compact]));
    })();

    // Get KPIContributions - the source of truth for per-document contributions
    // Include created_at for SNAPSHOT logic (take latest value)
    // IMPORTANT: For cumulative KPIs, we need contributions from ALL years (2025 to current)
    // since progress carries forward. We fetch from 2025 and filter during aggregation.
    const STRATEGIC_PLAN_START_YEAR = 2025;
    const kpiContributions = await prisma.kPIContribution.findMany({
      where: {
        year: { gte: STRATEGIC_PLAN_START_YEAR, lte: year }, // Fetch 2025 to requested year
        ...(quarter && { quarter }),
        ...(kraIdVariants && { kra_id: { in: kraIdVariants } }),
      },
      orderBy: {
        created_at: 'desc', // Most recent first for SNAPSHOT logic
      },
    });

    // Also get DRAFT (unapproved) aggregation activities to show provisional progress
    // These are activities staged for review but not yet approved
    const draftActivities = await prisma.aggregationActivity.findMany({
      where: {
        isApproved: false,
        qproAnalysis: {
          year,
          ...(quarter && { quarter }),
          status: 'DRAFT', // Only include DRAFT analyses
        },
      },
      include: {
        qproAnalysis: {
          select: {
            id: true,
            year: true,
            quarter: true,
            unitId: true,
            status: true,
            unit: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
        },
      },
    });

    console.log(`[KPI Progress] Found ${draftActivities.length} DRAFT activities for year ${year}${quarter ? `, quarter ${quarter}` : ''}`);
    if (draftActivities.length > 0) {
      console.log('[KPI Progress] Sample draft activity:', JSON.stringify(draftActivities[0], null, 2));
    }

    // Build contribution totals by KPI with proper aggregation based on target_type:
    // - COUNT: Sum all contributions (research outputs, events, etc.)
    // - SNAPSHOT: Take latest value (faculty count, student population)
    // - RATE/PERCENTAGE: Average all contributions (employment rate, grades)
    // - MILESTONE/BOOLEAN: Take latest (once achieved, done)
    //
    // CUMULATIVE TARGET HANDLING:
    // For KPIs with target_time_scope: "cumulative", contributions from ALL years
    // (2025 to requested year) are summed together. This is for KPIs where the
    // target spans the entire 2025-2029 period (e.g., "100% budget utilization by 2029").
    interface ContributionAggregate {
      total: number;       // For COUNT: sum, For RATE: sum for averaging, For SNAPSHOT/MILESTONE: latest value
      count: number;       // Number of contributions
      targetType: string;
      latestValue: number; // Most recent contribution value (for SNAPSHOT)
      latestAt: Date;      // Timestamp of latest contribution
      isCumulative: boolean; // Whether this KPI has cumulative target scope
      contributingYears: Set<number>; // Years that contributed (for cumulative tracking)
    }
    const contributionTotals = new Map<string, ContributionAggregate>();

    // For cumulative KPIs, track the per-year contribution aggregate so manual overrides
    // can REPLACE (not double-count) that year's computed contribution in the all-years sum.
    const cumulativeYearBases = new Map<string, {
      total: number;
      count: number;
      targetType: string;
      latestValue: number;
      latestAt: Date;
    }>();
    
    // For cumulative KPIs, we also maintain a separate "all-years" aggregate
    // that sums contributions across all years (for display in the requested year)
    const cumulativeAggregates = new Map<string, ContributionAggregate>();
    
    console.log(`[KPI Progress] Processing ${kpiContributions.length} KPIContribution records...`);
    
    for (const contrib of kpiContributions) {
      const normalizedKraId = normalizeKraId(contrib.kra_id);
      
      // Check if this KPI has cumulative target scope
      const isCumulative = isCumulativeTarget(strategicPlan as any, normalizedKraId, contrib.initiative_id);
      
      // Standard key includes year for per-year tracking
      const key = `${normalizedKraId}|${contrib.initiative_id}|${contrib.year}|${contrib.quarter}`;
      const existing = contributionTotals.get(key);
      
      // DEFENSIVE VALIDATION: Ensure target_type is valid before processing
      if (!contrib.target_type || typeof contrib.target_type !== 'string') {
        console.error(`[KPI Progress] ⚠️  CRITICAL: Invalid target_type in contribution ${contrib.id}: ${contrib.target_type} (type: ${typeof contrib.target_type})`);
        continue; // Skip this contribution to prevent corruption
      }
      
      const targetType = contrib.target_type.toUpperCase();
      
      if (!existing) {
        // First contribution for this key - initialize
        contributionTotals.set(key, {
          total: contrib.value,
          count: 1,
          targetType: contrib.target_type,
          latestValue: contrib.value,
          latestAt: contrib.created_at,
          isCumulative,
          contributingYears: new Set([contrib.year]),
        });
      } else {
        // DEFENSIVE CHECK: Warn if target_type mismatch detected
        // This prevents the bug where different contributions have inconsistent types
        if (existing.targetType.toUpperCase() !== targetType) {
          console.warn(`[KPI Progress] ⚠️  Target type mismatch for ${key}: existing="${existing.targetType}", current="${contrib.target_type}". Using existing type.`);
        }
        
        // Aggregate based on target type
        if (targetType === 'SNAPSHOT' || targetType === 'MILESTONE' || targetType === 'BOOLEAN' || targetType === 'TEXT_CONDITION') {
          // SNAPSHOT/MILESTONE: Keep only the latest value (most recent by created_at)
          // Since we ordered by created_at DESC, first entry is already latest
          // Only update if this is newer (shouldn't happen due to ordering, but safety check)
          if (contrib.created_at > existing.latestAt) {
            existing.latestValue = contrib.value;
            existing.latestAt = contrib.created_at;
          }
          existing.count += 1;
        } else if (targetType === 'RATE' || targetType === 'PERCENTAGE') {
          // RATE/PERCENTAGE: Accumulate for averaging
          existing.total += contrib.value;
          existing.count += 1;
        } else {
          // COUNT (default): Sum all contributions
          existing.total += contrib.value;
          existing.count += 1;
        }
        existing.contributingYears.add(contrib.year);
      }
      
      // CUMULATIVE AGGREGATION: For cumulative KPIs, also track all-years aggregate
      // This will be used when displaying progress for the requested year
      if (isCumulative) {
        // Key WITH year - captures the computed contribution for a single year
        const yearlyKey = `${normalizedKraId}|${contrib.initiative_id}|${contrib.quarter}|${contrib.year}`;
        const existingYearly = cumulativeYearBases.get(yearlyKey);
        if (!existingYearly) {
          cumulativeYearBases.set(yearlyKey, {
            total: contrib.value,
            count: 1,
            targetType: contrib.target_type,
            latestValue: contrib.value,
            latestAt: contrib.created_at,
          });
        } else {
          // Aggregate same as above but scoped to a single year
          if (targetType === 'SNAPSHOT' || targetType === 'MILESTONE' || targetType === 'BOOLEAN' || targetType === 'TEXT_CONDITION') {
            if (contrib.created_at > existingYearly.latestAt) {
              existingYearly.latestValue = contrib.value;
              existingYearly.latestAt = contrib.created_at;
            }
            existingYearly.count += 1;
          } else if (targetType === 'RATE' || targetType === 'PERCENTAGE') {
            existingYearly.total += contrib.value;
            existingYearly.count += 1;
          } else {
            existingYearly.total += contrib.value;
            existingYearly.count += 1;
          }
        }

        // Key without year - aggregates ALL years for this KPI+quarter
        const cumulativeKey = `${normalizedKraId}|${contrib.initiative_id}|${contrib.quarter}`;
        const existingCumulative = cumulativeAggregates.get(cumulativeKey);
        
        if (!existingCumulative) {
          cumulativeAggregates.set(cumulativeKey, {
            total: contrib.value,
            count: 1,
            targetType: contrib.target_type,
            latestValue: contrib.value,
            latestAt: contrib.created_at,
            isCumulative: true,
            contributingYears: new Set([contrib.year]),
          });
        } else {
          // Aggregate same as above but across all years
          // IMPORTANT: For cumulative PERCENTAGE, SUM values (each year adds to total progress)
          // e.g., 20% in 2025 + 10% in 2026 = 30% total cumulative progress
          if (targetType === 'PERCENTAGE') {
            // SUM for cumulative percentage - each year adds to total progress
            existingCumulative.total += contrib.value;
            if (contrib.created_at > existingCumulative.latestAt) {
              existingCumulative.latestAt = contrib.created_at;
            }
            existingCumulative.count += 1;
          } else if (targetType === 'SNAPSHOT' || targetType === 'MILESTONE' || targetType === 'BOOLEAN' || targetType === 'TEXT_CONDITION') {
            // Use latest by timestamp for non-percentage snapshots
            if (contrib.created_at > existingCumulative.latestAt) {
              existingCumulative.latestValue = contrib.value;
              existingCumulative.latestAt = contrib.created_at;
            }
            existingCumulative.count += 1;
          } else if (targetType === 'RATE') {
            existingCumulative.total += contrib.value;
            existingCumulative.count += 1;
          } else {
            // COUNT: sum all contributions
            existingCumulative.total += contrib.value;
            existingCumulative.count += 1;
          }
          existingCumulative.contributingYears.add(contrib.year);
        }
      }
    }
    
    // Log cumulative KPIs being tracked
    if (cumulativeAggregates.size > 0) {
      console.log(`[KPI Progress] Found ${cumulativeAggregates.size} cumulative KPI aggregates:`);
      cumulativeAggregates.forEach((agg, key) => {
        console.log(`  ${key}: total=${agg.total}, years=${Array.from(agg.contributingYears).join(',')}`);
      });
    }
    
    // DEFENSIVE SUMMARY: Log aggregation patterns to detect anomalies
    console.log(`[KPI Progress] Aggregation summary: ${contributionTotals.size} unique KPI/period combinations`);
    const typeCounts = new Map<string, number>();
    contributionTotals.forEach((agg, key) => {
      const type = agg.targetType.toUpperCase();
      typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
      
      // Log detailed aggregation for debugging
      console.log(`[KPI Progress] ${key}: type=${type}, count=${agg.count}, total=${agg.total}, latest=${agg.latestValue}`);
      
      // Warn if COUNT aggregation has suspiciously low total (possible SNAPSHOT behavior)
      if (type === 'COUNT' && agg.count > 1 && agg.total === agg.latestValue) {
        console.warn(`[KPI Progress] ⚠️  Possible aggregation anomaly for ${key}: COUNT type with ${agg.count} contributions but total=${agg.total} equals latest=${agg.latestValue}`);
      }
    });
    console.log(`[KPI Progress] Aggregation types: ${Array.from(typeCounts.entries()).map(([t, c]) => `${t}=${c}`).join(', ')}`);

    // For cumulative KPIs, fetch manual overrides from ALL years (2025 to requested year)
    // For annual KPIs, only fetch the requested year
    const kraAggregations = await prisma.kRAggregation.findMany({
      where: {
        year: { gte: STRATEGIC_PLAN_START_YEAR, lte: year }, // Fetch 2025 to requested year
        ...(quarter && { quarter }),
        ...(kraIdVariants && { kra_id: { in: kraIdVariants } }),
      },
      orderBy: [
        { year: 'asc' },  // IMPORTANT: Process earlier years first for cumulative aggregation
        { quarter: 'asc' },
      ],
    });

    // Build progress map
    const progressMap = new Map<string, Map<string, KPIProgressItem[]>>();

    const toFiniteNumber = (raw: unknown): number | null => {
      if (raw === null || raw === undefined) return null;
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, '').trim());
      return Number.isFinite(n) ? n : null;
    };

    // Build a Set of KPIs that have KPIContribution records (new system)
    // We'll use this to avoid double-counting when processing legacy AggregationActivity data
    const kpisWithContributions = new Set<string>();
    for (const contrib of kpiContributions) {
      const key = `${normalizeKraId(contrib.kra_id)}|${contrib.initiative_id}|${contrib.year}|${contrib.quarter}`;
      kpisWithContributions.add(key);
    }

    // Process aggregation activities (LEGACY system for backwards compatibility)
    // Only process activities for KPIs that DON'T have KPIContribution records
    // This ensures old documents (approved before KPIContribution system) still show progress
    for (const activity of aggregationActivities) {
      const qpro = activity.qproAnalysis;
      if (!qpro) continue;

      // Filter by year and quarter
      if (qpro.year !== year) continue;
      if (quarter && qpro.quarter !== quarter) continue;

      const initiativeId = activity.initiative_id;
      
      // Extract KRA from initiative ID (e.g., "KRA1-KPI1" -> "KRA 1") using normalized format
      const kraMatch = initiativeId.match(/^(KRA\s?\d+)/i);
      const rawKraId = kraMatch ? kraMatch[1] : null;
      const activityKraId = rawKraId ? normalizeKraId(rawKraId) : null;
      
      // Use normalized comparison for KRA ID filtering
      if (kraId && activityKraId !== normalizeKraId(kraId)) continue;
      if (!activityKraId) continue;

      // IMPORTANT: Skip this KPI if it already has KPIContribution records (avoid double-counting)
      const skipKey = `${activityKraId}|${initiativeId}|${qpro.year}|${qpro.quarter}`;
      if (kpisWithContributions.has(skipKey)) {
        console.log(`[KPI Progress] Skipping legacy activity for ${skipKey} - has KPIContribution records`);
        continue;
      }

      // Initialize maps
      if (!progressMap.has(activityKraId)) {
        progressMap.set(activityKraId, new Map());
      }
      const kraMap = progressMap.get(activityKraId)!;
      
      if (!kraMap.has(initiativeId)) {
        kraMap.set(initiativeId, []);
      }
      
      const progressItems = kraMap.get(initiativeId)!;
      
      // Find or create progress item for this year/quarter
      let progressItem = progressItems.find(
        p => p.year === qpro.year && p.quarter === qpro.quarter
      );
      
      if (!progressItem) {
        // Get target from strategic plan using normalized KRA ID and initiative ID
        const normalizedActKraId = normalizeKraId(activityKraId);
        const kra = allKras.find((k: any) => normalizeKraId(k.kra_id) === normalizedActKraId);
        
        // Normalize initiative ID to match strategic plan format
        const normalizedInitId = normalizeInitiativeId(String(initiativeId || ''));
        let initiative = kra?.initiatives.find((i: any) => normalizeInitiativeId(String(i.id)) === normalizedInitId);
        
        // Fallback: search by KPI number if direct match fails
        if (!initiative && initiativeId) {
          const kpiMatch = String(initiativeId).match(/KPI(\d+)/i);
          if (kpiMatch) {
            initiative = kra?.initiatives?.find((i: any) => String(i.id).includes(`KPI${kpiMatch[1]}`));
          }
        }
        
        const timelineData = initiative?.targets?.timeline_data?.find((t: any) => t.year === qpro.year);
        
        // Map target type from strategic plan
        const planTargetType = initiative?.targets?.type || 'count';
        const targetType = mapTargetTypeFromPlan(planTargetType);
        
        progressItem = {
          initiativeId,
          year: qpro.year,
          quarter: qpro.quarter,
          targetValue: timelineData?.target_value ?? 0,
          currentValue: 0,
          achievementPercent: 0,
          status: 'PENDING',
          submissionCount: 0,
          participatingUnits: [],
          targetType,
          manualOverride: null,
          manualOverrideReason: null,
          manualOverrideBy: null,
          manualOverrideAt: null,
          valueSource: 'none',
          hasUnapprovedData: false,
        };
        progressItems.push(progressItem);
      }

      // Aggregate reported values.
      // NOTE: For percentage KPIs we must NOT sum across units/activities; we aggregate as a mean measurement.
      if (activity.reported != null) {
        const reported = toFiniteNumber(activity.reported);
        if (reported !== null) {
          const meta = getInitiativeTargetMeta(
            strategicPlan as any,
            activityKraId,
            initiativeId,
            qpro.year
          );
          const targetType = String(meta.targetType || '').toLowerCase();

          if (targetType === 'percentage') {
            // Normalize percent:
            // - Accept 0..100
            // - If reported is a count and activity.target is a denominator, convert to percent
            let pct: number | null = null;
            if (reported >= 0 && reported <= 100) {
              pct = reported;
            } else {
              const denom = toFiniteNumber(activity.target);
              if (denom !== null && denom > 0 && reported >= 0) {
                const computed = (reported / denom) * 100;
                if (computed >= 0 && computed <= 100) pct = computed;
              }
            }

            if (pct !== null) {
              const sumKey = '_pctSum';
              const countKey = '_pctCount';
              (progressItem as any)[sumKey] = ((progressItem as any)[sumKey] || 0) + pct;
              (progressItem as any)[countKey] = ((progressItem as any)[countKey] || 0) + 1;
            }
          } else {
            const currentNum = typeof progressItem.currentValue === 'number' ? progressItem.currentValue : 0;
            progressItem.currentValue = currentNum + reported;
          }
        }
      }
      progressItem.submissionCount++;
      
      // Track participating units
      if (qpro.unit && !progressItem.participatingUnits.includes(qpro.unit.code)) {
        progressItem.participatingUnits.push(qpro.unit.code);
      }
    }

    // Process DRAFT activities to show provisional progress (pending approval)
    // These are newly uploaded documents that haven't been approved yet
    console.log(`[KPI Progress] Processing ${draftActivities.length} DRAFT activities...`);
    for (const activity of draftActivities) {
      const qpro = activity.qproAnalysis;
      if (!qpro) continue;

      const initiativeId = activity.initiative_id;
      
      console.log(`[KPI Progress] DRAFT activity: ${initiativeId}, reported: ${activity.reported}, year: ${qpro.year}, quarter: ${qpro.quarter}`);
      
      // Extract KRA from initiative ID
      const kraMatch = initiativeId.match(/^(KRA\s?\d+)/i);
      const rawKraId = kraMatch ? kraMatch[1] : null;
      const activityKraId = rawKraId ? normalizeKraId(rawKraId) : null;
      
      if (kraId && activityKraId !== normalizeKraId(kraId)) continue;
      if (!activityKraId) continue;

      // Initialize maps
      if (!progressMap.has(activityKraId)) {
        progressMap.set(activityKraId, new Map());
      }
      const kraMap = progressMap.get(activityKraId)!;
      
      if (!kraMap.has(initiativeId)) {
        kraMap.set(initiativeId, []);
      }
      
      const progressItems = kraMap.get(initiativeId)!;
      
      // Find or create progress item for this year/quarter
      let progressItem = progressItems.find(
        p => p.year === qpro.year && p.quarter === qpro.quarter
      );
      
      if (!progressItem) {
        // Get target from strategic plan - normalize initiative ID
        const normalizedActKraId = normalizeKraId(activityKraId);
        const kra = allKras.find((k: any) => normalizeKraId(k.kra_id) === normalizedActKraId);
        const normalizedInitId = normalizeInitiativeId(String(initiativeId || ''));
        let initiative = kra?.initiatives.find((i: any) => normalizeInitiativeId(String(i.id)) === normalizedInitId);
        if (!initiative && initiativeId) {
          const kpiMatch = String(initiativeId).match(/KPI(\d+)/i);
          if (kpiMatch) {
            initiative = kra?.initiatives?.find((i: any) => String(i.id).includes(`KPI${kpiMatch[1]}`));
          }
        }
        const timelineData = initiative?.targets?.timeline_data?.find((t: any) => t.year === qpro.year);
        
        const planTargetType = initiative?.targets?.type || 'count';
        const targetType = mapTargetTypeFromPlan(planTargetType);
        
        progressItem = {
          initiativeId,
          year: qpro.year,
          quarter: qpro.quarter,
          targetValue: timelineData?.target_value ?? 0,
          currentValue: 0,
          achievementPercent: 0,
          status: 'PENDING', // Mark as pending approval
          submissionCount: 0,
          participatingUnits: [],
          targetType,
          manualOverride: null,
          manualOverrideReason: null,
          manualOverrideBy: null,
          manualOverrideAt: null,
          valueSource: 'none',
          hasUnapprovedData: true,
        };
        progressItems.push(progressItem);
      }

      // Aggregate reported values from DRAFT activities
      // These will be added to approved values to show total provisional progress
      if (activity.reported != null) {
        const reported = toFiniteNumber(activity.reported);
        if (reported !== null) {
          const meta = getInitiativeTargetMeta(
            strategicPlan as any,
            activityKraId,
            initiativeId,
            qpro.year
          );
          const targetType = String(meta.targetType || '').toLowerCase();

          if (targetType === 'percentage') {
            // Normalize percent for DRAFT activities too
            let pct: number | null = null;
            if (reported >= 0 && reported <= 100) {
              pct = reported;
            } else {
              const denom = toFiniteNumber(activity.target);
              if (denom !== null && denom > 0 && reported >= 0) {
                const computed = (reported / denom) * 100;
                if (computed >= 0 && computed <= 100) pct = computed;
              }
            }

            if (pct !== null) {
              const sumKey = '_pctSum';
              const countKey = '_pctCount';
              (progressItem as any)[sumKey] = ((progressItem as any)[sumKey] || 0) + pct;
              (progressItem as any)[countKey] = ((progressItem as any)[countKey] || 0) + 1;
            }
          } else {
            const currentNum = typeof progressItem.currentValue === 'number' ? progressItem.currentValue : 0;
            progressItem.currentValue = currentNum + reported;
          }
        }
      }
      progressItem.submissionCount++;
      
      // Mark that this progress item includes unapproved/draft submissions
      progressItem.hasUnapprovedData = true;
      
      // Track participating units for DRAFT activities
      if (qpro.unit && !progressItem.participatingUnits.includes(qpro.unit.code)) {
        progressItem.participatingUnits.push(qpro.unit.code);
      }
    }

    // Track which cumulative KPIs we've already processed (to avoid duplicate entries)
    // This must be declared before processing KRAggregations and KPIContributions
    const processedCumulativeKPIs = new Set<string>();

    // Also use KRAggregation data for more accurate totals
    // For cumulative KPIs, we need to aggregate manual overrides across ALL years
    for (const agg of kraAggregations) {
      const kraMapKey = normalizeKraId(agg.kra_id);
      
      // Check if this is a cumulative KPI
      const isCumulative = isCumulativeTarget(strategicPlan as any, kraMapKey, agg.initiative_id);
      
      // For cumulative KPIs, aggregate manual overrides from all years
      if (isCumulative && agg.year < year) {
        // This is a prior year's manual override - add it to cumulative aggregate
        const cumulativeKey = `${kraMapKey}|${agg.initiative_id}|${agg.quarter}`;
        const existingCumulative = cumulativeAggregates.get(cumulativeKey);
        
        const hasManualOverride = agg.manual_override !== null && agg.manual_override !== undefined;
        if (hasManualOverride) {
          const manualValue = agg.manual_override?.toNumber() ?? 0;
          const yearlyKey = `${kraMapKey}|${agg.initiative_id}|${agg.quarter}|${agg.year}`;
          const baseForYear = cumulativeYearBases.get(yearlyKey);
          
          if (!existingCumulative) {
            cumulativeAggregates.set(cumulativeKey, {
              total: manualValue,
              count: 1,
              targetType: (agg.target_type as string) || 'count',
              latestValue: manualValue,
              latestAt: agg.manual_override_at || new Date(),
              isCumulative: true,
              contributingYears: new Set([agg.year]),
            });
          } else {
            // Aggregate based on target type
            // IMPORTANT: For cumulative PERCENTAGE, SUM values (each year adds to total progress)
            const targetType = String(agg.target_type || 'count').toUpperCase();
            if (targetType === 'PERCENTAGE') {
              // Manual override replaces that year's computed contribution (if any)
              if (baseForYear) {
                existingCumulative.total = existingCumulative.total - baseForYear.total + manualValue;
              } else {
                existingCumulative.total += manualValue;
              }
              if (agg.manual_override_at && agg.manual_override_at > existingCumulative.latestAt) {
                existingCumulative.latestAt = agg.manual_override_at;
              }
              existingCumulative.count += 1;
            } else if (targetType === 'SNAPSHOT' || targetType === 'MILESTONE' || targetType === 'BOOLEAN' || targetType === 'TEXT_CONDITION') {
              // Use latest by timestamp for non-percentage snapshots
              if (agg.manual_override_at && agg.manual_override_at > existingCumulative.latestAt) {
                existingCumulative.latestValue = manualValue;
                existingCumulative.latestAt = agg.manual_override_at;
              }
              existingCumulative.count += 1;
            } else if (targetType === 'RATE') {
              // Manual override replaces all contributions for that year (treated as 1 measurement)
              if (baseForYear) {
                existingCumulative.total -= baseForYear.total;
                existingCumulative.count = Math.max(0, existingCumulative.count - baseForYear.count);
              }
              existingCumulative.total += manualValue;
              existingCumulative.count += 1;
            } else {
              // COUNT: sum all contributions
              // Manual override replaces that year's computed contribution (if any)
              if (baseForYear) {
                existingCumulative.total = existingCumulative.total - baseForYear.total + manualValue;
              } else {
                existingCumulative.total += manualValue;
              }
              existingCumulative.count += 1;
            }
            existingCumulative.contributingYears.add(agg.year);
          }
          console.log(`[KPI Progress] Added manual override from ${agg.year} to cumulative aggregate for ${cumulativeKey}: value=${manualValue}`);
        }
        continue; // Skip creating entry for prior years - they'll be included in requested year's aggregate
      }
      
      // For the requested year (or annual KPIs), process normally
      // BUT: For cumulative KPIs in the requested year, if there's a manual override,
      // For cumulative KPIs in the requested year:
      // We need to combine prior year values WITH this year's contribution.
      // The cumulative total = sum of all prior years + current year contribution.
      if (isCumulative && agg.year === year) {
        const cumulativeKey = `${kraMapKey}|${agg.initiative_id}|${agg.quarter}`;
        const existingCumulative = cumulativeAggregates.get(cumulativeKey);
        
        const hasManualOverride = agg.manual_override !== null && agg.manual_override !== undefined;
        const manualValue = hasManualOverride ? (agg.manual_override?.toNumber() ?? 0) : 0;
        
        // For cumulative KPIs, we ALWAYS add to the cumulative aggregate
        // A value of 0 means "no new contribution this year", not "reset to 0"
        if (!existingCumulative) {
          // No prior year data - create initial cumulative entry with this year's value
          cumulativeAggregates.set(cumulativeKey, {
            total: manualValue,
            count: hasManualOverride ? 1 : 0,
            targetType: (agg.target_type as string) || 'count',
            latestValue: manualValue,
            latestAt: agg.manual_override_at || new Date(),
            isCumulative: true,
            contributingYears: new Set(hasManualOverride && manualValue > 0 ? [agg.year] : []),
          });
          console.log(`[KPI Progress] Created cumulative aggregate for ${cumulativeKey} with current year value=${manualValue}`);
        } else {
          // Prior year data exists - ADD current year's contribution
          // IMPORTANT: For cumulative, we SUM values across years
          const targetType = String(agg.target_type || 'count').toUpperCase();
          
          if (targetType === 'SNAPSHOT' || targetType === 'MILESTONE' || targetType === 'BOOLEAN' || targetType === 'TEXT_CONDITION') {
            // For SNAPSHOT types, use the latest non-zero value
            if (hasManualOverride && manualValue > 0 && agg.manual_override_at && agg.manual_override_at > existingCumulative.latestAt) {
              existingCumulative.latestValue = manualValue;
              existingCumulative.latestAt = agg.manual_override_at;
            }
            // For snapshot, total represents the latest value
            existingCumulative.total = existingCumulative.latestValue;
          } else {
            // For COUNT, PERCENTAGE, FINANCIAL: ADD current year's contribution to prior years
            // Only add if value > 0 (0 means "no new contribution this year")
            if (hasManualOverride && manualValue > 0) {
              existingCumulative.total += manualValue;
              existingCumulative.contributingYears.add(agg.year);
              if (agg.manual_override_at && agg.manual_override_at > existingCumulative.latestAt) {
                existingCumulative.latestAt = agg.manual_override_at;
              }
              existingCumulative.count += 1;
            }
          }
          console.log(`[KPI Progress] Added current year contribution to cumulative aggregate for ${cumulativeKey}: current_year_value=${manualValue}, cumulative_total=${existingCumulative.total}`);
        }
        
        // DO NOT mark as processed here - let the "HANDLE CUMULATIVE KPIs" section create the entry
        // This ensures the progress item is created with the correct cumulative value
        console.log(`[KPI Progress] Skipping entry creation for cumulative KPI ${agg.initiative_id} Q${agg.quarter} - will use cumulative section`);
        continue;
      }
      
      if (!progressMap.has(kraMapKey)) {
        progressMap.set(kraMapKey, new Map());
      }
      const kraMap = progressMap.get(kraMapKey)!;
      
      if (!kraMap.has(agg.initiative_id)) {
        kraMap.set(agg.initiative_id, []);
      }
      
      const progressItems = kraMap.get(agg.initiative_id)!;
      
      // Find or update progress item
      let progressItem = progressItems.find(
        p => p.year === agg.year && p.quarter === agg.quarter
      );
      
      // Determine value source and final current value
      const hasManualOverride = agg.manual_override !== null && agg.manual_override !== undefined;
      const qproValue = agg.total_reported ?? 0;
      
      // For cumulative KPIs, use the cumulative aggregate value (includes prior years)
      let finalValue: number;
      let contributingYearsForEntry: number[] | null = null;
      const aggTargetType = String(agg.target_type || 'count').toUpperCase();
      
      if (isCumulative && hasManualOverride) {
        // Use cumulative aggregate which includes current year's manual override + prior years
        const cumulativeKey = `${kraMapKey}|${agg.initiative_id}|${agg.quarter}`;
        const cumulativeData = cumulativeAggregates.get(cumulativeKey);
        if (cumulativeData) {
          if (aggTargetType === 'PERCENTAGE') {
            finalValue = Math.min(100, cumulativeData.total);
          } else if (aggTargetType === 'SNAPSHOT' || aggTargetType === 'MILESTONE' || aggTargetType === 'BOOLEAN' || aggTargetType === 'TEXT_CONDITION') {
            finalValue = cumulativeData.latestValue;
          } else if (aggTargetType === 'RATE') {
            finalValue = cumulativeData.count > 0 ? Math.round(cumulativeData.total / cumulativeData.count) : 0;
          } else {
            finalValue = cumulativeData.total;
          }
          contributingYearsForEntry = Array.from(cumulativeData.contributingYears).sort();
          console.log(`[KPI Progress] Using cumulative value ${finalValue} for ${agg.initiative_id} (from years: ${contributingYearsForEntry.join(',')})`);
        } else {
          finalValue = agg.manual_override?.toNumber() ?? qproValue;
        }
      } else {
        finalValue = hasManualOverride ? (agg.manual_override?.toNumber() ?? qproValue) : qproValue;
      }
      
      const valueSource: 'qpro' | 'manual' | 'none' = hasManualOverride ? 'manual' 
        : qproValue > 0 ? 'qpro' 
        : 'none';
      
      // For TEXT_CONDITION, return the text current_value instead of numeric manual_override
      let displayCurrentValue: number | string = finalValue;
      if (aggTargetType === 'TEXT_CONDITION' && hasManualOverride && agg.current_value) {
        displayCurrentValue = agg.current_value; // Return "Met", "Not Met", "In Progress"
      } else if (aggTargetType === 'TEXT_CONDITION' && hasManualOverride) {
         // Fallback if current_value is missing but manual_override exists
         if (finalValue >= 1) displayCurrentValue = 'Met';
         else if (finalValue >= 0.5) displayCurrentValue = 'In Progress';
         else displayCurrentValue = 'Not Met'; 
      }
      
      if (!progressItem) {
        progressItem = {
          initiativeId: agg.initiative_id,
          year: agg.year,
          quarter: agg.quarter,
          targetValue: agg.target_value?.toNumber() ?? 0,
          currentValue: displayCurrentValue,
          achievementPercent: agg.achievement_percent?.toNumber() ?? 0,
          status: (agg.status as any) || 'PENDING',
          submissionCount: agg.submission_count,
          participatingUnits: (agg.participating_units as string[]) || [],
          targetType: (aggTargetType as any) || 'COUNT',
          manualOverride: hasManualOverride ? agg.manual_override?.toNumber() : null,
          manualOverrideReason: agg.manual_override_reason || null,
          manualOverrideBy: agg.manual_override_by || null,
          manualOverrideAt: agg.manual_override_at?.toISOString() || null,
          valueSource,
        };
        // Add cumulative info if applicable
        if (isCumulative && contributingYearsForEntry && contributingYearsForEntry.length > 1) {
          (progressItem as any).isCumulative = true;
          (progressItem as any).contributingYears = contributingYearsForEntry;
        }
        progressItems.push(progressItem);
      } else {
        // Update with aggregation data (more accurate)
        progressItem.currentValue = displayCurrentValue;
        
        // Update targetType from aggregation record (authoritative source)
        if (aggTargetType) {
          progressItem.targetType = aggTargetType as any;
        }
        
        if (agg.achievement_percent != null) {
          progressItem.achievementPercent = agg.achievement_percent.toNumber();
        }
        if (agg.status) {
          progressItem.status = agg.status as any;
        }
        // Add manual override info
        progressItem.manualOverride = hasManualOverride ? agg.manual_override?.toNumber() : null;
        progressItem.manualOverrideReason = agg.manual_override_reason || null;
        progressItem.manualOverrideBy = agg.manual_override_by || null;
        progressItem.manualOverrideAt = agg.manual_override_at?.toISOString() || null;
        progressItem.valueSource = valueSource;
        // Add cumulative info if applicable
        if (isCumulative && contributingYearsForEntry && contributingYearsForEntry.length > 1) {
          (progressItem as any).isCumulative = true;
          (progressItem as any).contributingYears = contributingYearsForEntry;
        }
      }
    }

    // =====================================================================
    // USE KPIContribution data as the PRIMARY source of truth for progress
    // This ensures approved document contributions are reflected immediately
    // =====================================================================
    console.log(`[KPI Progress] Processing ${contributionTotals.size} contribution totals...`);
    
    for (const [key, contribData] of contributionTotals) {
      console.log(`[KPI Progress] Processing contribution key: ${key}, total=${contribData.total}, count=${contribData.count}`);
      
      const [kraIdKey, initiativeId, yearStr, quarterStr] = key.split('|');
      const contribYear = parseInt(yearStr);
      const contribQuarter = parseInt(quarterStr);
      
      // CUMULATIVE TARGET HANDLING:
      // For cumulative KPIs, we want to show the aggregated progress from ALL years (2025 to requested year)
      // when viewing the requested year. Skip entries from earlier years - they're already in cumulativeAggregates.
      const isCumulative = contribData.isCumulative;
      
      if (isCumulative) {
        // For cumulative KPIs, only process the requested year
        // Use the cumulative aggregate which includes all years up to the requested year
        if (contribYear !== year) {
          console.log(`[KPI Progress] Skipping cumulative KPI ${initiativeId} for year ${contribYear} (will use aggregate in year ${year})`);
          continue;
        }
        
        // Check if we've already processed this cumulative KPI (for this quarter)
        // NOTE: We only add to processedCumulativeKPIs if there's data for the requested year
        const cumulativeTrackingKey = `${kraIdKey}|${initiativeId}|${contribQuarter}`;
        if (processedCumulativeKPIs.has(cumulativeTrackingKey)) {
          console.log(`[KPI Progress] Skipping duplicate cumulative entry for ${cumulativeTrackingKey}`);
          continue;
        }
        // Mark as processed AFTER we create the entry below
        // This ensures the "HANDLE CUMULATIVE KPIs" section doesn't duplicate it
        
        // Use the cumulative aggregate AND add any manual overrides from years without QPRO contributions
        const cumulativeKey = `${kraIdKey}|${initiativeId}|${contribQuarter}`;
        const cumulativeData = cumulativeAggregates.get(cumulativeKey);
        if (cumulativeData) {
          console.log(`[KPI Progress] Using cumulative aggregate for ${initiativeId}: total=${cumulativeData.total}, years=${Array.from(cumulativeData.contributingYears).join(',')}`);
          // Override contribData with cumulative data for processing below
          Object.assign(contribData, {
            total: cumulativeData.total,
            count: cumulativeData.count,
            latestValue: cumulativeData.latestValue,
            latestAt: cumulativeData.latestAt,
            contributingYears: cumulativeData.contributingYears,
          });
        }
      }
      
      console.log(`[KPI Progress] Parsed: kraIdKey=${kraIdKey}, initiativeId=${initiativeId}, year=${contribYear}, quarter=${contribQuarter}, isCumulative=${isCumulative}`);
      
      // Initialize progress map entries if needed
      if (!progressMap.has(kraIdKey)) {
        progressMap.set(kraIdKey, new Map());
        console.log(`[KPI Progress] Created new kraMap for ${kraIdKey}`);
      }
      const kraMap = progressMap.get(kraIdKey)!;
      
      if (!kraMap.has(initiativeId)) {
        kraMap.set(initiativeId, []);
        console.log(`[KPI Progress] Created new progressItems array for ${initiativeId}`);
      }
      
      const progressItems = kraMap.get(initiativeId)!;
      console.log(`[KPI Progress] Current progressItems length: ${progressItems.length}`);
      
      let progressItem = progressItems.find(
        p => p.year === contribYear && p.quarter === contribQuarter
      );
      
      console.log(`[KPI Progress] Found existing progressItem: ${!!progressItem}`);
      
      if (!progressItem) {
        // Get target from strategic plan - normalize initiative ID
        const kra = allKras.find((k: any) => normalizeKraId(k.kra_id) === kraIdKey);
        const normalizedInitId = normalizeInitiativeId(String(initiativeId || ''));
        let initiative = kra?.initiatives.find((i: any) => normalizeInitiativeId(String(i.id)) === normalizedInitId);
        if (!initiative && initiativeId) {
          const kpiMatch = String(initiativeId).match(/KPI(\d+)/i);
          if (kpiMatch) {
            initiative = kra?.initiatives?.find((i: any) => String(i.id).includes(`KPI${kpiMatch[1]}`));
          }
        }
        const timelineData = initiative?.targets?.timeline_data?.find((t: any) => t.year === contribYear);
        const planTargetType = initiative?.targets?.type || 'count';
        const targetType = mapTargetTypeFromPlan(planTargetType);
        
        console.log(`[KPI Progress] Target lookup for ${initiativeId}:`);
        console.log(`  - KRA found: ${!!kra}`);
        console.log(`  - Initiative found: ${!!initiative}`);
        console.log(`  - Targets object: ${!!initiative?.targets}`);
        console.log(`  - Timeline data array: ${initiative?.targets?.timeline_data?.length || 0} items`);
        console.log(`  - Looking for year: ${contribYear}`);
        console.log(`  - Timeline data found: ${!!timelineData}`);
        if (timelineData) {
          console.log(`  - Target value: ${timelineData.target_value}`);
        }
        
        progressItem = {
          initiativeId,
          year: contribYear,
          quarter: contribQuarter,
          targetValue: timelineData?.target_value ?? 0,
          currentValue: 0,
          achievementPercent: 0,
          status: 'PENDING',
          submissionCount: 0,
          participatingUnits: [],
          targetType,
          manualOverride: null,
          manualOverrideReason: null,
          manualOverrideBy: null,
          manualOverrideAt: null,
          valueSource: 'none',
          hasUnapprovedData: false,
        };
        progressItems.push(progressItem);
      }
      
      console.log(`[KPI Progress] progressItem found/created, valueSource=${progressItem.valueSource}, currentValue=${progressItem.currentValue}`);
      
      // ALWAYS update with KPIContribution data - it's the source of truth from approved documents
      // KPIContribution takes precedence over manual overrides since it represents actual submitted data
      console.log(`[KPI Progress] Updating progressItem with contribution data (overriding any manual value)`);
      const targetType = contribData.targetType.toUpperCase();
      
      // Calculate the final value based on aggregation type
      let finalContribValue: number;
      if (targetType === 'SNAPSHOT' || targetType === 'MILESTONE' || targetType === 'BOOLEAN' || targetType === 'TEXT_CONDITION') {
        // SNAPSHOT: Use latest value only
        finalContribValue = contribData.latestValue;
      } else if (targetType === 'PERCENTAGE') {
        // PERCENTAGE: For cumulative, use SUM (capped at 100); for annual, average
        if (contribData.isCumulative) {
          // Cumulative: SUM all contributions across years (capped at 100)
          finalContribValue = Math.min(100, contribData.total);
        } else {
          // Annual: Average contributions for this period
          finalContribValue = contribData.count > 0 ? Math.round(contribData.total / contribData.count) : 0;
        }
      } else if (targetType === 'RATE') {
        // RATE: Average all contributions
        finalContribValue = contribData.count > 0 ? Math.round(contribData.total / contribData.count) : 0;
      } else {
        // COUNT (default): Sum all contributions
        finalContribValue = contribData.total;
      }
      
      // Update progress item with contribution data
      // For TEXT_CONDITION, preserve the text label from current_value instead of numeric
      if (targetType === 'TEXT_CONDITION') {
        // TEXT_CONDITION stores qualitative values - keep existing text label if set via manual override
        // Only update to numeric if there's no text current_value already set
        if (!progressItem.currentValue || typeof progressItem.currentValue === 'number') {
          // Map numeric back to text: 1 = Met, 0.5 = In Progress, 0 = Not Met
          if (finalContribValue >= 1) progressItem.currentValue = 'Met';
          else if (finalContribValue > 0) progressItem.currentValue = 'In Progress';
          else progressItem.currentValue = 'Not Met';
        }
      } else {
        progressItem.currentValue = finalContribValue;
      }
      progressItem.submissionCount = contribData.count;
      progressItem.valueSource = 'qpro';
      
      // Add cumulative info for UI to show which years contributed
      if (contribData.isCumulative && contribData.contributingYears.size > 1) {
        (progressItem as any).isCumulative = true;
        (progressItem as any).contributingYears = Array.from(contribData.contributingYears).sort();
      }
      
      // Clear manual override since QPRO data takes precedence
      progressItem.manualOverride = null;
      progressItem.manualOverrideReason = null;
      progressItem.manualOverrideBy = null;
      progressItem.manualOverrideAt = null;
      
      // Clear the unapproved flag since we're now using approved data
      // If there were draft submissions, they'll be added on top of this approved data
      if (progressItem.hasUnapprovedData !== true) {
        progressItem.hasUnapprovedData = false;
      }
      
      // Mark cumulative KPIs as processed to prevent duplicate entries
      if (isCumulative) {
        const cumulativeTrackingKey = `${kraIdKey}|${initiativeId}|${contribQuarter}`;
        processedCumulativeKPIs.add(cumulativeTrackingKey);
        console.log(`[KPI Progress] Marked cumulative KPI ${cumulativeTrackingKey} as processed after creating entry`);
      }
      
      // Log contribution application for debugging
      console.log(`[KPI Progress] Applied contribution: ${key} -> currentValue=${finalContribValue}, submissionCount=${contribData.count} (type: ${targetType}, method: ${targetType === 'SNAPSHOT' ? 'latest' : targetType === 'RATE' || targetType === 'PERCENTAGE' ? 'average' : 'sum'}, cumulative=${contribData.isCumulative})`);
    }

    // =====================================================================
    // HANDLE CUMULATIVE KPIs WITH CONTRIBUTIONS FROM EARLIER YEARS ONLY
    // If a cumulative KPI has contributions from 2025 but user is viewing 2026,
    // we need to create an entry for 2026 that shows the cumulative progress.
    // =====================================================================
    for (const [cumulativeKey, cumulativeData] of cumulativeAggregates) {
      const [kraIdKey, initiativeId, quarterStr] = cumulativeKey.split('|');
      const contribQuarter = parseInt(quarterStr);
      
      // Check if we already processed this in the main loop
      const trackingKey = `${kraIdKey}|${initiativeId}|${contribQuarter}`;
      if (processedCumulativeKPIs.has(trackingKey)) {
        continue; // Already processed
      }
      
      // This cumulative KPI has contributions from earlier years but no entry for requested year
      // We need to create one to show the cumulative progress
      console.log(`[KPI Progress] Creating entry for cumulative KPI ${initiativeId} year ${year} using prior year contributions`);
      
      // Initialize progress map entries if needed
      if (!progressMap.has(kraIdKey)) {
        progressMap.set(kraIdKey, new Map());
      }
      const kraMap = progressMap.get(kraIdKey)!;
      
      if (!kraMap.has(initiativeId)) {
        kraMap.set(initiativeId, []);
      }
      
      const progressItems = kraMap.get(initiativeId)!;
      
      // Get target from strategic plan for the requested year
      const kra = allKras.find((k: any) => normalizeKraId(k.kra_id) === kraIdKey);
      const normalizedInitId = normalizeInitiativeId(String(initiativeId || ''));
      let initiative = kra?.initiatives.find((i: any) => normalizeInitiativeId(String(i.id)) === normalizedInitId);
      if (!initiative && initiativeId) {
        const kpiMatch = String(initiativeId).match(/KPI(\d+)/i);
        if (kpiMatch) {
          initiative = kra?.initiatives?.find((i: any) => String(i.id).includes(`KPI${kpiMatch[1]}`));
        }
      }
      
      // For cumulative KPIs, use getTargetValueForYear which has fallback logic
      // (e.g., if only 2029 target exists, use it for all years 2025-2029)
      const targetValue = getTargetValueForYear(initiative?.targets?.timeline_data, year) ?? 0;
      
      const planTargetType = initiative?.targets?.type || 'count';
      const targetType = mapTargetTypeFromPlan(planTargetType);
      
      // Calculate the final value from cumulative data
      let finalContribValue: number;
      const targetTypeUpper = cumulativeData.targetType.toUpperCase();
      if (targetTypeUpper === 'SNAPSHOT' || targetTypeUpper === 'MILESTONE' || targetTypeUpper === 'BOOLEAN' || targetTypeUpper === 'TEXT_CONDITION') {
        finalContribValue = cumulativeData.latestValue;
      } else if (targetTypeUpper === 'PERCENTAGE') {
        // For cumulative percentage: SUM all contributions (each year adds to total)
        // Cap at 100% maximum
        finalContribValue = Math.min(100, cumulativeData.total);
      } else if (targetTypeUpper === 'RATE') {
        // For rate: average the values
        finalContribValue = cumulativeData.count > 0 ? Math.round(cumulativeData.total / cumulativeData.count) : 0;
      } else {
        finalContribValue = cumulativeData.total;
      }
      
      // For TEXT_CONDITION, convert numeric back to text label
      let displayCurrentValue: number | string = finalContribValue;
      if (targetTypeUpper === 'TEXT_CONDITION') {
        if (finalContribValue >= 1) displayCurrentValue = 'Met';
        else if (finalContribValue > 0) displayCurrentValue = 'In Progress';
        else displayCurrentValue = 'Not Met';
      }

      const progressItem: KPIProgressItem = {
        initiativeId,
        year,
        quarter: contribQuarter,
        targetValue: targetValue,
        currentValue: displayCurrentValue,
        achievementPercent: 0,
        status: 'PENDING',
        submissionCount: cumulativeData.count,
        participatingUnits: [],
        targetType,
        manualOverride: null,
        manualOverrideReason: null,
        manualOverrideBy: null,
        manualOverrideAt: null,
        valueSource: 'qpro',
        hasUnapprovedData: false,
      };
      
      // Add cumulative info
      (progressItem as any).isCumulative = true;
      (progressItem as any).contributingYears = Array.from(cumulativeData.contributingYears).sort();
      
      progressItems.push(progressItem);
      console.log(`[KPI Progress] Created cumulative entry: ${initiativeId} year ${year} Q${contribQuarter} -> currentValue=${finalContribValue} from years ${Array.from(cumulativeData.contributingYears).join(',')}`);
    }

    // Finalize percentage KPI averages and calculate achievement/status for items without aggregation data
    for (const [kraIdKey, kraMap] of progressMap) {
      for (const [initiativeIdKey, progressItems] of kraMap) {
        for (const item of progressItems) {

          // If we accumulated pct values, convert to mean
          const pctCount = (item as any)._pctCount as number | undefined;
          const pctSum = (item as any)._pctSum as number | undefined;
          if (pctCount && pctSum !== undefined) {
            // Store as an integer percent for consistency with DB/UI inputs.
            item.currentValue = Math.round(pctSum / pctCount);
          }

          // Prefer explicit aggregation table if present; otherwise compute from current/target.
          const currentNum = typeof item.currentValue === 'number' ? item.currentValue : parseFloat(String(item.currentValue)) || 0;
          if (item.achievementPercent === 0 && currentNum > 0) {
            const target = typeof item.targetValue === 'number'
              ? item.targetValue
              : parseFloat(String(item.targetValue)) || 0;

            console.log(`[KPI Progress] Final calc check for ${item.initiativeId}: currentValue=${currentNum}, targetValue=${target} (from item.targetValue=${item.targetValue})`);

            if (target > 0) {
              item.achievementPercent = Math.round((currentNum / target) * 100 * 100) / 100;
              console.log(`[KPI Progress] Achievement calc for ${item.initiativeId}: currentValue=${currentNum}, targetValue=${target}, achievement=${item.achievementPercent}%`);
            } else {
              console.log(`[KPI Progress] ⚠️ SKIP: target is 0 or negative for ${item.initiativeId}`);
            }
          }

          // Clamp for UI progress bars
          item.achievementPercent = Math.min(100, Math.max(0, item.achievementPercent || 0));

          // Only clamp currentValue for percentage KPIs.
          const meta = getInitiativeTargetMeta(
            strategicPlan as any,
            kraIdKey,
            initiativeIdKey,
            item.year
          );
          const targetType = String(meta.targetType || '').toLowerCase();
          if (targetType === 'percentage') {
            item.currentValue = Math.min(100, Math.max(0, currentNum));
          }
          
          // Update status based on achievement
          if (item.status === 'PENDING' && item.achievementPercent > 0) {
            if (item.achievementPercent >= 100) {
              item.status = 'MET';
            } else if (item.achievementPercent >= 80) {
              item.status = 'ON_TRACK';
            } else {
              item.status = 'MISSED';
            }
          }
        }
      }
    }

    // Build response
    const krasToProcess = kraId ? [targetKra] : allKras;
    const response: KPIProgress[] = [];

    for (const kra of krasToProcess) {
      if (!kra) continue;
      
      // Use normalized KRA ID for consistent lookup
      const normalizedKraIdForLookup = normalizeKraId(kra.kra_id);
      
      const kraProgress: KPIProgress = {
        kraId: kra.kra_id,
        kraTitle: kra.kra_title,
        initiatives: [],
      };

      for (const initiative of kra.initiatives || []) {
        const kraMap = progressMap.get(normalizedKraIdForLookup);
        let progressItems = kraMap?.get(initiative.id) || [];
        
        console.log(`[KPI Progress Response] Building response for ${initiative.id}: found ${progressItems.length} progress items in progressMap`);

        // Get target from strategic plan for creating missing quarter entries
        const timelineData = initiative.targets?.timeline_data?.find((t: any) => t.year === year);
        if (timelineData) {
          const quartersToCreate = quarter ? [quarter] : [1, 2, 3, 4];
          const planTargetType = initiative.targets?.type || 'count';
          const targetType = mapTargetTypeFromPlan(planTargetType);
          
          // Create entries for any missing quarters
          for (const q of quartersToCreate) {
            const existingItem = progressItems.find(p => p.year === year && p.quarter === q);
            if (!existingItem) {
              progressItems.push({
                initiativeId: initiative.id,
                year,
                quarter: q,
                targetValue: timelineData.target_value,
                currentValue: 0,
                achievementPercent: 0,
                status: 'PENDING',
                submissionCount: 0,
                participatingUnits: [],
                targetType,
                manualOverride: null,
                manualOverrideReason: null,
                manualOverrideBy: null,
                manualOverrideAt: null,
                valueSource: 'none',
              });
            }
          }
          
          // Sort by quarter for consistent display
          progressItems.sort((a, b) => a.quarter - b.quarter);
        }

        kraProgress.initiatives.push({
          id: initiative.id,
          outputs: initiative.key_performance_indicator?.outputs || '',
          outcomes: initiative.key_performance_indicator?.outcomes || '',
          targetType: initiative.targets?.type || 'count',
          progress: progressItems,
        });
        
        // Log what we're adding to response
        if (progressItems.length > 0 && progressItems.some(p => p.currentValue !== 0)) {
          console.log(`[KPI Progress Response] Added ${initiative.id} with ${progressItems.length} items:`, 
            progressItems.map(p => `Q${p.quarter}=${p.currentValue}`).join(', '));
        }
      }

      response.push(kraProgress);
    }
    
    console.log(`[KPI Progress] Final response: ${response.length} KRAs`);

    return NextResponse.json({
      success: true,
      year,
      quarter,
      data: kraId ? response[0] : response,
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });

  } catch (error) {
    console.error('Error fetching KPI progress:', error);
    return NextResponse.json(
      { error: 'Failed to fetch KPI progress', details: (error as Error).message },
      { 
        status: 500,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      }
    );
  }
}

/**
 * PATCH /api/kpi-progress
 * 
 * Save a manual override for a specific KPI's current value
 * 
 * Body:
 * - kraId: string (e.g., "KRA 5")
 * - initiativeId: string (e.g., "KRA5-KPI9")
 * - year: number
 * - quarter: number
 * - value: number | null (set to null to clear override and use QPRO value)
 * - reason?: string (optional reason for override)
 */
export async function PATCH(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;
    const { user } = authResult;

    const body = await request.json();
    const { kraId, initiativeId, year, quarter, value, reason, targetType } = body;

    // Validate required fields
    if (!kraId || !initiativeId || !year || !quarter) {
      return NextResponse.json(
        { error: 'Missing required fields: kraId, initiativeId, year, quarter' },
        { status: 400 }
      );
    }

    // Determine targetType if not provided
    let finalTargetType = targetType;
    if (!finalTargetType) {
      // Get from strategic plan - normalize initiative ID
      const allKras = (strategicPlan as any).kras || [];
      const normalizedKraId = normalizeKraId(kraId);
      const targetKra = allKras.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraId);
      const normalizedInitId = normalizeInitiativeId(String(initiativeId || ''));
      let initiative = targetKra?.initiatives?.find((i: any) => normalizeInitiativeId(String(i.id)) === normalizedInitId);
      if (!initiative && initiativeId) {
        const kpiMatch = String(initiativeId).match(/KPI(\d+)/i);
        if (kpiMatch) {
          initiative = targetKra?.initiatives?.find((i: any) => String(i.id).includes(`KPI${kpiMatch[1]}`));
        }
      }
      finalTargetType = mapTargetTypeFromPlan(initiative?.targets?.type || 'count');
    }

    // Normalize KRA ID for database lookup
    const normalizedKraId = normalizeKraId(kraId);
    const kraIdVariants = [kraId, normalizedKraId, normalizedKraId.replace(/\s+/g, '')];

    // Find existing aggregation record
    const existingAgg = await prisma.kRAggregation.findFirst({
      where: {
        kra_id: { in: kraIdVariants },
        initiative_id: initiativeId,
        year,
        quarter,
      },
    });

    if (!existingAgg) {
      // Create a new aggregation record if it doesn't exist
      // Get target from strategic plan - normalize initiative ID
      const allKras = (strategicPlan as any).kras || [];
      const targetKra = allKras.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraId);
      const normalizedInitId = normalizeInitiativeId(String(initiativeId || ''));
      let initiative = targetKra?.initiatives?.find((i: any) => normalizeInitiativeId(String(i.id)) === normalizedInitId);
      if (!initiative && initiativeId) {
        const kpiMatch = String(initiativeId).match(/KPI(\d+)/i);
        if (kpiMatch) {
          initiative = targetKra?.initiatives?.find((i: any) => String(i.id).includes(`KPI${kpiMatch[1]}`));
        }
      }
      
      // Use getTargetValueForYear for proper fallback logic (handles cumulative KPIs with single 2029 target)
      const targetValue = getTargetValueForYear(initiative?.targets?.timeline_data, year) ?? 0;

      // Calculate achievement based on target type
      let achievementPercent = 0;
      let manualOverrideNum: number | null = null;
      let status: 'MET' | 'ON_TRACK' | 'MISSED' | 'NOT_APPLICABLE' = 'NOT_APPLICABLE';
      
      if (value !== null) {
        if (finalTargetType === 'TEXT_CONDITION') {
          // Qualitative mapping for text conditions
          if (value === 'Met') {
            achievementPercent = 100;
            status = 'MET';
            manualOverrideNum = 1;
          } else if (value === 'In Progress') {
            achievementPercent = 50;
            status = 'ON_TRACK';
            manualOverrideNum = 0.5;
          } else {
            achievementPercent = 0;
            status = 'MISSED';
            manualOverrideNum = 0;
          }
        } else if (finalTargetType === 'MILESTONE') {
          // Binary: 0% or 100%
          achievementPercent = (value === 1 || value === '1') ? 100 : 0;
          manualOverrideNum = (value === 1 || value === '1') ? 1 : 0;
          status = (value === 1 || value === '1') ? 'MET' : 'NOT_APPLICABLE';
        } else {
          // Numeric types: COUNT, PERCENTAGE, FINANCIAL
          const numValue = typeof value === 'number' ? value : parseFloat(String(value).replace(/,/g, '')) || 0;
          const targetNum = typeof targetValue === 'number' ? targetValue : parseFloat(String(targetValue)) || 0;
          achievementPercent = targetNum > 0 ? (numValue / targetNum) * 100 : 0;
          manualOverrideNum = numValue;
          
          // Determine status
          if (achievementPercent >= 100) {
            status = 'MET';
          } else if (achievementPercent >= 80) {
            status = 'ON_TRACK';
          } else if (numValue > 0) {
            status = 'MISSED';
          }
        }
      }

      const newAgg = await prisma.kRAggregation.create({
        data: {
          kra_id: normalizedKraId,
          kra_title: targetKra?.kra_title || '',
          initiative_id: initiativeId,
          year,
          quarter,
          total_reported: 0,
          target_value: typeof targetValue === 'number' ? targetValue : parseFloat(String(targetValue)) || 0,
          achievement_percent: achievementPercent,
          submission_count: 0,
          participating_units: [],
          status,
          target_type: finalTargetType,
          current_value: value !== null ? String(value) : null,
          manual_override: manualOverrideNum,
          manual_override_reason: reason || null,
          manual_override_by: user.id,
          manual_override_at: new Date(),
        },
      });

      return NextResponse.json({
        success: true,
        message: 'Manual override created',
        data: {
          id: newAgg.id,
          kraId: normalizedKraId,
          initiativeId,
          year,
          quarter,
          value: value,
          valueSource: value !== null ? 'manual' : 'none',
        },
      });
    }

    // Update existing record with manual override
    // Get the correct target value from strategic plan (handles cumulative KPIs)
    const allKrasForUpdate = (strategicPlan as any).kras || [];
    const targetKraForUpdate = allKrasForUpdate.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraId);
    const normalizedInitIdForUpdate = normalizeInitiativeId(String(initiativeId || ''));
    let initiativeForUpdate = targetKraForUpdate?.initiatives?.find((i: any) => normalizeInitiativeId(String(i.id)) === normalizedInitIdForUpdate);
    if (!initiativeForUpdate && initiativeId) {
      const kpiMatch = String(initiativeId).match(/KPI(\d+)/i);
      if (kpiMatch) {
        initiativeForUpdate = targetKraForUpdate?.initiatives?.find((i: any) => String(i.id).includes(`KPI${kpiMatch[1]}`));
      }
    }
    // Use getTargetValueForYear for proper fallback logic
    const correctTargetValue = getTargetValueForYear(initiativeForUpdate?.targets?.timeline_data, year) ?? (existingAgg.target_value?.toNumber() ?? 0);
    const targetValue = correctTargetValue;
    
    // Calculate achievement and status based on target type
    let achievementPercent = 0;
    let effectiveValue: number | string = value !== null ? value : (existingAgg.total_reported ?? 0);
    let manualOverrideNum: number | null = null;
    let status: 'MET' | 'ON_TRACK' | 'MISSED' | 'NOT_APPLICABLE' = 'NOT_APPLICABLE';
    
    if (value !== null) {
      if (finalTargetType === 'TEXT_CONDITION') {
        // Qualitative mapping for text conditions
        if (value === 'Met') {
          achievementPercent = 100;
          status = 'MET';
          manualOverrideNum = 1;
        } else if (value === 'In Progress') {
          achievementPercent = 50;
          status = 'ON_TRACK';
          manualOverrideNum = 0.5;
        } else {
          achievementPercent = 0;
          status = 'MISSED';
          manualOverrideNum = 0;
        }
        effectiveValue = String(value);
      } else if (finalTargetType === 'MILESTONE') {
        // Binary: 0% or 100%
        const isAchieved = value === 1 || value === '1';
        achievementPercent = isAchieved ? 100 : 0;
        status = isAchieved ? 'MET' : 'NOT_APPLICABLE';
        manualOverrideNum = isAchieved ? 1 : 0;
        effectiveValue = manualOverrideNum;
      } else {
        // Numeric types: COUNT, PERCENTAGE, FINANCIAL
        const numValue = typeof value === 'number' ? value : parseFloat(String(value).replace(/,/g, '')) || 0;
        effectiveValue = numValue;
        manualOverrideNum = numValue;
        
        if (targetValue > 0) {
          achievementPercent = (numValue / targetValue) * 100;
        }
        
        // Determine status based on achievement
        if (achievementPercent >= 100) {
          status = 'MET';
        } else if (achievementPercent >= 80) {
          status = 'ON_TRACK';
        } else if (numValue > 0) {
          status = 'MISSED';
        }
      }
    } else {
      // Clearing override - use existing QPRO value
      const qproValue = existingAgg.total_reported ?? 0;
      effectiveValue = qproValue;
      if (targetValue > 0 && qproValue > 0) {
        achievementPercent = (qproValue / targetValue) * 100;
        if (achievementPercent >= 100) status = 'MET';
        else if (achievementPercent >= 80) status = 'ON_TRACK';
        else status = 'MISSED';
      }
    }

    const updatedAgg = await prisma.kRAggregation.update({
      where: { id: existingAgg.id },
      data: {
        target_type: finalTargetType,
        target_value: correctTargetValue, // Fix incorrect target value
        current_value: value !== null ? String(value) : existingAgg.current_value,
        manual_override: manualOverrideNum,
        manual_override_reason: value !== null ? (reason || null) : null,
        manual_override_by: value !== null ? user.id : null,
        manual_override_at: value !== null ? new Date() : null,
        achievement_percent: achievementPercent,
        status,
      },
    });

    return NextResponse.json({
      success: true,
      message: value !== null ? 'Manual override saved' : 'Manual override cleared',
      data: {
        id: updatedAgg.id,
        kraId: existingAgg.kra_id,
        initiativeId,
        year,
        quarter,
        currentValue: effectiveValue,
        manualOverride: value,
        qproValue: existingAgg.total_reported,
        achievementPercent,
        status,
        targetType: finalTargetType,
        valueSource: value !== null ? 'manual' : (existingAgg.total_reported ?? 0) > 0 ? 'qpro' : 'none',
      },
    });

  } catch (error) {
    console.error('Error saving KPI manual override:', error);
    return NextResponse.json(
      { error: 'Failed to save manual override', details: (error as Error).message },
      { status: 500 }
    );
  }
}
