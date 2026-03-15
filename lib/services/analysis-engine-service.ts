// Router-Extractor Architecture: JSON-Guided Deterministic Flow
// This replaces the fuzzy vector search with a deterministic logic flow using strategic_plan.json

// Import Strategic Plan JSON (deterministic source of truth)
// Use the lib/data copy to keep API + UI consistent.
import strategicPlan from '@/lib/data/strategic_plan.json';

import { computeAggregatedAchievement, getInitiativeTargetMeta, normalizeKraId } from '@/lib/utils/qpro-aggregation';

// Import KPI Type-Aware Analysis Logic
import {
  getKpiTypeCategory,
  generateTypeSpecificLogicInstruction,
  getGapInterpretation,
  validatePrescriptiveAnalysis,
  inferDomainContext,
  buildContextAwarePromptEnrichment,
  generateContextAwareRecommendation,
  type KpiTypeCategory,
  type RawKpiType
} from '@/lib/utils/kpi-type-logic';

// Keep these for section detection and summary extraction (useful preprocessing)
import { documentSectionDetector } from './document-section-detector';
import { summaryExtractor } from './summary-extractor';

// LangChain imports
import { BaseLanguageModel } from "@langchain/core/language_models/base";
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { z } from 'zod';
import { redisService } from './redis-service';
import { createHash } from 'crypto';

// Import pdf2json and mammoth using CommonJS style since they use export = syntax
import mammoth from 'mammoth';
const PDFParser = require('pdf2json');

// ========== ROUTER-EXTRACTOR MODELS ==========
// Router Model: Fast/cheap for classification (gpt-4o-mini)
const routerModel = new ChatOpenAI({
  modelName: "gpt-4o-mini",
  temperature: 0,
  maxTokens: 500, // Router output is short
  modelKwargs: {
    response_format: { type: "json_object" },
    seed: 42,
  },
});

// Extractor Model: Use gpt-4o-mini for extraction (cost/speed parity with router)
const extractorModel = new ChatOpenAI({
  modelName: "gpt-4o-mini",
  temperature: 0,
  maxTokens: 2500, // Reduced to stay within OpenRouter credit limits
  modelKwargs: {
    response_format: { type: "json_object" },
    seed: 42,
  },
});

// ========== HELPER FUNCTIONS ==========
/**
 * Safely converts string or string[] to a single text block.
 * Handles inconsistent JSON data types in strategic_plan.json
 */
function formatList(data: string | string[] | undefined | null): string {
  if (!data) return "N/A";
  if (Array.isArray(data)) {
    return data.join("; ");
  }
  return data; // It's already a string
}

function normalizePercentageReported(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/,/g, '').trim());
  if (!Number.isFinite(n)) return 0;

  // Common extraction artifact: decimals stripped (e.g., "19.2%" -> 192)
  let v = n;
  while (v > 100 && v <= 1000) {
    v = v / 10;
  }

  // Clamp to valid percentage range
  v = Math.min(100, Math.max(0, v));

  // DB uses Int for reported; store whole-number percent
  return Math.round(v);
}

// ========== ROUTER FUNCTION ==========
/**
 * Phase 1: Router - Classify document to a single dominant KRA
 * Analyzes filename and text preview to deterministically select ONE KRA
 * This replaces the fuzzy vector search step
 */
async function classifyDominantKRA(filename: string, textPreview: string): Promise<{ kraId: string; confidence: number } | null> {
  console.log("🚀 [ROUTER] Classifying document...");
  console.log(`[ROUTER] Filename: "${filename}"`);
  console.log(`[ROUTER] Text preview length: ${textPreview.length} chars`);

  // 1. Build the "Menu" from Strategic Plan JSON
  // Include Responsible Offices as strong signals (e.g., "HRMO" -> KRA 11/13)
  const kraMenu = strategicPlan.kras.map((kra: any) => {
    const offices = [...new Set(kra.initiatives.flatMap((i: any) => i.responsible_offices))].join(', ');
    const kpiOutputs = kra.initiatives.map((i: any) => i.key_performance_indicator?.outputs || '').filter(Boolean).join('; ').substring(0, 200);
    return `ID: "${kra.kra_id}" | Title: "${kra.kra_title}" | Offices: [${offices}] | KPIs: [${kpiOutputs}...]`;
  }).join('\n');

  // 2. Strict Classification Prompt
  const prompt = `
ROLE: Strategic Document Router for Laguna State Polytechnic University.
TASK: Map the uploaded document to EXACTLY ONE Key Result Area (KRA) from the list below.

DOCUMENT CONTEXT:
Title/Filename: "${filename}"
Excerpt (first 1500 chars): "${textPreview.substring(0, 1500)}..."

AVAILABLE KRAS:
${kraMenu}

LOGIC RULES (Follow in order):
1. **Check Document Title First (HIGHEST PRIORITY)**:
   - "Alumni" or "Employment" or "Graduate Tracer" -> KRA 3
   - "Research" or "Publication" or "Citation" -> KRA 5
   - "Training" or "Seminar" or "Workshop" or "Faculty Development" -> KRA 11
   - "International" or "MOU" or "Exchange" or "Global" -> KRA 4
   - "Curriculum" or "Course" or "Program" -> KRA 1
   - "Extension" or "Community" -> KRA 6, 7, or 8
   - "Health" or "Wellness" or "Fitness" -> KRA 13
   - "Budget" or "Financial" or "Utilization" -> KRA 21 or 22
   - "Licensure" or "Board Exam" -> KRA 2

2. **Check Responsible Offices (if title unclear)**:
   - Document mentions "HR", "HRMO" -> KRA 11 or KRA 13
   - Document mentions "Research Office" -> KRA 5
   - Document mentions "Registrar" -> KRA 2 or KRA 3
   - Document mentions "OVPAA", "Academic Affairs" -> KRA 1

3. **Content Keywords**:
   - Employment rates, tracer study, alumni -> KRA 3
   - Research papers, publications, citations -> KRA 5
   - Training attended, seminars, workshops -> KRA 11
   - Health programs, wellness activities -> KRA 13
   - International partnerships, foreign exchange -> KRA 4

OUTPUT FORMAT (JSON):
{
  "kraId": "KRA X",
  "confidence": 0.95,
  "reasoning": "Brief explanation of why this KRA was selected"
}

If genuinely unsure, return: { "kraId": "UNKNOWN", "confidence": 0.0, "reasoning": "explanation" }
`;

  try {
    const result = await routerModel.invoke([
      { role: "system", content: "You are a document classifier that outputs only JSON." },
      { role: "user", content: prompt }
    ]);

    const responseText = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    const parsed = JSON.parse(responseText);
    
    const kraId = parsed.kraId?.trim().replace(/['"]/g, '');
    const confidence = parsed.confidence || 0.5;
    
    console.log(`[ROUTER] Classification result: ${kraId} (confidence: ${confidence})`);
    console.log(`[ROUTER] Reasoning: ${parsed.reasoning || 'N/A'}`);

    // Validate ID exists in JSON (use normalized KRA ID for comparison)
    const normalizedKraId = normalizeKraId(kraId);
    const exists = strategicPlan.kras.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraId);
    if (exists) {
      return { kraId: normalizedKraId, confidence }; // Return normalized kraId
    } else if (kraId === 'UNKNOWN') {
      console.log('[ROUTER] Document could not be classified to a specific KRA');
      return null;
    } else {
      console.warn(`[ROUTER] KRA ID "${kraId}" not found in strategic plan`);
      return null;
    }
  } catch (error) {
    console.error('[ROUTER] Classification failed:', error);
    return null;
  }
}

// ========== EXTRACTOR FUNCTION ==========
/**
 * Phase 2: Extractor - Extract activities using only the relevant KRA's KPIs
 * This provides the AI with focused context, eliminating KRA confusion
 */
async function extractActivitiesForKRA(
  fullText: string, 
  kraId: string, 
  reportYear: number = 2025
): Promise<any[]> {
  console.log(`🚀 [EXTRACTOR] Extracting for ${kraId} (Year: ${reportYear})...`);

  // 1. Get the Specific KRA from JSON (use normalized KRA ID for comparison)
  const normalizedKraIdVal = normalizeKraId(kraId);
  const targetKRA = strategicPlan.kras.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraIdVal);
  if (!targetKRA) {
    throw new Error(`Invalid KRA ID: ${kraId}`);
  }

  console.log(`[EXTRACTOR] Target KRA: "${targetKRA.kra_title}"`);
  console.log(`[EXTRACTOR] Number of initiatives: ${targetKRA.initiatives.length}`);

  // 2. Build Context ONLY for this KRA and Year
  const kpiContext = targetKRA.initiatives.map((init: any) => {
    const yearTarget = init.targets?.timeline_data?.find((t: any) => t.year === reportYear);
    const targetValue = yearTarget?.target_value ?? 'N/A';
    
    // Use the formatList helper to handle both Arrays and Strings safely
    const strategiesText = formatList(init.strategies);
    const activitiesText = formatList(init.programs_activities);
    
    return `
--------------------------------
KPI ID: "${init.id}"
Description: "${init.key_performance_indicator?.outputs || 'N/A'}"
Expected Outcomes: "${init.key_performance_indicator?.outcomes || 'N/A'}"
Context (Strategies): "${strategiesText}"
Context (Activities): "${activitiesText}"
Target Value (${reportYear}): "${targetValue}"
Unit: "${init.targets?.type || 'count'}"
    `;
  }).join('\n--------------------------------\n');

  // 3. The Extraction Prompt with strict rules
  const prompt = `
ROLE: Strategic Data Analyst for Laguna State Polytechnic University.
CONTEXT: Analyzing QPRO report for "${targetKRA.kra_title}" (${targetKRA.kra_id}).

TASK: Extract ALL activities/accomplishments from the document that relate to the KPIs below.

TARGET KPIs FOR THIS KRA:
${kpiContext}

DOCUMENT TYPE DETECTION:
- If this is a **Research Report**: Each completed research/publication/study = 1 activity
- If this is a **Training Report**: Each training/seminar attended = 1 activity  
- If this is an **Employment/Tracer Report**: Each program's employment rate = 1 activity
- If this is a **Financial Report**: Each budget item = 1 activity

CRITICAL EXTRACTION RULES:

1. **For Research/Publication Documents:**
   - Each research title = 1 activity with reported_value = 1
   - Count total completed researches for the aggregate
   - Extract: researcher name, title, date completed, publication venue
   - Match to KPIs about "research outputs", "publications", "completed researches"

2. **For Training Documents:**
   - Each training session attended = 1 activity
   - Extract: training title, attendee count, date
   - Match to KPIs about "training", "capacity building", "faculty development"

3. **For Academic/Employment Reports:**
   - Extract actual percentages or counts from tables
   - Match to KPIs about "employment rate", "licensure passing", "graduates"

4. **Value Extraction:**
   - For counts (research, training): reported_value = number of items (e.g., 5 researches = 5)
   - For percentages: reported_value = the percentage number (e.g., 85.5)
   - For milestones: reported_value = 1 if completed, 0 if not

5. **Target Lookup:**
   - Use Target values from KPI context above for year ${reportYear}
   - Calculate: achievement = (reported_value / target_value) * 100

6. **MUST EXTRACT SOMETHING:**
   - If the document mentions ANY accomplishments related to this KRA, extract them
   - Even if exact values aren't clear, estimate based on listed items
   - Count rows/entries if they represent individual accomplishments

7. **KPI ID FORMAT (CRITICAL):**
   - The kpi_id field MUST be in the format "KRAx-KPIy" (e.g., "KRA3-KPI5", "KRA1-KPI2")
   - NEVER use just the KRA ID like "KRA 3" as kpi_id
   - Pick the BEST matching KPI from the list above based on activity content
   - If unsure, default to the first KPI: "${targetKRA.kra_id.replace(/\s+/g, '')}-KPI1"

OUTPUT FORMAT (JSON):
{
  "activities": [
    {
      "name": "Completed Research: IT Infrastructure Assessment Study",
      "reported_value": 1,
      "target_value": 10,
      "achievement": 10,
      "status": "MISSED",
      "kpi_id": "KRA5-KPI1",
      "data_type": "count",
      "evidence_snippet": "REYNALEN C. JUSTO - IT Infrastructure Assessment...",
      "unit": "LSPU - Santa Cruz Campus"
    }
  ],
  "summary": {
    "total_activities": 5,
    "met_count": 2,
    "missed_count": 3
  }
}

NOTE FOR PERCENTAGE VALUES:
- Keep reported_value within 0-100.
- If you extracted something like 192 but it likely means 19.2%, interpret it as 19.2 (and round to 19 if needed).

IMPORTANT: You MUST extract at least 1 activity if the document contains any accomplishments.
If you see a list of researches, each research = 1 activity.
If you see a table, each meaningful row = 1 activity.

DOCUMENT TEXT:
${fullText}
`;

  try {
    const response = await extractorModel.invoke([
      { role: "system", content: "You are a precise data extractor that outputs only valid JSON." },
      { role: "user", content: prompt }
    ]);

    const responseText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const parsed = JSON.parse(responseText);
    
    const activities = parsed.activities || [];
    console.log(`[EXTRACTOR] Extracted ${activities.length} activities for ${kraId}`);
    
    // Enrich with KRA metadata
    return activities.map((act: any) => ({
      ...act,
      kraId: kraId,
      kraTitle: targetKRA.kra_title,
      initiativeId: act.kpi_id || act.initiativeId,
      reported: act.reported_value ?? act.reported ?? 0,
      target: act.target_value ?? act.target ?? 0,
      dataType: act.data_type || act.dataType || 'count',
      evidenceSnippet: act.evidence_snippet || act.evidenceSnippet || ''
    }));
  } catch (error) {
    console.error('[EXTRACTOR] Extraction failed:', error);
    throw error;
  }
}

// ========== PRESCRIPTIVE ANALYSIS GENERATOR ==========
/**
 * Phase 3: Generate prescriptive analysis based on extracted activities
 */
async function generatePrescriptiveAnalysis(
  activities: any[],
  kraId: string,
  kraTitle: string,
  reportYear: number
): Promise<{ 
  documentInsight: string;
  prescriptiveItems: Array<{ title: string; issue: string; action: string; nextStep?: string }>;
  alignment: string; 
  opportunities: string; 
  gaps: string; 
  recommendations: string;
  overallAchievement: number;
}> {
  const extractJsonObjectCandidate = (rawText: string): string => {
    const text = String(rawText || '').trim();
    if (!text) return '';

    // Strip markdown fences if present
    const unfenced = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    // If it already looks like JSON, keep it
    if (unfenced.startsWith('{') && unfenced.endsWith('}')) return unfenced;

    // Try to extract the first JSON object-like block
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) return unfenced.slice(start, end + 1);
    return unfenced;
  };

  const tryParseJson = (rawText: string): any | null => {
    const candidate = extractJsonObjectCandidate(rawText);
    if (!candidate) return null;

    // Common LLM issues: smart quotes + trailing commas
    const normalized = candidate
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/,\s*([}\]])/g, '$1');

    try {
      return JSON.parse(normalized);
    } catch {
      return null;
    }
  };
  console.log(`🚀 [PRESCRIPTIVE] Generating analysis for ${kraId}...`);

  // Use normalized KRA ID for consistent lookup
  const normalizedKraIdForPrescriptive = normalizeKraId(kraId);
  const targetKRA = strategicPlan.kras.find((k: any) => normalizeKraId(k.kra_id) === normalizedKraIdForPrescriptive);
  const strategies = targetKRA?.initiatives.flatMap((i: any) => i.strategies || []).join('; ') || 'N/A';

  // KPI-level aggregation (prevents per-item target inflation and average-of-tiny-percent bug)
  const byInitiative = new Map<string, any[]>();
  for (const a of activities) {
    const initiativeId = String(a.initiativeId || a.kpi_id || '').trim() || `${normalizedKraIdForPrescriptive}-KPI1`;
    if (!byInitiative.has(initiativeId)) byInitiative.set(initiativeId, []);
    byInitiative.get(initiativeId)!.push(a);
  }

  const kpiSummaries = Array.from(byInitiative.entries()).map(([initiativeId, acts]) => {
    const meta = getInitiativeTargetMeta(strategicPlan as any, normalizedKraIdForPrescriptive, initiativeId, reportYear);
    const fallbackTarget = typeof acts[0]?.initiativeTarget === 'number'
      ? acts[0].initiativeTarget
      : (typeof acts[0]?.target === 'number' ? acts[0].target : Number(acts[0]?.target || 0));
    const targetValue = meta.targetValue ?? (Number.isFinite(fallbackTarget) && fallbackTarget > 0 ? fallbackTarget : 0);

    const aggregated = computeAggregatedAchievement({
      targetType: meta.targetType,
      targetValue,
      targetScope: meta.targetScope,
      activities: acts,
    });

    const achievement = Math.min(100, Math.max(0, aggregated.achievementPercent));
    const status = achievement >= 100 ? 'MET' : achievement >= 80 ? 'ON_TRACK' : 'MISSED';

    // Get KPI type category for type-aware analysis
    const rawKpiType = meta.targetType || acts[0]?.dataType || acts[0]?.data_type || 'count';
    const kpiTypeCategory = getKpiTypeCategory(rawKpiType);
    const gapInterpretation = getGapInterpretation(kpiTypeCategory);

    // Provide sample outputs (titles) but avoid repeating target/gap per item.
    const samples = acts
      .map((x) => String(x.name || '').trim())
      .filter(Boolean)
      .slice(0, 5);

    return {
      initiativeId,
      targetType: meta.targetType || acts[0]?.dataType || acts[0]?.data_type || 'count',
      kpiTypeCategory,
      gapInterpretation,
      totalReported: aggregated.totalReported,
      totalTarget: aggregated.totalTarget,
      achievementPercent: achievement,
      status,
      samples,
    };
  });

  const overallAchievement = kpiSummaries.length > 0
    ? kpiSummaries.reduce((sum, k) => sum + (k.achievementPercent || 0), 0) / kpiSummaries.length
    : 0;

  const maxAchievement = kpiSummaries.length > 0
    ? Math.max(...kpiSummaries.map((k) => Number(k.achievementPercent || 0)))
    : 0;

  const metCount = kpiSummaries.filter((k) => k.status === 'MET').length;
  const missedCount = kpiSummaries.filter((k) => k.status === 'MISSED').length;

  const normalizeId = (value: unknown) => String(value || '').replace(/\s+/g, '').trim().toLowerCase();
  const planSnapshotText = kpiSummaries.map((k) => {
    const initiative = targetKRA?.initiatives?.find((i: any) => normalizeId(i.id) === normalizeId(k.initiativeId));
    const outputs = initiative?.key_performance_indicator?.outputs || 'N/A';
    const outcomes = initiative?.key_performance_indicator?.outcomes || 'N/A';
    const yearTarget = initiative?.targets?.timeline_data?.find((t: any) => t.year === reportYear)?.target_value;
    const unit = initiative?.targets?.type || k.targetType || 'count';
    const strategiesText = formatList(initiative?.strategies);
    const programsText = formatList(initiative?.programs_activities);
    const officesText = (initiative?.responsible_offices || []).join(', ') || 'N/A';
    const timeScope = initiative?.targets?.target_time_scope || 'N/A';
    return `- ${k.initiativeId}:
  Outputs="${outputs}" | Outcomes="${outcomes}"
  Target(${reportYear})=${yearTarget ?? 'N/A'} (${unit}) | Scope=${timeScope}
  Strategies="${strategiesText}"
  Authorized Programs="${programsText}"
  Responsible Offices="${officesText}"`;
  }).join('\n');

  // Enhanced KPI summary with type category for type-aware analysis
  const kpiSummaryText = kpiSummaries.map((k) => {
    const reportedStr = typeof k.totalReported === 'number' ? k.totalReported.toFixed(k.targetType === 'percentage' ? 1 : 0) : String(k.totalReported);
    const targetStr = typeof k.totalTarget === 'number' ? k.totalTarget.toFixed(k.targetType === 'percentage' ? 1 : 0) : String(k.totalTarget);
    const sampleText = k.samples.length > 0 ? ` | Examples: ${k.samples.join('; ')}` : '';
    const typeInfo = `Type: ${k.targetType} (${k.kpiTypeCategory})`;
    return `- ${k.initiativeId}: ${reportedStr} vs ${targetStr} (${k.achievementPercent.toFixed(1)}%) [${k.status}] | ${typeInfo}${sampleText}`;
  }).join('\n');

  // Build type-specific logic rules for each unique KPI type in this analysis
  const uniqueKpiTypes = [...new Set(kpiSummaries.map(k => k.kpiTypeCategory))];
  const typeSpecificRules = uniqueKpiTypes.map(category => {
    const interpretation = getGapInterpretation(category);
    const relevantKpis = kpiSummaries.filter(k => k.kpiTypeCategory === category);
    const kpiIds = relevantKpis.map(k => k.initiativeId).join(', ');
    
    let rule = `\n[RULE FOR ${category} METRICS (${kpiIds})]:\n`;
    rule += `Gap Type: ${interpretation.gapType}\n`;
    rule += `Focus Areas: ${interpretation.rootCauseFocus.slice(0, 3).join('; ')}\n`;
    rule += `Action Archetype: ${interpretation.actionArchetype}\n`;
    if (interpretation.antiPattern) {
      rule += `⚠️ AVOID: ${interpretation.antiPattern}\n`;
    }
    return rule;
  }).join('\n');

  // Infer domain context from activity names and KRA title
  const allActivityNames = activities.map((a: any) => String(a.name || '').trim()).filter(Boolean);
  const domainContext = inferDomainContext(allActivityNames, kpiSummaries[0]?.initiativeId, kraTitle);
  const domainPromptEnrichment = buildContextAwarePromptEnrichment(allActivityNames, kpiSummaries[0]?.initiativeId, kraTitle);
  console.log(`[PRESCRIPTIVE] Domain context inferred: ${domainContext.domain} (${domainContext.domainLabel})`);

  const prompt = `
ROLE: Strategic Planning Advisor for Laguna State Polytechnic University (LSPU).
CONTEXT: Analyzing performance for "${kraTitle}" (${kraId}).

STRATEGIC PLAN SNAPSHOT (KRA-only, authoritative):
${planSnapshotText || 'N/A'}

PERFORMANCE DATA:
${kpiSummaryText}

SUMMARY:
- Total Extracted Items (evidence): ${activities.length}
- KPIs Evaluated: ${kpiSummaries.length}
- KPIs Met: ${metCount}
- KPIs Missed: ${missedCount}
- Overall Achievement (KPI-level): ${overallAchievement.toFixed(1)}%
- Highest KPI Achievement: ${maxAchievement.toFixed(1)}%

AUTHORIZED STRATEGIES FOR THIS KRA:
${strategies}

================================================================================
DOMAIN CONTEXT (CRITICAL - READ BEFORE GENERATING RECOMMENDATIONS)
================================================================================
${domainPromptEnrichment}
================================================================================

================================================================================
TYPE-AWARE ANALYSIS RULES (FOLLOW STRICTLY)
================================================================================
Your prescriptive recommendations MUST be appropriate for the KPI TYPE.
Different KPI types require DIFFERENT root cause analysis and action recommendations.
${typeSpecificRules}

KEY DISTINCTIONS (adapt language to domain context above):
- VOLUME (count): Gap = "Not enough outputs" → domain-appropriate scaling actions
- EFFICIENCY (rate/percentage): Gap = "Poor conversion/quality" → Improve processes, standards, quality (NOT data collection!)
- MILESTONE (boolean/status): Gap = "Project delayed" → Fast-track approvals, unblock dependencies
- PERFORMANCE (score/value): Gap = "Low satisfaction" → Investigate feedback, conduct surveys

⚠️ CRITICAL ANTI-PATTERNS TO AVOID:
1. For EFFICIENCY metrics (rates/percentages): Do NOT suggest "reporting bottleneck", "batch collection", "data collection delays". The data is correct - the ACTUAL PERFORMANCE is low.
2. NEVER output meta-system warnings like "Ensure KPI types are correctly classified" or "Validate that rate KPIs focus on quality". These are internal system concerns, NOT business prescriptions.
3. Do NOT use generic manufacturing/sales/production language (e.g., "Scale up production capacity") for academic, IT, or governance contexts. Use domain-appropriate terminology.
================================================================================

================================================================================
STRATEGIC PLAN GROUNDING RULES (CRITICAL)
================================================================================
- Every prescriptive item MUST reference a specific KPI ID from the performance data (e.g., ${kpiSummaries[0]?.initiativeId || 'KRA1-KPI1'})
- Every "action" MUST cite an authorized strategy or program from the STRATEGIC PLAN SNAPSHOT above
- The "responsibleOffice" MUST match one of the offices listed in the plan for the relevant KPI
- Priority: HIGH = achievement < 50%, MEDIUM = 50-80%, LOW = > 80%
- Timeframe should consider the target scope (cumulative vs per-year) from the plan
- Do NOT invent strategies, programs, or offices that are not in the strategic plan snapshot
================================================================================

TASK:
1) Write a single Document Insight paragraph (2–4 sentences) grounded on the performance data and the strategic plan snapshot.
   - Must reference the overall achievement percentage.
   - Must identify the primary bottleneck KPI (lowest achievement) using the KPI ID and its reported vs target.
   - Must correctly interpret the gap based on the KPI TYPE (see rules above).
   - Must use language appropriate for the domain context: ${domainContext.domainLabel}.
2) Produce Prescriptive Analysis as 2–3 items, each with:
   - title (short, domain-appropriate)
   - issue (one sentence, type-aware interpretation referencing the KPI ID)
   - action (specific, using the correct action archetype AND citing an authorized strategy/program from the plan, using domain-appropriate language)
   - nextStep (optional, immediate next action with timeframe)
   - relatedKpiId (the KPI ID this item addresses, e.g., "KRA3-KPI2")
   - responsibleOffice (the office from the strategic plan responsible for this action)
   - priority ("HIGH", "MEDIUM", or "LOW" based on achievement gap severity)
   - authorizedStrategy (the exact strategy text from the strategic plan that supports this action)
   - timeframe (recommended timeframe considering the target scope)
  RULE: Only include a "Sustain"/"high performers" item if at least one KPI has >80% achievement. If none are >80%, DO NOT generate that item.
  RULE: Each recommendation MUST match the action archetype for its KPI type (see TYPE-AWARE RULES above).
  RULE: Every recommendation must be an actionable operational prescription. NEVER include system-internal advice like "classify KPI types" or "validate data types."
3) Also provide brief supporting fields (alignment/opportunities/gaps/recommendations) for backward compatibility.

OUTPUT FORMAT (JSON):
{
  "documentInsight": "2-4 sentences referencing specific KPI IDs and the strategic plan, using domain-appropriate language",
  "prescriptiveItems": [
    {
      "title": "short action title",
      "issue": "one sentence, type-aware interpretation referencing KPI ID",
      "action": "specific action citing authorized strategy/program from the plan",
      "nextStep": "immediate next step with timeframe",
      "relatedKpiId": "KRAx-KPIy",
      "responsibleOffice": "office from strategic plan",
      "priority": "HIGH|MEDIUM|LOW",
      "authorizedStrategy": "exact strategy text from the plan",
      "timeframe": "based on target scope"
    }
  ],
  "alignment": "2-3 sentences on strategic alignment",
  "opportunities": ["..."],
  "gaps": "Specific gaps with numbers",
  "recommendations": ["..."]
}

IMPORTANT GUIDANCE:
- Do NOT critique individual documents/files as if each one must meet the full institutional target.
- Tailor recommendations to the domain context: ${domainContext.domainLabel}. Use terminology and actions appropriate for a state university, not generic business operations.
- For rate-based KPIs, interpret gaps as quality/conversion problems - focus on curriculum, training, industry partnerships.
- Avoid repetitive per-item gap statements; synthesize patterns and provide 2-3 concise prescriptive items.

STRICT OUTPUT RULES:
- Output MUST be valid JSON only (no extra commentary, no markdown code fences).
- All JSON string values must be single-line. Do not include literal line breaks inside strings (use spaces or \\n).
- NEVER output meta-system warnings like "Ensure KPI types are correctly classified" or "Validate data types". Every item must be an actionable business prescription.
`;

  try {
    const response = await routerModel.invoke([
      { role: "system", content: "You are a strategic planning advisor. Output only JSON." },
      { role: "user", content: prompt }
    ]);

    const responseText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const parsed = tryParseJson(responseText);
    if (!parsed) {
      throw new Error('LLM returned non-JSON or invalid JSON.');
    }

    const safeString = (v: any) => (typeof v === 'string' ? v.trim() : '');
    type PrescriptiveItem = {
      title: string;
      issue: string;
      action: string;
      nextStep?: string;
    };

    const rawItems: PrescriptiveItem[] = Array.isArray(parsed.prescriptiveItems)
      ? parsed.prescriptiveItems
          .filter((x: any) => x && typeof x === 'object')
          .slice(0, 5)
          .map((x: any) => ({
            title: safeString(x.title) || 'Recommendation',
            issue: safeString(x.issue) || 'Issue not specified.',
            action: safeString(x.action) || 'Action not specified.',
            nextStep: safeString(x.nextStep) || undefined,
          }))
      : [];

    const shouldAllowSustain = maxAchievement > 80;
    let prescriptiveItems = shouldAllowSustain
      ? rawItems
      : rawItems.filter((x: PrescriptiveItem) => !/\bsustain\b|high\s*perform(er|ers)|preserv(e|ing)\s+strong/i.test(`${x.title} ${x.issue} ${x.action}`));

    // Post-process validation: Check for type-aware anti-patterns
    // For efficiency metrics (rates/percentages), flag recommendations that suggest data collection fixes
    const hasEfficiencyMetrics = kpiSummaries.some(k => k.kpiTypeCategory === 'EFFICIENCY');
    if (hasEfficiencyMetrics) {
      prescriptiveItems = prescriptiveItems.map(item => {
        const combinedText = `${item.title} ${item.issue} ${item.action}`;
        const validation = validatePrescriptiveAnalysis(combinedText, 'percentage');
        if (!validation.isValid) {
          console.warn(`[TYPE-AWARE] Anti-pattern detected in prescriptive item: ${validation.warnings.join('; ')}`);
          // Fix the recommendation to focus on quality instead of reporting
          return {
            ...item,
            action: item.action
              .replace(/reporting\s+(bottleneck|backlog|delay|lag)/gi, 'quality improvement initiative')
              .replace(/batch\s+(collection|processing|data)/gi, 'targeted intervention')
              .replace(/collect\s+more\s+(data|lists|reports)/gi, 'improve program outcomes')
              .replace(/scale\s+up\s+(data|collection|reporting)/gi, 'enhance quality standards')
              .replace(/data\s+collection\s+(delay|issue|problem)/gi, 'outcome quality concern'),
          };
        }
        return item;
      });
    }

    // Filter out meta-system warnings that shouldn't appear in prescriptive output
    prescriptiveItems = prescriptiveItems.filter(item => {
      const combinedText = `${item.title} ${item.issue} ${item.action}`.toLowerCase();
      const metaWarningPatterns = [
        /ensure\s+kpi\s+types?\s+(are|is)\s+(correctly\s+)?classified/i,
        /validate\s+that\s+rate\s+kpis?\s+focus/i,
        /kpi\s+classification\s+verification/i,
        /correctly\s+classif(y|ied)\s+.*kpi/i,
        /ensure\s+.*data\s+types?\s+(are|is)\s+correct/i,
      ];
      const isMetaWarning = metaWarningPatterns.some(p => p.test(combinedText));
      if (isMetaWarning) {
        console.warn(`[TYPE-AWARE] Filtered meta-system warning from prescriptive output: "${item.title}"`);
      }
      return !isMetaWarning;
    });

    return {
      documentInsight: safeString(parsed.documentInsight) || 'Insight pending.',
      prescriptiveItems,
      alignment: parsed.alignment || 'Analysis pending.',
      opportunities: parsed.opportunities || 'No opportunities identified.',
      gaps: parsed.gaps || 'No gaps identified.',
      recommendations: parsed.recommendations || 'No recommendations.',
      overallAchievement: Math.round(overallAchievement * 100) / 100
    };
  } catch (error) {
    console.error('[PRESCRIPTIVE] Analysis generation failed:', error);

    // Deterministic fallback: never return empty insights just because JSON parsing failed.
    const bottleneck = kpiSummaries
      .slice()
      .sort((a, b) => Number(a.achievementPercent || 0) - Number(b.achievementPercent || 0))[0];

    const strongest = kpiSummaries
      .filter((k) => Number(k.achievementPercent || 0) > 80)
      .slice()
      .sort((a, b) => Number(b.achievementPercent || 0) - Number(a.achievementPercent || 0))[0];

    const bottleneckReported = bottleneck
      ? (typeof bottleneck.totalReported === 'number'
          ? bottleneck.totalReported.toFixed(bottleneck.targetType === 'percentage' ? 1 : 0)
          : String(bottleneck.totalReported ?? 'N/A'))
      : 'N/A';
    const bottleneckTarget = bottleneck
      ? (typeof bottleneck.totalTarget === 'number'
          ? bottleneck.totalTarget.toFixed(bottleneck.targetType === 'percentage' ? 1 : 0)
          : String(bottleneck.totalTarget ?? 'N/A'))
      : 'N/A';

    // Get type-aware context for fallback recommendations
    const bottleneckTypeCategory = bottleneck?.kpiTypeCategory || 'UNKNOWN';
    const bottleneckInterpretation = bottleneck?.gapInterpretation || getGapInterpretation('UNKNOWN');

    const documentInsightParts: string[] = [];
    documentInsightParts.push(
      `Overall achievement is ${overallAchievement.toFixed(1)}% across ${kpiSummaries.length} KPI(s) for ${kraId}.`
    );
    if (bottleneck?.initiativeId) {
      // Type-aware bottleneck description
      const gapDescription = bottleneckTypeCategory === 'EFFICIENCY' 
        ? `This indicates a ${bottleneckInterpretation.gapType.toLowerCase()} requiring quality-focused interventions.`
        : bottleneckTypeCategory === 'MILESTONE'
        ? `This indicates a ${bottleneckInterpretation.gapType.toLowerCase()} requiring administrative intervention.`
        : `This represents a ${bottleneckInterpretation.gapType.toLowerCase()}.`;
      documentInsightParts.push(
        `The primary bottleneck is ${bottleneck.initiativeId} at ${Number(bottleneck.achievementPercent || 0).toFixed(1)}% (reported ${bottleneckReported} vs target ${bottleneckTarget}). ${gapDescription}`
      );
    }
    if (strongest?.initiativeId) {
      documentInsightParts.push(
        `A relative strength is ${strongest.initiativeId} at ${Number(strongest.achievementPercent || 0).toFixed(1)}%.`
      );
    }

    // Type-aware fallback recommendations
    const fallbackItems: Array<{ title: string; issue: string; action: string; nextStep?: string }> = [];
    
    // Generate type-appropriate primary recommendation
    if (bottleneck?.initiativeId) {
      const actionArchetype = bottleneckInterpretation.actionArchetype;
      let typeAwareAction = '';
      let typeAwareNextStep = '';
      
      switch (bottleneckTypeCategory) {
        case 'EFFICIENCY':
          typeAwareAction = 'Review curriculum alignment with industry needs, strengthen industry partnerships for job placement, and enhance skills training programs. Focus on quality improvement rather than data collection.';
          typeAwareNextStep = `Schedule curriculum review meeting with industry partners within 30 days for ${bottleneck.initiativeId}.`;
          break;
        case 'MILESTONE':
          typeAwareAction = 'Identify specific blockers (approvals, resources, dependencies), escalate to appropriate authority, and create a fast-track action plan to unblock progress.';
          typeAwareNextStep = `Conduct blocker analysis meeting within 7 days for ${bottleneck.initiativeId}.`;
          break;
        case 'PERFORMANCE':
          typeAwareAction = 'Gather user feedback through surveys, analyze service delivery processes, and implement targeted improvements based on feedback data.';
          typeAwareNextStep = `Review recent feedback data and plan focus groups within 14 days for ${bottleneck.initiativeId}.`;
          break;
        case 'VOLUME':
        default: {
          // Use domain context for better recommendations
          const fallbackDomain = inferDomainContext(
            activities.map((a: any) => String(a.name || '').trim()).filter(Boolean),
            bottleneck?.initiativeId,
            kraTitle
          );
          if (fallbackDomain.domain === 'ACADEMIC_RESEARCH') {
            typeAwareAction = 'Intensify research output through faculty research load adjustments, expanded research grants, streamlined IRB/ethics review processes, and research mentoring programs.';
            typeAwareNextStep = `Convene a research productivity meeting within 14 days to identify immediate output opportunities for ${bottleneck.initiativeId}.`;
          } else if (fallbackDomain.domain === 'IT_INFRASTRUCTURE') {
            typeAwareAction = 'Accelerate IT project completion by securing procurement timelines, deploying additional technical personnel, and establishing project milestone tracking.';
            typeAwareNextStep = `Conduct IT project status review within 7 days for ${bottleneck.initiativeId}.`;
          } else if (fallbackDomain.domain === 'COMMUNITY_EXTENSION') {
            typeAwareAction = 'Expand community engagement through additional MOA/MOU partnerships, increase extension activity frequency, and broaden beneficiary coverage.';
            typeAwareNextStep = `Identify new community partnership opportunities within 14 days for ${bottleneck.initiativeId}.`;
          } else {
            typeAwareAction = 'Increase activity frequency, allocate additional resources, and address any reporting backlogs. Consider streamlining processes for faster output generation.';
            typeAwareNextStep = `Validate the latest reported/target values for ${bottleneck.initiativeId} within 7 days.`;
          }
          break;
        }
      }
      
      fallbackItems.push({
        title: `${actionArchetype}: Address ${bottleneckInterpretation.gapType}`,
        issue: `${bottleneck.initiativeId} is at ${Number(bottleneck.achievementPercent || 0).toFixed(1)}% (reported ${bottleneckReported} vs target ${bottleneckTarget}), indicating a ${bottleneckInterpretation.gapType.toLowerCase()}.`,
        action: typeAwareAction,
        nextStep: typeAwareNextStep,
      });
    } else {
      fallbackItems.push({
        title: 'Address the primary performance gap',
        issue: 'At least one KPI remains below target, limiting overall achievement.',
        action: 'Assign an owner to the lowest-performing KPI and implement a corrective plan within the next reporting cycle (2–4 weeks).',
        nextStep: 'Validate the latest reported/target values within 7 days.',
      });
    }

    if (strongest?.initiativeId) {
      fallbackItems.push({
        title: 'Sustain and operationalize high performers',
        issue: `${strongest.initiativeId} is performing relatively well (${Number(strongest.achievementPercent || 0).toFixed(1)}%) and should be protected from regression while gaps are addressed.`,
        action: 'Document the operating steps and evidence artifacts, then standardize reporting and accountability within the next quarter.',
        nextStep: `Assign an evidence custodian for ${strongest.initiativeId} within 2 weeks.`,
      });
    }

    // Remove "KPI classification verification" meta-system warning
    // and replace with an actionable operational item
    if (fallbackItems.length < 3) {
      fallbackItems.push({
        title: 'Strengthen evidence documentation and reporting',
        issue: 'Consistent evidence documentation and timely reporting are essential to accurately reflect performance and support data-driven decisions.',
        action: 'Standardize evidence collection templates, establish clear submission deadlines, and assign unit-level data custodians to ensure complete and accurate reporting.',
      });
    }

    return {
      documentInsight: documentInsightParts.join(' '),
      prescriptiveItems: fallbackItems.slice(0, 3),
      alignment: `Analysis completed for ${kraTitle} (${kraId}) based on extracted KPI performance and the strategic plan snapshot.`,
      opportunities: strongest?.initiativeId
        ? `High-performing KPI observed: ${strongest.initiativeId} (${Number(strongest.achievementPercent || 0).toFixed(1)}%).`
        : 'No KPI exceeded the high-performer threshold (>80%).',
      gaps: bottleneck?.initiativeId
        ? `Largest gap is ${bottleneck.initiativeId}: ${Number(bottleneck.achievementPercent || 0).toFixed(1)}% achieved (reported ${bottleneckReported} vs target ${bottleneckTarget}). Gap type: ${bottleneckInterpretation.gapType}.`
        : `${missedCount} KPI(s) are below target.`,
      recommendations: 'Use the structured prescriptive items as the immediate action plan for the next reporting cycle.',
      overallAchievement: Math.round(overallAchievement * 100) / 100,
    };
  }
}

// Helper to sanitize AI status values: convert spaces to underscores, normalize to uppercase
const sanitizeStatus = (val: unknown): string => {
  if (typeof val !== 'string') return String(val);
  return val.trim().toUpperCase().replace(/\s+/g, '_');
};

// Phase 2: Enhanced Noise Filtering with Regex (Universal)
const NOISE_REGEX = /^(REMARKS|TOTAL|GRAND TOTAL|NOTE|NOTES|PREPARED BY|APPROVED BY|TARGET|ACCOMPLISHMENT|VARIANCE|QUARTER|YEAR|N\/A|NA|NONE|TBD|GRADUATED|OUTCOME|SE|NO\.|NUMBER|COLUMN|ROW|HEADER)$/i;

/**
 * Filter noise entries from extracted activities
 * Removes headers, generic terms, and invalid entries
 */
function filterNoiseActivities(activities: any[]): any[] {
  const beforeCount = activities.length;
  
  const filtered = activities.filter((act: any) => {
    if (!act.name || typeof act.name !== 'string') return false;
    const name = act.name.trim();
    const nameUpper = name.toUpperCase();
    
    // 1. Regex blocklist check for exact matches
    if (NOISE_REGEX.test(nameUpper)) {
      console.log(`[NOISE FILTER] Removed: "${name}" (regex blocklist)`);
      return false;
    }
    
    // 2. Header Heuristic: If value is 1 and name is short/generic, likely a table header
    if (Number(act.reported) === 1 && name.split(' ').length <= 2 && name.length < 15) {
      // Check if it looks like a column header
      const headerPatterns = /^(total|count|number|amount|rate|percentage|status|date|year|quarter)/i;
      if (headerPatterns.test(name)) {
        console.log(`[NOISE FILTER] Removed: "${name}" (header pattern with value=1)`);
        return false;
      }
    }
    
    // 3. Drop entries that are just numbers, single letters, or special characters
    if (/^[\d\s.,%₱$]+$/.test(name) || /^[A-Z]$/i.test(name)) {
      console.log(`[NOISE FILTER] Removed: "${name}" (numeric/single letter)`);
      return false;
    }
    
    // 4. Drop entries with parenthetical column references like "(1)", "(2)", "[(4/2)]*100"
    if (/^\(?\d+\)?$/.test(name) || /\[\(.*\)\]\*\d+/.test(name)) {
      console.log(`[NOISE FILTER] Removed: "${name}" (column reference pattern)`);
      return false;
    }
    
    // 5. Drop very short names (less than 3 chars) unless they have actual values > 1
    if (name.length < 3 && Number(act.reported) <= 1) {
      console.log(`[NOISE FILTER] Removed: "${name}" (too short)`);
      return false;
    }
    
    return true;
  });
  
  console.log(`[NOISE FILTER] Filtered: ${beforeCount} -> ${filtered.length} activities (removed ${beforeCount - filtered.length})`);
  return filtered;
}

/**
 * Consolidate KRAs using "Dominant KRA" logic
 * Ensures all activities from the same document use consistent KRA assignment
 * Prevents mismatch where alumni employment appears under international MOUs
 */
function consolidateKRAs(activities: any[]): any[] {
  if (activities.length === 0) return activities;
  
  // 1. Count frequency of detected KRAs
  const counts: Record<string, number> = {};
  activities.forEach(a => {
    if (a.kraId) {
      counts[a.kraId] = (counts[a.kraId] || 0) + 1;
    }
  });
  
  // 2. Find the dominant KRA (the one with most activities)
  const dominantKRA = Object.keys(counts).reduce((a, b) => 
    counts[a] > counts[b] ? a : b, Object.keys(counts)[0] || ''
  );
  
  if (!dominantKRA) return activities;
  
  // 3. Check for outliers - if a KRA has < 20% of the dominant, it might be misclassified
  const dominantCount = counts[dominantKRA] || 0;
  const threshold = Math.max(1, dominantCount * 0.2);
  
  console.log(`[KRA CONSOLIDATE] Dominant KRA: ${dominantKRA} (${dominantCount} activities)`);
  
  return activities.map(act => {
    // If activity has no KRA or has a rare KRA, consider reassignment
    if (!act.kraId) {
      console.log(`[KRA CONSOLIDATE] Assigned missing KRA to dominant: ${dominantKRA} for "${act.name}"`);
      return { ...act, kraId: dominantKRA };
    }
    
    // If this KRA appears very rarely compared to dominant, flag it but don't force change
    // (User can override in review modal)
    if (counts[act.kraId] < threshold && act.kraId !== dominantKRA) {
      console.log(`[KRA CONSOLIDATE] Potential mismatch: "${act.name}" has ${act.kraId} but dominant is ${dominantKRA}`);
      // Add a flag for review
      return { ...act, kraConflict: true, suggestedKraId: dominantKRA };
    }
    
    return act;
  });
}

// Zod schemas for structured output validation
export const ActivitySchema = z.object({
  name: z.string().describe('Activity description from QPRO document'),
  kraId: z.string().describe('Matched KRA ID (e.g., "KRA 1")'),
  initiativeId: z.string().optional().describe('Matched initiative ID (e.g., "KRA1-KPI1")'),
  reported: z.number().describe('Reported/accomplished value'),
  target: z.number().describe('Target value from Strategic Plan timeline_data for the reporting year'),
  achievement: z.number().min(0).max(100).describe('Achievement percentage'),
  status: z.preprocess(sanitizeStatus, z.enum(["MET", "MISSED"])).describe('Status of target achievement - MET if achievement >= 100%, MISSED otherwise'),
  authorizedStrategy: z.string().describe('Exact strategy text copied from Strategic Plan context'),
  aiInsight: z.string().describe('AI-generated insight for this activity'),
  prescriptiveAnalysis: z.string().describe('Prescriptive analysis based on CALCULATED status (not raw numbers). Always reference the status field. For MET: focus on sustainability. For MISSED: focus on immediate corrective actions.'),
  confidence: z.number().min(0).max(1).describe('Confidence score for KRA matching (0-1)'),
  unit: z.string().optional().describe('Unit mentioned in context'),
  evidenceSnippet: z.string().optional().describe('Exact text snippet from QPRO document that supports this value'),
  dataType: z.preprocess(
    (val) => typeof val === 'string' ? val.trim().toLowerCase().replace(/\s+/g, '_') : val,
    z.enum(['percentage', 'currency', 'low_count', 'high_count', 'milestone'])
  ).optional().describe('Data type for visualization: percentage (%), currency (PHP), low_count (<=10), high_count (>10), milestone (text/yes-no)'),
  rootCause: z.string().optional().describe('Inferred root cause if target is missed (e.g., budget delay, lack of participants)'),
  suggestedStatus: z.preprocess(sanitizeStatus, z.enum(['MET', 'ON_TRACK', 'DELAYED', 'AT_RISK'])).optional().describe('Suggested status for review'),
});

export const KRASummarySchema = z.object({
  kraId: z.string(),
  kraTitle: z.string(),
  achievementRate: z.number().min(0).max(100),
  activities: z.union([
    z.array(ActivitySchema),
    z.array(z.string()),
    z.array(z.any())
  ]).transform((val: any) => {
    // If activities are strings, convert to activity name references
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'string') {
      return val.map((name: string) => ({
        name: name,
        kraId: '',
        reported: 0,
        target: 0,
        achievement: 0,
        status: 'MISSED',
        authorizedStrategy: '',
        aiInsight: '',
        prescriptiveAnalysis: '',
        confidence: 0
      }));
    }
    return val;
  }),
  strategicAlignment: z.string().describe('How this KRA aligns with strategic plan'),
  prescriptiveAnalysis: z.string().optional().describe('Overall prescriptive analysis for this KRA if behind target'),
  rootCause: z.string().optional().describe('Inferred root cause for gaps in this KRA'),
  actionItems: z.array(z.string()).optional().describe('Specific action items to address gaps'),
});

export const PrescriptiveItemSchema = z.object({
  title: z.string().min(1).describe('Short title for the prescriptive item'),
  issue: z.string().min(1).describe('The concrete issue or constraint identified'),
  action: z.string().min(1).describe('Concrete action to address the issue (with timeframe when possible)'),
  nextStep: z.string().optional().describe('Optional immediate next step to execute the action'),
  relatedKpiId: z.string().optional().describe('KPI ID this item addresses (e.g., KRA3-KPI2)'),
  responsibleOffice: z.string().optional().describe('Office responsible for executing this action'),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional().describe('Priority level based on gap severity'),
  authorizedStrategy: z.string().optional().describe('Strategy from strategic plan that supports this action'),
  timeframe: z.string().optional().describe('Recommended timeframe based on target_time_scope'),
});

export const QPROAnalysisOutputSchema = z.object({
  activities: z.array(ActivitySchema).describe('All extracted activities with KRA matches'),
  kras: z.array(KRASummarySchema).describe('Summary grouped by KRA'),
  documentInsight: z.string().default('').describe('Document-level insight paragraph grounded on KPI performance and the strategic plan'),
  prescriptiveItems: z.array(PrescriptiveItemSchema).default([]).describe('Document-level prescriptive analysis items (Issue/Action/Next Step)'),
  alignment: z.string().describe('Overall strategic alignment analysis'),
  opportunities: z.union([z.string(), z.array(z.string())]).transform((val: any) => {
    // Convert array to bullet-point string
    return Array.isArray(val) ? '• ' + val.join('\n• ') : val;
  }).describe('Strategic opportunities identified'),
  gaps: z.string().describe('Gaps or conflicts identified'),
  recommendations: z.union([z.string(), z.array(z.string())]).transform((val: any) => {
    // Convert array to bullet-point string
    return Array.isArray(val) ? '• ' + val.join('\n• ') : val;
  }).describe('Actionable recommendations'),
  overallAchievement: z.number().min(0).max(100).describe('Overall achievement score'),
  insightsGenerated: z.boolean().default(true).describe('Whether prescriptive insights have been generated'),
});

export type QPROAnalysisOutput = z.infer<typeof QPROAnalysisOutputSchema>;

class AnalysisEngineService {
  private llm: BaseLanguageModel;
  private promptTemplate: PromptTemplate;

  constructor() {
    const modelName = "gpt-4o-mini";
    // Enforce a safe output cap for gpt-4o-mini to avoid overly long outputs
    const GPT4O_MINI_MAX_OUTPUT = 4096;
    const modelKwargs: any = {
      response_format: { type: "json_object" },
      seed: 42,
    };

    this.llm = new ChatOpenAI({
      modelName,
      temperature: 0,
      maxTokens: GPT4O_MINI_MAX_OUTPUT, // LangChain uses camelCase maxTokens
      modelKwargs,
    });
    
    this.promptTemplate = PromptTemplate.fromTemplate(`
You are an expert strategic planning analyst for Laguna State Polytechnic University. Analyze a Quarterly Physical Report of Operations (QPRO) document against the university's strategic plan.

## Strategic Plan Context (Top 10 Most Relevant KRAs/Initiatives):
{strategic_context}

## QPRO Document Text:
{user_input}

## Document Section Analysis:
{section_analysis}

## Document Format Recognition:
- If the document is a **table/spreadsheet format** (e.g., "Training/Seminar Report", "Faculty/Staff Training"), extract EVERY single row as a separate activity
- If the document is a **narrative format**, extract all mentioned activities with quantifiable metrics
- Each row in a training table = one individual activity entry
- **CRITICAL**: For summary metrics (e.g., "Total No. of Attendees: 9"), prioritize using summary totals for achievement calculations instead of counting extracted rows

## Your Task:
Extract ALL activities from the QPRO document. For training tables, create one activity entry per row (do not skip any rows).

**CRITICAL - EXTRACT EVERY ACTIVITY**: This is a table-format document with many rows. You MUST extract every single training/seminar/activity mentioned. If you see a table, count the rows and extract exactly that many activities. Do NOT summarize, consolidate, or skip any rows. Each row = one activity entry.

**IMPORTANT - Summary Metrics Priority**: If the document contains summary sections with aggregate metrics (e.g., "Total No. of X: Y"), use these summary values as the primary reported value instead of counting individual rows. This ensures achievement calculations are based on official summaries.

For each activity:
1. **Identify the activity name** (exact title from the document, e.g., "Introduction to AI, ML and DP")
2. **Extract reported/accomplished value**:
   - For training tables: reported = 1 (one instance of this training attended)
   - For narrative reports: extract the actual number from the text
   - **IMPORTANT**: If the same training appears multiple times in the table (multiple faculty attended), create SEPARATE activity entries for each row - do NOT consolidate
3. **Look up target value** from the Strategic Plan Context above. Find the matched initiative's "Targets" object and use the target_value from timeline_data for year 2025. DO NOT extract targets from the QPRO document text. The target MUST come from the Strategic Plan's timeline_data.

## CRITICAL: KRA MATCHING STRATEGY - PRIORITIZE KPI & STRATEGIES
**Match activities to KRAs using this PRIORITY ORDER:**

## STRICT KRA ALIGNMENT DEFINITIONS (MUST FOLLOW):
Before matching, understand what each KRA category covers:

**KRA 3 (Quality of Instruction):** 
- Graduate employment rates, licensure exam results, curriculum effectiveness
- Alumni tracer studies, employment statistics
- *INCLUDES*: "Alumni Employment", "Graduate Tracer", "Licensure Passing Rate"

**KRA 4 (International Activities):**
- MUST involve foreign partners, international exchange, or cross-border MOUs
- International students, faculty exchange programs, global partnerships
- *EXCLUDES*: Local degree programs, domestic employment rates
- *If document says "Alumni Employment" or "Graduate Employment", it is NOT KRA 4*

**KRA 5 (Research):**
- Research publications, citations, patents, research awards
- *INCLUDES*: Papers published, citation counts, research grants

**KRA 11 (Human Resource Management):**
- Faculty training, staff development, HR policies
- *INCLUDES*: Training reports, seminar attendance, faculty development

**KRA 13 (Competitive HR):**
- Health and wellness programs, employee satisfaction
- *INCLUDES*: Wellness activities, fitness programs

**DOCUMENT TITLE CHECK (CRITICAL):**
- If document title contains "Alumni" or "Employment" or "Graduate Tracer" -> Use KRA 3
- If document title contains "International" or "MOU" or "Exchange" -> Use KRA 4
- If document title contains "Research" or "Publication" -> Use KRA 5
- If document title contains "Training" or "Seminar" or "Workshop" -> Use KRA 11

**STEP 1: STRATEGY MATCHING (Highest Priority)**
- First, check if the QPRO activity directly implements one of the **Strategies** listed in the KRA
- Example: If KRA 13 has strategy "conduct health and wellness program twice a week" and QPRO reports "health and wellness program", this is a STRONG match
- Use exact or near-exact keyword matching for strategy alignment

**STEP 2: KPI VALIDATION (Second Priority)**
- Verify if the activity contributes to the **Key Performance Indicator (KPI)** outputs/outcomes
- Example: If KRA 13 KPI output is "100% faculty and staff attended health and wellness program" and QPRO reports staff attending health program, this validates the KRA match
- Check if reported outcomes align with expected KPI outcomes (e.g., improvements in fitness levels, wellness metrics)

**STEP 3: TYPE-BASED CATEGORIZATION (Tertiary Priority)**
- If neither strategy nor KPI directly match, use activity TYPE to narrow down:
  - **Training/Seminars/Workshops/Conferences** → Only KRA 11 or KRA 13 (HR Development)
  - **Curriculum Development/Course Updates** → Only KRA 1
  - **Research/Publications** → Only KRA 3, 4, 5 (Research KRAs)
  - **Digital Systems/Infrastructure** → Only KRA 17
  - **Health/Wellness Programs** → Only KRA 13
  - **Community/Extension Programs** → Only KRA 6, 7, 8 (Community Engagement)
  - **Alumni/Graduate Employment** → ONLY KRA 3 (NEVER KRA 4)

**STEP 4: SEMANTIC SIMILARITY (Lowest Priority)**
- Only use general semantic similarity if strategies and KPI don't provide clear alignment
- Ensure the selected KRA is compatible with the activity type from Step 3

4. **Calculate achievement percentage** = (reported / target) * 100
5. **Determine status**: If achievement >= 100%, status = "MET"; otherwise, status = "MISSED".
6. **Copy authorized strategy**: Select and copy the EXACT text of the most relevant strategy from the "Strategies" field in the Strategic Plan Context above for the specific KRA being matched. Do not paraphrase or create new strategies.
7. **AI Insight**: Write a concise, data-driven insight for this activity (1-2 sentences). BE SPECIFIC with actual numbers.
   - **BAD**: "Good research output."
   - **GOOD**: "Strong research performance with 5 new papers published (target: 3) achieving 167% of goal."
   - Always include the actual reported value and target in the insight text.
8. **Prescriptive Analysis**: Based on the CALCULATED STATUS and authorized strategy, write ACTION-ORIENTED prescriptive analysis (do NOT just state the gap - provide concrete steps). CRITICAL: Use the status value, NOT raw number comparison:
   - If status is "MET": "To sustain this achievement, continue implementing [exact authorized strategy]. Consider [specific sustainability action like expanding scope, documenting best practices, or mentoring other units]."
   - If status is "MISSED": "To close this gap, immediately implement [exact authorized strategy]. Specific actions: [concrete steps with timeline like 'Schedule 2 additional sessions before Q4 ends' or 'Partner with 3 industry experts by December 2025']."
   - Be SPECIFIC with timelines (e.g., "by Q4 2025", "before semester end", "by [month] [year]") and quantifiable actions (e.g., "2 additional sessions", "3 partner organizations", "increase by 50%")
   - NEVER use the raw comparison (reported vs target) to determine advice tone; ALWAYS use the calculated status field.
9. **Assign confidence score** (0.0-1.0) for the KRA match based on strategy alignment first, then KPI validation, then semantic similarity:
   - 0.95-1.0: Perfect strategy + KPI match
   - 0.85-0.94: Strong strategy match + partial KPI alignment
   - 0.75-0.84: Type match + some semantic alignment
   - Below 0.75: Only semantic similarity available
10. **Extract unit/office** mentioned if available.

## VALIDATION BEFORE OUTPUT:
1. **Keep ALL activities**: Do NOT delete duplicates even if activity names are similar. Each row entry must be preserved.
2. **Verify target source**: Ensure every target value comes from the Strategic Plan's timeline_data, NOT from counting QPRO entries.
3. **Verify KRA matching**: For each activity, verify it was matched to an appropriate KRA using the priority order above.
4. **Count check**: Your activities array should have at least 70+ entries for training table documents.

## Important Guidelines:
- **COUNT ALL TRAINING SESSIONS**: For training/seminar tables, extract EVERY single row as individual activities with reported=1 each
- **KEEP ALL ACTIVITIES - DO NOT DEDUPLICATE FOR DISPLAY**: Each row in the table is a separate activity entry, even if the training name appears multiple times (different faculty may have attended the same training). Include all of them.
- **CRITICAL - TARGETS FROM STRATEGIC PLAN JSON**: 
  - Targets MUST come from the Strategic Plan's timeline_data for year 2025, NOT from QPRO document content
  - For each activity, look up the matched KRA's initiative and extract target_value from timeline_data[2025]
  - If the KRA has multiple initiatives (KPIs), select the one with highest semantic match to the activity

## FINAL OUTPUT REQUIREMENTS:
- **Minimum activities in array**: At least 70 activities if the document has a training table with 90+ rows
- **Include ALL unique attendance records**: If "Data Privacy Training" appears in 5 rows (5 different faculty), create 5 separate activity entries (one per row)
- **No consolidation or grouping**: Each row = one activity, period
  - If target_value is non-numeric (e.g., "Curriculum Updated"), convert to 1 (treat as 1 milestone unit)
  - DO NOT count how many activities you extracted as the target
  - DO NOT use the number of rows in the QPRO document as the target
  - The target is a FIXED number from the strategic plan JSON, independent of the QPRO document content
  - Example: If Strategic Plan says target_value = 2 for 2025, use 2 even if QPRO has 9 training entries. Achievement = 9/2 = 450%
- **STRATEGY-FIRST MATCHING**: Always check the Strategies field first before considering semantic similarity
- **SINGLE BEST-FIT KRA**: Each activity matches to ONLY ONE KRA based on strategy alignment first, then type matching
- **Return initiativeId**: Include the specific initiative/KPI ID (e.g., "KRA13-KPI1") to enable post-processing validation and proper target lookup
- The authorizedStrategy field MUST be an exact copy from the Strategic Plan Context strategies list for the matched KRA

## DATA TYPE DETECTION:
For each KPI, identify the data type based on the target value:
- **percentage**: If target contains "%" or is a rate/ratio (e.g., "80% passing rate")
- **currency**: If target contains "PHP", "Php", "₱" or is a monetary value (e.g., "Php 375,000")
- **low_count**: If target is a number <= 10 (e.g., "2 MOUs", "1 tracer study")
- **high_count**: If target is a number > 10 (e.g., "47 IP generated", "150 research findings")
- **milestone**: If target is text-based/qualitative (e.g., "ISO Recertified", "Curriculum Updated")

## PRESCRIPTIVE ANALYSIS REQUIREMENTS:
For EVERY activity where status is "MISSED" or achievement < 100%, generate:
1. **rootCause**: Infer the likely root cause from the document text (e.g., "budget delay", "lack of participants", "scheduling conflicts", "resource constraints")
2. **actionItems**: Suggest 1-3 specific, actionable interventions with timelines

## EVIDENCE EXTRACTION:
For each activity, extract the **evidenceSnippet** - the exact text from the document that proves/supports the reported value. This should be a direct quote from the QPRO document.

## Output Format:
Return ONLY a valid JSON object (no markdown, no code blocks) with this exact structure:

{{
  "activities": [
    {{
      "name": "Faculty training workshops",
      "kraId": "KRA 1",
      "initiativeId": "KRA1-KPI1",
      "reported": 8,
      "target": 10,
      "achievement": 80.0,
      "status": "MISSED",
      "suggestedStatus": "DELAYED",
      "dataType": "low_count",
      "evidenceSnippet": "Table 2 shows 8 faculty members completed the training program...",
      "rootCause": "Limited budget allocation for Q3 training activities",
      "authorizedStrategy": "collaborate with industry experts, tech companies and research institutions to design relevant course content",
      "aiInsight": "Training completion at 80% indicates good progress but falls short of the annual target.",
      "prescriptiveAnalysis": "Based on Strategic Plan strategy: collaborate with industry experts, tech companies and research institutions to design relevant course content. To address the gap of 2 workshops, prioritize partnerships with at least 2 additional industry experts before Q4.",
      "confidence": 0.95,
      "unit": "Office of the VP for Academic Affairs"
    }}
  ],
  "kras": [
    {{
      "kraId": "KRA 1",
      "kraTitle": "Development of New Curricula...",
      "achievementRate": 75.5,
      "activities": [...activities for this KRA...],
      "strategicAlignment": "This KRA shows strong alignment with curriculum development initiatives...",
      "prescriptiveAnalysis": "Overall KRA is behind target. Focus on accelerating curriculum updates and faculty training.",
      "rootCause": "Delayed curriculum review process",
      "actionItems": ["Schedule 2 additional curriculum workshops by Q4 2025", "Partner with 3 industry experts by December 2025"]
    }}
  ],
  "alignment": "Overall strategic alignment analysis (2-3 paragraphs)",
  "opportunities": "Strategic opportunities identified (bullet points or paragraphs)",
  "gaps": "Gaps or conflicts between QPRO and strategic plan (specific gaps with numbers)",
  "recommendations": "Actionable recommendations (prioritized list)",
  "overallAchievement": 72.3
}}

## Calculation Notes:
- **achievementRate per KRA** = average of all activities' achievement % for that KRA
- **overallAchievement** = weighted average of all KRAs' achievementRate

Return ONLY the JSON object. No additional text.
    `);
  }

  /**
   * Extract ALL activities from QPRO document WITHOUT KRA matching
   * This is pass 1 of the two-pass approach for better accuracy with large documents
   * Results are cached in Redis to avoid re-extracting from identical documents
   */
  async extractAllActivities(userText: string): Promise<any[]> {
    try {
      // Generate cache key from document content hash
      const contentHash = createHash('sha256').update(userText).digest('hex');
      const cacheKey = `qpro:extract:${contentHash}`;

      // Check if we have cached results
      const cachedActivities = await redisService.get<any[]>(cacheKey);
      if (cachedActivities && cachedActivities.length > 0) {
        console.log(`[EXTRACTION] Cache HIT: Retrieved ${cachedActivities.length} activities from Redis`);
        return cachedActivities;
      }

      console.log('[EXTRACTION] Cache MISS: Extracting activities from LLM...');

      const extractionPrompt = PromptTemplate.fromTemplate(`
ROLE: Strategic Data Analyst for Laguna State Polytechnic University.
TASK: Extract specific performance metrics from the provided QPRO document text/tables.

## QPRO Document Text:
{user_input}

## CRITICAL RULES FOR EXTRACTION:

### 1. SUBJECT-METRIC MAPPING (Row + Column):
   - Do NOT extract Row Labels as standalone activities.
   - COMBINE the Row Label with the Column Header to form the Activity Name.
   - Examples:
     * Academic: Row="BS CS", Col="Employment %" -> Activity="BS CS Employment Rate"
     * Financial: Row="ICT Equipment", Col="Obligated" -> Activity="ICT Equipment Obligation"
     * Research: Row="Engineering Dept", Col="Papers Published" -> Activity="Engineering Research Papers"
     * Training: Row="Faculty Name", Col="Training Title" -> Activity="[Training Title] Attendance"

### 2. VALUE EXTRACTION:
   - Extract the ACTUAL quantitative number/percentage found in the cell (e.g., 16.36, 50000, 85%).
   - **NEVER** default to "1" unless the report is explicitly counting a single occurrence.
   - If the value is a percentage, extract the number (e.g., "16.36%" -> reported: 16.36, dataType: "percentage").
   - If the value is currency, extract the number (e.g., "₱50,000" -> reported: 50000, dataType: "currency").

### 3. NOISE EXCLUSION (STRICT):
   - IGNORE these completely - do NOT create activities for:
     * Generic headers: "Remarks", "Total", "Grand Total", "Note", "Target", "Accomplishment", "Variance"
     * Column labels: "(1)", "(2)", "[(4/2)]*100", "Number of", "Total Number of"
     * Empty or N/A values
     * Summary rows at the bottom of tables
   - If you're unsure whether something is data or a header, check if it has a meaningful numeric value.

### 4. DOCUMENT TYPE DETECTION:
   - Look at the document title to understand context:
     * "Alumni Employment" / "Graduate Tracer" -> This is academic/employment data
     * "Financial Report" / "Budget" -> This is financial data
     * "Research Output" / "Publications" -> This is research data
     * "Training Report" / "Seminar" -> This is HR development data

Return a JSON object with this structure:
{{
  "documentType": "academic|financial|research|training|other",
  "activities": [
    {{
      "name": "BS CS Employment Rate",
      "reported": 16.36,
      "unit": "Campus Name or Department",
      "description": "Employment rate for BS CS graduates within 2 years",
      "dataType": "percentage"
    }}
  ]
}}

CRITICAL REMINDERS:
- Combine row + column context to form meaningful activity names
- Use the ACTUAL numerical value from the document
- Skip all header rows and summary rows
- Return ONLY valid JSON, no other text
      `);

      const chain = extractionPrompt.pipe(this.llm);
      const result = await chain.invoke({ user_input: userText });

      // Parse the response
      const responseText = typeof result === 'string' ? result : result.content;
      let activities = [];

      try {
        const parsed = JSON.parse(responseText);
        activities = parsed.activities || [];
        console.log('[EXTRACTION] Extracted', activities.length, 'activities from document');
      } catch (parseError) {
        console.error('[EXTRACTION] Failed to parse LLM response:', parseError);
        // Fallback: try to extract activities from the text response
        const lines = responseText.split('\n').filter((line: string) => 
          line.match(/^\d+\.\s+/) || line.includes('Activity') || line.includes('Training')
        );
        activities = lines.map((line: string) => ({
          name: line.replace(/^\d+\.\s+/, '').trim(),
          reported: 1,
          unit: null,
          description: ''
        }));
      }

      // Apply enhanced noise filtering using the global filterNoiseActivities function
      activities = filterNoiseActivities(activities);

      // Apply Dominant KRA consolidation to prevent mismatched KRA assignments
      // e.g., Alumni Employment should all be KRA 3, not split between KRA 3 and KRA 4
      activities = consolidateKRAs(activities);

      // Cache results for 24 hours (86400 seconds)
      const ttl = 24 * 60 * 60;
      await redisService.set(cacheKey, activities, ttl);
      console.log(`[EXTRACTION] Cached ${activities.length} activities in Redis with TTL=${ttl}s`);

      return activities;
    } catch (error) {
      console.error('[EXTRACTION] Error extracting activities:', error);
      throw error;
    }
  }

  async processQPRO(fileBuffer: Buffer, fileType: string, unitId?: string, reportYearOverride?: number, skipPrescriptive?: boolean): Promise<QPROAnalysisOutput> {
    try {
      // Validate input
      if (!fileBuffer || fileBuffer.length === 0) {
        throw new Error('File buffer is empty');
      }

      let userText: string;

      // Extract text based on file type
      if (fileType.toLowerCase() === 'application/pdf') {
        // Extract text from PDF using pdf2json
        const pdfParser = new PDFParser();
        // Create a promise to handle the event-driven pdf2json
        userText = await new Promise((resolve, reject) => {
          pdfParser.on('pdfParser_dataError', (errData: any) => {
            reject(errData.parserError);
          });
          pdfParser.on('pdfParser_dataReady', (pdfData: any) => {
            let textContent = '';
            if (pdfData && pdfData.formImage && pdfData.formImage.Pages) {
              pdfData.formImage.Pages.forEach((page: any) => {
                if (page.Texts) {
                  page.Texts.forEach((textItem: any) => {
                    textContent += (textItem.R && Array.isArray(textItem.R)) ?
                      textItem.R.map((run: any) => this.decodeText(run.T)).join(' ') + ' ' :
                      this.decodeText(textItem.T) + ' ';
                  });
                  textContent += '\n';
                }
              });
            }
            resolve(textContent);
          });
          pdfParser.parseBuffer(fileBuffer);
        });
      } else if (fileType.toLowerCase() === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        // Enhanced DOCX extraction - extract both raw text AND convert to HTML for table content
        const rawTextResult = await mammoth.extractRawText({ buffer: fileBuffer });
        const userTextRaw = rawTextResult.value || '';
        
        // Also extract HTML to better preserve table structure
        const htmlResult = await mammoth.convertToHtml({ buffer: fileBuffer });
        const htmlContent = htmlResult.value || '';
        
        console.log('[QPRO DIAGNOSTIC] HTML content length:', htmlContent.length);
        
        // More robust table extraction - handle nested HTML and complex structures
        let tableText = '';
        
        // Method 1: Extract table rows with improved regex
        const tableRowsRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rowMatch;
        let rowCount = 0;
        
        while ((rowMatch = tableRowsRegex.exec(htmlContent)) !== null) {
          const rowContent = rowMatch[1];
          
          // Extract cell content from <td> and <th> tags
          const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
          const cells = [];
          let cellMatch;
          
          while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
            // Remove all HTML tags and decode entities
            let cellText = cellMatch[1]
              .replace(/<[^>]*>/g, ' ')  // Remove all HTML tags
              .replace(/&nbsp;/g, ' ')   // Replace non-breaking spaces
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .trim();
            
            // Clean up multiple spaces
            cellText = cellText.replace(/\s+/g, ' ');
            
            if (cellText.length > 0) {
              cells.push(cellText);
            }
          }
          
          if (cells.length > 0) {
            tableText += cells.join(' | ') + '\n';
            rowCount++;
          }
        }
        
        console.log('[QPRO DIAGNOSTIC] Extracted', rowCount, 'table rows from HTML');
        
        // Pre-process table text to make it LLM-friendly
        // Convert pipe-separated rows into numbered list format
        const tableLines = tableText.split('\n').filter(line => line.trim().length > 0);
        let processedTableText = 'EXTRACTED TABLE ACTIVITIES (COMPLETE LIST):\n';
        processedTableText += '='.repeat(50) + '\n';
        tableLines.forEach((line, idx) => {
          // Skip header rows (lines with pipes that are mostly short text)
          const cells = line.split('|').map(c => c.trim());
          const avgCellLength = cells.reduce((sum, c) => sum + c.length, 0) / cells.length;
          
          // Only include rows that have meaningful content (not headers)
          if (avgCellLength > 3 && cells.some(c => c.length > 5)) {
            // Extract the activity name (usually first or most descriptive cell)
            const activityName = cells.find(c => c.length > 10) || cells[0];
            if (activityName && activityName.length > 3) {
              processedTableText += `${idx + 1}. ${activityName}\n`;
            }
          }
        });
        processedTableText += '='.repeat(50) + '\n';
        
        // Combine raw text with processed table content
        userText = userTextRaw + '\n\n' + processedTableText + '\n\n' + tableText;
      } else {
        throw new Error(`Unsupported file type: ${fileType}`);
      }

      // Diagnostic logging: output raw extracted text metadata
      console.log('[QPRO DIAGNOSTIC] ========== RAW TEXT EXTRACTION ==========');
      console.log('[QPRO DIAGNOSTIC] File type:', fileType);
      console.log('[QPRO DIAGNOSTIC] Raw text length (chars):', userText?.length || 0);
      console.log('[QPRO DIAGNOSTIC] Raw text preview (first 500 chars):', userText?.substring(0, 500));
      console.log('[QPRO DIAGNOSTIC] Raw text preview (last 500 chars):', userText?.substring(userText.length - 500));
      
      // Count extracted activities from the preprocessed list
      const activityListMatches = userText.match(/^\d+\.\s+.+$/gm);
      console.log('[QPRO DIAGNOSTIC] Total activities in preprocessed list:', activityListMatches ? activityListMatches.length : 0);
      
      // Also count lines with content (each line might be an activity in a table)
      const nonEmptyLines = userText.split('\n').filter(line => line.trim().length > 5).length;
      console.log('[QPRO DIAGNOSTIC] Non-empty content lines:', nonEmptyLines);
      
      console.log('[QPRO DIAGNOSTIC] ==========================================');

      // Validate extracted text
      if (!userText || userText.trim().length === 0) {
        throw new Error('No text could be extracted from the document');
      }

      // ========== NEW ROUTER-EXTRACTOR ARCHITECTURE ==========
      // This replaces the fuzzy vector search with deterministic JSON-guided logic
      
      // ========== PHASE 1: SECTION DETECTION (Preprocessing) ==========
      console.log('[QPRO DIAGNOSTIC] ========== SECTION DETECTION ==========');
      const sectionDetectionResult = await documentSectionDetector.detectSections(userText);
      console.log(documentSectionDetector.generateSectionSummary(sectionDetectionResult));
      console.log('[QPRO DIAGNOSTIC] ==========================================');

      // ========== PHASE 2: SUMMARY EXTRACTION (Preprocessing) ==========
      console.log('[QPRO DIAGNOSTIC] ========== SUMMARY EXTRACTION ==========');
      const summaryExtractionResult = await summaryExtractor.extractSummaries(userText);
      console.log(summaryExtractor.generateExtractionSummary(summaryExtractionResult));
      console.log('[QPRO DIAGNOSTIC] ==========================================');

      // Extract document title from section detection or use generic title
      const documentTitle = sectionDetectionResult.sections[0]?.title || 
                           sectionDetectionResult.documentType || 
                           'QPRO Document';
      
      // Determine report year (prefer caller-provided year)
      const reportYear = Number.isFinite(reportYearOverride as any)
        ? Math.trunc(Number(reportYearOverride))
        : new Date().getFullYear();
      console.log(`[QPRO DIAGNOSTIC] Document Title: "${documentTitle}"`);
      console.log(`[QPRO DIAGNOSTIC] Report Year: ${reportYear}`);

      // ========== PHASE 3: ROUTER - Classify to Single Dominant KRA ==========
      console.log('[QPRO DIAGNOSTIC] ========== ROUTER: KRA CLASSIFICATION ==========');
      const routerResult = await classifyDominantKRA(documentTitle, userText);
      
      if (!routerResult) {
        console.error('[ROUTER] Could not classify document to a specific KRA');
        throw new Error('Document could not be classified into a Strategic Plan KRA. Please ensure the document contains relevant content.');
      }
      
      const { kraId: dominantKRA, confidence: routerConfidence } = routerResult;
      // Use normalized KRA ID for consistent lookup
      const normalizedDominantKRA = normalizeKraId(dominantKRA);
      const targetKRA = strategicPlan.kras.find((k: any) => normalizeKraId(k.kra_id) === normalizedDominantKRA);
      
      console.log(`[ROUTER] ✅ Dominant KRA: ${normalizedDominantKRA} - "${targetKRA?.kra_title}"`);
      console.log(`[ROUTER] Confidence: ${(routerConfidence * 100).toFixed(1)}%`);
      console.log('[QPRO DIAGNOSTIC] ==========================================');

      // ========== PHASE 4: EXTRACTOR - Extract Activities for This KRA Only ==========
      console.log('[QPRO DIAGNOSTIC] ========== EXTRACTOR: ACTIVITY EXTRACTION ==========');
      const extractedActivities = await extractActivitiesForKRA(userText, normalizedDominantKRA, reportYear);
      console.log(`[EXTRACTOR] Extracted ${extractedActivities.length} activities for ${normalizedDominantKRA}`);
      console.log('[QPRO DIAGNOSTIC] ==========================================');

      // ========== PHASE 5: NOISE FILTER - Clean Extracted Activities ==========
      console.log('[QPRO DIAGNOSTIC] ========== NOISE FILTER ==========');
      const cleanedActivities = filterNoiseActivities(extractedActivities);
      console.log(`[NOISE FILTER] After filtering: ${cleanedActivities.length} activities`);
      console.log('[QPRO DIAGNOSTIC] ==========================================');

      // ========== PHASE 6: ENRICH ACTIVITIES - Add Required Fields ==========
      console.log('[QPRO DIAGNOSTIC] ========== ACTIVITY ENRICHMENT ==========');
      const enrichedActivities = cleanedActivities.map((act: any) => {
        let reported: any = act.reported || act.reported_value || 0;
        const initiativeId = act.initiativeId || act.kpi_id || `${normalizedDominantKRA}-KPI1`;

        // Resolve KPI target meta (single institutional target per KPI)
        const meta = getInitiativeTargetMeta(strategicPlan as any, normalizedDominantKRA, initiativeId, reportYear);
        const initiativeTarget = typeof act.target === 'number'
          ? act.target
          : (act.target_value !== undefined ? Number(act.target_value) : Number(act.target || 0));
        const resolvedInitiativeTarget = meta.targetValue ?? (Number.isFinite(initiativeTarget) && initiativeTarget > 0 ? initiativeTarget : 0);

        // Activity-level semantics:
        // - For count-based KPIs where each extracted row/title is an item, each item is a contribution (target=1).
        //   KPI-level progress is computed by summing items and comparing to the single institutional target.
        const targetType = String(meta.targetType || act.dataType || act.data_type || 'count').toLowerCase();

        // Ensure percentage KPIs remain in 0-100 range (and avoid decimal-stripping artifacts)
        if (targetType === 'percentage') {
          reported = normalizePercentageReported(reported);
        }
        // Activity achievement/status should be computed against the KPI's institutional target.
        // Using a per-row target of 1 for count KPIs incorrectly marks partial progress as "MET"
        // (e.g., 4 outputs vs 150 target would appear as 100%).
        const activityTarget = resolvedInitiativeTarget || 1;

        const achievementRaw = activityTarget > 0 ? (Number(reported) / activityTarget) * 100 : 0;
        const achievement = Math.min(100, Math.max(0, achievementRaw));
        const status: 'MET' | 'MISSED' = achievement >= 100 ? 'MET' : 'MISSED';
        
        // Get authorized strategy from the KRA
        const initiative = targetKRA?.initiatives.find((i: any) => i.id === act.initiativeId || i.id === act.kpi_id);
        const authorizedStrategy = initiative?.strategies?.[0] || 'Strategy from Strategic Plan';
        
        // Activity-level AI messages must not treat each document as needing to meet the full target.
        // For count KPIs, show the current contribution vs the institutional target.
        const aiInsight = targetType === 'count'
          ? `Recorded ${reported} toward the KPI target (${resolvedInitiativeTarget || 'N/A'} for ${reportYear}).`
          : (status === 'MET'
            ? `Target achieved: ${reported} vs ${resolvedInitiativeTarget || activityTarget} (${achievement.toFixed(1)}%).`
            : `Below target: ${reported} vs ${resolvedInitiativeTarget || activityTarget} (${achievement.toFixed(1)}%).`);

        const prescriptiveAnalysis = targetType === 'count'
          ? `Continue implementing: "${authorizedStrategy}". Focus on increasing total outputs toward the KPI target across the reporting period.`
          : (status === 'MET'
            ? `Sustain performance by continuing: "${authorizedStrategy}".`
            : `Improve results by implementing: "${authorizedStrategy}" within the current reporting period.`);

        // Determine suggested status with proper typing
        const suggestedStatus: 'MET' | 'ON_TRACK' | 'DELAYED' | 'AT_RISK' = 
          status === 'MET' ? 'MET' : 
          achievement >= 75 ? 'ON_TRACK' : 
          achievement >= 50 ? 'DELAYED' : 'AT_RISK';

        return {
          name: act.name,
          kraId: normalizedDominantKRA,
          initiativeId: act.initiativeId || act.kpi_id || `${normalizedDominantKRA}-KPI1`,
          reported: reported,
          target: activityTarget,
          initiativeTarget: resolvedInitiativeTarget,
          achievement: Math.round(achievement * 100) / 100,
          status: status,
          authorizedStrategy: authorizedStrategy,
          aiInsight: aiInsight,
          prescriptiveAnalysis: prescriptiveAnalysis,
          confidence: routerConfidence,
          unit: act.unit || '',
          evidenceSnippet: act.evidenceSnippet || act.evidence_snippet || '',
          dataType: act.dataType || act.data_type || 'count',
          rootCause: status === 'MISSED' ? 'Performance below target - review resource allocation and timeline' : undefined,
          suggestedStatus: suggestedStatus
        };
      });
      console.log(`[ENRICHMENT] Enriched ${enrichedActivities.length} activities`);
      console.log('[QPRO DIAGNOSTIC] ==========================================');

      // ========== PHASE 7: PRESCRIPTIVE ANALYSIS - Generate Insights ==========
      // When skipPrescriptive is true, defer insight generation to the review step
      let prescriptiveResult: {
        documentInsight: string;
        prescriptiveItems: Array<{ title: string; issue: string; action: string; nextStep?: string }>;
        alignment: string;
        opportunities: string;
        gaps: string;
        recommendations: string;
        overallAchievement: number;
      };

      if (skipPrescriptive) {
        console.log('[QPRO DIAGNOSTIC] ========== PRESCRIPTIVE ANALYSIS SKIPPED (deferred to review) ==========');
        // Compute overall achievement deterministically without LLM
        const byInit = new Map<string, any[]>();
        for (const a of enrichedActivities) {
          const iId = String(a.initiativeId || `${normalizedDominantKRA}-KPI1`).trim();
          if (!byInit.has(iId)) byInit.set(iId, []);
          byInit.get(iId)!.push(a);
        }
        const kpiAchievements = Array.from(byInit.entries()).map(([iId, acts]) => {
          const meta = getInitiativeTargetMeta(strategicPlan as any, normalizedDominantKRA, iId, reportYear);
          const fallbackTarget = typeof acts[0]?.initiativeTarget === 'number'
            ? acts[0].initiativeTarget
            : (typeof acts[0]?.target === 'number' ? acts[0].target : Number(acts[0]?.target || 0));
          const targetValue = meta.targetValue ?? (Number.isFinite(fallbackTarget) && fallbackTarget > 0 ? fallbackTarget : 0);
          const aggregated = computeAggregatedAchievement({
            targetType: meta.targetType,
            targetValue,
            targetScope: meta.targetScope,
            activities: acts,
          });
          return Math.min(100, Math.max(0, aggregated.achievementPercent));
        });
        const deferredOverall = kpiAchievements.length > 0
          ? kpiAchievements.reduce((s, v) => s + v, 0) / kpiAchievements.length
          : 0;

        prescriptiveResult = {
          documentInsight: '',
          prescriptiveItems: [],
          alignment: '',
          opportunities: '',
          gaps: '',
          recommendations: '',
          overallAchievement: deferredOverall,
        };
      } else {
        console.log('[QPRO DIAGNOSTIC] ========== PRESCRIPTIVE ANALYSIS ==========');
        prescriptiveResult = await generatePrescriptiveAnalysis(
          enrichedActivities,
          normalizedDominantKRA,
          targetKRA?.kra_title || normalizedDominantKRA,
          reportYear
        );
      }
      console.log(`[PRESCRIPTIVE] Overall Achievement: ${prescriptiveResult.overallAchievement}%`);
      console.log('[QPRO DIAGNOSTIC] ==========================================');

      // ========== PHASE 8: BUILD FINAL OUTPUT ==========
      const kraSummary = {
        kraId: normalizedDominantKRA,
        kraTitle: targetKRA?.kra_title || normalizedDominantKRA,
        achievementRate: prescriptiveResult.overallAchievement,
        activities: enrichedActivities,
        strategicAlignment: prescriptiveResult.alignment,
        prescriptiveAnalysis: prescriptiveResult.recommendations,
        rootCause: enrichedActivities.some((a: any) => a.status === 'MISSED') 
          ? 'Some targets missed - review implementation strategies' 
          : undefined,
        actionItems: enrichedActivities
          .filter((a: any) => a.status === 'MISSED')
          .slice(0, 3)
          .map((a: any) => `Address gap in: ${a.name}`)
      };

      const finalOutput: QPROAnalysisOutput = {
        activities: enrichedActivities,
        kras: [kraSummary],
        documentInsight: prescriptiveResult.documentInsight,
        prescriptiveItems: prescriptiveResult.prescriptiveItems,
        alignment: prescriptiveResult.alignment,
        opportunities: prescriptiveResult.opportunities,
        gaps: prescriptiveResult.gaps,
        recommendations: prescriptiveResult.recommendations,
        overallAchievement: prescriptiveResult.overallAchievement,
        insightsGenerated: !skipPrescriptive
      };

      console.log('[QPRO DIAGNOSTIC] ========== FINAL OUTPUT SUMMARY ==========');
      console.log(`[FINAL] Dominant KRA: ${normalizedDominantKRA}`);
      console.log(`[FINAL] Total Activities: ${finalOutput.activities.length}`);
      console.log(`[FINAL] Overall Achievement: ${finalOutput.overallAchievement}%`);
      console.log('[QPRO DIAGNOSTIC] ==========================================');

      return finalOutput;
    } catch (error) {
      console.error('Error in processQPRO:', error);
      throw error;
    }
  }

  /**
   * Analyze with exponential backoff retry and LLM fallback
   */
  private async analyzeWithRetry(
    strategicContext: string, 
    userText: string,
    sectionAnalysis: string = '',
    maxRetries: number = 3
  ): Promise<QPROAnalysisOutput> {
    let lastError: any;
    
    // Validate inputs before attempting LLM call
    if (!strategicContext || strategicContext.trim().length === 0) {
      throw new Error('strategicContext cannot be empty');
    }
    if (!userText || userText.trim().length === 0) {
      throw new Error('userText cannot be empty');
    }
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[AnalysisEngine] Attempt ${attempt}/${maxRetries} with GPT-4o-mini`);
        console.log(`[AnalysisEngine] strategicContext length: ${strategicContext.length}`);
        console.log(`[AnalysisEngine] userText length: ${userText.length}`);
        
        // Combine user input with strategic context
        const chain = this.promptTemplate.pipe(this.llm);
        const result = await chain.invoke({
          strategic_context: strategicContext,
          user_input: userText,
          section_analysis: sectionAnalysis
        });

        // Parse and validate JSON response
        const rawContent = result.content as string;
        return this.parseAndValidateLLMResponse(rawContent);
      } catch (error) {
        lastError = error;
        console.error(`[AnalysisEngine] Attempt ${attempt} failed:`, error);
        
        // If this was the last retry, try fallback providers
        if (attempt === maxRetries) {
          console.log('[AnalysisEngine] All GPT-4o-mini attempts failed, trying fallback providers...');
          
          // Try Qwen fallback
          try {
            return await this.analyzeWithQwen(strategicContext, userText, sectionAnalysis);
          } catch (qwenError) {
            console.error('[AnalysisEngine] Qwen fallback failed:', qwenError);
            
            // Try Gemini as last resort
            try {
              return await this.analyzeWithGemini(strategicContext, userText, sectionAnalysis);
            } catch (geminiError) {
              console.error('[AnalysisEngine] Gemini fallback failed:', geminiError);
              throw new Error(`All LLM providers failed. Last error: ${lastError.message}`);
            }
          }
        }
        
        // Exponential backoff: wait 2^attempt seconds
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`[AnalysisEngine] Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    throw lastError;
  }

  /**
   * Fallback analysis using Qwen
   */
  private async analyzeWithQwen(strategicContext: string, userText: string, sectionAnalysis: string = ''): Promise<QPROAnalysisOutput> {
    console.log('[AnalysisEngine] Using Qwen fallback provider');
    
    const qwenClient = new ChatOpenAI({
      modelName: "qwen/qwen-2.5-72b-instruct",
      temperature: 0.2,
      maxTokens: 2500, // Reduced to stay within OpenRouter credit limits
      configuration: {
        baseURL: process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENAI_API_KEY,
      },
      modelKwargs: {
        response_format: { type: "json_object" }
      },
    });
    
    const chain = this.promptTemplate.pipe(qwenClient);
    const result = await chain.invoke({
      strategic_context: strategicContext,
      user_input: userText,
      section_analysis: sectionAnalysis
    });
    
    return this.parseAndValidateLLMResponse(result.content as string);
  }

  /**
   * Fallback analysis using Gemini
   */
  private async analyzeWithGemini(strategicContext: string, userText: string, sectionAnalysis: string = ''): Promise<QPROAnalysisOutput> {
    console.log('[AnalysisEngine] Using Gemini fallback provider');
    
    // Note: Gemini doesn't support JSON mode the same way, so we rely on prompt engineering
    const geminiPrompt = `${this.promptTemplate.template}\n\nIMPORTANT: Return ONLY valid JSON in the exact format specified above. No markdown, no code blocks, just the JSON object.`;
    
    const geminiClient = new ChatOpenAI({
      modelName: "gemini-2.0-flash-001",
      temperature: 0.2,
      maxTokens: 2500, // Reduced to stay within OpenRouter credit limits
      configuration: {
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        apiKey: process.env.GOOGLE_AI_API_KEY,
      },
    });
    
    const geminiTemplate = PromptTemplate.fromTemplate(geminiPrompt);
    const chain = geminiTemplate.pipe(geminiClient);
    const result = await chain.invoke({
      strategic_context: strategicContext,
      user_input: userText,
      section_analysis: sectionAnalysis
    });
    
    return this.parseAndValidateLLMResponse(result.content as string);
  }

  /**
   * Helper method to decode hex-encoded text from pdf2json
   */
  private decodeText(hexText: string): string {
    if (!hexText) return '';
    try {
      // Remove the forward slash and replace #20 with space if needed
      hexText = hexText.replace(/\//g, '').replace(/#20/g, ';');
      // Decode hex to string
      const text = hexText.replace(/#([0-9A-Fa-f]{2})/g, (match, hex) => {
        return String.fromCharCode(parseInt(hex, 16));
      });
      return decodeURIComponent(escape(text));
    } catch (error) {
      console.error('Error decoding text:', error);
      return hexText || '';
    }
  }

  /**
   * Generate cache key for vector search results
   */
  private generateCacheKey(text: string, unitId?: string): string {
    const textHash = createHash('md5').update(text.slice(0, 1000)).digest('hex');
    return `qpro:vector-search:${textHash}:${unitId || 'all'}`;
  }

  /**
   * Implement "Winner Takes All" deduplication
   * Removes semantic duplicates from search results, keeping only the highest-scoring entry
   * for each KRA/initiative combination to prevent double-counting activities
   */
  private deduplicateSearchResults(results: any[]): any[] {
    if (results.length === 0) return results;

    // Group results by KRA ID to identify duplicates
    const kraMap = new Map<string, any>();
    
    results.forEach((result) => {
      const kraId = result.metadata?.kra_id;
      
      if (!kraId) {
        return; // Skip results without KRA ID
      }
      
      // If we haven't seen this KRA yet, or this result has a higher score, keep it
      if (!kraMap.has(kraId) || (result.score || 0) > (kraMap.get(kraId).score || 0)) {
        kraMap.set(kraId, result);
        console.log(`[DEDUP] KRA ${kraId}: score=${result.score?.toFixed(3)}`);
      } else {
        console.log(`[DEDUP] Skipping duplicate KRA ${kraId} (lower score: ${result.score?.toFixed(3)} < ${kraMap.get(kraId).score?.toFixed(3)})`);
      }
    });
    
    // Convert map back to array, sorted by score descending
    const deduped = Array.from(kraMap.values())
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    
    console.log(`[DEDUP] Deduplicated ${results.length} results to ${deduped.length} unique KRAs`);
    return deduped;
  }

  /**
   * Parse and validate LLM JSON response
   */
  private parseAndValidateLLMResponse(rawContent: string | any): QPROAnalysisOutput {
    try {
      let parsed: any;
      
      // If rawContent is already an object, use it directly
      if (typeof rawContent === 'object' && rawContent !== null) {
        console.log('[AnalysisEngine] Content is already an object, using directly');
        parsed = rawContent;
      } else {
        // If it's a string, parse it
        let cleanedContent = String(rawContent).trim();
        
        // Remove markdown code blocks if present
        if (cleanedContent.startsWith('```')) {
          cleanedContent = cleanedContent.replace(/^```json\n?/, '').replace(/\n?```$/, '');
        }
        
        // Parse JSON
        parsed = JSON.parse(cleanedContent);
      }
      
      // Validate with Zod schema
      const validated = QPROAnalysisOutputSchema.parse(parsed);
      
      console.log('[AnalysisEngine] Successfully validated LLM response');
      console.log(`[AnalysisEngine] Extracted ${validated.activities.length} activities across ${validated.kras.length} KRAs`);
      
      return validated;
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error('[AnalysisEngine] Zod validation failed:', error.errors);
        throw new Error(`LLM output validation failed: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
      }
      console.error('[AnalysisEngine] JSON parsing failed:', error);
      console.error('[AnalysisEngine] Raw content type:', typeof rawContent);
      console.error('[AnalysisEngine] Raw content preview:', String(rawContent).substring(0, 200));
      throw new Error(`Failed to parse LLM response as JSON: ${error}`);
    }
  }
}

export const analysisEngineService = new AnalysisEngineService();
export default AnalysisEngineService;