'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { Loader2, CheckCircle, XCircle, Edit2, Target, Lightbulb, ArrowLeft, ArrowRight } from 'lucide-react';
import AuthService from '@/lib/services/auth-service';
import strategicPlan from '@/lib/data/strategic_plan.json';
import { Badge } from '@/components/ui/badge';
import { ActivityCardRedesigned } from '@/components/qpro/activity-card-redesigned';
import { computeAggregatedAchievement, getInitiativeTargetMeta, normalizeKraId } from '@/lib/utils/qpro-aggregation';

// Interface for structured prescriptive analysis items
interface PrescriptiveItem {
  title: string;
  issue: string;
  action: string;
  nextStep?: string;
  relatedKpiId?: string;
  responsibleOffice?: string;
  priority?: 'HIGH' | 'MEDIUM' | 'LOW';
  authorizedStrategy?: string;
  timeframe?: string;
}

// Parse prescriptive text into structured items (same as qpro-analysis-detail.tsx)
function parsePrescriptiveTextToItems(text: string): PrescriptiveItem[] {
  if (typeof text !== 'string') return [];
  const raw = text.replace(/\r\n/g, '\n').trim();
  if (!raw) return [];

  const lines = raw.split('\n');
  const items: PrescriptiveItem[] = [];
  let current: Partial<PrescriptiveItem> | null = null;

  const pushCurrent = () => {
    if (!current) return;
    const title = String(current.title || '').trim();
    const issue = String(current.issue || '').trim();
    const action = String(current.action || '').trim();
    const nextStep = current.nextStep ? String(current.nextStep).trim() : undefined;
    if (title && issue && action) items.push({ title, issue, action, nextStep });
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const headerMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (headerMatch) {
      pushCurrent();
      current = { title: headerMatch[1].trim() };
      continue;
    }

    const fieldMatch = trimmed.match(/^(?:-\s*)?(Issue|Action|Next\s*Step)\s*:\s*(.*)$/i);
    if (fieldMatch && current) {
      const key = fieldMatch[1].toLowerCase().replace(/\s+/g, '');
      const value = fieldMatch[2].trim();
      if (key === 'issue') current.issue = value;
      if (key === 'action') current.action = value;
      if (key === 'nextstep') current.nextStep = value;
      continue;
    }
  }

  pushCurrent();
  return items;
}

// Format markdown text by removing raw markdown characters (same as qpro-analysis-detail.tsx)
function formatMarkdownText(text: any): string {
  if (!text) return '';
  
  if (typeof text !== 'string') {
    if (Array.isArray(text)) {
      return text.map((item: any) => formatMarkdownText(item)).join('\n');
    }
    if (typeof text === 'object') {
      if (text.action) {
        return `${text.action}${text.timeline ? ` (${text.timeline})` : ''}`;
      }
      if (text.recommendation) {
        return text.recommendation;
      }
      try {
        return JSON.stringify(text);
      } catch {
        return String(text);
      }
    }
    return String(text);
  }
  
  let formatted = text;
  
  try {
    const parsed = JSON.parse(formatted);
    if (Array.isArray(parsed)) {
      return parsed.map((item: any) => {
        if (typeof item === 'string') return item;
        if (item?.action) return item.action;
        if (item?.recommendation) return item.recommendation;
        return String(item);
      }).join('\n• ');
    }
    if (typeof parsed === 'object' && parsed !== null) {
      if (parsed.action) return parsed.action;
      if (parsed.recommendation) return parsed.recommendation;
    }
  } catch {
    // Not JSON, continue with string processing
  }
  
  formatted = formatted.replace(/^#{1,3}\s+/gm, '');
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '$1');
  formatted = formatted.replace(/\*([^*]+)\*/g, '$1');
  formatted = formatted.replace(/^\["|"\]$/g, '');
  formatted = formatted.replace(/","/g, ', ');
  
  return formatted.trim();
}

// Render formatted text with proper list formatting (same as qpro-analysis-detail.tsx)
function renderFormattedText(text: string): React.ReactNode {
  if (!text) return null;
  
  const lines = text.split('\n').filter(line => line.trim());
  
  const elements: React.ReactNode[] = [];
  let currentList: string[] = [];
  let listType: 'bullet' | 'numbered' | null = null;
  
  const flushList = () => {
    if (currentList.length > 0) {
      if (listType === 'numbered') {
        elements.push(
          <ol key={`ol-${elements.length}`} className="list-decimal list-inside space-y-1 ml-2">
            {currentList.map((item, idx) => (
              <li key={idx}>{formatMarkdownText(item)}</li>
            ))}
          </ol>
        );
      } else {
        elements.push(
          <ul key={`ul-${elements.length}`} className="list-disc list-inside space-y-1 ml-2">
            {currentList.map((item, idx) => (
              <li key={idx}>{formatMarkdownText(item)}</li>
            ))}
          </ul>
        );
      }
      currentList = [];
      listType = null;
    }
  };
  
  lines.forEach((line, idx) => {
    const trimmedLine = line.trim();
    
    if (trimmedLine.startsWith('###') || trimmedLine.startsWith('##') || trimmedLine.startsWith('#')) {
      flushList();
      const headerText = trimmedLine.replace(/^#{1,3}\s+/, '');
      elements.push(
        <p key={`h-${idx}`} className="font-semibold mt-3 first:mt-0">{formatMarkdownText(headerText)}</p>
      );
      return;
    }
    
    const numberedMatch = trimmedLine.match(/^\d+\.\s+(.+)/);
    if (numberedMatch) {
      if (listType !== 'numbered') {
        flushList();
        listType = 'numbered';
      }
      currentList.push(numberedMatch[1]);
      return;
    }
    
    const bulletMatch = trimmedLine.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      if (listType !== 'bullet') {
        flushList();
        listType = 'bullet';
      }
      currentList.push(bulletMatch[1]);
      return;
    }
    
    flushList();
    if (trimmedLine) {
      elements.push(
        <p key={`p-${idx}`} className="mb-2 last:mb-0">{formatMarkdownText(trimmedLine)}</p>
      );
    }
  });
  
  flushList();
  
  return <div className="space-y-2">{elements}</div>;
}

// Extract prescriptive value from various data structures
function extractPrescriptiveValue(data: any): string | null {
  if (!data) return null;
  if (typeof data === 'string') return data;
  
  if (typeof data === 'object') {
    if (data.recommendations || data.content || data.analysis || data.text) {
      return data.recommendations || data.content || data.analysis || data.text;
    }
    
    const keys = Object.keys(data);
    if (keys.length === 0) return null;
    
    const valueKey = keys.find(k => k.length > 1) || keys[0];
    const value = data[valueKey];
    
    if (typeof value === 'object' && value !== null) {
      if (value.recommendations || value.content || value.analysis) {
        return value.recommendations || value.content || value.analysis;
      }
      return JSON.stringify(value);
    }
    
    return String(value);
  }
  
  return null;
}

// KRA keywords for mismatch detection
const KRA_KEYWORDS: { [key: string]: string[] } = {
  'KRA 1': ['curriculum', 'curricula', 'course', 'program design'],
  'KRA 2': ['market', 'industry', 'demand'],
  'KRA 3': ['instruction', 'teaching', 'learning', 'quality', 'student', 'employment', 'graduate'],
  'KRA 4': ['international', 'mou', 'moa', 'global', 'linkage'],
  'KRA 5': ['research', 'publication', 'innovation'],
  'KRA 6': ['research linkage', 'collaboration', 'partnership'],
  'KRA 7': ['research resources', 'funding', 'laboratory'],
  'KRA 8': ['community', 'outreach', 'service'],
  'KRA 11': ['human resources', 'faculty', 'staff'],
  'KRA 12': ['international', 'global', 'stakeholder'],
  'KRA 13': ['competitive', 'human resources'],
  'KRA 14': ['satisfaction', 'satisfaction rating'],
  'KRA 18': ['risk', 'compliance'],
  'KRA 19': ['revenue', 'operational', 'efficiency'],
  'KRA 22': ['financial', 'resources', 'budget'],
};

// Available KRAs for manual mapping (from LSPU Strategic Plan)
const AVAILABLE_KRAS = [
  { id: 'KRA 1', title: 'Development of New Curricula Incorporating Emerging Technologies' },
  { id: 'KRA 2', title: 'Market-Driven Program Design and Implementation' },
  { id: 'KRA 3', title: 'Quality and Relevance of Instruction' },
  { id: 'KRA 4', title: 'College and Office International Activities and Projects' },
  { id: 'KRA 5', title: 'Research, Extension, and Innovation Productivity' },
  { id: 'KRA 6', title: 'Research, Extension, and Innovation Linkages' },
  { id: 'KRA 7', title: 'Research, Extension, and Innovation Resources' },
  { id: 'KRA 8', title: 'Service to the Community' },
  { id: 'KRA 9', title: 'Implementation of Sustainable Governance' },
  { id: 'KRA 10', title: 'Transforming into Green University' },
  { id: 'KRA 11', title: 'Judicious Management of Human Resources' },
  { id: 'KRA 12', title: 'Internationalized/Global University Stakeholders' },
  { id: 'KRA 13', title: 'Competitive Human Resources' },
  { id: 'KRA 14', title: 'Improved Satisfaction Rating of the Students, Faculty, and Personnel of the University' },
  { id: 'KRA 15', title: 'Certification and Compliance to Regulatory Requirements' },
  { id: 'KRA 16', title: 'Updating of Learning Materials and Facilities' },
  { id: 'KRA 17', title: 'Digital Transformation and Smart Campus Enablement' },
  { id: 'KRA 18', title: 'Risk Management and Compliance' },
  { id: 'KRA 19', title: 'Revenue Growth and Operational Efficiency' },
  { id: 'KRA 20', title: 'Related IGP Industry Engagement' },
  { id: 'KRA 21', title: 'Responsive Management of Resources' },
  { id: 'KRA 22', title: 'Management of Financial Resources' },
];

interface Activity {
  name: string;
  kraId: string;
  initiativeId?: string;
  reported: number;
  target: number;
  achievement: number;
  status: 'MET' | 'MISSED';
  authorizedStrategy?: string;
  evidenceSnippet?: string;
  confidence: number;
  confidenceScore?: number;
  prescriptiveNote?: string;
  prescriptiveAnalysis?: string;
  rootCause?: string;
  aiInsight?: string;
}

interface ReviewModalProps {
  isOpen?: boolean;
  onClose: () => void;
  analysisId: string;
  onApprove?: () => void;
  onReject?: () => void;
  forceFullPage?: boolean;
}

export default function ReviewQProModal({
  isOpen,
  onClose,
  analysisId,
  onApprove,
  onReject,
  forceFullPage = false,
}: ReviewModalProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [editedActivities, setEditedActivities] = useState<Activity[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [changedKRAIndices, setChangedKRAIndices] = useState<Set<number>>(new Set());
  const [mismatches, setMismatches] = useState<{ [key: number]: boolean }>({});
  const [kraValidationErrors, setKraValidationErrors] = useState<{ [key: number]: string }>({});
  const [kpiValidationErrors, setKpiValidationErrors] = useState<{ [key: number]: string }>({});
  const [currentProgress, setCurrentProgress] = useState<Map<string, { current: number; target: number }>>(new Map());
  const [isAlreadyApproved, setIsAlreadyApproved] = useState(false);
  const [reviewStep, setReviewStep] = useState<'ASSIGN' | 'INSIGHTS'>('ASSIGN');

  // Fetch current KPI progress to show cumulative achievement
  useEffect(() => {
    if (!analysisId || (!isOpen && !forceFullPage)) return;

    const fetchCurrentProgress = async () => {
      try {
        const token = await AuthService.getAccessToken();
        
        // First get the analysis to know which KPIs are involved
        const analysisRes = await fetch(`/api/qpro/analyses/${analysisId}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (!analysisRes.ok) return;
        
        const analysisData = await analysisRes.json();
        const activities = analysisData.activities || [];
        
        // Get unique KRA IDs from activities
        const kraIds = Array.from(new Set(
          activities
            .map((a: any) => a.kraId)
            .filter(Boolean)
        ));
        
        // Fetch progress for each KRA
        const progressMap = new Map<string, { current: number; target: number }>();
        
        for (const kraId of kraIds) {
          const year = analysisData.year || new Date().getFullYear();
          const progressRes = await fetch(
            `/api/kpi-progress?kraId=${encodeURIComponent(kraId as string)}&year=${year}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          
          if (progressRes.ok) {
            const progressData = await progressRes.json();
            const kraProgress = progressData.data;
            
            // Store current progress for each initiative
            if (kraProgress?.initiatives) {
              for (const initiative of kraProgress.initiatives) {
                // Sum all quarters for the year
                const yearProgress = initiative.progress
                  ?.filter((p: any) => p.year === year)
                  .reduce((sum: number, p: any) => {
                    const val = typeof p.currentValue === 'number' 
                      ? p.currentValue 
                      : parseFloat(String(p.currentValue)) || 0;
                    return sum + val;
                  }, 0) || 0;
                
                // Get target from first quarter (they should all have same annual target)
                const firstQuarter = initiative.progress?.find((p: any) => p.year === year);
                const target = firstQuarter?.targetValue || 0;
                
                progressMap.set(initiative.id, {
                  current: yearProgress,
                  target: typeof target === 'number' ? target : parseFloat(String(target)) || 0
                });
              }
            }
          }
        }
        
        setCurrentProgress(progressMap);
      } catch (err) {
        console.error('Error fetching current progress:', err);
      }
    };

    fetchCurrentProgress();
  }, [analysisId, isOpen, forceFullPage]);

  useEffect(() => {
    if (analysisId && (isOpen || forceFullPage)) {
      fetchAnalysis();
    }
  }, [analysisId, isOpen, forceFullPage]);

  // Helper to extract flat activities array from API response
  const extractActivitiesFromResponse = (data: any): Activity[] => {
    // Check if activities are directly available
    if (data.activities && Array.isArray(data.activities) && data.activities.length > 0) {
      return data.activities.map((act: any) => ({
        name: act.name || act.title || 'Unnamed Activity',
        kraId: act.kraId || act.kra_id || '',
        initiativeId: act.initiativeId || act.initiative_id || '',
        reported: Number(act.reported) || 0,
        target: Number(act.target) || 0,
        achievement: Number(act.achievement) || 0,
        status: act.status === 'MET' ? 'MET' : 'MISSED',
        authorizedStrategy: act.authorizedStrategy || '',
        evidenceSnippet: act.evidenceSnippet || '',
        confidence: Number(act.confidence) || 0.75,
        confidenceScore: Number(act.confidenceScore) || Number(act.confidence) || 0.75,
        prescriptiveNote: act.prescriptiveNote || '',
        prescriptiveAnalysis: act.prescriptiveAnalysis || '',
        rootCause: act.rootCause || '',
        aiInsight: act.aiInsight || '',
      }));
    }

    // Extract from organizedActivities (nested KRA → activities structure)
    if (data.organizedActivities && Array.isArray(data.organizedActivities)) {
      const flatActivities: Activity[] = [];
      data.organizedActivities.forEach((kraGroup: any) => {
        const kraId = kraGroup.kraId || '';
        const kpiId = kraGroup.kpiId || '';
        if (kraGroup.activities && Array.isArray(kraGroup.activities)) {
          kraGroup.activities.forEach((act: any) => {
            flatActivities.push({
              name: act.title || act.name || 'Unnamed Activity',
              kraId: kraId,
              initiativeId: act.initiativeId || kpiId || '',
              reported: Number(act.reported) || 0,
              target: Number(act.target) || 0,
              achievement: Number(act.achievement) || 0,
              status: act.status === 'MET' || (Number(act.achievement) >= 100) ? 'MET' : 'MISSED',
              authorizedStrategy: act.authorizedStrategy || '',
              evidenceSnippet: act.evidenceSnippet || act.description || '',
              confidence: Number(act.confidence) || 0.75,
              confidenceScore: Number(act.confidenceScore) || Number(act.confidence) || 0.75,
              prescriptiveNote: act.prescriptiveNote || '',
              prescriptiveAnalysis: act.prescriptiveAnalysis || '',
              rootCause: act.rootCause || '',
              aiInsight: act.aiInsight || '',
            });
          });
        }
      });
      return flatActivities;
    }

    return [];
  };

  const fetchAnalysis = async () => {
    try {
      setIsLoading(true);
      const token = await AuthService.getAccessToken();
      const response = await fetch(`/api/qpro/analyses/${analysisId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('Failed to fetch analysis');
      const data = await response.json();
      setAnalysis(data);

      // Check if analysis is already approved
      if (data.status === 'APPROVED') {
        setIsAlreadyApproved(true);
      }

      // Detect if insights have already been generated
      const prescriptiveData = data.prescriptiveAnalysis;
      const insightsExist = prescriptiveData
        && typeof prescriptiveData === 'object'
        && prescriptiveData.source !== 'pending'
        && prescriptiveData.generatedAt !== null;
      if (insightsExist || data.status === 'APPROVED') {
        setReviewStep('INSIGHTS');
      } else {
        setReviewStep('ASSIGN');
      }
      
      // Extract activities from the response (handles both flat and nested structures)
      const activities = extractActivitiesFromResponse(data);
      setEditedActivities(activities);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  const getInitiativesForKRA = (kraId: string) => {
    const kra = strategicPlan.kras.find((k: any) => k.kra_id === kraId);
    if (!kra?.initiatives) return [];
    const currentYear = Number(analysis?.year) || new Date().getFullYear();
    return kra.initiatives.map((i: any) => {
      // Get target for current year from timeline_data
      const timelineData = i.targets?.timeline_data;
      const yearTarget = timelineData?.find((t: any) => t.year === currentYear);
      const targetValue = yearTarget ? parseFloat(yearTarget.target_value) : undefined;
      
      return {
        ...i,
        title: i.key_performance_indicator?.outputs || i.key_performance_indicator?.outcomes || i.description || i.id,
        target: targetValue,
        targetType: i.targets?.type || 'count',
      };
    });
  };

  const findInitiative = (kraId: string, initiativeId?: string) => {
    if (!initiativeId) return null;
    const initiatives = getInitiativesForKRA(kraId);
    return initiatives.find((i: any) => i.id === initiativeId);
  };

  const getTargetFromTimelineForYear = (timelineData: any[] | undefined, year: number) => {
    if (!timelineData) return null;
    const target = timelineData.find((t: any) => t.year === year);
    return target ? parseFloat(target.target_value) : null;
  };

  const handleActivityChange = (index: number, field: keyof Activity, value: any) => {
    const updated = [...editedActivities];
    updated[index] = { ...updated[index], [field]: value };
    
    if (field === 'reported' || field === 'target') {
      const reported = field === 'reported' ? value : updated[index].reported;
      const target = field === 'target' ? value : updated[index].target;
      if (target > 0) {
        updated[index].achievement = (reported / target) * 100;
        updated[index].status = updated[index].achievement >= 100 ? 'MET' : 'MISSED';
      } else {
        updated[index].achievement = 0;
      }
    }
    setEditedActivities(updated);
  };

  const handleKRAChange = (index: number, kraId: string) => {
    const updated = [...editedActivities];
    updated[index] = { ...updated[index], kraId, initiativeId: undefined };
    setEditedActivities(updated);
    
    const newChanged = new Set(changedKRAIndices);
    newChanged.add(index);
    setChangedKRAIndices(newChanged);
    
    // Check for mismatch
    const keywords = KRA_KEYWORDS[kraId] || [];
    const activityName = updated[index].name.toLowerCase();
    const isMismatch = !keywords.some(k => activityName.includes(k));
    setMismatches(prev => ({ ...prev, [index]: isMismatch }));
  };

  const handleKPIChange = (index: number, kpiId: string) => {
    const updated = [...editedActivities];
    updated[index] = { ...updated[index], initiativeId: kpiId };
    
    // Auto-set target if available
    const year = Number(analysis?.year) || new Date().getFullYear();
    const kpi = findInitiative(updated[index].kraId, kpiId);
    const target = getTargetFromTimelineForYear(kpi?.targets?.timeline_data, year);
    
    if (target !== null) {
      updated[index].target = target;
      if (target > 0) {
        updated[index].achievement = (updated[index].reported / target) * 100;
        updated[index].status = updated[index].achievement >= 100 ? 'MET' : 'MISSED';
      }
    }
    
    setEditedActivities(updated);
  };

  const handleDeleteActivity = (index: number) => {
    const updated = editedActivities.filter((_, i) => i !== index);
    setEditedActivities(updated);
  };

  const validateKRAAssignments = () => {
    const errors: { [key: number]: string } = {};
    editedActivities.forEach((act, idx) => {
      if (!act.kraId) errors[idx] = 'KRA is required';
    });
    setKraValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const validateKPISelections = () => {
    const errors: { [key: number]: string } = {};
    editedActivities.forEach((act, idx) => {
      if (changedKRAIndices.has(idx) && !act.initiativeId) {
        errors[idx] = 'KPI is required for changed KRA';
      }
    });
    setKpiValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Helper to safely extract text from various data structures
  const safeExtractText = (val: any): string | null => {
    if (!val) return null;
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) {
      // If array of objects with title/action/issue fields, format nicely
      return val.map((item, idx) => {
        if (typeof item === 'string') return `${idx + 1}. ${item}`;
        if (typeof item === 'object') {
          const title = item.title || item.issue || item.name || '';
          const action = item.action || item.nextStep || item.recommendation || '';
          if (title && action) return `**${title}**: ${action}`;
          if (title) return `- ${title}`;
          if (action) return `- ${action}`;
          // Fallback: show key fields
          const keys = Object.keys(item).filter(k => typeof item[k] === 'string');
          return keys.map(k => `- **${k}**: ${item[k]}`).join('\n');
        }
        return String(item);
      }).join('\n\n');
    }
    if (typeof val === 'object') {
      // Handle nested object with common fields
      const parts: string[] = [];
      if (val.documentInsight) parts.push(safeExtractText(val.documentInsight) || '');
      if (val.prescriptiveAnalysis) parts.push(safeExtractText(val.prescriptiveAnalysis) || '');
      if (val.summary) parts.push(safeExtractText(val.summary) || '');
      if (val.recommendations) parts.push(safeExtractText(val.recommendations) || '');
      if (val.prescriptiveItems) parts.push(safeExtractText(val.prescriptiveItems) || '');
      if (parts.length > 0) return parts.filter(Boolean).join('\n\n');
      // Fallback: iterate object keys
      const entries = Object.entries(val).filter(([, v]) => v && typeof v === 'string');
      if (entries.length > 0) {
        return entries.map(([k, v]) => `**${k}**: ${v}`).join('\n\n');
      }
    }
    return null;
  };

  const extractDocumentLevelInsight = (analysisData: any): string | null => {
    if (!analysisData) return null;
    const val = analysisData.aiInsight || analysisData.documentInsight;
    return safeExtractText(val);
  };

  const extractDocumentLevelPrescriptive = (analysisData: any): string | null => {
    if (!analysisData) return null;
    const val = analysisData.prescriptiveAnalysis;
    return safeExtractText(val);
  };

  // Regenerate insights for activities with changed KRAs
  const handleRegenerateInsights = async () => {
    if (changedKRAIndices.size === 0) {
      setError('No KRA changes to regenerate');
      return;
    }

    if (!validateKPISelections()) {
      setError('Please select the correct KPI for each changed activity before regenerating.');
      return;
    }

    try {
      setIsRegenerating(true);
      setError(null);
      
      // Show toast notification that regeneration has started
      toast({
        title: 'Regenerating Insights',
        description: 'Analyzing KPI types and generating fresh recommendations...',
        duration: 3000,
      });

      const token = await AuthService.getAccessToken();
      if (!token) {
        throw new Error('Authentication required');
      }

      // Get activities with changed KRAs
      const activitiesToRegenerate = editedActivities
        .map((act, idx) => ({
          ...act,
          index: idx,
          // When reviewer regenerates from this screen, treat KPI as explicitly selected.
          // This prevents the regenerate endpoint from overriding initiativeId via LLM matching.
          userSelectedKPI: true,
        }))
        .filter((act) => changedKRAIndices.has(act.index));

      // Call API to regenerate insights based on new KRAs
      const response = await fetch(`/api/qpro/regenerate-insights`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          analysisId,
          activities: activitiesToRegenerate,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || 'Failed to regenerate insights'
        );
      }

      const regeneratedData = await response.json();

      // CRITICAL FIX: After successful regeneration, refetch the complete analysis from the database
      // to ensure we have the latest data including any server-side computed fields.
      // This prevents stale data issues when user corrects KPI/KRA classifications.
      console.log('[ReviewQProModal] Regeneration successful, refetching fresh analysis data...');
      
      // First, update with regenerated data immediately for responsiveness
      setAnalysis((prev: any) => ({
        ...(prev || {}),
        ...regeneratedData,
        // Mark as freshly regenerated
        _regeneratedAt: new Date().toISOString(),
      }));

      // Update activities with new insights from response
      setEditedActivities((prev) => {
        const updated = [...prev];
        regeneratedData.activities.forEach((regenerated: Activity) => {
          const origIndex = activitiesToRegenerate.find(
            (a) => a.name === regenerated.name
          )?.index;
          if (origIndex !== undefined) {
            updated[origIndex] = {
              ...updated[origIndex],
              ...regenerated,
            };
          }
        });
        return updated;
      });

      // Then, refetch the complete analysis to ensure all computed fields are fresh
      // This double-fetch ensures we pick up any server-side computed fields we may have missed
      try {
        const refetchResponse = await fetch(`/api/qpro/analyses/${analysisId}`, {
          headers: { Authorization: `Bearer ${token}` },
          // Add cache-busting to ensure we get fresh data
          cache: 'no-store',
        });
        if (refetchResponse.ok) {
          const freshData = await refetchResponse.json();
          console.log('[ReviewQProModal] Fresh analysis data retrieved after regeneration');
          
          // Update analysis with fresh data from DB, preserving any local edits
          setAnalysis((prev: any) => ({
            ...(prev || {}),
            ...freshData,
            // Preserve the prescriptiveAnalysis from regeneration if freshData doesn't have it
            prescriptiveAnalysis: freshData.prescriptiveAnalysis || regeneratedData.prescriptiveAnalysis || prev?.prescriptiveAnalysis,
          }));
          
          // Re-extract activities from fresh data to ensure consistency
          const freshActivities = extractActivitiesFromResponse(freshData);
          if (freshActivities.length > 0) {
            setEditedActivities(freshActivities);
          }
        }
      } catch (refetchError) {
        // Non-fatal: we already have regenerated data, just log the error
        console.warn('[ReviewQProModal] Could not refetch fresh data after regeneration:', refetchError);
      }

      // Clear the changed KRA indices since we've regenerated
      setChangedKRAIndices(new Set());
      
      setError(null);
      
      // Show prominent success notification
      toast({
        title: '✓ Success - Insights Regenerated',
        description: `${activitiesToRegenerate.length} ${activitiesToRegenerate.length === 1 ? 'activity' : 'activities'} updated with fresh AI analysis and corrected KPI classifications.`,
        duration: 5000,
        className: 'bg-green-50 border-green-200',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate insights');
    } finally {
      setIsRegenerating(false);
    }
  };

  // Handle approve
  const handleApprove = async () => {
    try {
      setIsApproving(true);
      setError(null);
      
      // Validate all KRAs are assigned before approval
      if (!validateKRAAssignments()) {
        setError('Please assign a KRA to all activities before approval');
        setIsApproving(false);
        return;
      }

      // If any activity was reclassified, enforce KPI selection under the corrected KRA
      if (!validateKPISelections()) {
        setError('Please select the correct KPI under the corrected KRA before approval');
        setIsApproving(false);
        return;
      }

      const token = await AuthService.getAccessToken();
      if (!token) {
        throw new Error('Authentication required');
      }

      // CRITICAL: First update activities with edits - must succeed before approval
      console.log('[ReviewModal] Saving activity edits before approval...');
      const updateResponse = await fetch(`/api/qpro/analyses/${analysisId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          activities: editedActivities,
        }),
      });

      if (!updateResponse.ok) {
        const updateError = await updateResponse.json().catch(() => ({}));
        throw new Error(updateError.error || 'Failed to save activity edits. Please try again.');
      }

      console.log('[ReviewModal] Activity edits saved successfully, proceeding with approval...');

      // Then approve - this will use the updated activities from the database
      const response = await fetch(`/api/qpro/approve/${analysisId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to approve analysis');
      }

      console.log('[ReviewModal] Analysis approved successfully');
      console.log('[ReviewModal] Calling onApprove callback to trigger page reload...');
      onApprove?.();
      // Note: Don't call onClose() here as the page will reload anyway
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve');
    } finally {
      setIsApproving(false);
    }
  };

  // Handle reject
  const handleReject = async () => {
    try {
      setIsRejecting(true);
      setError(null);

      const token = await AuthService.getAccessToken();
      if (!token) {
        throw new Error('Authentication required');
      }

      const response = await fetch(`/api/qpro/approve/${analysisId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          reason: 'Rejected after review',
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to reject analysis');
      }

      onReject?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject');
    } finally {
      setIsRejecting(false);
    }
  };

  // Confirm KRA/KPI assignments and generate insights (Step 1 -> Step 2 transition)
  const handleConfirmAndGenerate = async () => {
    try {
      setIsRegenerating(true);
      setError(null);

      const token = await AuthService.getAccessToken();
      if (!token) throw new Error('Authentication required');

      // Send ALL activities for fresh insight generation
      const allActivities = editedActivities.map((act, idx) => ({
        ...act,
        index: idx,
        userSelectedKPI: true, // User has confirmed all assignments
      }));

      const response = await fetch(`/api/qpro/regenerate-insights`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          analysisId,
          activities: allActivities,
          fullRegeneration: true,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to generate insights');
      }

      const regeneratedData = await response.json();

      // Update analysis state with fresh insights
      setAnalysis((prev: any) => ({
        ...(prev || {}),
        ...regeneratedData,
        _regeneratedAt: new Date().toISOString(),
      }));

      // Update activities with recalculated targets/achievements
      if (regeneratedData.activities?.length > 0) {
        setEditedActivities((prev) => {
          const updated = [...prev];
          regeneratedData.activities.forEach((regenerated: Activity) => {
            const origIndex = allActivities.find(
              (a) => a.name === regenerated.name
            )?.index;
            if (origIndex !== undefined) {
              updated[origIndex] = {
                ...updated[origIndex],
                ...regenerated,
              };
            }
          });
          return updated;
        });
      }

      // Transition to insights step
      setReviewStep('INSIGHTS');
      setChangedKRAIndices(new Set());

      toast({
        title: 'Insights Generated',
        description: 'Strategic analysis has been generated based on your confirmed KRA/KPI assignments.',
        duration: 5000,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate insights');
    } finally {
      setIsRegenerating(false);
    }
  };

  // Calculate summary stats using KPI-type-aware aggregation
  // This matches the backend logic in regenerate-insights endpoint
  const summaryStats = (() => {
    const activitiesWithTarget = editedActivities.filter((a) => a.target > 0);
    
    // Group activities by KRA+KPI for proper aggregation (matching backend logic)
    const groups = new Map<string, { kraId: string; initiativeId: string; activities: typeof activitiesWithTarget }>();
    
    for (const act of activitiesWithTarget) {
      const kraId = String(act.kraId || '').trim();
      const initiativeId = String(act.initiativeId || '').trim();
      if (!kraId || !initiativeId) continue;
      
      const key = `${kraId}::${initiativeId}`;
      if (!groups.has(key)) {
        groups.set(key, { kraId, initiativeId, activities: [] });
      }
      groups.get(key)!.activities.push(act);
    }
    
    // Calculate KPI-level achievements using type-aware aggregation
    const allKRAs = (strategicPlan as any).kras || [];
    const year = analysis?.year || 2025;
    
    const kpiAchievements: number[] = [];
    for (const g of groups.values()) {
      // Get target metadata from strategic plan
      const meta = getInitiativeTargetMeta({ kras: allKRAs } as any, g.kraId, g.initiativeId, year);
      
      // Fallback target value
      const fallbackTarget = typeof g.activities?.[0]?.target === 'number' 
        ? g.activities[0].target 
        : Number(g.activities?.[0]?.target || 0);
      const targetValue = meta.targetValue ?? (Number.isFinite(fallbackTarget) && fallbackTarget > 0 ? fallbackTarget : 0);
      
      // Use the same aggregation logic as backend
      const aggregated = computeAggregatedAchievement({
        targetType: meta.targetType || (g.activities?.[0] as any)?.targetType,
        targetValue,
        targetScope: meta.targetScope,
        activities: g.activities.map(a => ({ reported: a.reported, target: a.target })),
      });
      
      // Calculate cumulative achievement including current progress from already approved documents
      let cumulativeAchievement = aggregated.achievementPercent;
      
      if (g.initiativeId && currentProgress.has(g.initiativeId)) {
        const progress = currentProgress.get(g.initiativeId)!;
        const target = progress.target || targetValue || 1;
        
        // Add this document's contribution to current progress
        const newTotal = progress.current + aggregated.totalReported;
        const rawAchievement = target > 0 ? (newTotal / target) * 100 : 0;
        
        // Cap achievement at 100% - don't show excess percentage
        cumulativeAchievement = Math.min(rawAchievement, 100);
        
        console.log(`[Review] KPI ${g.initiativeId}:`);
        console.log(`  Current progress: ${progress.current}, This document adds: ${aggregated.totalReported}`);
        console.log(`  New total: ${newTotal}, Target: ${target}, Raw Achievement: ${rawAchievement.toFixed(1)}%, Displayed: ${cumulativeAchievement.toFixed(1)}%`);
      }
      
      if (cumulativeAchievement >= 0) {
        kpiAchievements.push(cumulativeAchievement);
      }
    }
    
    // Overall achievement is the average of KPI-level cumulative achievements
    const avgAchievement = kpiAchievements.length > 0
      ? kpiAchievements.reduce((sum, pct) => sum + pct, 0) / kpiAchievements.length
      : 0;
    
    // Count activities that met their targets (achievement >= 100%)
    const metCount = activitiesWithTarget.filter((a) => a.achievement >= 100).length;
    const missedCount = activitiesWithTarget.filter((a) => a.achievement < 100).length;

    return {
      totalActivities: editedActivities.length,
      metCount,
      missedCount,
      avgAchievement,
    };
  })();

  // Content component for both modal and full-page rendering
  const ReviewContent = () => (
    <>
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          <span className="ml-2 text-slate-600">Loading analysis...</span>
        </div>
      ) : error ? (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700">{error}</p>
        </div>
      ) : (
        <>
          {/* Step indicator banner */}
          {!isAlreadyApproved && (
            <div className="flex items-center gap-3 p-3 bg-slate-50 border border-slate-200 rounded-lg mb-4">
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${reviewStep === 'ASSIGN' ? 'bg-indigo-100 text-indigo-800 ring-2 ring-indigo-300' : 'bg-slate-100 text-slate-500'}`}>
                <span className="w-5 h-5 rounded-full bg-current/10 flex items-center justify-center text-[10px] font-bold">1</span>
                Review KRA/KPI Assignments
              </div>
              <ArrowRight className="w-4 h-4 text-slate-400" />
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${reviewStep === 'INSIGHTS' ? 'bg-indigo-100 text-indigo-800 ring-2 ring-indigo-300' : 'bg-slate-100 text-slate-500'}`}>
                <span className="w-5 h-5 rounded-full bg-current/10 flex items-center justify-center text-[10px] font-bold">2</span>
                Review Insights & Approve
              </div>
            </div>
          )}
          {/* Already Approved Warning Banner */}
          {isAlreadyApproved && (
            <div className="p-4 mb-4 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-amber-800 font-medium">
                Only DRAFT analyses can be edited. This analysis is already APPROVED
              </p>
            </div>
          )}
          {/* Document-Level AI Review - only shown in INSIGHTS step */}
          {reviewStep === 'INSIGHTS' && (() => {
            const documentInsight = extractDocumentLevelInsight(analysis);
            const prescriptiveRaw = extractDocumentLevelPrescriptive(analysis);

            // Extract structured prescriptive items (same logic as qpro-analysis-detail.tsx)
            const structuredItems: PrescriptiveItem[] = (() => {
              // First, try to get prescriptiveItems directly from prescriptiveAnalysis object
              const fromJson = (() => {
                if (!analysis?.prescriptiveAnalysis || typeof analysis.prescriptiveAnalysis !== 'object') return [];
                const items = (analysis.prescriptiveAnalysis as any).prescriptiveItems;
                if (!Array.isArray(items)) return [];
                return items
                  .filter((x: any) => x && typeof x === 'object')
                  .slice(0, 5)
                  .map((x: any) => ({
                    title: String(x.title || '').trim(),
                    issue: String(x.issue || '').trim(),
                    action: String(x.action || '').trim(),
                    nextStep: x.nextStep ? String(x.nextStep).trim() : undefined,
                    relatedKpiId: x.relatedKpiId ? String(x.relatedKpiId).trim() : undefined,
                    responsibleOffice: x.responsibleOffice ? String(x.responsibleOffice).trim() : undefined,
                    priority: ['HIGH', 'MEDIUM', 'LOW'].includes(x.priority) ? x.priority : undefined,
                    authorizedStrategy: x.authorizedStrategy ? String(x.authorizedStrategy).trim() : undefined,
                    timeframe: x.timeframe ? String(x.timeframe).trim() : undefined,
                  }))
                  .filter((x: any) => x.title && x.issue && x.action);
              })();

              if (fromJson.length > 0) return fromJson;
              
              // Fallback: parse the prescriptive text into structured items
              return prescriptiveRaw ? parsePrescriptiveTextToItems(prescriptiveRaw).slice(0, 5) : [];
            })();

            // Get document insight text from prescriptiveAnalysis object if available
            const documentInsightText = (() => {
              const fromJson = (analysis?.prescriptiveAnalysis && typeof analysis.prescriptiveAnalysis === 'object')
                ? (analysis.prescriptiveAnalysis as any).documentInsight
                : null;
              if (typeof fromJson === 'string' && fromJson.trim()) return fromJson.trim();
              return documentInsight || '';
            })();

            // Get prescriptive text for fallback rendering
            const prescriptiveText = (() => {
              const fromJson = (analysis?.prescriptiveAnalysis && typeof analysis.prescriptiveAnalysis === 'object')
                ? (analysis.prescriptiveAnalysis as any).prescriptiveAnalysis
                : null;
              if (typeof fromJson === 'string' && fromJson.trim()) return fromJson.trim();
              return prescriptiveRaw || '';
            })();

            const shouldShow = Boolean(documentInsightText || prescriptiveText || structuredItems.length > 0);
            if (!shouldShow) return null;

            return (
              <div className="space-y-4 mb-4">
                {/* Document Insight Section */}
                {documentInsightText && (
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <h4 className="font-semibold text-blue-900 mb-2 flex items-center gap-2 text-sm">
                      <Target className="w-4 h-4" />
                      Document Insight
                    </h4>
                    <div className="text-sm text-blue-800 prose prose-sm prose-blue max-w-none">
                      {renderFormattedText(documentInsightText)}
                    </div>
                  </div>
                )}

                {/* Prescriptive Analysis Section - Structured Format */}
                {(structuredItems.length > 0 || prescriptiveText) && (
                  <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
                    <h4 className="font-semibold text-purple-900 mb-2 flex items-center gap-2 text-sm">
                      <Lightbulb className="w-4 h-4" />
                      Prescriptive Analysis
                    </h4>
                    <div className="text-sm text-purple-800 prose prose-sm prose-purple max-w-none">
                      {structuredItems.length > 0 ? (
                        <ol className="list-decimal list-inside space-y-3">
                          {structuredItems.map((item, idx) => (
                            <li key={idx} className="">
                              <div className="inline-flex items-center gap-2">
                                <span className="font-semibold text-purple-900">{item.title}</span>
                                {item.priority && (
                                  <Badge variant={item.priority === 'HIGH' ? 'destructive' : item.priority === 'MEDIUM' ? 'default' : 'secondary'} className="text-[10px] px-1.5 py-0">
                                    {item.priority}
                                  </Badge>
                                )}
                                {item.relatedKpiId && (
                                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-purple-300 text-purple-700">
                                    {item.relatedKpiId}
                                  </Badge>
                                )}
                              </div>

                              <ul className="list-disc ml-6 mt-1 space-y-1">
                                <li>
                                  <span className="font-semibold">Issue:</span> {item.issue}
                                </li>
                                <li>
                                  <span className="font-semibold">Action:</span> {item.action}
                                </li>
                                {item.nextStep ? (
                                  <li>
                                    <span className="font-semibold">Next Step:</span> {item.nextStep}
                                  </li>
                                ) : null}
                                {item.responsibleOffice ? (
                                  <li>
                                    <span className="font-semibold">Responsible Office:</span> {item.responsibleOffice}
                                  </li>
                                ) : null}
                                {item.authorizedStrategy ? (
                                  <li>
                                    <span className="font-semibold">Strategic Plan Strategy:</span> <em>{item.authorizedStrategy}</em>
                                  </li>
                                ) : null}
                                {item.timeframe ? (
                                  <li>
                                    <span className="font-semibold">Timeframe:</span> {item.timeframe}
                                  </li>
                                ) : null}
                              </ul>
                            </li>
                          ))}
                        </ol>
                      ) : (
                        renderFormattedText(prescriptiveText)
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
          {/* Activities List - Modern Split Layout */}
          <ScrollArea className="flex-1">
            <div className="space-y-3 pr-4">
              {editedActivities.map((activity, idx) => (
                <ActivityCardRedesigned
                  key={activity.name + idx}
                  activity={activity}
                  mismatches={mismatches[idx]}
                  kraValidationError={kraValidationErrors[idx]}
                  kpiValidationError={kpiValidationErrors[idx]}
                  availableKRAs={AVAILABLE_KRAS}
                  availableKPIs={getInitiativesForKRA(activity.kraId)}
                  onKRAChange={(v) => handleKRAChange(idx, v)}
                  onKPIChange={(v) => handleKPIChange(idx, v)}
                  onReportedChange={(v) => handleActivityChange(idx, 'reported', v)}
                  onTargetChange={(v) => handleActivityChange(idx, 'target', v)}
                  onDelete={() => handleDeleteActivity(idx)}
                  kraChanged={changedKRAIndices.has(idx)}
                />
              ))}
            </div>
          </ScrollArea>
        </>
      )}
    </>
  );

  // Footer component for both modal and full-page rendering
  const ReviewFooter = () => (
    <div className={forceFullPage ? 'mt-6 gap-2 flex flex-col sm:flex-row' : 'gap-2 flex flex-col sm:flex-row'}>
      {/* Step 1 (ASSIGN): Show "Confirm & Generate Insights" button */}
      {reviewStep === 'ASSIGN' && !isAlreadyApproved && (
        <>
          {/* Info text when KRAs are changed */}
          {changedKRAIndices.size > 0 && (
            <div className="sm:col-span-2 md:col-span-3 p-3 bg-blue-50 border border-blue-200 rounded-lg mb-2 w-full">
              <p className="text-sm text-blue-700">
                <strong>{changedKRAIndices.size} activity update(s) pending.</strong> Your changes will be applied when you confirm assignments.
              </p>
            </div>
          )}

          <Button variant="outline" onClick={onClose} disabled={isRegenerating}>
            Cancel
          </Button>

          <Button
            onClick={handleConfirmAndGenerate}
            disabled={isRegenerating}
            className="bg-indigo-600 hover:bg-indigo-700"
          >
            {isRegenerating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Generating Insights...
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4 mr-2" />
                Confirm Assignments & Generate Insights
              </>
            )}
          </Button>
        </>
      )}

      {/* Step 2 (INSIGHTS): Show Back, Regenerate, Reject, Approve buttons */}
      {(reviewStep === 'INSIGHTS' || isAlreadyApproved) && (
        <>
          {/* Info text when KRAs are changed in INSIGHTS step */}
          {changedKRAIndices.size > 0 && !isAlreadyApproved && (
            <div className="sm:col-span-2 md:col-span-3 p-3 bg-blue-50 border border-blue-200 rounded-lg mb-2 w-full">
              <p className="text-sm text-blue-700">
                <strong>{changedKRAIndices.size} activity update(s) pending.</strong> Click "Regenerate Insights" to update targets and document-level AI analysis based on corrected KRA/KPI selections.
              </p>
            </div>
          )}

          {!isAlreadyApproved && (
            <Button
              variant="outline"
              onClick={() => {
                setReviewStep('ASSIGN');
                // Clear insights display when going back to make it clear they need regeneration
              }}
              disabled={isApproving || isRejecting || isRegenerating}
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Assignments
            </Button>
          )}

          <Button variant="outline" onClick={onClose} disabled={isApproving || isRejecting || isRegenerating}>
            Cancel
          </Button>

          {/* Regenerate Insights Button - visible when KRAs changed and not already approved */}
          {changedKRAIndices.size > 0 && !isAlreadyApproved && (
            <Button
              onClick={handleRegenerateInsights}
              disabled={isRegenerating || isSubmitting}
              className="bg-indigo-600 hover:bg-indigo-700"
            >
              {isRegenerating ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Edit2 className="w-4 h-4 mr-2" />
              )}
              {isRegenerating ? 'Regenerating...' : 'Regenerate Insights'}
            </Button>
          )}

          <Button
            variant="destructive"
            onClick={handleReject}
            disabled={isLoading || isApproving || isRejecting || isRegenerating || isAlreadyApproved}
          >
            {isRejecting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Rejecting...
              </>
            ) : (
              <>
                <XCircle className="w-4 h-4 mr-2" />
                Reject
              </>
            )}
          </Button>
          <Button
            onClick={handleApprove}
            disabled={isLoading || isApproving || isRejecting || isRegenerating || isAlreadyApproved}
            className="bg-green-600 hover:bg-green-700"
          >
            {isApproving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Approving...
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4 mr-2" />
                Approve & Commit
              </>
            )}
          </Button>
        </>
      )}
    </div>
  );

  // Render as full page or modal based on forceFullPage prop
  if (forceFullPage) {
    return (
      <div className="space-y-6 relative">
        <div className="flex items-center gap-2">
          <Edit2 className="w-5 h-5" />
          <h2 className="text-2xl font-bold">Review QPro Analysis</h2>
        </div>
        
        {/* Loading overlay during regeneration */}
        {isRegenerating && (
          <div className="fixed inset-0 bg-white/80 backdrop-blur-sm z-50 flex items-center justify-center">
            <div className="bg-white rounded-lg shadow-xl border-2 border-indigo-200 p-8 flex flex-col items-center gap-4 max-w-md mx-4">
              <Loader2 className="w-12 h-12 animate-spin text-indigo-600" />
              <div className="text-center">
                <p className="text-xl font-semibold text-slate-900">Regenerating Insights</p>
                <p className="text-sm text-slate-600 mt-2">
                  Analyzing KPI types and generating fresh recommendations...
                </p>
                <p className="text-xs text-slate-500 mt-2">
                  This may take a few moments.
                </p>
              </div>
            </div>
          </div>
        )}
        
        <ReviewContent />
        <ReviewFooter />
      </div>
    );
  }

  // Default: render as modal
  return (
    <Dialog
      open={!!isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="w-[95vw] h-[95vh] max-w-[1400px] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Edit2 className="w-5 h-5" />
            Review QPro Analysis
          </DialogTitle>
        </DialogHeader>

        {/* Loading overlay during regeneration */}
        {isRegenerating && (
          <div className="absolute inset-0 bg-white/80 backdrop-blur-sm z-50 flex items-center justify-center">
            <div className="bg-white rounded-lg shadow-xl border-2 border-indigo-200 p-8 flex flex-col items-center gap-4 max-w-md">
              <Loader2 className="w-12 h-12 animate-spin text-indigo-600" />
              <div className="text-center">
                <p className="text-xl font-semibold text-slate-900">Regenerating Insights</p>
                <p className="text-sm text-slate-600 mt-2">
                  Analyzing KPI types and generating fresh recommendations...
                </p>
                <p className="text-xs text-slate-500 mt-2">
                  This may take a few moments.
                </p>
              </div>
            </div>
          </div>
        )}

        <ReviewContent />

        <DialogFooter className="mt-4 gap-2 flex flex-col sm:flex-row">
          <ReviewFooter />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
