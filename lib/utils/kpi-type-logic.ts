/**
 * KPI Type-Aware Analysis Logic
 * 
 * This module implements the "Type-Aware Analysis" pattern to solve the
 * "Unit of Measure Blindness" problem. The system must modify its prescriptive
 * logic based on the KPI_TYPE (count, rate, boolean, etc.) defined in the strategic plan.
 * 
 * Logic Matrix:
 * | KPI Type Group | Specific Types               | Interpretation       | Root Cause Focus                    | Prescriptive Action |
 * |----------------|------------------------------|----------------------|-------------------------------------|---------------------|
 * | Volume         | count                        | Quantity Deficit     | Pipeline, Funding, Frequency, Lag   | Scale Up            |
 * | Efficiency     | rate, percentage, ratio      | Quality/Conversion   | Curriculum, Training, Standards     | Optimize Quality    |
 * | Milestone      | boolean, status, milestone   | Project Delay        | Bureaucracy, Approvals, Resources   | Intervention        |
 * | Performance    | score, value                 | Satisfaction Deficit | User Experience, Facilities         | Root Cause Analysis |
 * | Text           | text                         | N/A                  | Qualitative Context                 | Summarize           |
 */

// KPI Type Categories
export type KpiTypeCategory = 'VOLUME' | 'EFFICIENCY' | 'MILESTONE' | 'PERFORMANCE' | 'TEXT' | 'UNKNOWN';

// Raw KPI types as they appear in strategic_plan.json
export type RawKpiType = 'count' | 'percentage' | 'rate' | 'ratio' | 'milestone' | 'boolean' | 'status' | 'score' | 'value' | 'text' | string;

/**
 * Maps a raw KPI type string to its category for analysis logic
 */
export function getKpiTypeCategory(kpiType: RawKpiType | undefined | null): KpiTypeCategory {
  if (!kpiType) return 'UNKNOWN';
  
  const normalized = String(kpiType).toLowerCase().trim();
  
  // Volume types - quantity-based metrics
  if (['count', 'low_count', 'high_count', 'number', 'quantity'].includes(normalized)) {
    return 'VOLUME';
  }
  
  // Efficiency types - rate/conversion metrics
  if (['rate', 'percentage', 'ratio', 'percent', '%'].includes(normalized)) {
    return 'EFFICIENCY';
  }
  
  // Milestone types - binary/status metrics
  if (['milestone', 'boolean', 'status', 'binary', 'yes/no', 'yes-no', 'achieved', 'completed'].includes(normalized)) {
    return 'MILESTONE';
  }
  
  // Performance types - score/satisfaction metrics
  if (['score', 'value', 'rating', 'index', 'satisfaction'].includes(normalized)) {
    return 'PERFORMANCE';
  }
  
  // Text types - qualitative metrics
  if (['text', 'narrative', 'description', 'qualitative'].includes(normalized)) {
    return 'TEXT';
  }
  
  return 'UNKNOWN';
}

/**
 * Gap interpretation based on KPI type category
 */
export interface GapInterpretation {
  category: KpiTypeCategory;
  gapType: string;
  rootCauseFocus: string[];
  actionArchetype: string;
  antiPattern: string | null; // What NOT to suggest
}

/**
 * Get the gap interpretation for a KPI type category
 */
export function getGapInterpretation(category: KpiTypeCategory): GapInterpretation {
  switch (category) {
    case 'VOLUME':
      return {
        category: 'VOLUME',
        gapType: 'Quantity Deficit',
        rootCauseFocus: [
          'Insufficient pipeline or production capacity',
          'Limited funding or resource allocation',
          'Low frequency of activities/events',
          'Reporting lag or data collection delays',
          'Staff/resource availability constraints'
        ],
        actionArchetype: 'Scale Up',
        antiPattern: null // Volume metrics can suggest scaling
      };
      
    case 'EFFICIENCY':
      return {
        category: 'EFFICIENCY',
        gapType: 'Quality/Conversion Deficit',
        rootCauseFocus: [
          'Curriculum relevance and alignment with industry needs',
          'Training quality and delivery effectiveness',
          'Difficulty of standards or assessments',
          'Retention policies and student support',
          'Industry partnership and placement programs'
        ],
        actionArchetype: 'Optimize Quality',
        antiPattern: 'Do NOT suggest "collecting more data" or "scaling data collection" - the data is likely correct, but performance is low'
      };
      
    case 'MILESTONE':
      return {
        category: 'MILESTONE',
        gapType: 'Project Delay',
        rootCauseFocus: [
          'Bureaucratic bottlenecks and approval delays',
          'Resource or budget availability issues',
          'Stakeholder coordination challenges',
          'Dependency on external approvals',
          'Change management resistance'
        ],
        actionArchetype: 'Intervention',
        antiPattern: 'Do NOT suggest incremental improvements - focus on unblocking specific delays'
      };
      
    case 'PERFORMANCE':
      return {
        category: 'PERFORMANCE',
        gapType: 'Satisfaction/Standard Deficit',
        rootCauseFocus: [
          'User experience and service delivery quality',
          'Facilities and infrastructure conditions',
          'Process efficiency and responsiveness',
          'Communication and feedback mechanisms',
          'Staff competency and service attitude'
        ],
        actionArchetype: 'Root Cause Analysis',
        antiPattern: 'Do NOT assume the issue without user feedback data - investigate surveys and feedback first'
      };
      
    case 'TEXT':
      return {
        category: 'TEXT',
        gapType: 'Qualitative Context',
        rootCauseFocus: [
          'Narrative completeness and clarity',
          'Key themes and patterns',
          'Sentiment and stakeholder perspectives'
        ],
        actionArchetype: 'Summarize',
        antiPattern: 'Do NOT apply numeric gap analysis to text-based metrics'
      };
      
    default:
      return {
        category: 'UNKNOWN',
        gapType: 'Standard Variance',
        rootCauseFocus: ['General performance review required'],
        actionArchetype: 'Standard Analysis',
        antiPattern: null
      };
  }
}

/**
 * Generate type-specific logic instruction for LLM prompts
 * This is the dynamic injection based on KPI type
 */
export function generateTypeSpecificLogicInstruction(kpiType: RawKpiType | undefined | null): string {
  const category = getKpiTypeCategory(kpiType);
  const interpretation = getGapInterpretation(category);
  
  const rootCauseList = interpretation.rootCauseFocus
    .map((cause, i) => `   ${i + 1}. ${cause}`)
    .join('\n');
  
  const antiPatternWarning = interpretation.antiPattern 
    ? `\n⚠️ WARNING: ${interpretation.antiPattern}`
    : '';
  
  switch (category) {
    case 'VOLUME':
      return `
[LOGIC RULE: VOLUME METRIC]
Since this KPI is a COUNT/VOLUME type:
1. Interpret any gap as a QUANTITY DEFICIT - not enough outputs are being produced.
2. Potential root causes to investigate:
${rootCauseList}
3. Recommended action archetype: "${interpretation.actionArchetype}"
   - Suggest increasing frequency of activities
   - Suggest allocating more resources/funding
   - Suggest batch-processing or fixing reporting backlogs
   - Suggest hiring/training more staff if capacity is limited
${antiPatternWarning}
`;
      
    case 'EFFICIENCY':
      return `
[LOGIC RULE: EFFICIENCY/QUALITY METRIC]
Since this KPI is a RATE/PERCENTAGE type:
1. Interpret any gap as a QUALITY/CONVERSION DEFICIT - outcomes are poor despite activity.
   Example: If employment rate is low, students ARE graduating but are NOT getting hired.
   Example: If passing rate is low, students ARE taking exams but are NOT passing.
2. Potential root causes to investigate:
${rootCauseList}
3. Recommended action archetype: "${interpretation.actionArchetype}"
   - Focus on curriculum review and industry alignment
   - Suggest skills training and competency enhancement
   - Recommend retention and support programs
   - Consider industry partnership improvements
${antiPatternWarning}

CRITICAL: A low percentage does NOT mean "reporting problems" or "data collection issues."
The data is likely correct - the ACTUAL PERFORMANCE is the problem.
`;
      
    case 'MILESTONE':
      return `
[LOGIC RULE: MILESTONE/STATUS METRIC]
Since this KPI is a MILESTONE/BOOLEAN type:
1. Interpret any gap as a PROJECT DELAY - something is blocked or incomplete.
2. Potential root causes to investigate:
${rootCauseList}
3. Recommended action archetype: "${interpretation.actionArchetype}"
   - Suggest fast-tracking approvals
   - Recommend task force assignment
   - Suggest budget/resource reallocation
   - Consider executive intervention for critical blockers
${antiPatternWarning}
`;
      
    case 'PERFORMANCE':
      return `
[LOGIC RULE: PERFORMANCE/SCORE METRIC]
Since this KPI is a SCORE/VALUE type:
1. Interpret any gap as a SATISFACTION/STANDARD DEFICIT - quality perception is low.
2. Potential root causes to investigate:
${rootCauseList}
3. Recommended action archetype: "${interpretation.actionArchetype}"
   - Conduct user surveys and feedback analysis
   - Review service delivery processes
   - Assess facilities and infrastructure
   - Implement improvement based on feedback data
${antiPatternWarning}
`;
      
    case 'TEXT':
      return `
[LOGIC RULE: TEXT/QUALITATIVE METRIC]
Since this KPI is a TEXT/NARRATIVE type:
1. This metric requires qualitative analysis, not numeric gap calculation.
2. Focus areas:
${rootCauseList}
3. Recommended action archetype: "${interpretation.actionArchetype}"
   - Extract key themes and patterns
   - Identify sentiment and stakeholder perspectives
   - Provide narrative summary
${antiPatternWarning}
`;
      
    default:
      return `
[LOGIC RULE: STANDARD ANALYSIS]
KPI type not clearly defined. Apply standard variance analysis:
1. Compare actual vs target values
2. Identify the magnitude of the gap
3. Provide general improvement recommendations based on context
`;
  }
}

/**
 * Generate type-specific prescriptive recommendations based on gap analysis
 */
export interface PrescriptiveRecommendation {
  title: string;
  issue: string;
  action: string;
  nextStep: string;
  kpiType: KpiTypeCategory;
}

/**
 * Generate default prescriptive recommendations based on KPI type and performance
 */
export function generateTypeAwareRecommendation(
  kpiType: RawKpiType | undefined | null,
  kpiName: string,
  actualValue: number,
  targetValue: number,
  achievementPercent: number
): PrescriptiveRecommendation {
  const category = getKpiTypeCategory(kpiType);
  const interpretation = getGapInterpretation(category);
  const gap = targetValue - actualValue;
  
  switch (category) {
    case 'VOLUME':
      return {
        title: 'Scale Up Production Volume',
        issue: `${kpiName} shows a quantity deficit: ${actualValue} achieved vs ${targetValue} target (${achievementPercent.toFixed(1)}% achievement). Need ${gap} more outputs.`,
        action: 'Increase activity frequency, allocate additional resources, and address any reporting backlogs. Consider batch-processing pending submissions.',
        nextStep: `Identify immediate actions to produce ${Math.ceil(gap * 0.5)} additional outputs within the next reporting period.`,
        kpiType: category
      };
      
    case 'EFFICIENCY':
      return {
        title: 'Optimize Quality and Conversion',
        issue: `${kpiName} indicates a conversion/quality gap: ${actualValue.toFixed(1)}% achieved vs ${targetValue}% target. This suggests outcome quality issues, NOT reporting problems.`,
        action: 'Review curriculum alignment with industry needs, enhance skills training programs, strengthen industry partnerships, and implement retention support mechanisms.',
        nextStep: 'Conduct a curriculum review meeting with industry partners within 30 days to identify skills gaps.',
        kpiType: category
      };
      
    case 'MILESTONE':
      return {
        title: 'Fast-Track Project Completion',
        issue: `${kpiName} milestone is incomplete or delayed. This requires administrative intervention to unblock progress.`,
        action: 'Identify the specific blocker (approvals, resources, dependencies), escalate to appropriate authority, and create a fast-track action plan.',
        nextStep: 'Schedule a project review meeting within 7 days to identify and address all blockers.',
        kpiType: category
      };
      
    case 'PERFORMANCE':
      return {
        title: 'Investigate User Feedback',
        issue: `${kpiName} shows satisfaction/standard deficit: ${actualValue} vs ${targetValue} target. Root cause analysis needed before prescribing solutions.`,
        action: 'Gather and analyze user feedback, conduct surveys if needed, review service delivery processes, and implement targeted improvements.',
        nextStep: 'Review recent feedback data and conduct focus group sessions within 14 days.',
        kpiType: category
      };
      
    case 'TEXT':
      return {
        title: 'Qualitative Assessment',
        issue: `${kpiName} requires qualitative evaluation rather than numeric gap analysis.`,
        action: 'Extract key themes, identify patterns, and summarize stakeholder perspectives.',
        nextStep: 'Complete narrative analysis and summary within the current reporting period.',
        kpiType: category
      };
      
    default:
      return {
        title: 'Address Performance Gap',
        issue: `${kpiName} is at ${achievementPercent.toFixed(1)}% achievement (${actualValue} vs ${targetValue} target).`,
        action: 'Review the specific factors contributing to the gap and develop a targeted improvement plan.',
        nextStep: 'Assign ownership and create an action plan within 14 days.',
        kpiType: category
      };
  }
}

/**
 * Validate that a prescriptive analysis doesn't contain anti-patterns for its KPI type
 */
export function validatePrescriptiveAnalysis(
  analysis: string,
  kpiType: RawKpiType | undefined | null
): { isValid: boolean; warnings: string[] } {
  const category = getKpiTypeCategory(kpiType);
  const warnings: string[] = [];
  const analysisLower = analysis.toLowerCase();
  
  if (category === 'EFFICIENCY') {
    // Check for volume-type recommendations being applied to efficiency metrics
    const volumePatterns = [
      /reporting\s+(bottleneck|backlog|delay|lag)/i,
      /batch\s+(collection|processing|data)/i,
      /collect\s+more\s+(data|lists|reports)/i,
      /scale\s+up\s+(data|collection|reporting)/i,
      /data\s+collection\s+(delay|issue|problem)/i,
      /increase\s+(data|reporting)\s+frequency/i
    ];
    
    for (const pattern of volumePatterns) {
      if (pattern.test(analysis)) {
        warnings.push(
          `Anti-pattern detected: Suggesting data collection/reporting fixes for an EFFICIENCY metric. ` +
          `For rate/percentage KPIs, focus on quality improvement (curriculum, training, standards), not data volume.`
        );
        break;
      }
    }
  }
  
  if (category === 'MILESTONE') {
    // Check for incremental improvement suggestions instead of intervention
    const incrementalPatterns = [
      /gradual(ly)?\s+improve/i,
      /incremental\s+(improvement|progress|change)/i,
      /slow(ly)?\s+increase/i
    ];
    
    for (const pattern of incrementalPatterns) {
      if (pattern.test(analysis)) {
        warnings.push(
          `Anti-pattern detected: Suggesting incremental improvements for a MILESTONE metric. ` +
          `For milestone/status KPIs, focus on unblocking specific delays through intervention.`
        );
        break;
      }
    }
  }
  
  return {
    isValid: warnings.length === 0,
    warnings
  };
}

/**
 * Get a human-readable description of the KPI type for display
 */
export function getKpiTypeDescription(kpiType: RawKpiType | undefined | null): string {
  const category = getKpiTypeCategory(kpiType);
  const interpretation = getGapInterpretation(category);
  
  return `${category} (${interpretation.gapType}) - ${interpretation.actionArchetype}`;
}

/**
 * Build the complete dynamic prompt section for type-aware prescriptive analysis
 */
export function buildTypeAwarePromptContext(
  kpiType: RawKpiType | undefined | null,
  kpiName: string,
  kraName: string,
  targetValue: number | string,
  actualValue: number | string,
  gap: number | string
): string {
  const category = getKpiTypeCategory(kpiType);
  const logicInstruction = generateTypeSpecificLogicInstruction(kpiType);

  return `
[DATA CONTEXT]
KPI Name: ${kpiName}
KRA: ${kraName}
KPI Type: ${kpiType || 'Unknown'} (Category: ${category})
Target: ${targetValue}
Actual: ${actualValue}
Gap: ${gap}

${logicInstruction}
`;
}

// =========================================================================
// Domain-Aware Context Inference
// =========================================================================

/**
 * Represents the inferred domain context derived from activity names, KPI name,
 * and KRA title. Used to tailor prescriptive recommendations so they speak in
 * the language of the actual operational domain rather than generic advice.
 */
export interface DomainContext {
  domain:
    | 'ACADEMIC_RESEARCH'
    | 'IT_INFRASTRUCTURE'
    | 'HR_TRAINING'
    | 'COMMUNITY_EXTENSION'
    | 'FINANCIAL'
    | 'GOVERNANCE'
    | 'STUDENT_SERVICES'
    | 'GENERAL';
  domainLabel: string;
  contextClues: string[];
  recommendationFramework: string;
}

/** @internal keyword config for each domain */
const DOMAIN_KEYWORDS: Record<
  Exclude<DomainContext['domain'], 'GENERAL'>,
  { keywords: string[]; label: string; framework: string }
> = {
  ACADEMIC_RESEARCH: {
    keywords: [
      'research', 'thesis', 'dissertation', 'publication', 'journal', 'paper',
      'study', 'analysis', 'scholarly', 'manuscript', 'authorship', 'citation',
      'scopus', 'accreditation', 'curriculum',
    ],
    label: 'Academic Research & Scholarship',
    framework:
      'Recommendations should focus on faculty research load, research grants, IRB/ethics review processes, publication pipelines, and academic collaboration networks.',
  },
  IT_INFRASTRUCTURE: {
    keywords: [
      'it', 'infrastructure', 'network', 'system', 'server', 'software',
      'hardware', 'database', 'computing', 'digital', 'technology',
      'cybersecurity', 'ict', 'website', 'portal', 'lms', 'e-learning',
      'online platform',
    ],
    label: 'IT Infrastructure & Digital Systems',
    framework:
      'Recommendations should focus on procurement timelines, technical personnel deployment, system uptime, project milestone tracking, and cybersecurity posture.',
  },
  HR_TRAINING: {
    keywords: [
      'training', 'seminar', 'workshop', 'professional development', 'faculty',
      'staff development', 'certification', 'licensure', 'competency', 'skills',
      'capacity building', 'hrmd', 'manpower',
    ],
    label: 'Human Resource Development & Training',
    framework:
      'Recommendations should focus on training frequency, modality diversification (online/blended), participant coverage, competency assessments, and faculty/staff development plans.',
  },
  COMMUNITY_EXTENSION: {
    keywords: [
      'community', 'extension', 'outreach', 'partnership', 'linkage', 'moa',
      'mou', 'stakeholder', 'engagement', 'barangay', 'local government',
      'beneficiary', 'livelihood', 'services rendered',
    ],
    label: 'Community Extension & Outreach',
    framework:
      'Recommendations should focus on community needs assessments, partnership agreements (MOA/MOU), beneficiary targeting, outreach logistics, and impact measurement.',
  },
  FINANCIAL: {
    keywords: [
      'budget', 'revenue', 'income', 'financial', 'expenditure', 'fund',
      'allocation', 'utilization rate', 'collection efficiency', 'tuition', 'fee',
    ],
    label: 'Financial Management',
    framework:
      'Recommendations should focus on budget utilization, revenue collection strategies, expenditure controls, fund allocation optimization, and financial sustainability.',
  },
  GOVERNANCE: {
    keywords: [
      'policy', 'compliance', 'regulation', 'accreditation', 'iso',
      'quality assurance', 'governance', 'charter', 'manual of operations',
      'audit', 'institutional',
    ],
    label: 'Governance & Quality Assurance',
    framework:
      'Recommendations should focus on policy compliance, accreditation requirements, quality management systems, audit readiness, and institutional governance improvements.',
  },
  STUDENT_SERVICES: {
    keywords: [
      'enrollment', 'retention', 'graduation', 'employment', 'placement',
      'student', 'satisfaction', 'scholarship', 'admission', 'guidance',
      'counseling', 'dormitory', 'athletics',
    ],
    label: 'Student Services & Success',
    framework:
      'Recommendations should focus on student support programs, enrollment strategies, retention interventions, career placement services, and student satisfaction improvement.',
  },
};

/**
 * Infer the operational domain from the names of activities, the KPI, and the
 * KRA. Uses keyword frequency matching with word-boundary awareness to
 * determine the best-fit domain.
 *
 * @param activityNames - Array of activity/task names associated with the KPI
 * @param kpiName       - The name of the KPI itself (optional)
 * @param kraTitle      - The title of the parent KRA (optional)
 * @returns A {@link DomainContext} describing the inferred domain and its
 *          recommendation framework.
 */
export function inferDomainContext(
  activityNames: string[],
  kpiName?: string,
  kraTitle?: string
): DomainContext {
  // Build a single searchable corpus from all available text signals
  const corpus = [
    ...activityNames,
    ...(kpiName ? [kpiName] : []),
    ...(kraTitle ? [kraTitle] : []),
  ]
    .join(' ')
    .toLowerCase();

  // Score each domain by counting keyword hits
  const scores: {
    domain: Exclude<DomainContext['domain'], 'GENERAL'>;
    score: number;
    clues: string[];
  }[] = [];

  for (const [domain, config] of Object.entries(DOMAIN_KEYWORDS) as [
    Exclude<DomainContext['domain'], 'GENERAL'>,
    (typeof DOMAIN_KEYWORDS)[keyof typeof DOMAIN_KEYWORDS],
  ][]) {
    const clues: string[] = [];
    let score = 0;

    for (const keyword of config.keywords) {
      // Multi-word keywords are matched as plain substrings;
      // single-word keywords use word-boundary matching so "it" does not
      // match inside "community".
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = keyword.includes(' ')
        ? new RegExp(escaped, 'gi')
        : new RegExp(`\\b${escaped}\\b`, 'gi');

      const matches = corpus.match(regex);
      if (matches) {
        score += matches.length;
        clues.push(keyword);
      }
    }

    if (score > 0) {
      scores.push({ domain, score, clues });
    }
  }

  // Sort descending by score
  scores.sort((a, b) => b.score - a.score);

  if (scores.length === 0) {
    return {
      domain: 'GENERAL',
      domainLabel: 'General University Operations',
      contextClues: [],
      recommendationFramework:
        'Recommendations should be tailored to the specific operational context of a state university (LSPU).',
    };
  }

  const best = scores[0];
  const config = DOMAIN_KEYWORDS[best.domain];

  return {
    domain: best.domain,
    domainLabel: config.label,
    contextClues: best.clues,
    recommendationFramework: config.framework,
  };
}

// =========================================================================
// Context-Aware Prescriptive Recommendation
// =========================================================================

/**
 * Domain-specific recommendation templates keyed by KpiTypeCategory then by
 * DomainContext domain. When a combination is not explicitly listed the
 * generator falls back to GENERAL, then to the legacy type-only recommendation.
 */
const CONTEXT_RECOMMENDATIONS: Partial<
  Record<
    KpiTypeCategory,
    Partial<
      Record<
        DomainContext['domain'],
        { title: string; actionTemplate: string; nextStepTemplate: string }
      >
    >
  >
> = {
  VOLUME: {
    ACADEMIC_RESEARCH: {
      title: 'Intensify Research Output',
      actionTemplate:
        'Intensify research output through faculty research load adjustments, expanded research grants, and streamlined IRB/ethics review processes. Encourage co-authorship and inter-campus research collaboration to multiply publication counts.',
      nextStepTemplate:
        'Convene a Research Council meeting within 14 days to identify quick-win publications in progress and allocate seed grants for at least {halfGap} additional research outputs.',
    },
    IT_INFRASTRUCTURE: {
      title: 'Accelerate IT Project Delivery',
      actionTemplate:
        'Accelerate IT project completion by securing procurement timelines, deploying additional technical personnel, and establishing project milestone tracking. Prioritize critical infrastructure deliverables and fast-track vendor agreements.',
      nextStepTemplate:
        'Conduct a project status review within 7 days, identify the top {halfGap} deliverables that can be completed in the next reporting cycle, and escalate pending procurement requests.',
    },
    HR_TRAINING: {
      title: 'Expand Training Program Reach',
      actionTemplate:
        'Increase training session frequency, diversify training modalities (online/blended), and expand participant coverage across units. Leverage existing LMS platforms for asynchronous delivery to maximize reach.',
      nextStepTemplate:
        'Schedule {halfGap} additional training sessions within the next 30 days, prioritizing units with the lowest participation rates.',
    },
    COMMUNITY_EXTENSION: {
      title: 'Scale Community Extension Activities',
      actionTemplate:
        'Expand outreach activities by forging new MOA/MOU partnerships with LGUs and barangays, deploying more extension teams, and streamlining beneficiary documentation processes.',
      nextStepTemplate:
        'Identify {halfGap} additional community sites for extension activities and draft partnership agreements within 21 days.',
    },
    FINANCIAL: {
      title: 'Increase Revenue Collection Volume',
      actionTemplate:
        'Strengthen collection mechanisms, expand revenue-generating programs, and ensure timely billing and follow-up on outstanding receivables.',
      nextStepTemplate:
        'Review collection processes and set up automated reminders for outstanding accounts within 14 days to close the gap of {gap} in target.',
    },
    GOVERNANCE: {
      title: 'Accelerate Policy and Compliance Deliverables',
      actionTemplate:
        'Fast-track pending policy documents, compliance reports, and governance deliverables by assigning dedicated task forces and setting non-negotiable deadlines for each output.',
      nextStepTemplate:
        'Inventory all pending governance deliverables within 7 days and assign clear ownership for the {halfGap} most critical items.',
    },
    STUDENT_SERVICES: {
      title: 'Boost Student Service Program Output',
      actionTemplate:
        'Increase the number of student service programs, scholarship slots, or guidance sessions by expanding staffing, extending service hours, and streamlining application processes.',
      nextStepTemplate:
        'Identify {halfGap} additional service delivery opportunities (e.g., career fairs, counseling sessions) schedulable within 30 days.',
    },
    GENERAL: {
      title: 'Scale Up Output Volume',
      actionTemplate:
        'Increase activity frequency, allocate additional resources, and address any reporting backlogs. Review workflow bottlenecks and consider batch-processing pending submissions.',
      nextStepTemplate:
        'Identify immediate actions to produce {halfGap} additional outputs within the next reporting period.',
    },
  },
  EFFICIENCY: {
    ACADEMIC_RESEARCH: {
      title: 'Improve Research Quality Outcomes',
      actionTemplate:
        'Strengthen research mentorship programs, invest in methodological training, align research priorities with indexed-journal requirements, and provide editing/statistical consultation support to improve acceptance rates.',
      nextStepTemplate:
        'Launch a research quality enhancement workshop within 21 days covering manuscript preparation, statistical rigor, and journal selection strategies.',
    },
    IT_INFRASTRUCTURE: {
      title: 'Optimize System Performance and Uptime',
      actionTemplate:
        'Conduct root-cause analysis on system performance bottlenecks, upgrade critical infrastructure components, implement automated monitoring/alerting, and establish SLA-driven maintenance schedules.',
      nextStepTemplate:
        'Deploy monitoring dashboards within 14 days and schedule a performance audit for all critical systems.',
    },
    HR_TRAINING: {
      title: 'Enhance Training Effectiveness',
      actionTemplate:
        'Redesign training curricula based on post-training assessment results, implement competency-based evaluations, and introduce follow-up coaching to improve knowledge retention and application rates.',
      nextStepTemplate:
        'Analyze post-training assessment scores within 14 days and redesign the bottom-performing modules.',
    },
    COMMUNITY_EXTENSION: {
      title: 'Improve Extension Program Impact Rates',
      actionTemplate:
        'Refine beneficiary targeting criteria, strengthen pre-activity needs assessments, and implement post-activity impact evaluations to improve the conversion of outreach efforts into measurable community outcomes.',
      nextStepTemplate:
        'Conduct impact evaluations for the last 3 extension programs within 21 days and identify improvement areas.',
    },
    STUDENT_SERVICES: {
      title: 'Improve Student Success Rates',
      actionTemplate:
        'Strengthen academic support programs (tutoring, supplemental instruction), enhance career services alignment with industry needs, and implement early-warning systems for at-risk students.',
      nextStepTemplate:
        'Review retention and placement data within 14 days, identify at-risk cohorts, and activate targeted intervention programs.',
    },
    GENERAL: {
      title: 'Optimize Quality and Conversion',
      actionTemplate:
        'Review process quality, enhance training and standards, strengthen partnerships, and implement retention support mechanisms to improve outcome rates.',
      nextStepTemplate:
        'Conduct a process review meeting within 30 days to identify quality improvement opportunities.',
    },
  },
  MILESTONE: {
    ACADEMIC_RESEARCH: {
      title: 'Unblock Research Milestone Completion',
      actionTemplate:
        'Identify the specific research process bottleneck (IRB approval, funding release, data access) and escalate to the VP for Research. Assign a dedicated facilitator to shepherd the deliverable through remaining approvals.',
      nextStepTemplate:
        'Schedule a milestone review with the Research Office within 7 days to map all remaining blockers and assign resolution owners.',
    },
    IT_INFRASTRUCTURE: {
      title: 'Resolve IT Project Blockers',
      actionTemplate:
        'Identify whether the delay stems from procurement, technical dependencies, or staffing. Escalate procurement bottlenecks to BAC, reassign technical resources if needed, and establish a war-room cadence until the milestone is achieved.',
      nextStepTemplate:
        'Conduct an emergency IT project status meeting within 5 days and produce a critical-path resolution plan.',
    },
    GOVERNANCE: {
      title: 'Fast-Track Governance Milestone',
      actionTemplate:
        'Escalate the pending policy/compliance milestone to the appropriate governance body, assign a drafting task force with a hard deadline, and schedule approval sessions to eliminate queue delays.',
      nextStepTemplate:
        'Submit the draft deliverable to the governance board within 14 days with a request for expedited review.',
    },
    GENERAL: {
      title: 'Fast-Track Milestone Completion',
      actionTemplate:
        'Identify the specific blocker (approvals, resources, dependencies), escalate to appropriate authority, and create a fast-track action plan with non-negotiable deadlines.',
      nextStepTemplate:
        'Schedule a project review meeting within 7 days to identify and address all blockers.',
    },
  },
  PERFORMANCE: {
    STUDENT_SERVICES: {
      title: 'Investigate Student Satisfaction Drivers',
      actionTemplate:
        'Administer targeted satisfaction surveys, conduct focus groups with student leaders, review service delivery touchpoints, and benchmark against peer institutions to identify specific improvement areas.',
      nextStepTemplate:
        'Launch a rapid student satisfaction pulse survey within 10 days and analyze results to pinpoint the top 3 pain points.',
    },
    IT_INFRASTRUCTURE: {
      title: 'Improve IT Service Satisfaction',
      actionTemplate:
        'Analyze helpdesk ticket trends, measure response/resolution times, survey end-users on pain points, and prioritize fixes for the most-reported issues.',
      nextStepTemplate:
        'Review the last 90 days of helpdesk data within 7 days and present a top-5 improvement plan to IT leadership.',
    },
    GENERAL: {
      title: 'Investigate Performance Gap Root Causes',
      actionTemplate:
        'Gather and analyze user feedback, conduct surveys if needed, review service delivery processes, and implement targeted improvements based on data.',
      nextStepTemplate:
        'Review recent feedback data and conduct focus group sessions within 14 days.',
    },
  },
};

/**
 * Generate a prescriptive recommendation that considers BOTH the KPI type
 * category AND the inferred operational domain of the activities. This avoids
 * the "generic advice" problem where, e.g., an IT infrastructure KPI receives
 * manufacturing-style "scale up production" language.
 *
 * The existing {@link generateTypeAwareRecommendation} is intentionally left
 * unchanged for backward compatibility.
 *
 * @param kpiType            - The raw KPI type string from the strategic plan
 * @param kpiName            - Human-readable KPI name
 * @param activityNames      - Names of activities contributing to this KPI
 * @param kraTitle           - Title of the parent KRA
 * @param actualValue        - Achieved value
 * @param targetValue        - Target value
 * @param achievementPercent - Percentage achievement (0-100+)
 * @returns A {@link PrescriptiveRecommendation} tailored to both type and domain
 */
export function generateContextAwareRecommendation(
  kpiType: RawKpiType | undefined | null,
  kpiName: string,
  activityNames: string[],
  kraTitle: string,
  actualValue: number,
  targetValue: number,
  achievementPercent: number
): PrescriptiveRecommendation {
  const category = getKpiTypeCategory(kpiType);
  const domainContext = inferDomainContext(activityNames, kpiName, kraTitle);
  const gap = targetValue - actualValue;
  const halfGap = Math.ceil(gap * 0.5);

  // Helper to interpolate simple placeholders in templates
  const interpolate = (template: string): string =>
    template
      .replace(/\{gap\}/g, String(gap))
      .replace(/\{halfGap\}/g, String(halfGap))
      .replace(/\{kpiName\}/g, kpiName)
      .replace(/\{actualValue\}/g, String(actualValue))
      .replace(/\{targetValue\}/g, String(targetValue))
      .replace(/\{achievementPercent\}/g, achievementPercent.toFixed(1));

  // Look up the domain-specific template; fall back to GENERAL then to legacy
  const categoryTemplates = CONTEXT_RECOMMENDATIONS[category];
  const template =
    categoryTemplates?.[domainContext.domain] ?? categoryTemplates?.GENERAL;

  if (template) {
    // Build the issue string that describes the gap in domain-appropriate terms
    let issue: string;
    switch (category) {
      case 'VOLUME':
        issue = `${kpiName} shows a quantity deficit in the ${domainContext.domainLabel} domain: ${actualValue} achieved vs ${targetValue} target (${achievementPercent.toFixed(1)}% achievement). Need ${gap} more outputs.`;
        break;
      case 'EFFICIENCY':
        issue = `${kpiName} indicates a quality/conversion gap in ${domainContext.domainLabel}: ${actualValue}% achieved vs ${targetValue}% target. This reflects actual performance, not a reporting issue.`;
        break;
      case 'MILESTONE':
        issue = `${kpiName} milestone in ${domainContext.domainLabel} is incomplete or delayed. Administrative intervention required to unblock progress.`;
        break;
      case 'PERFORMANCE':
        issue = `${kpiName} shows a satisfaction/standard deficit in ${domainContext.domainLabel}: ${actualValue} vs ${targetValue} target. Root cause investigation needed.`;
        break;
      default:
        issue = `${kpiName} is at ${achievementPercent.toFixed(1)}% achievement (${actualValue} vs ${targetValue} target) in ${domainContext.domainLabel}.`;
        break;
    }

    return {
      title: template.title,
      issue,
      action: interpolate(template.actionTemplate),
      nextStep: interpolate(template.nextStepTemplate),
      kpiType: category,
    };
  }

  // No domain-specific template found - fall back to the legacy function
  return generateTypeAwareRecommendation(
    kpiType,
    kpiName,
    actualValue,
    targetValue,
    achievementPercent
  );
}

// =========================================================================
// Context-Aware Prompt Enrichment for LLM
// =========================================================================

/**
 * Generate a text block that can be injected into an LLM prompt to give it
 * domain context so that its recommendations use the right operational language
 * for the specific KPI domain at LSPU.
 *
 * @param activityNames - Array of activity/task names
 * @param kpiName       - Optional KPI name
 * @param kraTitle      - Optional KRA title
 * @returns A formatted string block suitable for prompt injection
 */
export function buildContextAwarePromptEnrichment(
  activityNames: string[],
  kpiName?: string,
  kraTitle?: string
): string {
  const ctx = inferDomainContext(activityNames, kpiName, kraTitle);

  // Include top activity names so the LLM can reference specific programs
  const topActivities = activityNames.slice(0, 5);
  const activitySample = topActivities.length > 0
    ? `\nKey activities in this report: ${topActivities.map(a => `"${a}"`).join(', ')}${activityNames.length > 5 ? ` (and ${activityNames.length - 5} more)` : ''}`
    : '';

  return `
[DOMAIN CONTEXT]
Inferred domain: ${ctx.domainLabel}
Context clues: ${ctx.contextClues.join(', ')}${activitySample}
Recommendation framework: ${ctx.recommendationFramework}

IMPORTANT: Your recommendations MUST be appropriate for this specific domain context.
Do NOT use generic manufacturing/sales/production language for academic or IT contexts.
Tailor your language and recommendations to the specific operational reality of ${ctx.domainLabel} at a state university (LSPU).
`;
}
