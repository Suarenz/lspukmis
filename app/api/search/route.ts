import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import enhancedDocumentService from '@/lib/services/enhanced-document-service';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import ColivaraService from '@/lib/services/colivara-service';
import QwenGenerationService from '@/lib/services/qwen-generation-service';
import { Document } from '@/lib/api/types';
import SuperMapper from '@/lib/utils/super-mapper';
import prisma from '@/lib/prisma';
import { cleanDocumentTitle } from '@/lib/utils/document-utils';
import { searchCacheService } from '@/lib/services/search-cache-service';

// Define the source type for the Qwen response
interface Source {
  title: string;
  documentId?: string; // Made optional since it might not always be available
  confidence: number;
  isQproDocument?: boolean;
  qproAnalysisId?: string;
}

// Helper: clamp a confidence/relevance score to [0, 1]
function clampScore(score: number | undefined | null, fallback = 0.85): number {
  const val = (typeof score === 'number' && score > 0) ? score : fallback;
  return Math.min(Math.max(val, 0), 1);
}

// Helper function to generate consistent cache keys
function generateCacheKey(query: string, unitId?: string, category?: string, filters?: any) {
  // Convert "undefined" string to proper undefined/null for consistent cache keys
  const safeUnitId = (unitId === 'undefined' || unitId === undefined || unitId === null) ? 'all' : unitId;
  const safeCategory = (category === 'undefined' || category === undefined || category === null) ? 'all' : category;
  const safeFilters = (filters === 'undefined' || filters === undefined || filters === null) ? {} : filters;
  return btoa([
    query.toLowerCase().trim(),
    safeUnitId,
    safeCategory,
    JSON.stringify(safeFilters)
  ].join('|')).replace(/[^a-zA-Z0-9]/g, '_');
}

// Lazy initialization to avoid build-time errors when env vars are missing
let qwenService: QwenGenerationService | null = null;
function getQwenService() {
  if (!qwenService && process.env.QWEN_API_KEY) {
    qwenService = new QwenGenerationService({ model: process.env.QWEN_MODEL || 'qwen/qwen-2.5-vl-72b-instruct' });
  }
  return qwenService;
}

const colivaraService = new ColivaraService();

// Helper function to deduplicate search results based on document ID
function deduplicateResults(results: any[]): any[] {
  const seenIds = new Set<string>();
  const uniqueResults: any[] = [];
  
  for (const result of results) {
    // Use the document ID for deduplication - try multiple possible locations
    const docId = result.id ||
                  result.documentId ||
                  (result.document && result.document.id) ||
                  (result.metadata && result.metadata.documentId) ||
                  (result.document && result.document.metadata.documentId) ||
                  undefined;
    
    if (docId && !seenIds.has(docId)) {
      seenIds.add(docId);
      uniqueResults.push(result);
    } else if (!docId) {
      // If no ID is available, add it anyway (though this shouldn't happen with proper data)
      console.warn('Result without valid document ID in deduplicateResults:', result);
      uniqueResults.push(result);
    }
   }
  
  return uniqueResults;
}

// Group similar search results by document ID to consolidate duplicates
function groupResults(results: any[]): any[] {
  const groupedMap = new Map<string, any>();
  
  for (const result of results) {
    // Use the document ID as the grouping key - try multiple possible locations
    const docId = result.id ||
                  result.documentId ||
                  (result.document && result.document.id) ||
                  (result.metadata && result.metadata.documentId) ||
                  (result.document && result.document.metadata.documentId) ||
                  undefined;
    
    if (docId) {
      if (groupedMap.has(docId)) {
        // If we already have a result for this document, we'll keep the one with higher score
        const existingResult = groupedMap.get(docId);
        const currentScore = result.score || result.confidenceScore || 0;
        const existingScore = existingResult.score || existingResult.confidenceScore || 0;
        
        // Keep the result with higher score
        if (currentScore > existingScore) {
          groupedMap.set(docId, result);
        }
      } else {
        groupedMap.set(docId, result);
      }
    } else {
      // If no ID, add it directly (shouldn't happen in normal cases after our filtering)
      console.warn('Result without valid document ID:', result);
      groupedMap.set(`fallback_${results.indexOf(result)}`, result);
    }
   }
  
  return Array.from(groupedMap.values());
}

// Helper function to deduplicate sources based on document ID and title
function deduplicateSources(sources: any[]): any[] {
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const uniqueSources: any[] = [];
  
  for (const source of sources) {
    const docId = source.documentId;
    const title = cleanDocumentTitle(source.title || '').toLowerCase();
    
    // Check if we've already seen this document ID or exact title
    const isDuplicate = (docId && seenIds.has(docId)) || (title && seenTitles.has(title));
    
    if (!isDuplicate) {
      if (docId) seenIds.add(docId);
      if (title) seenTitles.add(title);
      uniqueSources.push(source);
    }
  }
  
  return uniqueSources;
}

// Mapper function to convert Colivara search results to the standard format expected by the frontend
async function mapColivaraResultsToDocuments(colivaraResults: any[]) {
  // Create a set of document IDs from the search results to fetch from the database, ensuring they are valid strings
  // Extract document IDs from the Colivara results - the ID should come from the metadata of the Colivara document
  const allIds = colivaraResults
    .map((result: any) => {
      // Try multiple possible locations for the document ID
      let extractedId = result.documentId ||
             result.id ||
             (result.document && result.document.id) ||
             (result.metadata && result.metadata.documentId) || // Check in metadata for the original document ID
             (result.document && result.document.metadata && result.document.metadata.documentId) || // Nested check
             undefined;
      
      // If ID contains underscores, it might be the compound format "docId_blobId_filename"
      // Extract just the document ID (first part before underscore)
      if (extractedId && typeof extractedId === 'string' && extractedId.includes('_')) {
        const parts = extractedId.split('_');
        const firstPart = parts[0];
        // Validate it's a proper CUID format (alphanumeric, 20-30 chars)
        if (/^[a-z0-9]+$/i.test(firstPart) && firstPart.length >= 20 && firstPart.length <= 30) {
          console.log(`[Search] Extracted document ID from compound: ${firstPart} (was: ${extractedId})`);
          extractedId = firstPart;
        }
      }
      
      return extractedId;
    });
  
  // Log problematic IDs for debugging
  const problematicIds = allIds.filter((id: any) => typeof id !== 'string' || id === undefined || id === null || id.trim() === '' || id.length === 0);
  if (problematicIds.length > 0) {
    console.warn('Found problematic document IDs in mapColivaraResultsToDocuments:', problematicIds);
    console.warn('Sample of problematic results:', colivaraResults.slice(0, 5).map((r: any) => ({
      documentId: r.documentId,
      id: r.id,
      metadata: r.metadata,
      document: r.document,
      hasDocument: !!r.document,
      documentIdFromDoc: r.document?.id,
      documentIdFromMetadata: r.metadata?.documentId
    })));
  }
  
  const documentIds = allIds
    .filter((id: any) => {
      // Only include IDs that are valid strings
      return typeof id === 'string' && id.trim() !== '' && id.length > 0;
    });
  
  // Remove duplicates from documentIds
  const uniqueDocumentIds = [...new Set(documentIds)];
  
  // Fetch actual document data from the database to ensure correct titles and descriptions
  let dbDocMap = new Map();
  if (uniqueDocumentIds.length > 0) {
    const dbDocuments = await prisma.document.findMany({
      where: {
        id: { in: uniqueDocumentIds },
        status: 'ACTIVE' // Only include active documents
      },
      include: {
        uploadedByUser: true,
        documentUnit: true,
        qproAnalyses: {
          select: { id: true },
          take: 1,
        },
      }
    });
    
    // Create a map for quick lookup of database document data
    dbDocMap = new Map(dbDocuments.map((doc: any) => [doc.id, doc]));
  }
  
 // Process results and map them to proper document format
  const mappedResults = [];
  for (const result of colivaraResults) {
    // Get the document ID from the result - try multiple possible locations
    const rawId = result.documentId ||
                  result.id ||
                  (result.document && result.document.id) ||
                  (result.metadata && result.metadata.documentId) ||
                  (result.document && result.document.metadata && result.document.metadata.documentId) ||
                  undefined;
    
    // Only process if we have a valid document ID
    if (typeof rawId === 'string' && rawId.trim() !== '' && rawId.length > 0) {
      // Get the corresponding database document if it exists
      const dbDoc = dbDocMap.get(rawId);
      
      // If the document exists in the database, use its data as the primary source
      if (dbDoc) {
        // Use database document as primary source but override with search-specific data
        const mappedDocument = {
          ...dbDoc,
          tags: Array.isArray(dbDoc.tags) ? dbDoc.tags as string[] : [],
          unitId: dbDoc.unitId ?? undefined,
          versionNotes: dbDoc.versionNotes ?? undefined,
          uploadedBy: dbDoc.uploadedByUser?.name || dbDoc.uploadedBy,
          status: dbDoc.status as 'ACTIVE' | 'ARCHIVED' | 'PENDING_REVIEW',
          unit: dbDoc.documentUnit ? {
            id: dbDoc.documentUnit.id,
            name: dbDoc.documentUnit.name,
            code: dbDoc.documentUnit.code,
            description: dbDoc.documentUnit.description || undefined,
            createdAt: dbDoc.documentUnit.createdAt,
            updatedAt: dbDoc.documentUnit.updatedAt,
          } : undefined,
          uploadedAt: new Date(dbDoc.uploadedAt),
          createdAt: new Date(dbDoc.createdAt),
          updatedAt: new Date(dbDoc.updatedAt),
          // Colivara fields
          colivaraDocumentId: dbDoc.colivaraDocumentId ?? undefined,
          colivaraProcessingStatus: dbDoc.colivaraProcessingStatus as 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' ?? undefined,
          colivaraProcessedAt: dbDoc.colivaraProcessedAt ? new Date(dbDoc.colivaraProcessedAt) : undefined,
          colivaraChecksum: dbDoc.colivaraChecksum ?? undefined,
        };
        
        // Override with search-specific data if available in the result
        mappedResults.push({
          ...mappedDocument,
          // IMPORTANT: Explicitly set documentId to the clean database ID for proper preview URL construction
          documentId: dbDoc.id,
          title: cleanDocumentTitle(dbDoc.title || result.title || result.originalName || result.document_name || (result.document && result.document.title) || dbDoc.fileName || 'Untitled Document'), // Prioritize database document title over Colivara result
          // For content, use robust fallback logic
          content: (() => {
            const rawContent = result.content || result.text || result.extractedText || dbDoc.description || '';
            const hasRealText = typeof rawContent === 'string' && rawContent.trim().length > 0;
            
            if (hasRealText) {
              return rawContent;
            } else {
              return 'Visual Content'; // This fixes "undefined" in content field
            }
          })(),
          // For snippet, try Colivara result first, then fallback to database description
          snippet: (() => {
            // Try to get actual extracted text from Colivara result
            const extractedText = result.extractedText || result.content || result.text;
            const hasRealText = typeof extractedText === 'string' && extractedText.trim().length > 10;
            
            if (hasRealText) {
              // Return meaningful content, not just the title
              const cleanText = extractedText.trim();
              return cleanText.substring(0, 300) + (cleanText.length > 300 ? '...' : '');
            } else if (dbDoc.description && dbDoc.description.trim().length > 10) {
              // Use database description if available and not too short
              return dbDoc.description.substring(0, 300) + (dbDoc.description.length > 300 ? '...' : '');
            } else {
              return 'Document matched your search query. Click to view full content.'; // Improved message for visual-only content
            }
          })(),
          // Add search-specific fields
          score: clampScore(result.score || result.confidenceScore),
          pageNumbers: result.pageNumbers || [],
          documentSection: result.documentSection || '',
          confidenceScore: clampScore(result.confidenceScore || result.score),
          visualContent: result.visualContent, // Add visual content if available
          extractedText: result.extractedText, // Add extracted text if available
          // QPRO document information
          isQproDocument: dbDoc.isQproDocument || false,
          qproAnalysisId: dbDoc.qproAnalyses && dbDoc.qproAnalyses.length > 0 ? dbDoc.qproAnalyses[0].id : undefined,
          // Document URL for preview - handle QPRO documents differently
          documentUrl: dbDoc.isQproDocument && dbDoc.qproAnalyses && dbDoc.qproAnalyses.length > 0
            ? `/qpro/analysis/${dbDoc.qproAnalyses[0].id}`
            : `/repository/preview/${dbDoc.id}`,
        });
      } else {
        // If no database document exists (shouldn't happen after zombie filtering), log a warning
        console.warn(`Document with ID ${rawId} not found in database but returned by Colivara search`);
      }
    } else {
      // If no valid document ID found, log for debugging but skip this result
      console.warn('Skipping result with no valid document ID:', {
        documentId: result.documentId,
        id: result.id,
        metadata: result.metadata,
        document: result.document,
      });
    }
  }
  
  return mappedResults;
}

// Function to remove zombie documents (documents that exist in Colivara but not in Prisma)
async function filterZombieDocuments(results: any[]): Promise<any[]> {
  // Create a set of document IDs from the search results, ensuring they are valid strings
 // Extract document IDs from the Colivara results - the ID should come from the metadata of the Colivara document
 const allIds = results.map((result: any) => {
    // Try multiple possible locations for the document ID
    const extractedId = result.documentId ||
           result.id ||
           (result.document && result.document.id) ||
           (result.metadata && result.metadata.documentId) || // Check in metadata for the original document ID
           (result.document && result.document.metadata && result.document.metadata.documentId) || // Nested check
           undefined;
    
    // Log what we extracted for debugging
    if (extractedId && extractedId.includes('_')) {
      console.warn(`⚠️ Invalid document ID extracted (contains underscore): ${extractedId}`);
      console.warn('   Metadata:', result.metadata);
      console.warn('   Document:', result.document?.document_name);
    }
    
    return extractedId;
  });
  
  // Log problematic IDs for debugging
  const problematicIds = allIds.filter((id: any) => typeof id !== 'string' || id === undefined || id === null || id.trim() === '' || id.length === 0);
  if (problematicIds.length > 0) {
    console.warn('Found problematic document IDs in search results:', problematicIds);
    console.warn('Sample of search results:', results.slice(0, 3).map((r: any) => ({
      documentId: r.documentId,
      id: r.id,
      metadata: r.metadata,
      hasDocument: !!r.document,
      documentIdFromDoc: r.document?.id,
      documentIdFromMetadata: r.metadata?.documentId
    })));
  }
  
  const documentIds = allIds
    .filter((id: any) => {
      // Only include IDs that are valid strings
      return typeof id === 'string' && id.trim() !== '' && id.length > 0;
    });
  
  // Remove duplicates from documentIds
  const uniqueDocumentIds = [...new Set(documentIds)];
  
  if (uniqueDocumentIds.length === 0) {
    console.warn('No valid document IDs found in search results');
    return results;
  }
  
  // Query Prisma to get the actual documents that exist in the database
  const existingDocs = await prisma.document.findMany({
    where: {
      id: { in: uniqueDocumentIds },
      status: 'ACTIVE' // Only include active documents
    },
    select: { id: true }
 });
  
  // Create a Set of existing document IDs for fast lookup
  const existingDocIds = new Set(existingDocs.map((doc: any) => doc.id));
  
  // Filter out results that don't exist in the database (zombie documents)
  return results.filter((result: any) => {
    // Try multiple possible locations for the document ID
    const docId = result.documentId ||
                  result.id ||
                  (result.document && result.document.id) ||
                  (result.metadata && result.metadata.documentId) ||
                  (result.document && result.document.metadata && result.document.metadata.documentId) ||
                  undefined;
    return typeof docId === 'string' && docId.trim() !== '' && existingDocIds.has(docId);
  });
}

// Function to enhance results with visual content for multimodal processing
async function enhanceResultsWithVisualContent(results: any[], query: string, userId: string): Promise<any[]> {
  // For each result, ensure visual content from Colivara is formatted as screenshots for the LLM
  const enhancedResults = [];
  
  for (const result of results) {
    try {
      const enhancedResult = { ...result };
      
      // Convert visualContent (img_base64 from Colivara) into screenshots array format for LLM
      if (result.visualContent && !enhancedResult.screenshots) {
        // Colivara returns page images as base64 - convert to array format
        enhancedResult.screenshots = [result.visualContent];
        console.log(`[Search] Added visual content as screenshot for document ${result.documentId}, page ${result.pageNumbers?.[0] || 1}`);
      } else if (result.screenshots && result.screenshots.length > 0) {
        // Already has screenshots
        console.log(`[Search] Document ${result.documentId} already has ${result.screenshots.length} screenshots`);
      } else {
        // No visual content available
        enhancedResult.screenshots = [];
      }
      
      // Ensure extractedText field exists (even if empty)
      if (!enhancedResult.extractedText) {
        enhancedResult.extractedText = result.content || result.text || '';
      }
      
      enhancedResults.push(enhancedResult);
    } catch (error) {
      console.error(`Error enhancing result with visual content for document ${result.documentId}:`, error);
      // Return the original result if enhancement fails
      enhancedResults.push(result);
    }
  }
  
  return enhancedResults;
}

export async function GET(request: NextRequest) {
  try {
    // Verify authentication
    const authResult = await requireAuth(request);
    if ('status' in authResult) { // Check if it's a NextResponse (error case)
      return authResult;
    }
    
    const { user } = authResult;

    // Extract query parameters
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q') || searchParams.get('query') || '';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '10'))); // Limit to 50 max
    const unitId = searchParams.get('unit') || undefined;
    const category = searchParams.get('category') || undefined;
    const useSemantic = searchParams.get('semantic') === 'true' || true; // Default to true for semantic search
    
    if (!query) {
      return NextResponse.json(
        { error: 'Query parameter is required' },
        { status: 400 }
      );
    }

    const userId = user.id;

    // Extract additional parameters for generation
    const generateResponse = searchParams.get('generate') === 'true';
    const generationType = searchParams.get('generationType') || 'text-only'; // 'text-only' or 'multimodal'
    
    // Check cache first before making expensive API calls
    // For GET requests, there are no filters from request body, so pass an empty object to ensure consistent cache keys
    // Using {} instead of undefined ensures cache key consistency between GET and POST requests
    // Normalize "undefined" strings to proper undefined values
    const normalizedUnitId = (unitId === 'undefined') ? undefined : unitId;
    const normalizedCategory = (category === 'undefined') ? undefined : category;
    console.log(`Checking cache for query: "${query}", unitId: "${normalizedUnitId}", category: "${normalizedCategory}"`);
    const cachedResult = await searchCacheService.getCachedResult(query, normalizedUnitId, normalizedCategory, {});
    if (cachedResult) {
      console.log(`Cache hit for query: ${query}`);
      console.log(`Cache key used: ${generateCacheKey(query, unitId, category, {})}`);
      
      // Enhance cached results with visual content if needed for multimodal processing
      let enhancedCachedResults = cachedResult.results;
      if (generateResponse) {
        enhancedCachedResults = await enhanceResultsWithVisualContent(cachedResult.results, query, userId);
      }
      
      // Create a new cached result object with enhanced results
      const enhancedCachedResult = {
        ...cachedResult,
        results: enhancedCachedResults
      };
      
      // If we're generating a response, we still need to call the generation service
      // because the generated content might not be cached or might have expired
      if (generateResponse) {
        try {
          const service = getQwenService();
          if (!service) {
            throw new Error('Qwen service not configured');
          }
          
          // For comprehensive queries (like "what trainings/seminars did..."), use more results
          const isComprehensiveQuery = query.toLowerCase().includes('list') ||
                                      query.toLowerCase().includes('all') ||
                                      query.toLowerCase().includes('every') ||
                                      query.toLowerCase().includes('faculty') ||
                                      query.toLowerCase().includes('training') ||
                                      query.toLowerCase().includes('seminar') ||
                                      query.toLowerCase().includes('attended') ||
                                      query.toLowerCase().includes('presentation') ||
                                      query.toLowerCase().includes('research') ||
                                      (query.toLowerCase().includes('what') && query.toLowerCase().includes('training')) ||
                                      (query.toLowerCase().includes('what') && query.toLowerCase().includes('seminar')) ||
                                      (query.toLowerCase().includes('which') && query.toLowerCase().includes('training')) ||
                                      (query.toLowerCase().includes('which') && query.toLowerCase().includes('seminar'));
          
          // Use more results for comprehensive queries, but make sure we don't exceed what we have
          const resultsForGeneration = isComprehensiveQuery ?
            enhancedCachedResult.results.slice(0, Math.min(6, enhancedCachedResult.results.length)) : // Use up to 6 results for comprehensive queries
            enhancedCachedResult.results.slice(0, 3);  // Use top 3 results for specific queries for better context
          
          const qwenResult = await service.generateInsights(
            query,
            resultsForGeneration,
            userId
          );
          
          // Add generated response to cached results
          const responseWithGeneration = {
            ...enhancedCachedResult,
            generatedResponse: qwenResult.summary,
            generationType: generationType,
            sources: qwenResult.sources
          };
          
          // Include the document URL for the relevant document in the response
          if (enhancedCachedResult.results.length > 0 && responseWithGeneration.sources.length > 0) {
            // Find the document that corresponds to the source and add its URL
            const relevantDoc = enhancedCachedResult.results.find(doc => doc.documentId === responseWithGeneration.sources[0].documentId);
            if (relevantDoc) {
              // Access documentUrl from the relevantDoc if it exists
              const docWithUrl = relevantDoc as any;
              if (docWithUrl.documentUrl) {
                (responseWithGeneration as any).relevantDocumentUrl = docWithUrl.documentUrl;
              }
            }
          }
          
          return NextResponse.json(responseWithGeneration);
        } catch (generationError) {
          console.error('Qwen generation failed:', generationError);
          
          // Provide a fallback response when AI generation fails
          const errorMessage = generationError instanceof Error ? generationError.message : String(generationError);
          
          // Check if it's an OpenRouter configuration error
          if (errorMessage.includes('data policy') || errorMessage.includes('404') || errorMessage.includes('No endpoints found')) {
            console.error('⚠️ OpenRouter API configuration issue. Please check: https://openrouter.ai/settings/privacy');
            
            // Provide basic fallback response with cached results
            const basicSources = enhancedCachedResult.results.slice(0, Math.min(3, enhancedCachedResult.results.length)).map((result: any) => ({
              title: result.title || 'Untitled Document',
              documentId: result.documentId || result.id || '', // Use id as fallback if documentId is not set
              confidence: clampScore(result.score || result.confidenceScore),
            }));
            const fallbackResponse = {
              ...enhancedCachedResult,
              generatedResponse: `Found relevant documents for your query. Click on the documents below to view the full content.\n\n**Note:** AI-powered insights are temporarily unavailable due to API configuration.`,
              generationType: 'fallback',
              sources: deduplicateSources(basicSources),
            };
            return NextResponse.json(fallbackResponse);
          }
          
          // Return cached results even if generation fails
          return NextResponse.json(enhancedCachedResult);
        }
      }
      
      // Return cached result directly if no generation needed
      return NextResponse.json(enhancedCachedResult);
    }
    
    console.log(`Cache miss for query: ${query}, making API calls...`);
    console.log(`Cache key that was not found: ${generateCacheKey(query, unitId, category, {})}`);
    
    if (useSemantic) {
      // Use Colivara hybrid search
      try {
        const colivaraResults = await colivaraService.performHybridSearch(
          query,
          { unitId, category },
          userId
        );
        
        // --- ADD THIS ---
        console.log("🔍 SEARCH RESULTS LOG:", JSON.stringify(colivaraResults, null, 2));
        // ----------------
        
        // Filter out zombie documents (deleted from Prisma but still in Colivara) first
        const filteredResults = await filterZombieDocuments(colivaraResults.results);
        
        // Map Colivara results to standard document format using database data
        let mappedResults = await mapColivaraResultsToDocuments(filteredResults);
        
        // Group and deduplicate results to avoid showing the same document multiple times
        mappedResults = groupResults(mappedResults);
        
        // Create response object
        let responseResults = mappedResults;
        
        // If generateResponse is true, limit results to the most relevant document
        if (generateResponse && mappedResults && mappedResults.length > 0) {
          // Use only the top result for display when generating AI response
          responseResults = mappedResults.slice(0, 3);
        }

        const response: any = {
          results: responseResults,
          total: responseResults.length, // Use actual count after potential filtering
          page,
          limit,
          totalPages: Math.ceil(mappedResults.length / limit), // Keep original total for pagination reference
          query: colivaraResults.query,
          processingTime: colivaraResults.processingTime,
          searchType: 'hybrid',
        };

        // If generateResponse is true, use Qwen to generate a response based on the search results
        if (generateResponse && mappedResults && mappedResults.length > 0) {
          // First, get valid document IDs to filter zombie documents
          const validDocumentIds = new Set(
            filteredResults.map((result: any) => {
              return result.documentId ||
                     result.id ||
                     (result.document && result.document.id) ||
                     (result.metadata && result.metadata.documentId) ||
                     (result.document && result.document.metadata.documentId) ||
                     undefined;
            }).filter((id: any) => typeof id === 'string' && id.trim() !== '' && id.length > 0)
          );
 
          // 1. MAP (Universal) - This creates the multimodal content needed for Qwen
          // First, collect all Colivara document IDs to map to database IDs in a single query
          const colivaraDocIds = colivaraResults.results
            .filter((item: any) => {
              // Only include items that have a valid document ID that exists in our filtered results
              const docId = item.documentId ||
                           item.id ||
                           (item.document && item.document.id) ||
                           (item.metadata && item.metadata.documentId) ||
                           (item.document && item.document.metadata && item.document.metadata.documentId) ||
                           undefined;
              return typeof docId === 'string' && docId.trim() !== '' && validDocumentIds.has(docId);
            })
            .map((item: any) => {
              // Get the Colivara document ID
              const docData = item.document || item;
              const metadata = docData.metadata || item.metadata || {};
              
              // Validate that the document ID is in proper CUID format before using it
              const documentId = item.documentId || docData.document_id || docData.id?.toString() || "";
              const isValidDocumentId = documentId && documentId !== 'undefined' && !documentId.includes('undefined') && /^[a-z0-9]+$/i.test(documentId) && documentId.length >= 20 && documentId.length <= 30;
              
              // Extract the original database document ID from metadata if available
              const originalDocumentId = metadata.documentId || (docData.metadata && docData.metadata.documentId) || item.metadata?.documentId;
              const hasValidOriginalId = originalDocumentId && typeof originalDocumentId === 'string' && /^[a-z0-9]+$/i.test(originalDocumentId) && originalDocumentId.length >= 20 && originalDocumentId.length <= 30;
              
              return {
                colivaraDocumentId: isValidDocumentId ? documentId : "",
                originalDocumentId: hasValidOriginalId ? originalDocumentId : undefined, // Store the original database ID if available
                item: item, // Keep reference to the original item
                index: colivaraResults.results.indexOf(item) // Keep track of the index
              };
            })
            .filter((mapping: any) => mapping.colivaraDocumentId); // Only keep items with valid Colivara IDs
          
          // Query the database to map Colivara document IDs to database document IDs
          const colivaraIdsToMap = colivaraDocIds
            .filter((mapping: any) => !mapping.originalDocumentId) // Only map if we don't already have the original DB ID
            .map((mapping: any) => mapping.colivaraDocumentId);
            
          let colivaraToDbMap = new Map(); // Initialize as empty map
          let qproDocMap = new Map(); // Map to store QPRO document info
          
          if (colivaraIdsToMap.length > 0) {
            try {
              // Query the database to find documents that have these colivaraDocumentIds
              // Include description for better evidence display
              const dbDocuments = await prisma.document.findMany({
                where: {
                  colivaraDocumentId: { in: colivaraIdsToMap }
                },
                select: {
                  id: true,
                  colivaraDocumentId: true,
                  isQproDocument: true,
                  description: true, // Include description for fallback evidence
                  title: true, // Include title for better display
                  qproAnalyses: {
                    select: { id: true },
                    take: 1,
                  },
                }
              });
              
              // Create a map from Colivara ID to database ID
              colivaraToDbMap = new Map(dbDocuments.map(doc => [doc.colivaraDocumentId, doc.id]));
              // Create a map for QPRO document info and description
              qproDocMap = new Map(dbDocuments.map(doc => [doc.id, {
                isQproDocument: doc.isQproDocument,
                qproAnalysisId: doc.qproAnalyses && doc.qproAnalyses.length > 0 ? doc.qproAnalyses[0].id : undefined,
                description: doc.description,
                title: doc.title,
              }]));
            } catch (error) {
              console.error('Error querying database for colivara document IDs:', error);
            }
          }
          
          // Now map the results with proper document IDs
          const mappableResults = colivaraResults.results
            .filter((item: any) => {
              // Only include items that have a valid document ID that exists in our filtered results
              const docId = item.documentId ||
                           item.id ||
                           (item.document && item.document.id) ||
                           (item.metadata && item.metadata.documentId) ||
                           (item.document && item.document.metadata && item.document.metadata.documentId) ||
                           undefined;
              return typeof docId === 'string' && docId.trim() !== '' && validDocumentIds.has(docId);
            });
          
          // Use Promise.all to handle async mapping
          const rawMapped = await Promise.all(mappableResults.map(async (item: any, index: number) => {
              const docData = item.document || item;
              const metadata = docData.metadata || item.metadata || {};
              
              // 1. Get Raw Image - Try multiple possible locations for image data
              let rawImage = docData.img_base64 ||
                            item.img_base64 ||
                            docData.image ||
                            metadata.image ||
                            item.visualContent ||
                            (item.document && item.document.visualContent) ||
                            (item.extracted_content && item.extracted_content.image) ||
                            null;
 
              // 1. Clean the string if it has data URL prefix
              if (rawImage && typeof rawImage === 'string') {
                  rawImage = rawImage.replace(/^data:image\/[a-z]+;base64,/, "");
              }
 
              // 2. DETECT MIME TYPE FROM DATA (The Fix)
              // Don't rely on the filename. Look at the first few characters of the code.
              let mimeType = 'image/jpeg'; // Default
              if (rawImage && typeof rawImage === 'string') {
                  if (rawImage.startsWith('iVBOR')) {
                      mimeType = 'image/png';
                  } else if (rawImage.startsWith('/9j/')) {
                      mimeType = 'image/jpeg';
                  }
              }
 
              // Helper to find text - Try multiple possible locations for extracted text
              const txt = docData.text ||
                         item.content ||
                         metadata.text ||
                         item.extractedText ||
                         (item.document && item.document.extractedText) ||
                         (item.extracted_content && item.extracted_content.text) ||
                         (item.extracted_content && item.extracted_content.content) ||
                         metadata.extracted_text ||
                         "";
 
              // SCORE FIX: If Colivara returns 0 but it's the top result, imply relevance based on rank
              let score = docData.raw_score || docData.score || item.score || 0;
              if (score === 0 && index === 0) score = 0.99; // Top result is logically relevant
              if (score === 0 && index === 1) score = 0.80;
 
              // IMAGE DEBUG: Log image size and header
              if (rawImage && typeof rawImage === 'string') {
                  console.log(`📸 IMAGE DEBUG [${metadata.originalName || metadata.title || docData.document_name || "Untitled"}]: Size = ${rawImage.length} characters`);
                  console.log(`   Header check: ${rawImage.substring(0, 30)}...`);
              } else {
                  console.log(`❌ NO IMAGE found for ${metadata.originalName || metadata.title || docData.document_name || "Untitled"}`);
              }
 
              // Validate that the document ID is in proper CUID format before using it
              const documentId = item.documentId || docData.document_id || docData.id?.toString() || "";
              const isValidDocumentId = documentId && documentId !== 'undefined' && !documentId.includes('undefined') && /^[a-z0-9]+$/i.test(documentId) && documentId.length >= 20 && documentId.length <= 30;
              
              // Extract the original database document ID from metadata if available
              const originalDocumentId = metadata.documentId || (docData.metadata && docData.metadata.documentId) || item.metadata?.documentId;
              const hasValidOriginalId = originalDocumentId && typeof originalDocumentId === 'string' && /^[a-z0-9]+$/i.test(originalDocumentId) && originalDocumentId.length >= 20 && originalDocumentId.length <= 30;
              
              // Try to get the database document ID by looking up the Colivara ID in our map
              let finalDocumentId = hasValidOriginalId ? originalDocumentId : undefined;
              
              if (!finalDocumentId && isValidDocumentId && colivaraToDbMap.has(documentId)) {
                finalDocumentId = colivaraToDbMap.get(documentId);
              }
              
              // If we still don't have a valid database ID, try looking up by the document ID directly
              // This handles the case where documentId IS the database ID
              if (!finalDocumentId && isValidDocumentId) {
                // Check if the documentId itself is a valid database document
                try {
                  const directDoc = await prisma.document.findFirst({
                    where: {
                      id: documentId,
                      status: 'ACTIVE',
                    },
                    select: {
                      id: true,
                      isQproDocument: true,
                      description: true,
                      title: true,
                      qproAnalyses: {
                        select: { id: true },
                        take: 1,
                      },
                    },
                  });
                  if (directDoc) {
                    finalDocumentId = directDoc.id;
                    console.log(`✅ Document ID ${documentId} is a valid database ID`);
                    // Add to qproDocMap for later use
                    if (!qproDocMap.has(directDoc.id)) {
                      qproDocMap.set(directDoc.id, {
                        isQproDocument: directDoc.isQproDocument,
                        qproAnalysisId: directDoc.qproAnalyses && directDoc.qproAnalyses.length > 0 ? directDoc.qproAnalyses[0].id : undefined,
                        description: directDoc.description,
                        title: directDoc.title,
                      });
                    }
                  }
                } catch (directLookupError) {
                  // Ignore - the document might not exist with this ID
                }
              }
              
              // Get QPRO document info if available
              const qproInfo = finalDocumentId ? qproDocMap.get(finalDocumentId) : undefined;
              const isQproDocument = qproInfo?.isQproDocument || false;
              const qproAnalysisId = qproInfo?.qproAnalysisId;
              const dbDescription = qproInfo?.description || '';
              const dbTitle = qproInfo?.title || '';
              
              // Use the final document ID (database ID) for the URL, fallback to Colivara ID if not found
              const previewDocumentId = finalDocumentId || (isValidDocumentId ? documentId : undefined);
              
              // Determine the correct document URL based on whether it's a QPRO document
              const documentUrl = finalDocumentId
                ? (isQproDocument && qproAnalysisId
                    ? `/qpro/analysis/${qproAnalysisId}`
                    : `/repository/preview/${finalDocumentId}`)
                : undefined;
              
              return {
                documentId: isValidDocumentId ? documentId : "",
                originalDocumentId: finalDocumentId, // Store the database document ID if available
                title: cleanDocumentTitle(metadata.originalName || metadata.title || dbTitle || docData.document_name || (docData.title && cleanDocumentTitle(docData.title)) || (item.title && cleanDocumentTitle(item.title)) || "Untitled"),
                content: txt || dbDescription || "Visual content only", // Required field for SearchResult
                
                // UI Snippet: Show what we actually found - enhanced for better evidence display
                // Use extracted text first, then database description, then a helpful message
                snippet: (() => {
                  if (txt && txt.trim().length > 20) {
                    return txt.substring(0, 300) + (txt.length > 300 ? "..." : "");
                  } else if (dbDescription && dbDescription.trim().length > 20) {
                    return dbDescription.substring(0, 300) + (dbDescription.length > 300 ? "..." : "");
                  } else {
                    return "Document matched your search query. Click to view full content.";
                  }
                })(),
                
                score: score,
                pageNumbers: [], // Required field for SearchResult
                document: {}, // Required field for SearchResult
                screenshots: rawImage ? [rawImage] : [],
                mimeType: mimeType, // Pass the TRUE type
                extractedText: txt,
                // Include document URL for redirect functionality
                documentUrl: documentUrl,
                // QPRO document information
                isQproDocument: isQproDocument,
                qproAnalysisId: qproAnalysisId,
              };
            }));

          // 2. DEDUPLICATE (Kill the Zombies)
          const uniqueMap = new Map();
          const cleanResults = [];

          for (const doc of rawMapped) {
              // Use documentId or Title as unique key to prevent duplicates
              const key = doc.documentId || doc.title;
              if (!uniqueMap.has(key)) {
                  uniqueMap.set(key, true);
                  cleanResults.push(doc);
              }
          }
          
          try {
            // Use generateInsights to get both the response and the sources used
            // For queries asking for comprehensive lists (like faculty and their trainings), use more results
            const isComprehensiveQuery = query.toLowerCase().includes('list') ||
                                        query.toLowerCase().includes('all') ||
                                        query.toLowerCase().includes('every') ||
                                        query.toLowerCase().includes('faculty') ||
                                        query.toLowerCase().includes('training') ||
                                        query.toLowerCase().includes('seminar') ||
                                        query.toLowerCase().includes('attended') ||
                                        query.toLowerCase().includes('presentation') ||
                                        query.toLowerCase().includes('research') ||
                                        (query.toLowerCase().includes('what') && query.toLowerCase().includes('training')) ||
                                        (query.toLowerCase().includes('what') && query.toLowerCase().includes('seminar')) ||
                                        (query.toLowerCase().includes('which') && query.toLowerCase().includes('training')) ||
                                        (query.toLowerCase().includes('which') && query.toLowerCase().includes('seminar'));
            
            // Use more results for comprehensive queries, but make sure we don't exceed what we have
            const resultsForGeneration = isComprehensiveQuery ?
              cleanResults.slice(0, Math.min(6, cleanResults.length)) : // Use up to 6 results for comprehensive queries
              cleanResults.slice(0, 3);  // Use top 3 results for specific queries for better context
            
            const service = getQwenService();
            if (!service) {
              throw new Error('Qwen service not configured');
            }
            const qwenResult = await service.generateInsights(
              query,
              resultsForGeneration
            );
            
            response.generatedResponse = qwenResult.summary;
            response.generationType = generationType;
            
            // Check if the AI indicated that the documents don't contain relevant information
            if (qwenResult.noRelevantDocuments) {
              console.log(`🔍 No relevant documents found for query: "${query}"`);
              response.noRelevantDocuments = true;
              // Provide a user-friendly message
              response.generatedResponse = `**No relevant documents found for your query.**\n\nThe documents in the system do not contain information about "${query}". Please try:\n- Using different search terms\n- Uploading documents that contain this information\n- Checking if the document has been indexed properly`;
            }
            
            // Include all relevant sources for comprehensive queries, otherwise just the top one
            // Clean the title in the source and ensure we have the database document ID and QPRO info
            const cleanedSources = qwenResult.sources && qwenResult.sources.length > 0 ?
              await Promise.all(qwenResult.sources.map(async (source, idx) => {
                // Try to match by title first (more reliable when Qwen returns title as documentId)
                let originalResult = resultsForGeneration.find(result => {
                  const resultTitle = cleanDocumentTitle(result.title || '').toLowerCase();
                  const sourceTitle = cleanDocumentTitle(source.title || '').toLowerCase();
                  const sourceDocId = source.documentId || '';
                  
                  // Match by title similarity or exact document ID match
                  return resultTitle === sourceTitle || 
                         result.documentId === sourceDocId || 
                         result.originalDocumentId === sourceDocId;
                });
                
                // If no match found, use the result at the same index
                if (!originalResult && idx < resultsForGeneration.length) {
                  originalResult = resultsForGeneration[idx];
                  console.log(`⚠️ Source matching by index fallback for "${source.title}"`);
                }
                
                // Priority: originalDocumentId > documentId, but validate it's a proper document ID
                let databaseDocumentId = originalResult?.originalDocumentId || originalResult?.documentId || source.documentId;
                
                // Validate that it's actually a valid document ID
                // Allow alphanumeric, hyphens, underscores, spaces, and dots (for filenames)
                const isValidDocId = databaseDocumentId && 
                                    typeof databaseDocumentId === 'string' && 
                                    /^[a-z0-9_\-\s.]+$/i.test(databaseDocumentId) && 
                                    databaseDocumentId.trim().length >= 10;
                
                if (!isValidDocId) {
                  console.warn(`⚠️ Invalid document ID for source "${source.title}": ${databaseDocumentId}`);
                  // If invalid, try harder to find the real document ID
                  if (originalResult?.originalDocumentId && /^[a-z0-9_\-\s.]+$/i.test(originalResult.originalDocumentId)) {
                    databaseDocumentId = originalResult.originalDocumentId;
                  } else if (originalResult?.documentId && /^[a-z0-9_\-\s.]+$/i.test(originalResult.documentId)) {
                    databaseDocumentId = originalResult.documentId;
                  } else {
                    // Last resort: search all results by title to find the correct document ID
                    const titleMatch = resultsForGeneration.find(r => {
                      const rTitle = cleanDocumentTitle(r.title || '').toLowerCase();
                      const sTitle = cleanDocumentTitle(source.title || '').toLowerCase();
                      return rTitle.includes(sTitle) || sTitle.includes(rTitle);
                    });
                    if (titleMatch?.originalDocumentId) {
                      databaseDocumentId = titleMatch.originalDocumentId;
                      console.log(`✅ Found document ID by title match: ${databaseDocumentId}`);
                    } else {
                      // Final fallback: search database by title
                      try {
                        const cleanTitle = cleanDocumentTitle(source.title || '').trim();
                        if (cleanTitle.length > 5) {
                          const dbDoc = await prisma.document.findFirst({
                            where: {
                              OR: [
                                { title: { contains: cleanTitle, mode: 'insensitive' } },
                                { fileName: { contains: cleanTitle, mode: 'insensitive' } },
                              ],
                              status: 'ACTIVE',
                            },
                            select: {
                              id: true,
                              isQproDocument: true,
                              qproAnalyses: { select: { id: true }, take: 1 },
                            },
                          });
                          if (dbDoc) {
                            databaseDocumentId = dbDoc.id;
                            console.log(`✅ Found document ID by database title search: ${databaseDocumentId}`);
                            // Update QPRO info if found
                            if (dbDoc.isQproDocument && dbDoc.qproAnalyses?.length > 0) {
                              originalResult = {
                                ...originalResult,
                                isQproDocument: true,
                                qproAnalysisId: dbDoc.qproAnalyses[0].id,
                              } as any;
                            }
                          } else {
                            console.error(`❌ Could not find valid document ID for source: ${source.title}`);
                            databaseDocumentId = undefined; // Set to undefined instead of empty string to prevent rendering
                          }
                        } else {
                          console.error(`❌ Title too short for database search: ${source.title}`);
                          databaseDocumentId = undefined; // Set to undefined instead of empty string
                        }
                      } catch (dbError) {
                        console.error(`❌ Database lookup failed for source: ${source.title}`, dbError);
                        databaseDocumentId = undefined; // Set to undefined instead of empty string
                      }
                    }
                  }
                }
                
                // Ensure confidence is a valid number (fallback to result's score if Qwen returns 0)
                // Clamp to [0, 1] to prevent >100% relevance display
                const rawConfidence = (source.confidence && source.confidence > 0)
                  ? source.confidence
                  : (originalResult?.score || (originalResult as any)?.confidenceScore || 0.85);
                const confidence = Math.min(Math.max(rawConfidence, 0), 1);
                
                return {
                  ...source,
                  title: cleanDocumentTitle(source.title),
                  documentId: databaseDocumentId, // Use the validated database document ID
                  confidence: confidence, // Ensure valid confidence score
                  isQproDocument: originalResult?.isQproDocument || false,
                  qproAnalysisId: originalResult?.qproAnalysisId || undefined,
                };
              })) : [];
            
            // Log the cleaned sources for debugging
            console.log('[API cleanedSources]', cleanedSources.map(s => ({ 
              title: s.title, 
              documentId: s.documentId,
              isQpro: s.isQproDocument,
              qproId: s.qproAnalysisId 
            })));
            
            // Deduplicate sources to avoid showing the same document multiple times
            response.sources = deduplicateSources(cleanedSources);
            
            // Include the document URL for the relevant document in the response
            if (cleanResults.length > 0 && response.sources.length > 0) {
              // Find the document that corresponds to the source and add its URL
              const relevantDoc = cleanResults.find(doc => doc.documentId === response.sources[0].documentId);
              if (relevantDoc && relevantDoc.documentUrl) {
                response.relevantDocumentUrl = relevantDoc.documentUrl;
              } else {
                // Fallback: try to find document by originalDocumentId if documentId doesn't match
                const relevantDocFallback = cleanResults.find(doc => doc.originalDocumentId === response.sources[0].documentId);
                if (relevantDocFallback && relevantDocFallback.documentUrl) {
                  response.relevantDocumentUrl = relevantDocFallback.documentUrl;
                }
              }
            }
            
            // Update the response results to include the visual content for caching
            // This ensures that when the response is cached, it includes the visual content needed for multimodal processing
            if (cleanResults.length > 0) {
              // Map the cleanResults (with visual content) to the response results
              response.results = cleanResults.slice(0, 3); // Use top 3 results for display when generating AI response
            }
          } catch (generationError) {
            console.error('Qwen generation failed:', generationError);
            // Don't fail the entire request if generation fails, just return search results
          }
        }

        // Store results in cache before returning - use empty object for consistency with cache retrieval
        // Before caching, ensure the response results include visual content if it exists
        await searchCacheService.setCachedResult(query, response, normalizedUnitId, normalizedCategory, {});
        return NextResponse.json(response);
      } catch (colivaraError) {
        console.error('Colivara search failed, falling back to traditional search:', colivaraError);
        // Fall back to traditional search if Colivara fails
        // Use traditional search
        console.log(`Colivara search failed for query: ${query}, falling back to traditional search`);
        const traditionalResults = await enhancedDocumentService.searchDocuments(
          query,
          unitId,
          category,
          undefined, // tags
          userId,
          page,
          limit
        );
        
        // Format traditional results to match expected response structure
        // Map traditional results to the same format as Colivara results using SuperMapper
        const formattedResults = traditionalResults.documents.map(doc => ({
          documentId: doc.id,
          title: cleanDocumentTitle(doc.title || doc.fileName || 'Untitled Document'),
          content: doc.description || '',
          score: 0.5, // Default score for traditional search
          pageNumbers: [],
          documentSection: 'description',
          confidenceScore: 0.5,
          snippet: doc.description ? doc.description.substring(0, 200) + '...' : 'No preview available',
          document: SuperMapper.createStandardDocument(doc) // Process through SuperMapper
        }));

        // Group and deduplicate results to avoid showing the same document multiple times
        const groupedResults = groupResults(formattedResults);

        // Create response object
        const response: any = {
          results: groupedResults,
          total: groupedResults.length, // Use actual deduplicated count
          page,
          limit,
          totalPages: Math.ceil(groupedResults.length / limit),
          query,
          processingTime: 0, // We don't track processing time for traditional search here
          searchType: 'traditional',
        };

        // If generateResponse is true, use Qwen to generate a response based on the search results
        if (generateResponse && groupedResults && groupedResults.length > 0) {
          try {
            // For traditional search, handle comprehensive queries similarly
            const isComprehensiveQuery = query.toLowerCase().includes('list') ||
                                        query.toLowerCase().includes('all') ||
                                        query.toLowerCase().includes('every') ||
                                        query.toLowerCase().includes('faculty') ||
                                        query.toLowerCase().includes('training') ||
                                        query.toLowerCase().includes('seminar') ||
                                        query.toLowerCase().includes('attended') ||
                                        query.toLowerCase().includes('presentation') ||
                                        query.toLowerCase().includes('research') ||
                                        (query.toLowerCase().includes('what') && query.toLowerCase().includes('training')) ||
                                        (query.toLowerCase().includes('what') && query.toLowerCase().includes('seminar')) ||
                                        (query.toLowerCase().includes('which') && query.toLowerCase().includes('training')) ||
                                        (query.toLowerCase().includes('which') && query.toLowerCase().includes('seminar'));
            
            // Use more results for comprehensive queries, but make sure we don't exceed what we have
            const resultsForGeneration = isComprehensiveQuery ?
              groupedResults.slice(0, Math.min(6, groupedResults.length)) : // Use up to 6 results for comprehensive queries
              groupedResults.slice(0, 3);  // Use top 3 results for specific queries for better context
            
            // Use generateInsights to get both the response and the sources used
            const service = getQwenService();
            if (!service) {
              throw new Error('Qwen service not configured');
            }
            const qwenResult = await service.generateInsights(
              query,
              resultsForGeneration,
              userId
            );
            
            response.generatedResponse = qwenResult.summary;
            response.generationType = generationType;
            
            // Include all relevant sources for comprehensive queries, otherwise just the top one
            // Ensure confidence is a valid number
            const cleanedSources = qwenResult.sources && qwenResult.sources.length > 0 ?
              qwenResult.sources.map(source => ({
                ...source,
                title: cleanDocumentTitle(source.title),
                confidence: clampScore(source.confidence)
              })) : [];
            
            // Deduplicate sources to avoid showing the same document multiple times
            response.sources = deduplicateSources(cleanedSources);
          } catch (generationError) {
            console.error('Qwen generation failed:', generationError);
            
            // Provide a fallback response when AI generation fails
            const errorMessage = generationError instanceof Error ? generationError.message : String(generationError);
            
            // Check if it's an OpenRouter configuration error
            if (errorMessage.includes('data policy') || errorMessage.includes('404') || errorMessage.includes('No endpoints found')) {
              console.error('⚠️ OpenRouter API configuration issue. Please check: https://openrouter.ai/settings/privacy');
              
              // Provide basic fallback response
              response.generatedResponse = `Found relevant documents for your query. Click on the documents below to view the full content.\n\n**Note:** AI-powered insights are temporarily unavailable due to API configuration.`;
              response.generationType = 'fallback';
              
              // Create basic sources from search results if not already set
              if (!response.sources || response.sources.length === 0) {
                const basicSources = groupedResults.slice(0, Math.min(3, groupedResults.length)).map((result: any) => ({
                  title: result.title || 'Untitled Document',
                  documentId: result.documentId || result.id || '', // Use id as fallback
                  confidence: clampScore(result.score || result.confidenceScore),
                }));
                response.sources = deduplicateSources(basicSources);
              }
            }
            
            // Don't fail the entire request if generation fails, just return search results
          }
        }
        
        // Store results in cache before returning - use empty object for consistency with cache retrieval
        // Before caching, ensure the response results include visual content if it exists
        await searchCacheService.setCachedResult(query, response, normalizedUnitId, normalizedCategory, {});
        return NextResponse.json(response);
      }
    } else {
      // Use traditional search
      const traditionalResults = await enhancedDocumentService.searchDocuments(
        query,
        unitId,
        category,
        undefined, // tags
        userId,
        page,
        limit
      );
      
      // Format traditional results to match expected response structure
      // Map traditional results to the same format as Colivara results using SuperMapper
      const formattedResults = traditionalResults.documents.map(doc => ({
        documentId: doc.id,
        title: doc.title,
        content: doc.description,
        score: 0.5, // Default score for traditional search
        pageNumbers: [],
        documentSection: 'description',
        confidenceScore: 0.5,
        snippet: doc.description.substring(0, 200) + '...',
        document: SuperMapper.createStandardDocument(doc) // Process through SuperMapper
      }));

      // Group and deduplicate results to avoid showing the same document multiple times
      const groupedResults = groupResults(formattedResults);

      // Create response object
      const response: any = {
        results: groupedResults,
        total: groupedResults.length, // Use actual deduplicated count
        page,
        limit,
        totalPages: Math.ceil(groupedResults.length / limit),
        query,
        processingTime: 0, // We don't track processing time for traditional search here
        searchType: 'traditional',
      };

      // If generateResponse is true, use Qwen to generate a response based on the search results
      if (generateResponse && groupedResults && groupedResults.length > 0) {
        try {
          // For traditional search, handle comprehensive queries similarly
          const isComprehensiveQuery = query.toLowerCase().includes('list') ||
                                    query.toLowerCase().includes('all') ||
                                    query.toLowerCase().includes('every') ||
                                    query.toLowerCase().includes('faculty') ||
                                    query.toLowerCase().includes('training') ||
                                    query.toLowerCase().includes('seminar') ||
                                    query.toLowerCase().includes('attended') ||
                                    query.toLowerCase().includes('presentation') ||
                                    query.toLowerCase().includes('research') ||
                                    (query.toLowerCase().includes('what') && query.toLowerCase().includes('training')) ||
                                    (query.toLowerCase().includes('what') && query.toLowerCase().includes('seminar')) ||
                                    (query.toLowerCase().includes('which') && query.toLowerCase().includes('training')) ||
                                    (query.toLowerCase().includes('which') && query.toLowerCase().includes('seminar'));
        
          // Use more results for comprehensive queries, but make sure we don't exceed what we have
          const resultsForGeneration = isComprehensiveQuery ?
            groupedResults.slice(0, Math.min(6, groupedResults.length)) : // Use up to 6 results for comprehensive queries
            groupedResults.slice(0, 3);  // Use top 3 results for specific queries for better context
        
          // Use generateInsights to get both the response and the sources used
          const service = getQwenService();
          if (!service) {
            throw new Error('Qwen service not configured');
          }
          const qwenResult = await service.generateInsights(
            query,
            resultsForGeneration,
            userId
          );
          
          response.generatedResponse = qwenResult.summary;
          response.generationType = generationType;
          
          // Include all relevant sources for comprehensive queries, otherwise just the top one
          // Ensure confidence is a valid number
          const cleanedSources = qwenResult.sources && qwenResult.sources.length > 0 ?
            qwenResult.sources.map(source => ({
              ...source,
              title: cleanDocumentTitle(source.title),
              confidence: clampScore(source.confidence)
            })) : [];
        
          // Deduplicate sources to avoid showing the same document multiple times
          response.sources = deduplicateSources(cleanedSources);
        } catch (generationError) {
          console.error('Qwen generation failed:', generationError);
          
          // Provide a fallback response when AI generation fails
          const errorMessage = generationError instanceof Error ? generationError.message : String(generationError);
          
          // Check if it's an OpenRouter configuration error
          if (errorMessage.includes('data policy') || errorMessage.includes('404') || errorMessage.includes('No endpoints found')) {
            console.error('⚠️ OpenRouter API configuration issue. Please check: https://openrouter.ai/settings/privacy');
            
            // Provide basic fallback response
            response.generatedResponse = `Found relevant documents for your query. Click on the documents below to view the full content.\n\n**Note:** AI-powered insights are temporarily unavailable due to API configuration.`;
            response.generationType = 'fallback';
            
            // Create basic sources from search results
            const basicSources = groupedResults.slice(0, Math.min(3, groupedResults.length)).map(result => ({
              title: result.title || 'Untitled Document',
              documentId: result.documentId || result.id || '', // Use id as fallback
              confidence: clampScore(result.score || result.confidenceScore),
            }));
            response.sources = deduplicateSources(basicSources);
          }
          
          // Don't fail the entire request if generation fails, just return search results with fallback message
        }
      }

      // Store results in cache before returning - use empty object for consistency with cache retrieval
      // Before caching, ensure the response results include visual content if it exists
      await searchCacheService.setCachedResult(query, response, normalizedUnitId, normalizedCategory, {});
      return NextResponse.json(response);
    }
  } catch (error) {
    console.error('Error in search API:', error);
    return NextResponse.json(
      { error: 'Internal server error during search' },
      { status: 500 }
    );
 }
}

export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const authResult = await requireAuth(request);
    if ('status' in authResult) { // Check if it's a NextResponse (error case)
      return authResult;
    }
    
    const { user } = authResult;

    // Parse request body
    const body = await request.json();
    const { query, unitId, category, filters, page = 1, limit = 10, useSemantic = true, generateResponse = false, generationType = 'text-only' } = body;

    if (!query) {
      return NextResponse.json(
        { error: 'Query parameter is required' },
        { status: 400 }
      );
    }

    const userId = user.id;

    // Check cache first before making expensive API calls
    // Using filters object directly for POST requests to maintain consistency with request parameters
    // Normalize "undefined" strings to proper undefined values
    const normalizedUnitId = (unitId === 'undefined') ? undefined : unitId;
    const normalizedCategory = (category === 'undefined') ? undefined : category;
    const normalizedFilters = (filters === 'undefined') ? {} : filters;
    console.log(`Checking cache for POST query: "${query}", unitId: "${normalizedUnitId}", category: "${normalizedCategory}", filters:`, normalizedFilters);
    const cachedResult = await searchCacheService.getCachedResult(query, normalizedUnitId, normalizedCategory, normalizedFilters);
    if (cachedResult) {
      console.log(`Cache hit for POST query: ${query}`);
      console.log(`Cache key used: ${generateCacheKey(query, unitId, category, filters)}`);
      
      // Enhance cached results with visual content if needed for multimodal processing
      let enhancedCachedResults = cachedResult.results;
      if (generateResponse) {
        enhancedCachedResults = await enhanceResultsWithVisualContent(cachedResult.results, query, userId);
      }
      
      // Create a new cached result object with enhanced results
      const enhancedCachedResult = {
        ...cachedResult,
        results: enhancedCachedResults
      };
      
      // If we're generating a response, we still need to call the generation service
      // because the generated content might not be cached or might have expired
      if (generateResponse) {
        try {
          const service = getQwenService();
          if (!service) {
            throw new Error('Qwen service not configured');
          }
          
          // For comprehensive queries (like "what trainings/seminars did..."), use more results
          const isComprehensiveQuery = query.toLowerCase().includes('list') ||
                                      query.toLowerCase().includes('all') ||
                                      query.toLowerCase().includes('every') ||
                                      query.toLowerCase().includes('faculty') ||
                                      query.toLowerCase().includes('training') ||
                                      query.toLowerCase().includes('seminar') ||
                                      query.toLowerCase().includes('attended') ||
                                      query.toLowerCase().includes('presentation') ||
                                      query.toLowerCase().includes('research') ||
                                      (query.toLowerCase().includes('what') && query.toLowerCase().includes('training')) ||
                                      (query.toLowerCase().includes('what') && query.toLowerCase().includes('seminar')) ||
                                      (query.toLowerCase().includes('which') && query.toLowerCase().includes('training')) ||
                                      (query.toLowerCase().includes('which') && query.toLowerCase().includes('seminar'));
          
          // Use more results for comprehensive queries, but make sure we don't exceed what we have
          const resultsForGeneration = isComprehensiveQuery ?
            enhancedCachedResult.results.slice(0, Math.min(6, enhancedCachedResult.results.length)) : // Use up to 6 results for comprehensive queries
            enhancedCachedResult.results.slice(0, 3);  // Use top 3 results for specific queries for better context
          
          const qwenResult = await service.generateInsights(
            query,
            resultsForGeneration,
            userId
          );
          
          // Add generated response to cached results
          const responseWithGeneration = {
            ...enhancedCachedResult,
            generatedResponse: qwenResult.summary,
            generationType: generationType,
            sources: qwenResult.sources,
          };
          
          // Include the document URL for the relevant document in the response
          if (enhancedCachedResult.results.length > 0 && responseWithGeneration.sources.length > 0) {
            // Find the document that corresponds to the source and add its URL
            const relevantDoc = enhancedCachedResult.results.find(doc => doc.documentId === responseWithGeneration.sources[0].documentId);
            if (relevantDoc) {
              // Access documentUrl from the relevantDoc if it exists
              const docWithUrl = relevantDoc as any;
              if (docWithUrl.documentUrl) {
                (responseWithGeneration as any).relevantDocumentUrl = docWithUrl.documentUrl;
              }
            }
          }
          
          return NextResponse.json(responseWithGeneration);
        } catch (generationError) {
          console.error('Qwen generation failed:', generationError);
          
          // Provide a fallback response when AI generation fails
          const errorMessage = generationError instanceof Error ? generationError.message : String(generationError);
          
          // Check if it's an OpenRouter configuration error
          if (errorMessage.includes('data policy') || errorMessage.includes('404') || errorMessage.includes('No endpoints found')) {
            console.error('⚠️ OpenRouter API configuration issue. Please check: https://openrouter.ai/settings/privacy');
            
            // Provide basic fallback response with cached results
            const basicSources = enhancedCachedResult.results.slice(0, Math.min(3, enhancedCachedResult.results.length)).map((result: any) => ({
              title: result.title || 'Untitled Document',
              documentId: result.documentId || result.id || '', // Use id as fallback if documentId is not set
              confidence: clampScore(result.score || result.confidenceScore),
            }));
            const fallbackResponse = {
              ...enhancedCachedResult,
              generatedResponse: `Found relevant documents for your query. Click on the documents below to view the full content.\n\n**Note:** AI-powered insights are temporarily unavailable due to API configuration.`,
              generationType: 'fallback',
              sources: deduplicateSources(basicSources),
            };
            return NextResponse.json(fallbackResponse);
          }
          
          // Return cached results even if generation fails
          return NextResponse.json(enhancedCachedResult);
        }
      }
      
      // Return cached result directly if no generation needed
      return NextResponse.json(enhancedCachedResult);
    }
    
    console.log(`Cache miss for POST query: ${query}, making API calls...`);
    console.log(`Cache key that was not found: ${generateCacheKey(query, unitId, category, filters)}`);

    let searchResults;
    let searchType = '';
    let processingTime = 0;
    
    if (useSemantic) {
      // Use Colivara hybrid search
      try {
        const colivaraResults = await colivaraService.performHybridSearch(
          query,
          {
            unitId: normalizedUnitId,
            category: normalizedCategory,
            ...normalizedFilters
          },
          userId
        );
        
        // --- ADD THIS ---
        console.log("🔍 SEARCH RESULTS LOG:", JSON.stringify(colivaraResults, null, 2));
        // ----------------
        
        searchType = 'hybrid';
        processingTime = colivaraResults.processingTime;
        
        // Filter out zombie documents (deleted from Prisma but still in Colivara) first
        const filteredResults = await filterZombieDocuments(colivaraResults.results);
        
        // Map Colivara results to standard document format using database data
        let mappedResults = await mapColivaraResultsToDocuments(filteredResults);
        
        // Group and deduplicate results to avoid showing the same document multiple times
        mappedResults = groupResults(mappedResults);
        
        // First, get valid document IDs to filter zombie documents
        const validDocumentIds = new Set(
          filteredResults.map((result: any) => {
            return result.documentId ||
                   result.id ||
                   (result.document && result.document.id) ||
                   (result.metadata && result.metadata.documentId) ||
                   (result.document && result.document.metadata.documentId) ||
                   undefined;
          }).filter((id: any) => typeof id === 'string' && id.trim() !== '' && id.length > 0)
        );

        // 1. MAP (Universal) - First, collect all Colivara document IDs to map to database IDs in a single query
        const colivaraDocIds = colivaraResults.results
          .filter((item: any) => {
            // Only include items that have a valid document ID that exists in our filtered results
            const docId = item.documentId ||
                         item.id ||
                         (item.document && item.document.id) ||
                         (item.metadata && item.metadata.documentId) ||
                         (item.document && item.document.metadata && item.document.metadata.documentId) ||
                         undefined;
            return typeof docId === 'string' && docId.trim() !== '' && validDocumentIds.has(docId);
          })
          .map((item: any) => {
            // Get the Colivara document ID
            const docData = item.document || item;
            const metadata = docData.metadata || item.metadata || {};
            
            // Validate that the document ID is in proper CUID format before using it
            const documentId = item.documentId || docData.document_id || docData.id?.toString() || "";
            const isValidDocumentId = documentId && documentId !== 'undefined' && !documentId.includes('undefined') && /^[a-z0-9]+$/i.test(documentId) && documentId.length >= 20 && documentId.length <= 30;
            
            // Extract the original database document ID from metadata if available
            const originalDocumentId = metadata.documentId || (docData.metadata && docData.metadata.documentId) || item.metadata?.documentId;
            const hasValidOriginalId = originalDocumentId && typeof originalDocumentId === 'string' && /^[a-z0-9]+$/i.test(originalDocumentId) && originalDocumentId.length >= 20 && originalDocumentId.length <= 30;
            
            return {
              colivaraDocumentId: isValidDocumentId ? documentId : "",
              originalDocumentId: hasValidOriginalId ? originalDocumentId : undefined, // Store the original database ID if available
              item: item, // Keep reference to the original item
              index: colivaraResults.results.indexOf(item) // Keep track of the index
            };
          })
          .filter((mapping: any) => mapping.colivaraDocumentId); // Only keep items with valid Colivara IDs
        
        // Query the database to map Colivara document IDs to database document IDs
        const colivaraIdsToMap = colivaraDocIds
          .filter((mapping: any) => !mapping.originalDocumentId) // Only map if we don't already have the original DB ID
          .map((mapping: any) => mapping.colivaraDocumentId);
          
        let colivaraToDbMap = new Map(); // Initialize as empty map
        
        if (colivaraIdsToMap.length > 0) {
          try {
            // Query the database to find documents that have these colivaraDocumentIds
            // Include description for better evidence display
            const dbDocuments = await prisma.document.findMany({
              where: {
                colivaraDocumentId: { in: colivaraIdsToMap }
              },
              select: {
                id: true,
                colivaraDocumentId: true,
                description: true, // Include description for fallback evidence
                title: true, // Include title for better display
              }
            });
            
            // Create a map from Colivara ID to database info
            colivaraToDbMap = new Map(dbDocuments.map(doc => [doc.colivaraDocumentId, {
              id: doc.id,
              description: doc.description,
              title: doc.title,
            }]));
          } catch (error) {
            console.error('Error querying database for colivara document IDs:', error);
          }
        }
        
        // Now map the results with proper document IDs
        const mappableResults = colivaraResults.results
          .filter((item: any) => {
            // Only include items that have a valid document ID that exists in our filtered results
            const docId = item.documentId ||
                         item.id ||
                         (item.document && item.document.id) ||
                         (item.metadata && item.metadata.documentId) ||
                         (item.document && item.document.metadata && item.document.metadata.documentId) ||
                         undefined;
            return typeof docId === 'string' && docId.trim() !== '' && validDocumentIds.has(docId);
          });
        
        // Use Promise.all to handle async mapping
        const rawMapped = await Promise.all(mappableResults.map(async (item: any, index: number) => {
            const docData = item.document || item;
            const metadata = docData.metadata || item.metadata || {};
            
            // 1. Get Raw Image - Try multiple possible locations for image data
            let rawImage = docData.img_base64 ||
                          item.img_base64 ||
                          docData.image ||
                          metadata.image ||
                          item.visualContent ||
                          (item.document && item.document.visualContent) ||
                          (item.extracted_content && item.extracted_content.image) ||
                          null;

            // 1. Clean the string if it has data URL prefix
            if (rawImage && typeof rawImage === 'string') {
                rawImage = rawImage.replace(/^data:image\/[a-z]+;base64,/, "");
            }

            // 2. DETECT MIME TYPE FROM DATA (The Fix)
            // Don't rely on the filename. Look at the first few characters of the code.
            let mimeType = 'image/jpeg'; // Default
            if (rawImage && typeof rawImage === 'string') {
                if (rawImage.startsWith('iVBOR')) {
                    mimeType = 'image/png';
                } else if (rawImage.startsWith('/9j/')) {
                    mimeType = 'image/jpeg';
                }
            }
            
            // Helper to find text - Try multiple possible locations for extracted text
            const txt = docData.text ||
                       item.content ||
                       metadata.text ||
                       item.extractedText ||
                       (item.document && item.document.extractedText) ||
                       (item.extracted_content && item.extracted_content.text) ||
                       (item.extracted_content && item.extracted_content.content) ||
                       metadata.extracted_text ||
                       "";
            
            // SCORE FIX: If Colivara returns 0 but it's the top result, imply relevance based on rank
            let score = docData.raw_score || docData.score || item.score || 0;
            if (score === 0 && index === 0) score = 0.99; // Top result is logically relevant
            if (score === 0 && index === 1) score = 0.80;
            
            // 2. DETECT MIME TYPE FROM DATA (The Fix)
            // Don't rely on the filename. Look at the first few characters of the code.
            let detectedMimeType = 'image/jpeg'; // Default
            if (rawImage && typeof rawImage === 'string') {
                if (rawImage.startsWith('iVBOR')) {
                    detectedMimeType = 'image/png';
                } else if (rawImage.startsWith('/9j/')) {
                    detectedMimeType = 'image/jpeg';
                }
            }
            
            // IMAGE DEBUG: Log image size and header
            if (rawImage && typeof rawImage === 'string') {
                console.log(`📸 IMAGE DEBUG [${metadata.originalName || metadata.title || docData.document_name || "Untitled"}]: Size = ${rawImage.length} characters`);
                console.log(`   Header check: ${rawImage.substring(0, 30)}...`);
            } else {
                console.log(`❌ NO IMAGE found for ${metadata.originalName || metadata.title || docData.document_name || "Untitled"}`);
            }
            
            // Validate that the document ID is in proper CUID format before using it
            const documentId = item.documentId || docData.document_id || docData.id?.toString() || "";
            const isValidDocumentId = documentId && documentId !== 'undefined' && !documentId.includes('undefined') && /^[a-z0-9]+$/i.test(documentId) && documentId.length >= 20 && documentId.length <= 30;
            
            // Extract the original database document ID from metadata if available
            const originalDocumentId = metadata.documentId || (docData.metadata && docData.metadata.documentId) || item.metadata?.documentId;
            const hasValidOriginalId = originalDocumentId && typeof originalDocumentId === 'string' && /^[a-z0-9]+$/i.test(originalDocumentId) && originalDocumentId.length >= 20 && originalDocumentId.length <= 30;
            
            // Try to get the database document info by looking up the Colivara ID in our map
            let finalDocumentId = hasValidOriginalId ? originalDocumentId : undefined;
            let dbInfo = null;
            
            if (!finalDocumentId && isValidDocumentId && colivaraToDbMap.has(documentId)) {
              dbInfo = colivaraToDbMap.get(documentId);
              finalDocumentId = dbInfo?.id;
            }
            
            // If we still don't have a valid database ID, try looking up by the document ID directly
            // This handles the case where documentId IS the database ID
            if (!finalDocumentId && isValidDocumentId) {
              // Check if the documentId itself is a valid database document
              try {
                const directDoc = await prisma.document.findFirst({
                  where: {
                    id: documentId,
                    status: 'ACTIVE',
                  },
                  select: {
                    id: true,
                    description: true,
                    title: true,
                  },
                });
                if (directDoc) {
                  finalDocumentId = directDoc.id;
                  dbInfo = {
                    id: directDoc.id,
                    description: directDoc.description,
                    title: directDoc.title,
                  };
                  console.log(`✅ [POST] Document ID ${documentId} is a valid database ID`);
                }
              } catch (directLookupError) {
                // Ignore - the document might not exist with this ID
              }
            }
            
            // Get database description for fallback
            const dbDescription = dbInfo?.description || '';
            const dbTitle = dbInfo?.title || '';
            
            // Use the final document ID (database ID) for the URL, fallback to Colivara ID if not found
            const previewDocumentId = finalDocumentId || (isValidDocumentId ? documentId : undefined);
            
            return {
              documentId: isValidDocumentId ? documentId : "",
              originalDocumentId: finalDocumentId, // Store the database document ID if available
              title: cleanDocumentTitle(metadata.originalName || metadata.title || dbTitle || docData.document_name || (docData.title && cleanDocumentTitle(docData.title)) || (item.title && cleanDocumentTitle(item.title)) || "Untitled"),
              content: txt || dbDescription || "Visual content only", // Required field for SearchResult
              
              // UI Snippet: Show what we actually found - use extracted text, then db description, then helpful message
              snippet: (() => {
                if (txt && txt.trim().length > 20) {
                  return txt.substring(0, 300) + (txt.length > 300 ? "..." : "");
                } else if (dbDescription && dbDescription.trim().length > 20) {
                  return dbDescription.substring(0, 300) + (dbDescription.length > 300 ? "..." : "");
                } else {
                  return "Document matched your search query. Click to view full content.";
                }
              })(),
              
              score: score,
              pageNumbers: [], // Required field for SearchResult
              document: {}, // Required field for SearchResult
              screenshots: rawImage ? [rawImage] : [],
              mimeType: detectedMimeType, // Pass the TRUE type
              extractedText: txt,
              // Include document URL for redirect functionality - use the database document ID if available
              documentUrl: finalDocumentId ? `/repository/preview/${finalDocumentId}` : undefined
            };
          }));

        // 2. DEDUPLICATE (Kill the Zombies)
        const uniqueMap = new Map();
        const cleanResults = [];

        for (const doc of rawMapped) {
            // Use documentId or Title as unique key to prevent duplicates
            const key = doc.documentId || doc.title;
            if (!uniqueMap.has(key)) {
                uniqueMap.set(key, true);
                cleanResults.push(doc);
            }
        }
        
        // For comprehensive queries (like "what trainings/seminars did..."), use more results
        const isComprehensiveQuery = query.toLowerCase().includes('list') ||
                                    query.toLowerCase().includes('all') ||
                                    query.toLowerCase().includes('every') ||
                                    query.toLowerCase().includes('faculty') ||
                                    query.toLowerCase().includes('training') ||
                                    query.toLowerCase().includes('seminar') ||
                                    query.toLowerCase().includes('attended') ||
                                    query.toLowerCase().includes('presentation') ||
                                    query.toLowerCase().includes('research') ||
                                    (query.toLowerCase().includes('what') && query.toLowerCase().includes('training')) ||
                                    (query.toLowerCase().includes('what') && query.toLowerCase().includes('seminar')) ||
                                    (query.toLowerCase().includes('which') && query.toLowerCase().includes('training')) ||
                                    (query.toLowerCase().includes('which') && query.toLowerCase().includes('seminar'));
        
        searchResults = isComprehensiveQuery ? cleanResults.slice(0, 6) : cleanResults.slice(0, 1); // Use more results for comprehensive queries
        
        // Update the response results to include the visual content for caching
        // This ensures that when the response is cached, it includes the visual content needed for multimodal processing
        if (cleanResults.length > 0) {
          // Map the cleanResults (with visual content) to the searchResults
          searchResults = isComprehensiveQuery ? cleanResults.slice(0, 6) : cleanResults.slice(0, 1);
        }
      } catch (colivaraError) {
        console.error('Colivara search failed, falling back to traditional search:', colivaraError);
        // Fall back to traditional search if Colivara fails
        searchType = 'traditional';
        // Use traditional search
        const traditionalResults = await enhancedDocumentService.searchDocuments(
          query,
          normalizedUnitId,
          normalizedCategory,
          undefined, // tags
          userId,
          page,
          limit
        );
        
        // Format traditional results to match expected response structure
        // Map traditional results to the same format as Colivara results using SuperMapper
        const formattedResults = traditionalResults.documents.map(doc => ({
          documentId: doc.id,
          title: cleanDocumentTitle(doc.title || doc.fileName || 'Untitled Document'),
          content: doc.description || '',
          score: 0.5, // Default score for traditional search
          pageNumbers: [],
          documentSection: 'description',
          confidenceScore: 0.5,
          snippet: doc.description ? doc.description.substring(0, 200) + '...' : 'No preview available',
          document: SuperMapper.createStandardDocument(doc) // Process through SuperMapper
        }));

        // Group and deduplicate results to avoid showing the same document multiple times
        const groupedResults = groupResults(formattedResults);
        searchResults = groupedResults;
      }
    } else {
      // Use traditional search
      searchType = 'traditional';
      const traditionalResults = await enhancedDocumentService.searchDocuments(
        query,
        normalizedUnitId,
        normalizedCategory,
        undefined, // tags
        userId,
        page,
        limit
      );
      
      // Format traditional results to match expected response structure
      // Map traditional results to the same format as Colivara results using SuperMapper
      const formattedResults = traditionalResults.documents.map(doc => ({
        documentId: doc.id,
        title: cleanDocumentTitle(doc.title || doc.fileName || 'Untitled Document'),
        content: doc.description || '',
        score: 0.5, // Default score for traditional search
        pageNumbers: [],
        documentSection: 'description',
        confidenceScore: 0.5,
        snippet: doc.description ? doc.description.substring(0, 200) + '...' : 'No preview available',
        document: SuperMapper.createStandardDocument(doc) // Process through SuperMapper
      }));

      // Group and deduplicate results to avoid showing the same document multiple times
      const groupedResults = groupResults(formattedResults);
      searchResults = groupedResults;
    }

    // If generateResponse is true, use Qwen to generate a response based on the search results
    let generatedResponse = null;
    let sources: Source[] = [];
    let relevantDocumentUrl = null;
    if (generateResponse && searchResults && searchResults.length > 0) {
      try {
        // For queries asking for comprehensive lists (like faculty and their trainings), use more results
        const isComprehensiveQuery = query.toLowerCase().includes('list') ||
                                    query.toLowerCase().includes('all') ||
                                    query.toLowerCase().includes('every') ||
                                    query.toLowerCase().includes('faculty') ||
                                    query.toLowerCase().includes('training') ||
                                    query.toLowerCase().includes('seminar') ||
                                    query.toLowerCase().includes('attended') ||
                                    query.toLowerCase().includes('presentation') ||
                                    query.toLowerCase().includes('research') ||
                                    (query.toLowerCase().includes('what') && query.toLowerCase().includes('training')) ||
                                    (query.toLowerCase().includes('what') && query.toLowerCase().includes('seminar')) ||
                                    (query.toLowerCase().includes('which') && query.toLowerCase().includes('training')) ||
                                    (query.toLowerCase().includes('which') && query.toLowerCase().includes('seminar'));
        
        const resultsForGeneration = isComprehensiveQuery ?
          searchResults.slice(0, Math.min(6, searchResults.length)) : // Use up to 6 results for comprehensive queries
          searchResults.slice(0, 3);  // Use top 3 results for specific queries for better context
          
        // Use generateInsights to get both the response and the sources used
        const service = getQwenService();
        if (!service) {
          throw new Error('Qwen service not configured');
        }
        const qwenResult = await service.generateInsights(
          query,
          resultsForGeneration,
          userId
        );
        
        generatedResponse = qwenResult.summary;
        
        // Include all relevant sources for comprehensive queries, otherwise just the top one
        // Clean the title in the source and ensure we have the database document ID and QPRO info
        // Ensure confidence is a valid number
        const cleanedSources = qwenResult.sources && qwenResult.sources.length > 0 ?
          qwenResult.sources.map((source, idx) => {
            // Try to match by title first (more reliable when Qwen returns title as documentId)
            let originalResult = resultsForGeneration.find(result => {
              const resultTitle = cleanDocumentTitle(result.title || '');
              const sourceTitle = cleanDocumentTitle(source.title || '');
              const sourceDocId = source.documentId || '';
              
              return resultTitle === sourceTitle || 
                     result.documentId === sourceDocId || 
                     result.originalDocumentId === sourceDocId;
            });
            
            // If no match found, use the result at the same index
            if (!originalResult && idx < resultsForGeneration.length) {
              originalResult = resultsForGeneration[idx];
              console.log(`⚠️ Source matching by index fallback for "${source.title}"`);
            }
            
            // Use the database document ID if available, with proper validation
            let databaseDocumentId = originalResult?.originalDocumentId || originalResult?.documentId || source.documentId;
            
            // Validate that it's actually a valid CUID, not a title
            const isValidCuid = databaseDocumentId && 
                                typeof databaseDocumentId === 'string' && 
                                /^[a-z0-9]+$/i.test(databaseDocumentId) && 
                                databaseDocumentId.length >= 20 && 
                                databaseDocumentId.length <= 30;
            
            if (!isValidCuid) {
              console.warn(`⚠️ Invalid document ID for source "${source.title}": ${databaseDocumentId}`);
              // Try to find by title if the ID is invalid
              if (originalResult?.originalDocumentId) {
                databaseDocumentId = originalResult.originalDocumentId;
              }
            }
            
            // Ensure confidence is a valid number (fallback to result's score if Qwen returns 0)
            // Clamp to [0, 1] to prevent >100% relevance display
            const rawConfidence2 = (source.confidence && source.confidence > 0)
              ? source.confidence
              : (originalResult?.score || originalResult?.confidenceScore || 0.85);
            const confidence = Math.min(Math.max(rawConfidence2, 0), 1);
            
            return {
              ...source,
              title: cleanDocumentTitle(source.title),
              documentId: databaseDocumentId, // Use the database document ID for clicking
              confidence: confidence, // Ensure valid confidence score
              isQproDocument: originalResult?.isQproDocument || false,
              qproAnalysisId: originalResult?.qproAnalysisId || undefined,
            };
          }) : [];
            
        // Deduplicate sources to avoid showing the same document multiple times
        sources = deduplicateSources(cleanedSources);
          
        // Include the document URL for the relevant document in the response
        if (searchResults.length > 0 && sources.length > 0) {
          // Find the document that corresponds to the source and add its URL
          const relevantDoc = searchResults.find(doc => doc.documentId === sources[0].documentId);
          if (relevantDoc && relevantDoc.documentUrl) {
            relevantDocumentUrl = relevantDoc.documentUrl;
          } else {
            // Fallback: try to find document by originalDocumentId if documentId doesn't match
            const relevantDocFallback = searchResults.find(doc => doc.originalDocumentId === sources[0].documentId);
            if (relevantDocFallback && relevantDocFallback.documentUrl) {
              relevantDocumentUrl = relevantDocFallback.documentUrl;
            }
          }
        }
      } catch (generationError) {
        console.error('Qwen generation failed:', generationError);
        
        // Provide a fallback response when AI generation fails
        const errorMessage = generationError instanceof Error ? generationError.message : String(generationError);
        
        // Check if it's an OpenRouter configuration error
        if (errorMessage.includes('data policy') || errorMessage.includes('404') || errorMessage.includes('No endpoints found')) {
          console.error('⚠️ OpenRouter API configuration issue. Please check: https://openrouter.ai/settings/privacy');
          
          // Provide basic fallback response
          generatedResponse = `Found ${searchResults.length} relevant document${searchResults.length !== 1 ? 's' : ''} for your query. Click on the document${searchResults.length !== 1 ? 's' : ''} below to view the full content.\n\n**Note:** AI-powered insights are temporarily unavailable due to API configuration. Please check your OpenRouter settings at https://openrouter.ai/settings/privacy`;
          
          // Create basic sources from search results
          const basicSources = searchResults.slice(0, Math.min(3, searchResults.length)).map(result => ({
            title: result.title || 'Untitled Document',
            documentId: result.originalDocumentId || result.documentId,
            confidence: clampScore(result.score || result.confidenceScore),
            isQproDocument: result.isQproDocument || false,
            qproAnalysisId: result.qproAnalysisId,
          }));
          sources = deduplicateSources(basicSources);
        } else {
          // For other errors, don't provide a generated response
          generatedResponse = null;
        }
      }
    }

    // Return search results with optional generated response
    let responseResults = searchResults;
    
    // If generateResponse is true, limit results to the most relevant document
    if (generateResponse && searchResults && searchResults.length > 0) {
      // Use only the top result for display when generating AI response
      responseResults = searchResults.slice(0, 1);
    }

    const response: any = {
      results: responseResults,
      total: responseResults.length, // Use actual count after potential filtering
      page,
      limit,
      totalPages: Math.ceil(searchResults.length / limit), // Keep original total for pagination reference
      query,
      processingTime,
      searchType,
    };

    // Include generated response and sources if available
    if (generatedResponse) {
      response.generatedResponse = generatedResponse;
      response.generationType = generationType;
      response.sources = sources;
      
      // Include the document URL for the relevant document in the response
      if (relevantDocumentUrl) {
        response.relevantDocumentUrl = relevantDocumentUrl;
      }
    }

    // Store results in cache before returning
    // Before caching, ensure the response results include visual content if it exists
    await searchCacheService.setCachedResult(query, response, normalizedUnitId, normalizedCategory, normalizedFilters);
    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in search API:', error);
    return NextResponse.json(
      { error: 'Internal server error during search' },
      { status: 500 }
    );
  }
}