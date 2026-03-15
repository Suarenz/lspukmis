import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BotIcon, LightbulbIcon, FileText, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { cleanDocumentTitle } from '@/lib/utils/document-utils';

interface SourceInfo {
  title: string;
  documentId?: string; // Made optional since it might not always be available
  confidence: number;
  isQproDocument?: boolean;
  qproAnalysisId?: string;
}

interface QwenResponseDisplayProps {
  generatedResponse: string;
  generationType: string;
  sources?: SourceInfo[];
  isLoading?: boolean;
  error?: string;
  relevantDocumentUrl?: string; // Added for the clickable document link
  noRelevantDocuments?: boolean; // Flag to indicate no relevant documents were found
}

// Helper function to get the correct document URL based on document type
const getDocumentUrl = (source: SourceInfo): string | null => {
  console.log('[getDocumentUrl] Checking source:', { 
    title: source.title, 
    documentId: source.documentId, 
    isQpro: source.isQproDocument,
    qproAnalysisId: source.qproAnalysisId 
  });
  
  // First validate that the document ID is valid
  if (!isValidDocumentId(source.documentId) && !source.qproAnalysisId) {
    console.warn('[getDocumentUrl] Invalid document ID for source:', source.title, source.documentId);
    return null; // Return null to indicate invalid URL
  }
  if (source.isQproDocument && source.qproAnalysisId) {
    const url = `/qpro/analysis/${source.qproAnalysisId}`;
    console.log('[getDocumentUrl] QPRO URL:', url);
    return url;
  }
  // Only return preview URL if we have a valid document ID
  if (source.documentId && isValidDocumentId(source.documentId)) {
    // Clean the document ID (remove filename extension if present)
    const cleanId = cleanDocumentId(source.documentId);
    const url = `/repository/preview/${cleanId}`;
    console.log('[getDocumentUrl] Preview URL:', url, '(cleaned from:', source.documentId, ')');
    return url;
  }
  console.warn('[getDocumentUrl] No valid URL found for source:', source.title);
  return null;
};

// Helper function to check if document ID is valid
const isValidDocumentId = (documentId: string | undefined): boolean => {
  if (!documentId || typeof documentId !== 'string') {
    console.log('[DocumentID Validation] Failed: empty or not string', documentId);
    return false;
  }
  if (documentId === 'undefined' || documentId.includes('undefined')) {
    console.log('[DocumentID Validation] Failed: contains undefined', documentId);
    return false;
  }
  
  // Trim whitespace
  const trimmedId = documentId.trim();
  
  // Check it's not just a file extension
  if (/^\.(pdf|docx?|xlsx?|pptx?|jpg|jpeg|png|gif|bmp|tiff|webp)$/i.test(trimmedId)) {
    console.log('[DocumentID Validation] Failed: file extension only', trimmedId);
    return false;
  }
  
  // Document IDs can contain:
  // - Alphanumeric characters (a-z, A-Z, 0-9)
  // - Hyphens (-)
  // - Underscores (_)
  // - May have file extension or filename parts
  // Must be at least 10 characters long (excluding whitespace)
  const isValid = trimmedId.length >= 10 && /^[a-z0-9_\-\s.]+$/i.test(trimmedId);
  console.log('[DocumentID Validation]', isValid ? 'VALID' : 'INVALID', trimmedId);
  return isValid;
};

// Helper function to clean document ID (remove filename and blobId if present)
const cleanDocumentId = (documentId: string): string => {
  // Document IDs from Colivara may be in format: docId_blobId_filename.ext
  // We need to extract just the first part (docId) which is the database document ID
  
  // First, check if it's a valid CUID format (alphanumeric, 20-30 chars)
  // If the whole thing is a clean CUID, return as-is
  if (/^[a-z0-9]{20,30}$/i.test(documentId.trim())) {
    return documentId.trim();
  }
  
  // If it contains underscores, extract the first part (before the first underscore)
  if (documentId.includes('_')) {
    const parts = documentId.split('_');
    const firstPart = parts[0];
    
    // Validate the first part is a proper CUID format (alphanumeric, 20-30 chars)
    if (/^[a-z0-9]{20,30}$/i.test(firstPart)) {
      console.log('[cleanDocumentId] Extracted clean ID:', firstPart, 'from:', documentId);
      return firstPart;
    }
    
    // If first part is a UUID format (with hyphens), it's likely a database ID
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(firstPart)) {
      console.log('[cleanDocumentId] Extracted UUID:', firstPart, 'from:', documentId);
      return firstPart;
    }
  }
  
  // Fallback: return as-is if no pattern matches
  console.log('[cleanDocumentId] No pattern matched, returning as-is:', documentId);
  return documentId.trim();
};

const QwenResponseDisplay: React.FC<QwenResponseDisplayProps> = ({
  generatedResponse,
  generationType,
  sources,
  isLoading,
  error,
  relevantDocumentUrl, // Added to props
  noRelevantDocuments // Added to props
}) => {
 if (isLoading) {
    return (
      <Card className="mb-6 animate-pulse">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LightbulbIcon className="w-5 h-5" />
            Generating Insights
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="h-4 bg-gray-200 rounded w-3/4"></div>
            <div className="h-4 bg-gray-200 rounded"></div>
            <div className="h-4 bg-gray-200 rounded w-5/6"></div>
            <div className="mt-4 pt-4 border-t border-gray-200">
              <div className="h-4 bg-gray-200 rounded w-1/3 mb-2"></div>
              <div className="h-3 bg-gray-100 rounded w-2/3 mb-1"></div>
              <div className="h-3 bg-gray-100 rounded w-1/2"></div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="mb-6 border-red-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-red-60">
            <LightbulbIcon className="w-5 h-5" />
            Generated Insights Error
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-60">{error}</p>
        </CardContent>
      </Card>
    );
  }

  if (!generatedResponse) {
    return null;
  }

  // Special handling for when no relevant documents were found
  if (noRelevantDocuments) {
    return (
      <Card className="mb-6 border-amber-200 bg-amber-50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-amber-700">
            <LightbulbIcon className="w-5 h-5" />
            No Relevant Documents Found
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="prose prose-amber max-w-none">
            <div className="whitespace-pre-wrap text-amber-800">
              <p className="mb-3">The documents in the system do not contain information that matches your query.</p>
              <p className="font-medium mb-2">Suggestions:</p>
              <ul className="list-disc ml-6 space-y-1">
                <li>Try using different search terms or keywords</li>
                <li>Make sure the document you&apos;re looking for has been uploaded to the system</li>
                <li>Check if the document is still being processed (this can take a few minutes after upload)</li>
                <li>Contact your administrator if you believe the document should exist</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

 return (
    <Card className="mb-6 border-blue-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LightbulbIcon className="w-5 h-5 text-blue-600" />
          Generated Insights
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="prose prose-blue max-w-none">
          <div className="whitespace-pre-wrap text-gray-700 wrap-break-word">
            {generatedResponse.split('\n').map((line, i) => {
              // Check if the line contains a list item (starts with * or - or numbered list)
              const trimmedLine = line.trim();
              if (trimmedLine.startsWith('* **') || trimmedLine.startsWith('- **')) {
                // Handle nested bullet list items like "* **Name of Person**"
                const match = trimmedLine.match(/^\s*[*-]\s*\*\*(.+?)\*\*(.*)/);
                if (match) {
                  return (
                    <div key={i} className="ml-4 my-1">
                      <span className="font-semibold">• {match[1]}</span>
                      {match[2] && <span>{match[2]}</span>}
                    </div>
                  );
                }
                return <div key={i} className="ml-4 my-1">• {trimmedLine.substring(2).trim()}</div>;
              } else if (/^\s*\d+\.\s/.test(trimmedLine)) {
                // Handle numbered lists
                return <div key={i} className="ml-4 my-1">{trimmedLine}</div>;
              } else if (trimmedLine.startsWith('**') && trimmedLine.endsWith('**')) {
                // Handle bold headers
                return <div key={i} className="font-bold mt-3 mb-1">{trimmedLine.slice(2, -2)}</div>;
              } else if (trimmedLine === '') {
                // Handle empty lines
                return <div key={i} className="my-2"></div>;
              } else {
                // Handle regular text
                return <div key={i} className="my-1">{line}</div>;
              }
            })}
          </div>
          
          {sources && sources.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-200">
              <h4 className="flex items-center gap-2 font-medium mb-2 text-sm">
                <FileText className="w-4 h-4" />
                Source Documents ({Math.min(sources.length, 3)} of {sources.length})
              </h4>
              <ul className="space-y-1.5">
                {sources.slice(0, 3).map((source, index) => {
                  const documentUrl = getDocumentUrl(source);
                  const hasValidUrl = documentUrl !== null;
                  // Clamp confidence to [0, 1] for display
                  const clampedConfidence = typeof source.confidence === 'number' ? Math.min(Math.max(source.confidence, 0), 1) : 0;

                  return (
                    <li key={index} className="flex items-center gap-2 text-sm">
                      <span className="text-xs bg-blue-100 text-blue-800 rounded-full w-5 h-5 flex items-center justify-center shrink-0 font-semibold">
                        {index + 1}
                      </span>
                      <div className="flex-1 min-w-0 flex items-center gap-2">
                        {hasValidUrl ? (
                          <Link
                            href={documentUrl}
                            className="font-medium text-blue-600 hover:text-blue-800 hover:underline transition-colors cursor-pointer truncate"
                          >
                            {cleanDocumentTitle(source.title)}
                          </Link>
                        ) : (
                          <span className="font-medium text-gray-700 truncate">
                            {cleanDocumentTitle(source.title)}
                          </span>
                        )}
                        {source.isQproDocument && (
                          <Badge variant="default" className="bg-blue-600 hover:bg-blue-700 text-xs">QPRO</Badge>
                        )}
                        {clampedConfidence > 0 && (
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded shrink-0">
                            {(clampedConfidence * 100).toFixed(0)}%
                          </span>
                        )}
                      </div>
                      {hasValidUrl && (
                        <Link
                          href={documentUrl}
                          className="text-blue-600 hover:text-blue-800 transition-colors shrink-0"
                        >
                          <ExternalLink className="w-4 h-4" />
                          <span className="sr-only">View Document</span>
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          
          {relevantDocumentUrl && !relevantDocumentUrl.includes('undefined') && (
            <div className="mt-6 pt-4 border-t border-gray-200">
              <div className="bg-blue-50 p-4 rounded-lg">
                <Link href={relevantDocumentUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 transition-colors font-medium">
                  <FileText className="w-5 h-5" />
                  <span>View Source Document</span>
                  <ExternalLink className="w-5 h-5" />
                </Link>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default QwenResponseDisplay;