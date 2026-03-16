'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, AlertCircle, BarChart3, Lightbulb, Target, Clock, CheckCircle2, RefreshCw, TrendingUp, Activity, Users, Calendar, FolderOpen } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Cell } from 'recharts';
import { KRAClassification } from './kra-review-component';
import { Recommendation } from './recommendations-display';
import KPIDashboard, { KPIGroup, KPIActivity } from './kpi-dashboard';
import AuthService from '@/lib/services/auth-service';

// Helper function to safely render prescriptive analysis items
// Handles strings, objects with action/timeline fields, and arrays
// Renders arrays as proper bullet lists for professional formatting
function renderPrescriptiveItem(item: any): React.ReactNode {
  if (!item) return null;
  
  if (typeof item === 'string') {
    // Try to parse JSON strings
    try {
      const parsed = JSON.parse(item);
      return renderPrescriptiveItem(parsed);
    } catch {
      // Clean up markdown artifacts
      return item
        .replace(/^#{1,3}\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/^\["|"\]$/g, '')
        .trim();
    }
  }
  
  // Handle arrays - render as bullet list
  if (Array.isArray(item)) {
    if (item.length === 0) return null;
    return (
      <ul className="list-disc list-inside space-y-1 mt-1">
        {item.map((subItem, idx) => {
          let content = '';
          if (typeof subItem === 'string') {
            content = subItem.replace(/^#{1,3}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').trim();
          } else if (subItem?.action) {
            content = `${subItem.action}${subItem.timeline ? ` (${subItem.timeline})` : ''}`;
          } else if (subItem?.recommendation) {
            content = subItem.recommendation;
          } else if (typeof subItem === 'object') {
            content = JSON.stringify(subItem);
          } else {
            content = String(subItem);
          }
          return <li key={idx} className="text-sm text-slate-700">{content}</li>;
        })}
      </ul>
    );
  }
  
  if (typeof item === 'object' && item !== null) {
    if (item.action) {
      return `${item.action}${item.timeline ? ` (${item.timeline})` : ''}`;
    }
    if (item.recommendation) {
      return item.recommendation;
    }
    return JSON.stringify(item);
  }
  return String(item);
}

// Parse JSON string or array into structured action items
function parseRecommendations(value: any): Array<{action: string; timeline?: string; priority?: string}> {
  if (!value) return [];
  
  // Already an array
  if (Array.isArray(value)) {
    return value.map((item: any) => {
      if (typeof item === 'string') {
        return { action: item };
      }
      if (typeof item === 'object' && item !== null) {
        return {
          action: item.action || item.recommendation || JSON.stringify(item),
          timeline: item.timeline || item.deadline,
          priority: item.priority
        };
      }
      return { action: String(item) };
    });
  }
  
  // Try to parse as JSON string
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parseRecommendations(parsed);
    } catch {
      // Split by newlines or bullet points if plain text
      const lines = value.split(/\n|•|\.(?=\s*[A-Z])/).filter((l: string) => l.trim());
      return lines.map((line: string) => ({ action: line.trim() }));
    }
  }
  
  // Single object
  if (typeof value === 'object' && value !== null) {
    return [{
      action: value.action || value.recommendation || JSON.stringify(value),
      timeline: value.timeline,
      priority: value.priority
    }];
  }
  
  return [{ action: String(value) }];
}

// Parse and safely extract prescriptive analysis data from various formats
// Handles cases where data might be a dictionary with keys like 'a', 'b', 'c', 'd', 'KRA 1', etc.
function extractPrescriptiveValue(data: any): string | null {
  if (!data) return null;
  
  // If it's already a string, return it
  if (typeof data === 'string') return data;
  
  // If it's an object, check for common value fields
  if (typeof data === 'object') {
    // If it's a direct value object (not a wrapper dict)
    if (data.recommendations || data.content || data.analysis || data.text) {
      return data.recommendations || data.content || data.analysis || data.text;
    }
    
    // If it's a dictionary with keys, extract the first/best value
    const keys = Object.keys(data);
    if (keys.length === 0) return null;
    
    // Skip single-letter keys that might indicate a bug (a, b, c, d)
    const valueKey = keys.find(k => k.length > 1) || keys[0];
    const value = data[valueKey];
    
    // Recursively extract if the value is also an object
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

// Get priority badge color
function getPriorityColor(priority?: string): string {
  switch (priority?.toLowerCase()) {
    case 'high':
    case 'critical':
      return 'bg-red-500 text-white';
    case 'medium':
      return 'bg-amber-500 text-white';
    case 'low':
      return 'bg-blue-500 text-white';
    default:
      return 'bg-gray-500 text-white';
  }
}

// Format markdown text by removing raw markdown characters and converting to proper text
// Handles strings, objects, arrays safely - prevents "text.replace is not a function" errors
function formatMarkdownText(text: any): string {
  if (!text) return '';
  
  // Handle non-string types first
  if (typeof text !== 'string') {
    // If it's an array, join items with newlines
    if (Array.isArray(text)) {
      return text.map((item: any) => formatMarkdownText(item)).join('\n');
    }
    // If it's an object with action/recommendation field
    if (typeof text === 'object') {
      if (text.action) {
        return `${text.action}${text.timeline ? ` (${text.timeline})` : ''}`;
      }
      if (text.recommendation) {
        return text.recommendation;
      }
      // Fallback - try to stringify
      try {
        return JSON.stringify(text);
      } catch {
        return String(text);
      }
    }
    // Convert to string for other types
    return String(text);
  }
  
  // Now we know text is a string
  let formatted = text;
  
  // Try to parse JSON strings
  try {
    const parsed = JSON.parse(formatted);
    if (Array.isArray(parsed)) {
      // Return as bulleted list
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
  
  // Remove markdown headers (###, ##, #)
  formatted = formatted.replace(/^#{1,3}\s+/gm, '');
  
  // Remove bold/italic markers (**text** or *text*)
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '$1');
  formatted = formatted.replace(/\*([^*]+)\*/g, '$1');
  
  // Remove JSON array brackets and quotes
  formatted = formatted.replace(/^\["|"\]$/g, '');
  formatted = formatted.replace(/","/g, ', ');
  
  return formatted.trim();
}

// Render formatted text with proper list formatting
function renderFormattedText(text: string): React.ReactNode {
  if (!text) return null;
  
  // Split by lines
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
    
    // Check for markdown headers
    if (trimmedLine.startsWith('###') || trimmedLine.startsWith('##') || trimmedLine.startsWith('#')) {
      flushList();
      const headerText = trimmedLine.replace(/^#{1,3}\s+/, '');
      elements.push(
        <p key={`h-${idx}`} className="font-semibold mt-3 first:mt-0">{formatMarkdownText(headerText)}</p>
      );
      return;
    }
    
    // Check for numbered list items (1. 2. etc)
    const numberedMatch = trimmedLine.match(/^\d+\.\s+(.+)/);
    if (numberedMatch) {
      if (listType !== 'numbered') {
        flushList();
        listType = 'numbered';
      }
      currentList.push(numberedMatch[1]);
      return;
    }
    
    // Check for bullet items (- or *)
    const bulletMatch = trimmedLine.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      if (listType !== 'bullet') {
        flushList();
        listType = 'bullet';
      }
      currentList.push(bulletMatch[1]);
      return;
    }
    
    // Regular paragraph
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

export interface ExtractedSection {
  title: string;
  type: string;
  activities: string[];
}

export interface PrescriptiveAnalysisData {
  documentInsight?: string;
  prescriptiveAnalysis?: string;
  prescriptiveItems?: PrescriptiveItem[];
  recommendations?: string;
  root_cause?: string;
  gaps?: string;
  action_items?: string[];
  summary?: {
    year?: number;
    totalActivities?: number;
    metCount?: number;
    missedCount?: number;
    overallAchievement?: number;
  };
}

export interface PrescriptiveItem {
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

export interface OrganizedActivity {
  kraId: string;
  kraTitle: string;
  kpiId?: string;
  kpiTitle?: string;
  activities: Array<{
    title: string;
    target?: number;
    reported?: number;
    achievement?: number;
    status?: string;
    confidence?: number;
    description?: string;
    date?: string;
    unit?: string;
    aiInsight?: string;
    prescriptiveAnalysis?: string;
    rootCause?: string;
  }>;
  activityCount: number;
  completionPercentage: number;
  totalTarget?: number;
  totalReported?: number;
  status?: string;
}

export interface AchievementMetric {
  overallScore: number;
  completeness: number;
  currentState: string;
  targetState: string;
}

export interface QPROAnalysisDetail {
  id: string;
  title: string;
  extractedSections: ExtractedSection[];
  kraClassifications: KRAClassification[];
  organizedActivities: OrganizedActivity[];
  insights: string[];
  recommendations: Recommendation[];
  achievementMetrics: AchievementMetric;
  uploadedDate: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'APPROVED' | 'DRAFT';
  prescriptiveAnalysis?: PrescriptiveAnalysisData | any;
  alignment?: string;
  opportunities?: string;
  gaps?: string;
}

// Map KRA IDs to human-readable titles
const KRA_TITLES: { [key: string]: string } = {
  'KRA 1': 'Development of New Curricula',
  'KRA 2': 'Accreditation',
  'KRA 3': 'Quality and Relevance of Instruction',
  'KRA 4': 'International Activities',
  'KRA 5': 'Research Outputs',
  'KRA 6': 'Extension Programs',
  'KRA 7': 'Community Partnerships',
  'KRA 8': 'Technology Transfer',
  'KRA 9': 'Revenue Generation',
  'KRA 10': 'Resource Mobilization',
  'KRA 11': 'Human Resource Management',
  'KRA 12': 'Student Development',
  'KRA 13': 'Health and Wellness',
  'KRA 14': 'Environmental Sustainability',
  'KRA 15': 'Quality Management',
  'KRA 16': 'Governance',
  'KRA 17': 'Digital Transformation',
  'UNCLASSIFIED': 'Uncategorized Activities',
};

function getKRADisplayTitle(kraId: string, fallbackTitle?: string): string {
  return KRA_TITLES[kraId] || fallbackTitle || kraId;
}

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

interface QPROAnalysisDetailProps {
  analysisId: string;
}

export default function QPROAnalysisDetail({
  analysisId,
}: QPROAnalysisDetailProps) {
  const { toast } = useToast();
  const [analysis, setAnalysis] = useState<QPROAnalysisDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editedKRAs, setEditedKRAs] = useState<{ [key: string]: string }>({});
  const [changedActivityIds, setChangedActivityIds] = useState<Set<string>>(new Set());
  const [isRegenerating, setIsRegenerating] = useState(false);

  useEffect(() => {
    const loadAnalysis = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Get authentication token
        const token = await AuthService.getAccessToken();
        if (!token) {
          throw new Error('Authentication required. Please log in again.');
        }

        const response = await fetch(`/api/qpro/analyses/${analysisId}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to load analysis');
        }

        const data = await response.json();
        setAnalysis(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load analysis';
        setError(message);
      } finally {
        setIsLoading(false);
      }
    };

    if (analysisId) {
      loadAnalysis();
    }
  }, [analysisId]);

  // Handle KRA change for an activity
  const handleKRAChange = (activityId: string, newKraId: string) => {
    setEditedKRAs((prev) => ({
      ...prev,
      [activityId]: newKraId,
    }));
    
    setChangedActivityIds((prev) => {
      const updated = new Set(prev);
      updated.add(activityId);
      return updated;
    });
  };

  // Regenerate insights for activities with changed KRAs
  const handleRegenerateInsights = async () => {
    if (changedActivityIds.size === 0) {
      setError('No KRA changes to regenerate');
      return;
    }

    try {
      setIsRegenerating(true);
      setError(null);
      
      // Show toast notification that regeneration has started
      toast({
        title: 'Regenerating Insights',
        description: `Analyzing ${changedActivityIds.size} activities with corrected KPI types...`,
        duration: 3000,
      });

      const token = await AuthService.getAccessToken();
      if (!token) {
        throw new Error('Authentication required');
      }

      // Get activities with changed KRAs
      const activitiesToRegenerate = analysis!.organizedActivities.flatMap((org) =>
        (org.activities || []).map((act, idx) => ({
          ...act,
          name: act.title || `Activity ${idx}`,
          kraId: editedKRAs[`${org.kraId}-${idx}`] || org.kraId,
          index: idx,
        }))
      ).filter((act) => changedActivityIds.has(`${act.kraId}-${act.index}`));

      // Call API to regenerate insights
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
        throw new Error(errorData.error || 'Failed to regenerate insights');
      }

      const regeneratedData = await response.json();

      // Update analysis with new insights
      setAnalysis((prev) => {
        if (!prev) return prev;
        const updated = { ...prev };
        
        // Update activities with regenerated insights, target, achievement, and status
        regeneratedData.activities.forEach((regenerated: any) => {
          // Find and update the matching activity
          updated.organizedActivities = updated.organizedActivities.map((org) => ({
            ...org,
            activities: (org.activities || []).map((act) =>
              act.title === regenerated.name
                ? { 
                    ...act,
                    target: regenerated.target !== undefined ? regenerated.target : act.target,
                    achievement: regenerated.achievement !== undefined ? regenerated.achievement : act.achievement,
                    status: regenerated.status || act.status,
                    aiInsight: regenerated.aiInsight,
                    prescriptiveAnalysis: regenerated.prescriptiveAnalysis 
                  }
                : act
            ),
          }));
        });
        
        // Recalculate kraClassifications based on updated activities
        const kraClassificationsMap: { [key: string]: { id: string; title: string; count: number; achievements: number[] } } = {};
        
        updated.organizedActivities.forEach((org) => {
          if (!kraClassificationsMap[org.kraId]) {
            kraClassificationsMap[org.kraId] = {
              id: org.kraId,
              title: org.kraTitle,
              count: 0,
              achievements: [],
            };
          }
          
          (org.activities || []).forEach((act) => {
            kraClassificationsMap[org.kraId].count += 1;
            if (act.achievement !== undefined && act.achievement !== null) {
              kraClassificationsMap[org.kraId].achievements.push(act.achievement);
            }
          });
        });
        
        // Convert map to array and calculate achievement rates
        updated.kraClassifications = Object.values(kraClassificationsMap).map((kra) => ({
          id: kra.id,
          title: kra.title,
          count: kra.count,
          achievementRate: kra.achievements.length > 0
            ? kra.achievements.reduce((a, b) => a + b, 0) / kra.achievements.length
            : 0,
          strategicAlignment: '',
        }));
        
        return updated;
      });

      // Clear the changed activity IDs
      setChangedActivityIds(new Set());
      setEditedKRAs({});
      
      // Show success toast
      toast({
        title: 'Insights Regenerated',
        description: 'Fresh analysis generated with updated KPI classifications.',
        duration: 3000,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate insights');
    } finally {
      setIsRegenerating(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex items-start gap-3 py-6">
          <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-red-900">Failed to load analysis</p>
            <p className="text-sm text-red-700 mt-1">{error}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!analysis) {
    return (
      <Card>
        <CardContent className="text-center py-12 text-slate-600">
          No analysis data available
        </CardContent>
      </Card>
    );
  }

  if (analysis.status === 'PENDING') {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          <p className="font-medium text-slate-900">Analyzing document...</p>
          <p className="text-sm text-slate-600">
            This may take a few minutes. Please wait.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (analysis.status === 'FAILED') {
    return (
      <Card>
        <CardContent className="flex items-start gap-3 py-6">
          <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-red-900">Analysis failed</p>
            <p className="text-sm text-red-700 mt-1">
              Could not process the document. Please try again.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Convert organizedActivities to KPIGroups for the dashboard
  const kpiGroups: KPIGroup[] = analysis.organizedActivities
    .filter((org) => org.kpiId) // Only include activities with KPI data
    .map((org) => ({
      kraId: org.kraId,
      kraTitle: org.kraTitle,
      kpiId: org.kpiId || '',
      kpiTitle: org.kpiTitle || '',
      activities: (org.activities || []).map((act) => ({
        title: act.title || 'Unnamed',
        target: act.target || 0,
        reported: act.reported || 0,
        achievement: act.achievement || 0,
        status: (act.status as 'MET' | 'PARTIAL' | 'NOT_STARTED') || 'NOT_STARTED',
        confidence: act.confidence || 0.5,
      })),
      totalTarget: org.totalTarget || 0,
      totalReported: org.totalReported || 0,
      completionPercentage: org.completionPercentage || 0,
      status: (org.status as 'MET' | 'ON_TRACK' | 'PARTIAL' | 'NOT_STARTED') || 'NOT_STARTED',
    }));

  const hasKPIData = kpiGroups.length > 0;
  
  // FIX: Flatten all activities from organizedActivities for Stage 3 display
  // This ensures activities are shown even when KPI data is not available
  const allFlattenedActivities = analysis.organizedActivities.flatMap((org) => 
    (org.activities || []).map((act) => ({
      ...act,
      kraId: org.kraId,
      kraTitle: org.kraTitle,
    }))
  );
  
  // Check if we have any organized activities to show
  const hasOrganizedActivities = analysis.organizedActivities.length > 0 && allFlattenedActivities.length > 0;

  // Compute KPI completion rate from actual KPI group data (replaces hardcoded overallScore)
  const avgKpiCompletion = hasKPIData
    ? Math.round(kpiGroups.reduce((sum, k) => sum + k.completionPercentage, 0) / kpiGroups.length)
    : analysis.achievementMetrics.overallScore;

  return (
    <div className="space-y-4">

      {/* Redesigned Header Card */}
      <Card className="overflow-hidden border shadow-sm">
        <div className="bg-linear-to-r from-slate-800 to-slate-700 px-6 py-5">
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-bold text-white leading-tight truncate">
                {analysis.title}
              </h1>
              <div className="flex items-center gap-3 mt-2">
                <span className="text-slate-400 text-xs flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5" />
                  {new Date(analysis.uploadedDate).toLocaleDateString('en-US', {
                    month: 'short', day: 'numeric', year: 'numeric',
                  })}
                </span>
                <Badge className={
                  analysis.status === 'COMPLETED' || analysis.status === 'APPROVED'
                    ? 'bg-green-500 hover:bg-green-500 text-white text-xs border-0'
                    : analysis.status === 'DRAFT'
                    ? 'bg-slate-500 hover:bg-slate-500 text-white text-xs border-0'
                    : 'bg-amber-500 hover:bg-amber-500 text-white text-xs border-0'
                }>
                  {analysis.status}
                </Badge>
              </div>
            </div>
          </div>
        </div>
        <CardContent className="p-0">
          <div className="grid grid-cols-3 divide-x divide-slate-100">
            {/* KPI Completion */}
            <div className="p-5">
              <p className="text-[10px] text-slate-500 uppercase font-semibold tracking-wider">KPI Completion</p>
              <p className={`text-4xl font-bold mt-1.5 ${
                avgKpiCompletion >= 80 ? 'text-green-600' :
                avgKpiCompletion >= 50 ? 'text-amber-600' : 'text-red-600'
              }`}>
                {avgKpiCompletion}%
              </p>
              <div className="mt-2 bg-slate-100 rounded-full h-1.5 overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    avgKpiCompletion >= 80 ? 'bg-green-500' :
                    avgKpiCompletion >= 50 ? 'bg-amber-400' : 'bg-red-500'
                  }`}
                  style={{ width: `${Math.min(avgKpiCompletion, 100)}%` }}
                />
              </div>
            </div>
            {/* Data Completeness */}
            <div className="p-5">
              <p className="text-[10px] text-slate-500 uppercase font-semibold tracking-wider">Data Completeness</p>
              <p className="text-4xl font-bold text-slate-800 mt-1.5">
                {analysis.achievementMetrics.completeness}%
              </p>
              <div className="mt-2 bg-slate-100 rounded-full h-1.5 overflow-hidden">
                <div
                  className="h-full rounded-full bg-blue-500"
                  style={{ width: `${Math.min(analysis.achievementMetrics.completeness, 100)}%` }}
                />
              </div>
            </div>
            {/* KRAs Covered */}
            <div className="p-5">
              <p className="text-[10px] text-slate-500 uppercase font-semibold tracking-wider">KRAs Covered</p>
              <p className="text-4xl font-bold text-slate-800 mt-1.5">
                {analysis.kraClassifications.length}
                <span className="text-sm font-normal text-slate-500 ml-1">areas</span>
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                {analysis.kraClassifications.slice(0, 4).map((kra) => (
                  <span key={kra.id} className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-medium">
                    {kra.id}
                  </span>
                ))}
                {analysis.kraClassifications.length > 4 && (
                  <span className="text-[10px] bg-slate-100 text-slate-400 px-1.5 py-0.5 rounded">
                    +{analysis.kraClassifications.length - 4}
                  </span>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tab Navigation */}
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-4 h-10 bg-slate-100 p-1 rounded-lg">
          <TabsTrigger value="overview" className="text-sm flex items-center gap-1.5">
            <BarChart3 className="w-3.5 h-3.5" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="kpi-performance" className="text-sm flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5" />
            KPI Performance
          </TabsTrigger>
          <TabsTrigger value="ai-insights" className="text-sm flex items-center gap-1.5">
            <Lightbulb className="w-3.5 h-3.5" />
            AI Insights
          </TabsTrigger>
          <TabsTrigger value="activities" className="text-sm flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" />
            Activities
          </TabsTrigger>
        </TabsList>

        {/* ── OVERVIEW TAB ── */}
        <TabsContent value="overview" className="mt-4 space-y-4">

          {/* KPI Status Quick Counts */}
          {hasKPIData && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Met',         count: kpiGroups.filter(k => k.status === 'MET').length,         cardClass: 'bg-green-50 border-green-200', textClass: 'text-green-900', dot: 'bg-green-500' },
                { label: 'On Track',    count: kpiGroups.filter(k => k.status === 'ON_TRACK').length,    cardClass: 'bg-blue-50 border-blue-200',   textClass: 'text-blue-900',  dot: 'bg-blue-500'  },
                { label: 'Partial',     count: kpiGroups.filter(k => k.status === 'PARTIAL').length,     cardClass: 'bg-amber-50 border-amber-200', textClass: 'text-amber-900', dot: 'bg-amber-500' },
                { label: 'Not Started', count: kpiGroups.filter(k => k.status === 'NOT_STARTED').length, cardClass: 'bg-red-50 border-red-200',     textClass: 'text-red-900',   dot: 'bg-red-500'   },
              ].map(({ label, count, cardClass, textClass, dot }) => (
                <div key={label} className={`p-4 rounded-lg border flex items-center gap-3 ${cardClass}`}>
                  <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${dot}`} />
                  <div>
                    <p className={`text-3xl font-bold ${textClass}`}>{count}</p>
                    <p className={`text-[10px] font-semibold uppercase tracking-wider opacity-70 ${textClass}`}>{label}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* KRA Coverage Breakdown */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <FolderOpen className="w-4 h-4 text-slate-500" />
                  KRA Coverage Breakdown
                </CardTitle>
                {(analysis.status === 'APPROVED' || analysis.status === 'COMPLETED') && (
                  <Badge variant="outline" className="text-green-700 border-green-400 text-xs">
                    <CheckCircle2 className="w-3 h-3 mr-1" />
                    Verified
                  </Badge>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                {analysis.kraClassifications.reduce((s, k) => s + k.count, 0)} total records across {analysis.kraClassifications.length} Key Result Areas
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {analysis.kraClassifications.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-4">No KRA classifications found</p>
              ) : (
                analysis.kraClassifications.map((kra) => {
                  const title = KRA_TITLES[kra.id] || kra.title || kra.id;
                  const pct = Math.min(kra.achievementRate ?? 0, 100);
                  return (
                    <div key={kra.id}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[10px] font-bold text-slate-400 w-12 shrink-0 uppercase tracking-wide">{kra.id}</span>
                          <span className="text-sm font-medium text-slate-800 truncate">{title}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0 ml-3">
                          <span className="text-xs text-slate-500">{kra.count} records</span>
                          {pct > 0 && (
                            <span className={`text-xs font-bold ${pct >= 80 ? 'text-green-600' : pct >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                              {pct.toFixed(0)}%
                            </span>
                          )}
                        </div>
                      </div>
                      {pct > 0 && (
                        <div className="ml-14 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${pct >= 80 ? 'bg-green-500' : pct >= 50 ? 'bg-amber-400' : 'bg-red-400'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          {/* Context Block - Current / Target State */}
          {(analysis.achievementMetrics.currentState || analysis.achievementMetrics.targetState) && (
            <Card className="bg-slate-50 border-slate-200">
              <CardContent className="pt-5 pb-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  {analysis.achievementMetrics.currentState && (
                    <div>
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Current State</p>
                      <p className="text-sm text-slate-700 leading-relaxed">{analysis.achievementMetrics.currentState}</p>
                    </div>
                  )}
                  {analysis.achievementMetrics.targetState && (
                    <div>
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Target State</p>
                      <p className="text-sm text-slate-700 leading-relaxed">{analysis.achievementMetrics.targetState}</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

        </TabsContent>

        {/* ── KPI PERFORMANCE TAB ── */}
        <TabsContent value="kpi-performance" className="mt-4 space-y-4">
          {hasKPIData ? (
            <>
              {/* Horizontal Bar Chart */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">KPI Achievement Overview</CardTitle>
                  <p className="text-xs text-slate-500">Completion percentage per KPI — color indicates status</p>
                </CardHeader>
                <CardContent>
                  <div style={{ height: Math.max(200, kpiGroups.length * 44 + 40) }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        layout="vertical"
                        data={kpiGroups.map(k => ({
                          name: k.kpiId,
                          completion: Math.min(k.completionPercentage, 150),
                          status: k.status,
                        }))}
                        margin={{ top: 4, right: 40, left: 8, bottom: 4 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                        <XAxis
                          type="number"
                          domain={[0, 100]}
                          tickFormatter={(v) => `${v}%`}
                          tick={{ fontSize: 11, fill: '#94a3b8' }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          type="category"
                          dataKey="name"
                          tick={{ fontSize: 11, fill: '#64748b' }}
                          width={70}
                          axisLine={false}
                          tickLine={false}
                        />
                        <RechartsTooltip
                          formatter={(value: number, _name: string, props: any) => [
                            `${kpiGroups.find(k => k.kpiId === props.payload.name)?.completionPercentage ?? value}%`,
                            'Completion',
                          ]}
                          contentStyle={{
                            borderRadius: '8px',
                            border: '1px solid #e2e8f0',
                            fontSize: '12px',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                          }}
                        />
                        <Bar dataKey="completion" radius={[0, 4, 4, 0]} maxBarSize={20}>
                          {kpiGroups.map((entry, i) => (
                            <Cell
                              key={`cell-${i}`}
                              fill={
                                entry.status === 'MET'       ? '#22c55e' :
                                entry.status === 'ON_TRACK'  ? '#3b82f6' :
                                entry.status === 'PARTIAL'   ? '#f59e0b' :
                                                               '#ef4444'
                              }
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  {/* Legend */}
                  <div className="flex flex-wrap gap-4 mt-3 justify-center border-t border-slate-100 pt-3">
                    {[
                      { color: '#22c55e', label: 'Met' },
                      { color: '#3b82f6', label: 'On Track' },
                      { color: '#f59e0b', label: 'Partial' },
                      { color: '#ef4444', label: 'Not Started' },
                    ].map(({ color, label }) => (
                      <div key={label} className="flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: color }} />
                        <span className="text-xs text-slate-500">{label}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Existing KPIDashboard (unchanged) */}
              <KPIDashboard
                kpiGroups={kpiGroups}
                selectedYear={Number((analysis as any)?.year) || new Date().getFullYear()}
              />
            </>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <BarChart3 className="w-12 h-12 text-slate-200 mb-3" />
                <p className="font-medium text-slate-600">No KPI performance data available</p>
                <p className="text-sm text-slate-400 mt-1">KPI data appears once activities are mapped to specific KPIs in the strategic plan.</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── AI INSIGHTS TAB ── */}
        <TabsContent value="ai-insights" className="mt-4 space-y-4">
          {(() => {
            const isJsonLike = (value: unknown) => {
              if (typeof value !== 'string') return false;
              const t = value.trim();
              if (!t) return false;
              return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
            };

            const isNullishText = (value: unknown) => {
              if (typeof value !== 'string') return false;
              const t = value.trim().toLowerCase();
              return t === 'null' || t === 'undefined';
            };

            const documentInsightText = (() => {
              const fromJson = (analysis.prescriptiveAnalysis && typeof analysis.prescriptiveAnalysis === 'object')
                ? (analysis.prescriptiveAnalysis as any).documentInsight
                : null;
              if (typeof fromJson === 'string' && fromJson.trim()) return fromJson.trim();
              const parts = [analysis.alignment, analysis.opportunities, analysis.gaps]
                .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
                .filter((v) => !isJsonLike(v))
                .map((v) => v.trim());
              return parts.join('\n\n');
            })();

            const prescriptiveText = (() => {
              const fromJson = (analysis.prescriptiveAnalysis && typeof analysis.prescriptiveAnalysis === 'object')
                ? (analysis.prescriptiveAnalysis as any).prescriptiveAnalysis
                : null;
              if (typeof fromJson === 'string' && fromJson.trim()) return fromJson.trim();
              if (Array.isArray(analysis.recommendations) && analysis.recommendations.length > 0) {
                return analysis.recommendations
                  .map((rec) => {
                    const metaParts = [rec.timeline, rec.owner].filter(Boolean);
                    const meta = metaParts.length > 0 ? ` (${metaParts.join(' • ')})` : '';
                    const priority = rec.priority ? `[${rec.priority}] ` : '';
                    const title = rec.title?.trim() ? `${rec.title.trim()}: ` : '';
                    const desc = rec.description?.trim() ? rec.description.trim() : '';
                    return `- ${priority}${title}${desc}${meta}`.trim();
                  })
                  .filter((line) => line !== '-')
                  .join('\n');
              }
              const fallback = extractPrescriptiveValue(analysis.prescriptiveAnalysis) || '';
              return isNullishText(fallback) ? '' : fallback;
            })();

            const structuredItems: PrescriptiveItem[] = (() => {
              const fromJson = (() => {
                if (!analysis.prescriptiveAnalysis || typeof analysis.prescriptiveAnalysis !== 'object') return [];
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
              return prescriptiveText ? parsePrescriptiveTextToItems(prescriptiveText).slice(0, 5) : [];
            })();

            const shouldShow = Boolean(documentInsightText || prescriptiveText || structuredItems.length > 0);

            if (!shouldShow) return (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <Lightbulb className="w-12 h-12 text-slate-200 mb-3" />
                  <p className="font-medium text-slate-600">No AI insights available yet</p>
                  <p className="text-sm text-slate-400 mt-1">Insights are generated after document analysis completes.</p>
                </CardContent>
              </Card>
            );

            return (
              <div className="space-y-4">

                {/* Document Insight Card */}
                {documentInsightText && (
                  <Card className="border-blue-200 overflow-hidden">
                    <div className="h-1 bg-blue-500" />
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="text-sm font-semibold text-blue-900 flex items-center gap-2">
                        <Target className="w-4 h-4 text-blue-600" />
                        Document Insight
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-sm text-slate-700 leading-relaxed">
                        {renderFormattedText(documentInsightText)}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Structured Prescriptive Items */}
                {structuredItems.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between px-0.5">
                      <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest">
                        Action Items ({structuredItems.length})
                      </h3>
                      <div className="flex gap-2">
                        {(['HIGH', 'MEDIUM', 'LOW'] as const).map((p) => (
                          <span key={p} className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            p === 'HIGH'   ? 'bg-red-100 text-red-700' :
                            p === 'MEDIUM' ? 'bg-amber-100 text-amber-700' :
                                             'bg-blue-100 text-blue-700'
                          }`}>{p}</span>
                        ))}
                      </div>
                    </div>

                    {structuredItems.map((item, idx) => (
                      <Card
                        key={idx}
                        className={`border-l-4 overflow-hidden shadow-sm ${
                          item.priority === 'HIGH'   ? 'border-l-red-500' :
                          item.priority === 'MEDIUM' ? 'border-l-amber-500' :
                          item.priority === 'LOW'    ? 'border-l-blue-500' :
                                                       'border-l-slate-300'
                        }`}
                      >
                        <CardContent className="pt-4 pb-4 space-y-3">
                          {/* Header Row */}
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-slate-900 text-sm leading-tight">{item.title}</span>
                              {item.priority && (
                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                  item.priority === 'HIGH'   ? 'bg-red-100 text-red-700' :
                                  item.priority === 'MEDIUM' ? 'bg-amber-100 text-amber-700' :
                                                               'bg-blue-100 text-blue-700'
                                }`}>{item.priority}</span>
                              )}
                              {item.relatedKpiId && (
                                <span className="text-[10px] font-medium bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full border border-purple-200">
                                  {item.relatedKpiId}
                                </span>
                              )}
                            </div>
                            <span className="text-xs text-slate-300 font-mono shrink-0">
                              #{String(idx + 1).padStart(2, '0')}
                            </span>
                          </div>

                          {/* Field Rows */}
                          <div className="space-y-2">
                            <div className="flex gap-3">
                              <span className="text-[10px] font-bold uppercase text-slate-400 w-16 shrink-0 tracking-wider pt-0.5">Issue</span>
                              <p className="text-sm text-slate-700 flex-1 leading-relaxed">{item.issue}</p>
                            </div>
                            <div className="flex gap-3">
                              <span className="text-[10px] font-bold uppercase text-slate-400 w-16 shrink-0 tracking-wider pt-0.5">Action</span>
                              <p className="text-sm text-slate-800 flex-1 font-medium leading-relaxed">{item.action}</p>
                            </div>
                            {item.nextStep && (
                              <div className="flex gap-3">
                                <span className="text-[10px] font-bold uppercase text-slate-400 w-16 shrink-0 tracking-wider pt-0.5">Next</span>
                                <p className="text-sm text-slate-700 flex-1 leading-relaxed">{item.nextStep}</p>
                              </div>
                            )}
                          </div>

                          {/* Footer Meta Row */}
                          {(item.responsibleOffice || item.timeframe || item.authorizedStrategy) && (
                            <div className="pt-2.5 border-t border-slate-100 flex flex-wrap gap-4">
                              {item.responsibleOffice && (
                                <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                  <Users className="w-3 h-3 shrink-0" />
                                  <span>{item.responsibleOffice}</span>
                                </div>
                              )}
                              {item.timeframe && (
                                <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                  <Clock className="w-3 h-3 shrink-0" />
                                  <span>{item.timeframe}</span>
                                </div>
                              )}
                              {item.authorizedStrategy && (
                                <div className="flex items-center gap-1.5 text-xs text-slate-500">
                                  <Target className="w-3 h-3 shrink-0" />
                                  <span className="italic">{item.authorizedStrategy}</span>
                                </div>
                              )}
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}

                {/* Fallback: legacy unstructured prescriptive text */}
                {structuredItems.length === 0 && prescriptiveText && (
                  <Card className="border-purple-200 overflow-hidden">
                    <div className="h-1 bg-purple-400" />
                    <CardHeader className="pb-3 pt-4">
                      <CardTitle className="text-sm font-semibold text-purple-900 flex items-center gap-2">
                        <Lightbulb className="w-4 h-4 text-purple-600" />
                        Prescriptive Analysis
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="p-4 bg-purple-50 rounded-lg text-sm text-purple-900 leading-relaxed">
                        {renderFormattedText(prescriptiveText)}
                      </div>
                    </CardContent>
                  </Card>
                )}

              </div>
            );
          })()}
        </TabsContent>

        {/* ── ACTIVITIES TAB ── */}
        <TabsContent value="activities" className="mt-4 space-y-4">

          {/* Regenerate Banner */}
          {changedActivityIds.size > 0 && (
            <div className="flex items-center justify-between gap-4 p-3 bg-indigo-50 border border-indigo-200 rounded-lg">
              <p className="text-sm text-indigo-700">
                <strong>{changedActivityIds.size}</strong> KRA assignment(s) changed. Regenerate to update AI insights.
              </p>
              <Button
                onClick={handleRegenerateInsights}
                disabled={isRegenerating}
                className="bg-indigo-600 hover:bg-indigo-700 shrink-0"
                size="sm"
              >
                {isRegenerating
                  ? <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  : <RefreshCw className="w-4 h-4 mr-2" />
                }
                {isRegenerating ? 'Regenerating...' : 'Regenerate Insights'}
              </Button>
            </div>
          )}

          {!hasOrganizedActivities ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <Activity className="w-12 h-12 text-slate-200 mb-3" />
                <p className="font-medium text-slate-600">No activities organized yet</p>
                <p className="text-sm text-slate-400 mt-1">Activities appear after document processing completes.</p>
              </CardContent>
            </Card>
          ) : (
            analysis.organizedActivities.map((org) => {
              const kraTitle = getKRADisplayTitle(org.kraId, org.kraTitle);
              return (
                <Card key={org.kraId}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <CardTitle className="text-sm font-semibold text-slate-800 truncate">{kraTitle}</CardTitle>
                        <p className="text-xs text-slate-400 mt-0.5">{org.kraId}</p>
                      </div>
                      <Badge variant="outline" className="text-slate-500 text-xs shrink-0">
                        {org.activityCount} {org.activityCount === 1 ? 'activity' : 'activities'}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {org.activities && Array.isArray(org.activities) && org.activities.length > 0 ? (
                      org.activities.map((activity, i) => {
                        const achievement = activity.achievement ?? 0;
                        const activityId = `${org.kraId}-${i}`;
                        const selectedKraId = editedKRAs[activityId] || org.kraId;
                        const isChanged = changedActivityIds.has(activityId);
                        return (
                          <div
                            key={i}
                            className={`p-3 border rounded-lg transition-colors ${
                              isChanged ? 'bg-indigo-50 border-indigo-300' : 'bg-slate-50 border-slate-200 hover:border-slate-300'
                            }`}
                          >
                            <div className="flex justify-between items-start gap-4">
                              <div className="flex-1 min-w-0 space-y-2">
                                <p className="font-medium text-slate-900 text-sm leading-snug">{activity.title || 'Unnamed'}</p>
                                {activity.unit && (
                                  <p className="text-slate-400 text-xs">{activity.unit}</p>
                                )}
                                <div className="pt-1">
                                  <Label className="text-xs text-slate-500 mb-1.5 block">Assign KRA:</Label>
                                  <Select
                                    value={selectedKraId}
                                    onValueChange={(v) => handleKRAChange(activityId, v)}
                                  >
                                    <SelectTrigger className="h-8 text-xs w-full">
                                      <SelectValue placeholder="Select KRA" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {AVAILABLE_KRAS.map((kra) => (
                                        <SelectItem key={kra.id} value={kra.id}>
                                          <strong>{kra.id}</strong>: {kra.title.substring(0, 50)}...
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  {isChanged && (
                                    <p className="text-xs text-indigo-600 mt-1 font-medium">KRA Changed</p>
                                  )}
                                </div>
                              </div>
                              <div className="text-right shrink-0 ml-4">
                                <span className="block font-bold text-slate-900 text-sm">
                                  {activity.reported}{achievement > 0 ? '%' : ''}
                                </span>
                                <span className={`text-xs font-medium ${
                                  achievement >= 100 ? 'text-green-600' :
                                  achievement > 0    ? 'text-amber-600' : 'text-slate-400'
                                }`}>
                                  {achievement >= 100  ? 'MET' :
                                   achievement > 0     ? `${Math.round(achievement)}%` : 'Pending'}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-sm text-slate-500 italic">No activities</p>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}

        </TabsContent>

      </Tabs>
    </div>
  );
}
