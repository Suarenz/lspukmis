import { ColiVara } from 'colivara-ts';
import prisma from '@/lib/prisma';
import { Document } from '@/lib/api/types';
import { ColivaraDocument, ColivaraIndex } from '@/lib/types/colivara-types';
import { colivaraErrorHandler, ColivaraError as ColivaraServiceError, ColivaraErrorType } from './colivara-error-handler';

interface DocumentMetadata {
  originalName: string;
  size: number;
  type: string;
  extension: string;
  uploadedAt: Date;
 lastModified: Date;
  hash: string;
}

interface ProcessingStatus {
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  progress?: number;
  error?: string;
  processedAt?: Date;
  num_pages?: number;  // Add page count field
}

interface SearchFilters {
  unitId?: string;
  category?: string;
  dateRange?: { start: Date; end: Date };
  fileType?: string[];
}

interface SearchResults {
  results: SearchResult[];
  total: number;
  query: string;
 processingTime: number;
}

interface SearchResult {
  documentId: string;
  title: string;
  content: string;
  score: number;
  pageNumbers: number[];
  documentSection?: string;
  confidenceScore?: number;
  snippet: string;
  document: Document;
  visualContent?: string; // Base64 encoded visual content
  extractedText?: string; // Extracted text content
  screenshots?: string[]; // Array of screenshot base64 strings
}

interface ColivaraConfig {
  apiKey: string;
  processingTimeout: number;
  maxFileSize: number;
  retryAttempts: number;
  batchSize: number;
  cacheEnabled: boolean;
  cacheTtl: number;
  defaultCollection: string;
}

class ColivaraError extends Error {
  constructor(message: string, public code?: string, public status?: number) {
    super(message);
    this.name = 'ColivaraError';
 }
}

class ColivaraApiError extends ColivaraError {
  constructor(message: string, public response?: any) {
    super(message, 'API_ERROR', response?.status);
    this.name = 'ColivaraApiError';
  }
}

class ColivaraProcessingError extends ColivaraError {
  constructor(message: string, public documentId: string) {
    super(message, 'PROCESSING_ERROR');
    this.name = 'ColivaraProcessingError';
  }
}

/**
 * Module-level cache for temporarily storing uploaded image base64 content.
 * Used as a reliable fallback when Colivara search doesn't return img_base64 for image files.
 * Entries auto-expire after 24 hours (matching temp document TTL).
 */
const tempImageCache = new Map<string, { base64: string; mimeType: string; timestamp: number }>();

/** Clean up expired entries from the image cache (older than 24 hours) */
function cleanTempImageCache() {
  const now = Date.now();
  const TTL = 24 * 60 * 60 * 1000; // 24h
  for (const [key, entry] of tempImageCache) {
    if (now - entry.timestamp > TTL) {
      tempImageCache.delete(key);
    }
  }
}

class ColivaraService {
  private client: ColiVara;
  private config: ColivaraConfig;
  private isInitialized: boolean;
  private defaultCollection: string = 'lspu-kmis-documents';
  private tempCollection: string = 'lspu-kmis-chat-temp';

  constructor(config?: Partial<ColivaraConfig>) {
    this.config = this.mergeConfig(config);
    this.client = new ColiVara(this.config.apiKey);
    this.isInitialized = false;
  }

  private mergeConfig(userConfig?: Partial<ColivaraConfig>): ColivaraConfig {
    return {
      apiKey: process.env.COLIVARA_API_KEY || userConfig?.apiKey || '',
      processingTimeout: userConfig?.processingTimeout || 300000, // 5 minutes default
      maxFileSize: userConfig?.maxFileSize || 52428800, // 50MB default
      retryAttempts: userConfig?.retryAttempts || 3,
      batchSize: userConfig?.batchSize || 10,
      cacheEnabled: userConfig?.cacheEnabled ?? true,
      cacheTtl: userConfig?.cacheTtl || 3600000, // 1 hour default
      defaultCollection: userConfig?.defaultCollection || 'lspu-kmis-documents',
    };
  }

  async initialize(): Promise<void> {
    try {
      // Validate API key by checking health
      await this.validateApiKey();
      
      // Ensure the default collection exists
      await this.ensureDefaultCollection();
      
      this.isInitialized = true;
      console.log('Colivara service initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Colivara service:', error);
      throw error;
    }
  }

  async validateApiKey(): Promise<boolean> {
    try {
      // Test connectivity to Colivara service using the health check
      if (typeof this.client.checkHealth !== 'function') {
        throw new ColivaraApiError('Colivara client does not have a checkHealth method');
      }
      await this.client.checkHealth();
      return true;
    } catch (error) {
      console.error('API key validation failed:', error);
      throw colivaraErrorHandler.convertErrorToColivaraError(error);
    }
  }

  private async ensureDefaultCollection(): Promise<void> {
    try {
      // Try to get the collection first
      if (typeof this.client.getCollection !== 'function') {
        throw new ColivaraApiError('Colivara client does not have a getCollection method');
      }
      
      try {
        await this.client.getCollection({ collection_name: this.config.defaultCollection });
        console.log(`Collection '${this.config.defaultCollection}' already exists`);
      } catch (error) {
        // Check if the error is because the method doesn't exist or collection doesn't exist
        if (error instanceof TypeError || (error instanceof Error && error.message.includes('method'))) {
          throw error; // Re-throw if it's a method not found error
        }
        
        // If collection doesn't exist, create it
        console.log(`Creating collection '${this.config.defaultCollection}'`);
        
        if (typeof this.client.createCollection !== 'function') {
          throw new ColivaraApiError('Colivara client does not have a createCollection method');
        }
        
        await this.client.createCollection({
          name: this.config.defaultCollection,
          metadata: {
            description: 'Default collection for LSPU KMIS documents',
            created_at: new Date().toISOString()
          }
        });
        console.log(`Collection '${this.config.defaultCollection}' created successfully`);
      }
    } catch (error) {
      console.error(`Failed to ensure default collection exists:`, error);
      throw error;
    }
  }

  async uploadDocument(fileUrl: string, documentId: string, metadata: DocumentMetadata, base64Content?: string): Promise<string> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      // Update document status to PROCESSING using raw SQL since Prisma client hasn't been updated
      await prisma.$executeRaw`
        UPDATE documents
        SET "colivaraProcessingStatus" = 'PROCESSING', "colivaraChecksum" = ${metadata.hash}
        WHERE id = ${documentId}
      `;

      // Check if the upsertDocument method exists
      if (typeof this.client.upsertDocument !== 'function') {
        throw new ColivaraApiError('Colivara client does not have an upsertDocument method');
      }
      
      // Validate document metadata before upload
      if (!documentId || typeof documentId !== 'string') {
        throw new ColivaraApiError('Invalid document ID provided for upload');
      }

      // Validate document name
      const documentName = `${documentId}_${metadata.originalName}`;
      if (!documentName || documentName.length > 255) {
        throw new ColivaraApiError('Document name is invalid or too long');
      }

      // Validate collection name
      if (!this.config.defaultCollection || typeof this.config.defaultCollection !== 'string') {
        throw new ColivaraApiError('Invalid collection name provided');
      }

      // Prepare upload parameters
      const uploadParams: any = {
        name: documentName,
        collection_name: this.config.defaultCollection,
        metadata: {
          documentId,
          title: metadata.originalName, // Ensure the title is stored in metadata for proper display
          ...metadata
        },
        wait: false // Don't wait for processing to complete, we'll check status separately
      };

      // If base64 content is provided, use it instead of the URL
      if (base64Content) {
        console.log('Uploading document with base64 content:', {
          name: documentName,
          collection_name: this.config.defaultCollection,
          metadata: {
            documentId,
            ...metadata
          }
        });
        uploadParams.document_base64 = base64Content; // Use document_base64 instead of content for Colivara API
      } else {
        // If no base64 content provided, use the URL (fallback for backward compatibility)
        if (!fileUrl || typeof fileUrl !== 'string') {
          throw new ColivaraApiError('Invalid file URL provided for upload');
        }
        console.log('Uploading document with URL:', {
          name: documentName,
          collection_name: this.config.defaultCollection,
          document_url: fileUrl,
          metadata: {
            documentId,
            ...metadata
          }
        });
        uploadParams.document_url = fileUrl;
      }

      const response = await this.client.upsertDocument(uploadParams);

      console.log('Upload response received:', response);

      // Extract document ID from response - adjust based on actual API response structure
      // Ensure we return a string value, not the entire response object
      const responseObj = response as any;
      const documentIdFromResponse = responseObj.id || responseObj.documentId || responseObj.name ||
                                    (typeof response === 'string' ? response : documentName);

      if (!documentIdFromResponse) {
        throw new ColivaraApiError('Invalid response from upsertDocument - no document ID returned');
      }

      // Validate that the document ID is a proper string
      if (typeof documentIdFromResponse !== 'string' || documentIdFromResponse === '[object Object]') {
        throw new ColivaraApiError(`Invalid document ID returned from API: ${typeof documentIdFromResponse}`);
      }

      // Store the Colivara document ID using raw SQL
      await prisma.$executeRaw`
        UPDATE documents
        SET "colivaraDocumentId" = ${documentIdFromResponse}
        WHERE id = ${documentId}
      `;

      return documentIdFromResponse;
    } catch (error) {
      console.error(`Failed to upload document ${documentId} to Colivara:`, error);
      
      // Update document status to FAILED using raw SQL
      await prisma.$executeRaw`
        UPDATE documents
        SET "colivaraProcessingStatus" = 'FAILED', "colivaraMetadata" = ${JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' })}::jsonb
        WHERE id = ${documentId}
      `;

      if (error instanceof ColivaraError) {
        throw error;
      }

      throw new ColivaraProcessingError(
        `Failed to upload document to Colivara: ${error instanceof Error ? error.message : 'Unknown error'}`,
        documentId
      );
    }
  }

  async checkProcessingStatus(colivaraDocumentId: string): Promise<ProcessingStatus> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      // Validate that colivaraDocumentId is actually a string, not an object
      if (typeof colivaraDocumentId !== 'string' || colivaraDocumentId === '[object Object]' || !colivaraDocumentId) {
        throw new ColivaraApiError('Invalid document ID provided to checkProcessingStatus');
      }

      console.log(`Checking processing status for document ID: ${colivaraDocumentId}`);

      if (typeof this.client.getDocument !== 'function') {
        throw new ColivaraApiError('Colivara client does not have a getDocument method');
      }
      
      const response = await this.client.getDocument({
        document_name: colivaraDocumentId,
        collection_name: this.config.defaultCollection  // Include collection name in the request
      });

      console.log(`Processing status response for ${colivaraDocumentId}:`, response);

      // Handle the response based on the actual ColiVara API response structure
      // Since we don't have exact type information, we'll access fields safely
      return {
        status: (response as any).status as 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' || 'PENDING',
        progress: (response as any).progress || 0,
        error: (response as any).error,
        processedAt: (response as any).processedAt ? new Date((response as any).processedAt) : undefined,
        num_pages: (response as any).num_pages || (response as any).pages || (response as any).page_count || 0,  // Add page count information
      };
    } catch (error) {
      console.error(`Failed to check processing status for ${colivaraDocumentId}:`, error);
      
      // Convert error to ColivaraError to check if it's a 404
      const colivaraError = colivaraErrorHandler.convertErrorToColivaraError(error);
      
      // If it's a document not found error, return appropriate status
      if (colivaraError.type === ColivaraErrorType.DOCUMENT_NOT_FOUND) {
        console.warn(`Document ${colivaraDocumentId} not found in Colivara collections`);
        return {
          status: 'FAILED',
          error: `Document not found in Colivara: ${colivaraError.message}`,
          processedAt: new Date(),
        };
      }
      
      // For other errors, log them and re-throw
      console.error(`Error checking processing status for ${colivaraDocumentId}:`, colivaraError);
      throw colivaraError;
    }
  }

  async waitForProcessing(colivaraDocumentId: string, maxWaitTime: number = 3000): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 5000; // Check every 5 seconds

    // Add a 2-second delay before starting the status check loop
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log(`Waiting 2 seconds before starting status check for document: ${colivaraDocumentId}`);

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const status = await this.checkProcessingStatus(colivaraDocumentId);
        
        if (status.status === 'COMPLETED' || (status.num_pages !== undefined && status.num_pages > 0)) {
          return true;
        } else if (status.status === 'FAILED') {
          console.error(`Document processing failed for ${colivaraDocumentId}: ${status.error}`);
          return false;
        }
        
        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      } catch (error) {
        console.error(`Error checking processing status for ${colivaraDocumentId}:`, error);
        // If the error is due to document not being found, return false immediately
        if (error instanceof ColivaraServiceError && (error as any).type === ColivaraErrorType.DOCUMENT_NOT_FOUND) {
          console.error(`Document ${colivaraDocumentId} not found in Colivara, failing immediately`);
          return false;
        }
        return false;
      }
    }
    
    console.warn(`Processing timeout for ${colivaraDocumentId} after ${maxWaitTime}ms`);
    return false;
  }

  async performSemanticSearch(query: string, filters?: SearchFilters, userId?: string): Promise<SearchResults> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      const startTime = Date.now();
      
      let response;
      
      // Check if the search method exists on the client
      if (typeof this.client.search !== 'function') {
        console.warn('Colivara client does not have a search method, falling back to traditional search');
        return {
          results: [],
          total: 0,
          query,
          processingTime: 0,
        };
      }
      
      try {
        response = await this.client.search({
          query,
          collection_name: this.config.defaultCollection,
          top_k: 10 // Return top 10 results
          // Note: Filters are not directly supported in the search call,
          // they would need to be implemented using metadata filtering if available in the actual API
        });
      } catch (error) {
        console.error('Colivara search API call failed:', error);
        // Return empty results but don't throw, let the fallback mechanism handle it
        return {
          results: [],
          total: 0,
          query,
          processingTime: 0,
        };
      }
      const processingTime = Date.now() - startTime;

      console.log('[Colivara Search] Raw response structure:', JSON.stringify(response.results[0], null, 2).substring(0, 500));

      // Format results to match our expected structure
      const results: SearchResult[] = response.results.map((item: any) => {
        // Extract the original document ID from multiple possible locations
        let originalDocumentId = item.metadata?.documentId ||
                                (item.document && item.document.metadata?.documentId) ||
                                item.metadata?.id ||
                                item.id;
                                
        // If still not found, try to extract from document_metadata in the document object
        if (!originalDocumentId && item.document && item.document_metadata) {
          originalDocumentId = item.document.document_metadata.documentId;
        }
        
        // If still not found, try to extract directly from document_metadata property
        if (!originalDocumentId && item.document_metadata) {
          originalDocumentId = item.document_metadata.documentId;
        }
        
        // If still not found, try to extract from the document name (which contains the document ID)
        if (!originalDocumentId && item.document?.document_name) {
          // Extract document ID from document_name which is in format "docId_blobId_filename.ext"
          // We need to extract just the first part (before the first underscore)
          const nameParts = item.document.document_name.split('_');
          if (nameParts.length >= 1 && nameParts[0]) {
            // Validate it's a proper CUID format (alphanumeric, 20-30 chars)
            const potentialId = nameParts[0];
            if (/^[a-z0-9]+$/i.test(potentialId) && potentialId.length >= 20 && potentialId.length <= 30) {
              originalDocumentId = potentialId;
            } else {
              console.warn(`[Colivara] Invalid document ID extracted from name: ${potentialId}`);
            }
          }
        }
                                  
        // Extract score - prioritize raw_score/normalized_score from Colivara API
        const score = item.normalized_score || item.raw_score || item.score || item.similarity || item.prob || item.confidence || 0;
        
        // Extract content from various possible fields in Colivara response
        // Colivara is a multimodal search that returns page images (img_base64), not extracted text
        // The text content needs to be extracted from the images by the LLM
        const extractedContent = item.chunk || item.content || item.text || item.page_content || 
                                 item.metadata?.content || item.metadata?.text || 
                                 item.document?.content || item.document?.text || '';
        
        // Extract page image (this is what Colivara actually returns for visual search)
        const pageImage = item.img_base64 || item.image || item.image_data || item.base64_image;
        
        // Log what we found for debugging
        if (!extractedContent || extractedContent.trim().length === 0) {
          console.log('[Colivara Search] Document uses visual content (page images):', originalDocumentId, {
            hasPageImage: !!pageImage,
            pageNumber: item.page_number,
            score: score
          });
        }
                                  
        return {
          documentId: originalDocumentId,
          title: item.metadata?.title || item.title || item.metadata?.originalName || item.name || item.document_metadata?.title || 'Untitled Document',
          content: extractedContent || (pageImage ? 'Visual content available - text will be extracted by AI' : ''),
          score: score,
          pageNumbers: [item.page_number].filter(Boolean) || item.page_numbers || item.pageNumbers || item.pages || [],
          documentSection: item.section || item.documentSection || item.metadata?.section || '',
          confidenceScore: score, // Use the same score value for consistency
          snippet: extractedContent ? extractedContent.substring(0, 300) : (pageImage ? 'Visual content - AI will extract text from page image' : ''),
          document: item.document || item.metadata?.document || item || {} as Document,
          visualContent: pageImage, // This is the actual page image from Colivara
          extractedText: extractedContent, // Text if available
        };
      });

      return {
        results,
        total: results.length,
        query,
        processingTime,
      };
    } catch (error) {
      console.error('Semantic search failed:', error);
      // Return an empty result set in case of error
      return {
        results: [],
        total: 0,
        query,
        processingTime: 0,
      };
    }
  }

  async performHybridSearch(query: string, filters?: SearchFilters, userId?: string): Promise<SearchResults> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      // Perform semantic search with Colivara
      const semanticResults = await this.performSemanticSearch(query, filters, userId);

      // Perform traditional database search
      const traditionalResults = await this.performTraditionalSearch(query, filters, userId);

      // Combine and rank results
      const combinedResults = this.combineSearchResults(semanticResults, traditionalResults);

      return {
        results: combinedResults,
        total: combinedResults.length,
        query,
        processingTime: semanticResults.processingTime + (traditionalResults as any).processingTime || 0,
      };
    } catch (error) {
      console.error('Hybrid search failed:', error);
      // Fallback to traditional search only
      return await this.performTraditionalSearch(query, filters, userId);
    }
  }

  private async performTraditionalSearch(query: string, filters?: SearchFilters, userId?: string): Promise<SearchResults> {
    // This would use the existing search functionality from enhanced-document-service
    // For now, we'll implement a basic version
    const documents = await prisma.document.findMany({
      where: {
        AND: [
          {
            OR: [
              { title: { contains: query, mode: 'insensitive' } },
              { description: { contains: query, mode: 'insensitive' } },
              { tags: { path: ['$[*]'], string_contains: query } as any }, // Search for query string within the tags array using JSON path as array
            ]
          },
          filters?.unitId ? { unitId: filters.unitId } : {},
          filters?.category ? { category: filters.category } : {},
        ],
        status: 'ACTIVE',
      },
      include: {
        uploadedByUser: true,
        documentUnit: true,
      },
      take: 50, // Limit to 50 results
    });

    const results: SearchResult[] = documents.map((doc: any) => ({
      documentId: doc.id,
      title: doc.title,
      content: doc.description,
      score: 0.5, // Default score for traditional search
      pageNumbers: [],
      documentSection: 'description',
      confidenceScore: 0.5,
      snippet: doc.description.substring(0, 200) + '...',
      document: {
        ...doc,
        tags: Array.isArray(doc.tags) ? doc.tags as string[] : [],
        uploadedBy: doc.uploadedByUser?.name || doc.uploadedBy,
        unit: doc.documentUnit ? {
          id: doc.documentUnit.id,
          name: doc.documentUnit.name,
          code: doc.documentUnit.code,
          description: doc.documentUnit.description || undefined,
          createdAt: doc.documentUnit.createdAt,
          updatedAt: doc.documentUnit.updatedAt,
        } : undefined,
        uploadedAt: new Date(doc.uploadedAt),
        createdAt: new Date(doc.createdAt),
        updatedAt: new Date(doc.updatedAt),
        // Colivara fields (for consistency)
        colivaraDocumentId: doc.colivaraDocumentId ?? undefined,
        colivaraProcessingStatus: doc.colivaraProcessingStatus as 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' ?? undefined,
        colivaraProcessedAt: doc.colivaraProcessedAt ? new Date(doc.colivaraProcessedAt) : undefined,
        colivaraChecksum: doc.colivaraChecksum ?? undefined,
      } as Document,
    }));

    return {
      results,
      total: results.length,
      query,
      processingTime: 0, // We don't track this for traditional search here
    };
  }

  private combineSearchResults(semanticResults: SearchResults, traditionalResults: SearchResults): SearchResult[] {
   // This is a simplified combination - in a real implementation, we would have more sophisticated ranking
   const combined = [...semanticResults.results];
   
   // Add traditional results that aren't already in semantic results
   for (const tradResult of traditionalResults.results) {
     // Check if document already exists in combined results using documentId field
     const exists = combined.some(semResult => {
       const semDocId = semResult.documentId;
       const tradDocId = tradResult.documentId;
       return semDocId && tradDocId && semDocId === tradDocId;
     });
     if (!exists) {
       combined.push(tradResult);
     }
   }
   
   // Sort by score (or some combination of scores)
   const sorted = combined.sort((a, b) => (b.score || 0) - (a.score || 0));
   
   // Filter out low-relevance results (below 0.3 or 30% relevance)
   // Note: Colivara returns normalized_score which is similarity (higher = better)
   // Only filter if there are multiple results - always keep at least the top result
   const MIN_RELEVANCE_THRESHOLD = 0.3;
   if (sorted.length > 1) {
     const filtered = sorted.filter((result, index) => {
       // Always keep the top result
       if (index === 0) return true;
       // Filter out results below threshold
       return (result.score || 0) >= MIN_RELEVANCE_THRESHOLD;
     });
     return filtered;
   }
   
   return sorted;
 }

  async indexDocument(documentId: string, base64Content?: string): Promise<boolean> {
    try {
      console.log(`[Colivara] indexDocument called for ${documentId}, base64Content provided: ${!!base64Content}`);
      
      if (!this.isInitialized) {
        console.log(`[Colivara] Initializing Colivara service...`);
        await this.initialize();
      }

      // Get document from database
      const document = await prisma.document.findUnique({
        where: { id: documentId },
        include: {
          uploadedByUser: true,
          documentUnit: true,
        }
      });

      if (!document) {
        throw new ColivaraProcessingError(`Document not found: ${documentId}`, documentId);
      }

      console.log(`[Colivara] Document found: ${document.title}, fileType: ${document.fileType}, fileSize: ${document.fileSize}`);

      // Update document status to PROCESSING using raw SQL
      await prisma.$executeRaw`
        UPDATE documents
        SET "colivaraProcessingStatus" = 'PROCESSING'
        WHERE id = ${documentId}
      `;

      console.log(`[Colivara] Updated document status to PROCESSING`);

      // Upload document to Colivara for processing
      const colivaraDocId = await this.uploadDocument(
        document.fileUrl,
        documentId,
        {
          originalName: document.fileName,
          size: document.fileSize,
          type: document.fileType,
          extension: document.fileName.split('.').pop() || '',
          uploadedAt: document.uploadedAt,
          lastModified: document.updatedAt,
          hash: (document as any).colivaraChecksum || ''
        },
        base64Content // Pass the base64 content if provided
      );

      console.log(`[Colivara] Document uploaded to Colivara with ID: ${colivaraDocId}`);

      console.log('[Colivara] Upload result from upsertDocument:', { colivaraDocId, documentId });

      // Start background processing without blocking
      console.log(`[Colivara] Starting background processing for document ${documentId}`);
      this.waitForProcessingAndComplete(documentId, colivaraDocId);
      
      return true;
    } catch (error) {
      console.error(`[Colivara] Failed to index document ${documentId}:`, error);
      
      // Update document status to FAILED using raw SQL
      await prisma.$executeRaw`
        UPDATE documents
        SET "colivaraProcessingStatus" = 'FAILED'
        WHERE id = ${documentId}
      `;
      
      return false;
    }
  }

  private async waitForProcessingAndComplete(documentId: string, colivaraDocId: string): Promise<void> {
    try {
      console.log(`[Colivara] Waiting for processing to complete for document ${documentId} (${colivaraDocId})`);
      
      // Wait for processing to complete
      const completed = await this.waitForProcessing(colivaraDocId, this.config.processingTimeout);

      if (completed) {
        console.log(`[Colivara] Processing completed for document ${documentId}`);
        
        // Update document with Colivara results using raw SQL
        await prisma.$executeRaw`
          UPDATE documents
          SET "colivaraDocumentId" = ${colivaraDocId},
              "colivaraProcessingStatus" = 'COMPLETED',
              "colivaraProcessedAt" = ${new Date()}::timestamp
          WHERE id = ${documentId}
        `;

        console.log(`[Colivara] Updated document ${documentId} status to COMPLETED`);

        // Extract and store the processed content in ColivaraIndex
        await this.storeProcessedContent(documentId, colivaraDocId);
      } else {
        console.error(`[Colivara] Processing failed or timed out for document ${documentId}`);
        
        // Handle timeout or failure
        await prisma.$executeRaw`
          UPDATE documents
          SET "colivaraProcessingStatus" = 'FAILED'
          WHERE id = ${documentId}
        `;
      }
    } catch (error) {
      console.error(`[Colivara] Error completing processing for document ${documentId}:`, error);
      
      // Update document status to FAILED using raw SQL
      await prisma.$executeRaw`
        UPDATE documents
        SET "colivaraProcessingStatus" = 'FAILED'
        WHERE id = ${documentId}
      `;
    }
  }

  private async storeProcessedContent(documentId: string, colivaraDocId: string): Promise<void> {
    try {
      // Get the processed content from Colivara
      // Note: The official API might not have a direct content endpoint
      // We'll need to implement this based on what the actual API provides
      console.log(`Storing processed content for document ${documentId} with Colivara ID ${colivaraDocId}`);
      
      // For now, we'll just log this operation
      // The actual implementation would depend on what data the Colivara API returns
      // after document processing is complete
    } catch (error) {
      console.error(`Failed to store processed content for document ${documentId}:`, error);
      throw error;
    }
  }

   async updateIndex(documentId: string, base64Content?: string): Promise<boolean> {
     try {
       // Get the current document to check if it has changed
       const document = await prisma.document.findUnique({
         where: { id: documentId }
       });
 
       if (!document) {
         return false;
       }
 
       // Check if we need to reprocess (e.g., if file has changed)
       // For now, we'll just reprocess - we'll need to implement proper change detection
       // once the Prisma client is updated with new fields
       if ((document as any).colivaraProcessingStatus === 'COMPLETED' && (document as any).colivaraChecksum) {
         // In a real implementation, we would check if the file has changed
         // For now, we'll just reprocess
       }
 
       return await this.indexDocument(documentId, base64Content);
     } catch (error) {
       console.error(`Failed to update index for document ${documentId}:`, error);
       return false;
     }
   }

  async deleteFromIndex(documentId: string): Promise<boolean> {
    try {
      // Get the document first to check if it has a Colivara document ID
      const document = await prisma.document.findUnique({
        where: { id: documentId }
      });

      // If document exists and has a Colivara document ID, delete from Colivara collection
      if (document && (document as any).colivaraDocumentId) {
        try {
          // Delete from Colivara collection using the official API
          await this.client.deleteDocument({
            document_name: (document as any).colivaraDocumentId,
            collection_name: this.config.defaultCollection
          });
          console.log(`Successfully deleted document ${documentId} (${(document as any).colivaraDocumentId}) from Colivara collection`);
        } catch (colivaraError) {
          // Log the error but continue with database cleanup
          console.error(`Failed to delete document ${documentId} from Colivara collection:`, colivaraError);
          
          // Check if it's a "document not found" error, which is acceptable
          const colivaraServiceError = colivaraErrorHandler.convertErrorToColivaraError(colivaraError);
          if (colivaraServiceError.type !== ColivaraErrorType.DOCUMENT_NOT_FOUND) {
            // For other errors, log but continue with database cleanup
            console.warn(`Non-critical error deleting document from Colivara collection, proceeding with database cleanup:`, colivaraError);
          }
        }
      }

      // Delete all index entries for this document using raw SQL
      await prisma.$executeRaw`
        DELETE FROM colivara_indexes WHERE "documentId" = ${documentId}
      `;

      // Update document to reset Colivara fields using raw SQL
      await prisma.$executeRaw`
        UPDATE documents
        SET "colivaraDocumentId" = NULL,
            "colivaraEmbeddings" = NULL,
            "colivaraMetadata" = NULL,
            "colivaraProcessingStatus" = NULL,
            "colivaraProcessedAt" = NULL,
            "colivaraChecksum" = NULL
        WHERE id = ${documentId}
      `;

      return true;
    } catch (error) {
      console.error(`Failed to delete document ${documentId} from index:`, error);
      return false;
    }
  }

  async extractDocumentMetadata(colivaraDocumentId: string): Promise<any> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      // Validate that colivaraDocumentId is actually a string, not an object
      if (typeof colivaraDocumentId !== 'string' || colivaraDocumentId === '[object Object]') {
        throw new ColivaraApiError('Invalid document ID provided to extractDocumentMetadata');
      }

      if (typeof this.client.getDocument !== 'function') {
        throw new ColivaraApiError('Colivara client does not have a getDocument method');
      }
      
      const response = await this.client.getDocument({
        document_name: colivaraDocumentId,
        collection_name: this.config.defaultCollection  // Include collection name in the request
      });
      return response.metadata || response;
    } catch (error) {
      console.error(`Failed to extract metadata for ${colivaraDocumentId}:`, error);
      throw error;
    }
  }

  async processNewDocument(document: Document, fileUrl: string, base64Content?: string): Promise<void> {
    // This method processes a newly uploaded document
    // It will be called after a document is successfully uploaded to the system
    // Processing happens in the background without blocking the upload response
    console.log(`[Colivara] Processing new document: ${document.id} (${document.title})`);
    console.log(`[Colivara] Has base64Content: ${!!base64Content}, Length: ${base64Content?.length || 0}`);
    console.log(`[Colivara] File URL: ${fileUrl}`);
    this.processNewDocumentAsync(document, fileUrl, base64Content).catch((error) => {
      console.error(`[Colivara] Failed to process document ${document.id}:`, error);
    });
  }

  private async processNewDocumentAsync(document: Document, fileUrl: string, base64Content?: string): Promise<void> {
    try {
      console.log(`[Colivara] Starting async processing for document ${document.id}`);
      
      if (!base64Content) {
        console.warn(`[Colivara] No base64Content provided for document ${document.id}, skipping Colivara indexing`);
        return;
      }

      // The document should already be in the database with PENDING status
      // We just need to trigger the Colivara processing
      // Wait for indexing to complete so we can catch and log errors
      const success = await this.indexDocument(document.id, base64Content);
      
      if (success) {
        console.log(`[Colivara] Successfully indexed document ${document.id}`);
      } else {
        console.error(`[Colivara] Failed to index document ${document.id} - indexDocument returned false`);
      }
    } catch (error) {
      console.error(`[Colivara] Error processing new document ${document.id}:`, error);
      // Update status to FAILED so we know it didn't work
      try {
        await prisma.$executeRaw`
          UPDATE documents
          SET "colivaraProcessingStatus" = 'FAILED'
          WHERE id = ${document.id}
        `;
      } catch (dbError) {
        console.error(`[Colivara] Failed to update document status for ${document.id}:`, dbError);
      }
    }
 }

  async handleDocumentUpdate(documentId: string, updatedDocument: Document, fileUrl?: string, base64Content?: string): Promise<void> {
    try {
      // Handle document updates
      // If the file has changed (fileUrl is provided), reprocess the document
      if (fileUrl) {
        // Use updateIndex which will call indexDocument with the base64 content if provided
        const success = await this.updateIndex(documentId, base64Content);
        if (!success) {
          console.error(`Failed to reprocess updated document ${documentId} with Colivara`);
        }
      } else {
        // If only metadata changed, we might need to update the index differently
        // For now, just return
        return;
      }
    } catch (error) {
      console.error(`Error handling document update for ${documentId}:`, error);
    }
  }

 /**
   * Get visual content (screenshots/pages) from processed documents
   * @param colivaraDocumentId The document ID in Colivara
   * @param pageNumbers Specific pages to retrieve (optional, if not provided, returns all available)
   */
  async getVisualContent(colivaraDocumentId: string, pageNumbers?: number[]): Promise<string[]> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      // Validate that colivaraDocumentId is actually a string, not an object
      if (typeof colivaraDocumentId !== 'string' || colivaraDocumentId === '[object Object]') {
        throw new ColivaraApiError('Invalid document ID provided to getVisualContent');
      }

      console.log(`Getting visual content for document: ${colivaraDocumentId}, pages: ${pageNumbers || 'all'}`);

      // Check if the getDocumentPages method exists on the client
      if (typeof (this.client as any).getDocumentPages !== 'function') {
        console.warn('Colivara client does not have a getDocumentPages method, returning empty array');
        return [];
      }

      const response = await (this.client as any).getDocumentPages({
        document_name: colivaraDocumentId,
        collection_name: this.config.defaultCollection,
        page_numbers: pageNumbers
      });

      // Process the response to extract base64 images
      if (response && response.pages) {
        // If pages is an array of objects with image data
        if (Array.isArray(response.pages)) {
          return response.pages.map((page: any) => {
            // Return base64 image data if available, otherwise return empty string
            return page.image_data || page.image || page.base64 || '';
          }).filter((img: string) => img !== ''); // Filter out empty strings
        }
        // If response has a different structure, try to extract images
        else if (response.images && Array.isArray(response.images)) {
          return response.images;
        }
      }

      return [];
    } catch (error) {
      console.error(`Failed to get visual content for ${colivaraDocumentId}:`, error);
      return [];
    }
 }

  /**
   * Get extracted text content from processed documents
   * @param colivaraDocumentId The document ID in Colivara
   * @param pageNumbers Specific pages to retrieve text from (optional, if not provided, returns all available)
   */
  async getExtractedText(colivaraDocumentId: string, pageNumbers?: number[]): Promise<string> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      // Validate that colivaraDocumentId is actually a string, not an object
      if (typeof colivaraDocumentId !== 'string' || colivaraDocumentId === '[object Object]') {
        throw new ColivaraApiError('Invalid document ID provided to getExtractedText');
      }

      console.log(`Getting extracted text for document: ${colivaraDocumentId}, pages: ${pageNumbers || 'all'}`);

      // Check if the getDocumentText method exists on the client
      if (typeof (this.client as any).getDocumentText !== 'function') {
        console.warn('Colivara client does not have a getDocumentText method, returning empty string');
        return '';
      }

      const response = await (this.client as any).getDocumentText({
        document_name: colivaraDocumentId,
        collection_name: this.config.defaultCollection,
        page_numbers: pageNumbers
      });

      // Return the extracted text content
      return response.text || response.content || response.extracted_text || '';
    } catch (error) {
      console.error(`Failed to get extracted text for ${colivaraDocumentId}:`, error);
      return '';
    }
 }

  /**
   * Enhanced search method that includes visual content and extracted text for multimodal processing
   */
  async performEnhancedSearch(query: string, filters?: SearchFilters, userId?: string): Promise<SearchResults> {
    try {
      // First, perform the standard semantic search
      const standardResults = await this.performSemanticSearch(query, filters, userId);

      // Instead of calling getVisualContent and getExtractedText which may trigger getDocumentPages errors,
      // we'll return the standard results which should already contain the content from the search response
      // This avoids the problematic API calls while still providing data for Gemini
      return standardResults;
    } catch (error) {
      console.error('Enhanced search failed:', error);
      // Fallback to standard search
      return await this.performSemanticSearch(query, filters, userId);
    }
  }

  // ========================
  // Chat-with-File (Temporary Collection) Methods
  // These methods operate on a SEPARATE Colivara collection for ephemeral chat attachments.
  // They NEVER touch the main 'lspu-kmis-documents' collection.
  // ========================

  /**
   * Ensure the temporary chat collection exists in Colivara.
   */
  private async ensureTempCollection(): Promise<void> {
    try {
      if (typeof this.client.getCollection !== 'function') {
        throw new ColivaraApiError('Colivara client does not have a getCollection method');
      }
      try {
        await this.client.getCollection({ collection_name: this.tempCollection });
      } catch {
        console.log(`Creating temporary chat collection '${this.tempCollection}'`);
        if (typeof this.client.createCollection !== 'function') {
          throw new ColivaraApiError('Colivara client does not have a createCollection method');
        }
        await this.client.createCollection({
          name: this.tempCollection,
          metadata: {
            description: 'Temporary collection for chat-with-file attachments',
            created_at: new Date().toISOString(),
            type: 'temporary_chat',
          },
        });
        console.log(`Temporary chat collection '${this.tempCollection}' created successfully`);
      }
    } catch (error) {
      console.error('Failed to ensure temp collection exists:', error);
      throw error;
    }
  }

  /**
   * Upload a temporary file for chat-with-file. Uses a session-specific document name
   * in the separate temp collection so it never pollutes the main index.
   * @returns The Colivara document name used for the upload.
   */
  async uploadTempChatDocument(
    sessionId: string,
    fileName: string,
    base64Content: string,
  ): Promise<string> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      await this.ensureTempCollection();

      const documentName = `chat_${sessionId}_${fileName}`;

      if (typeof this.client.upsertDocument !== 'function') {
        throw new ColivaraApiError('Colivara client does not have an upsertDocument method');
      }

      console.log(`[Colivara Chat] Uploading temp document: ${documentName} to collection ${this.tempCollection}`);

      // Cache image base64 content for reliable fallback during search
      const isImageFile = fileName.match(/\.(jpg|jpeg|png|gif|webp)$/i);
      if (isImageFile) {
        const ext = fileName.split('.').pop()?.toLowerCase() || 'jpeg';
        const mimeMap: Record<string, string> = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
          gif: 'image/gif', webp: 'image/webp',
        };
        tempImageCache.set(documentName, {
          base64: base64Content,
          mimeType: mimeMap[ext] || 'image/jpeg',
          timestamp: Date.now(),
        });
        cleanTempImageCache(); // Prune old entries
        console.log(`[Colivara Chat] Cached image base64 for fallback (${base64Content.length} chars): ${documentName}`);
      }

      await this.client.upsertDocument({
        name: documentName,
        collection_name: this.tempCollection,
        document_base64: base64Content,
        metadata: {
          status: 'temporary_chat',
          session_id: sessionId,
          fileName,
          uploaded_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
        wait: true, // Wait for processing so the document is immediately searchable
      });

      console.log(`[Colivara Chat] Temp document uploaded successfully: ${documentName}`);
      return documentName;
    } catch (error) {
      console.error(`[Colivara Chat] Failed to upload temp document for session ${sessionId}:`, error);
      throw new ColivaraProcessingError(
        `Failed to upload temp chat document: ${error instanceof Error ? error.message : 'Unknown error'}`,
        sessionId,
      );
    }
  }

  /**
   * Search ONLY within the temporary chat collection for a specific session's document.
   * This never touches the main collection.
   */
  async searchTempChatDocument(
    query: string,
    sessionId: string,
    documentName: string,
  ): Promise<SearchResults> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      const startTime = Date.now();

      if (typeof this.client.search !== 'function') {
        console.warn('Colivara client does not have a search method');
        return { results: [], total: 0, query, processingTime: 0 };
      }

      const response = await this.client.search({
        query,
        collection_name: this.tempCollection,
        top_k: 10,
      });

      const processingTime = Date.now() - startTime;

      // Filter results to only include the document from this session
      let sessionResults = response.results.filter((item: any) => {
        const docName =
          item.document?.document_name ||
          item.document_name ||
          item.name ||
          '';
        return docName === documentName || docName.startsWith(`chat_${sessionId}_`);
      });

      // Special handling for image files: If we have a result but no visual content, 
      // attempt to fetch the original document to include the image
      const isImageFile = documentName.match(/\.(jpg|jpeg|png|gif|webp)$/i);
      
      // Log what Colivara actually returned for debugging
      if (sessionResults.length > 0) {
        console.log(`[Colivara Chat] Search returned ${sessionResults.length} results. First result fields:`, {
          has_img_base64: !!sessionResults[0].img_base64,
          img_base64_length: sessionResults[0].img_base64?.length || 0,
          document_name: sessionResults[0].document_name,
          page_number: sessionResults[0].page_number,
          normalized_score: sessionResults[0].normalized_score,
        });
      }

      // Check if any result actually has non-empty visual content
      const hasVisualResults = sessionResults.some((r: any) => {
        const img = r.img_base64 || r.image || r.base64_image;
        return img && typeof img === 'string' && img.length > 100; // Must be non-trivial
      });
      
      // If we're searching an image but got no results with image data,
      // we should try multiple fallback strategies to get the image for Qwen to "see"
      if (isImageFile && !hasVisualResults) {
        let imageBase64: string | null = null;
        
        // Fallback 1: Try getDocument with expand: "pages" to get page images
        try {
            console.log(`[Colivara Chat] Image file detected with no visual search results. Trying getDocument with expand=pages: ${documentName}`);
            const docResponse = await this.client.getDocument({
                document_name: documentName,
                collection_name: this.tempCollection,
                expand: "pages",
            });
            
            // Extract image from pages array (PageOut has img_base64)
            if (docResponse?.pages && Array.isArray(docResponse.pages) && docResponse.pages.length > 0) {
                const pageImg = docResponse.pages[0].img_base64;
                if (pageImg && pageImg.length > 100) {
                    imageBase64 = pageImg;
                    console.log(`[Colivara Chat] Got image from getDocument pages (${pageImg.length} chars)`);
                }
            }
        } catch (fetchError) {
            console.warn(`[Colivara Chat] getDocument with pages failed:`, fetchError);
        }
        
        // Fallback 2: Use the module-level cache from upload time
        if (!imageBase64) {
            const cached = tempImageCache.get(documentName);
            if (cached) {
                imageBase64 = cached.base64;
                console.log(`[Colivara Chat] Using cached upload base64 (${cached.base64.length} chars, type: ${cached.mimeType})`);
            }
        }
        
        // If we got an image through any fallback, inject it as a synthetic result
        if (imageBase64) {
            if (sessionResults.length > 0) {
                // Augment existing result with image data
                sessionResults[0].img_base64 = imageBase64;
                console.log(`[Colivara Chat] Augmented existing search result with image data`);
            } else {
                // Create a synthetic result with the image
                sessionResults.push({
                    document_name: documentName,
                    normalized_score: 1.0,
                    raw_score: 1.0,
                    score: 1.0,
                    content: "Image file content",
                    metadata: { fileName: documentName },
                    img_base64: imageBase64,
                    page_number: 1,
                    collection_name: this.tempCollection,
                    collection_id: 0,
                    document_id: 0,
                } as any);
                console.log(`[Colivara Chat] Created synthetic result with image data (${imageBase64.length} chars)`);
            }
        } else {
            console.warn(`[Colivara Chat] All fallback strategies failed for image file: ${documentName}`);
        }
      }

      // For non-image files (PDFs, DOCX): If search returned results but WITHOUT img_base64,
      // try to fetch page images via getDocument with expand=pages
      if (!isImageFile && sessionResults.length > 0 && !hasVisualResults) {
        try {
          console.log(`[Colivara Chat] Non-image file has results but no page images. Trying getDocument with expand=pages: ${documentName}`);
          const docResponse = await this.client.getDocument({
            document_name: documentName,
            collection_name: this.tempCollection,
            expand: "pages",
          });
          
          if (docResponse?.pages && Array.isArray(docResponse.pages)) {
            // Match page images to existing results by page_number
            for (const result of sessionResults) {
              const pageNum = result.page_number || 1;
              const matchingPage = docResponse.pages.find((p: any) => p.page_number === pageNum);
              if (matchingPage?.img_base64 && matchingPage.img_base64.length > 100) {
                result.img_base64 = matchingPage.img_base64;
              }
            }
            // If no results matched, add all pages as visual content to the first result
            if (!sessionResults.some((r: any) => r.img_base64 && r.img_base64.length > 100)) {
              const firstPageWithImage = docResponse.pages.find((p: any) => p.img_base64 && p.img_base64.length > 100);
              if (firstPageWithImage && sessionResults.length > 0) {
                sessionResults[0].img_base64 = firstPageWithImage.img_base64;
                console.log(`[Colivara Chat] Augmented first result with page image from getDocument`);
              }
            }
          }
        } catch (fetchError) {
          console.warn(`[Colivara Chat] getDocument fallback failed for non-image file:`, fetchError);
        }
      }

      const results: SearchResult[] = sessionResults.map((item: any) => {
        const score =
          item.normalized_score || item.raw_score || item.score || item.similarity || 0;
        const extractedContent =
          item.chunk || item.content || item.text || item.page_content ||
          item.metadata?.content || item.metadata?.text ||
          item.document?.content || item.document?.text || '';
        const pageImage = item.img_base64 || item.image || item.image_data || item.base64_image;

        return {
          documentId: `chat_${sessionId}`,
          title: item.metadata?.fileName || documentName,
          content: extractedContent || (pageImage ? 'Visual content available - text will be extracted by AI' : ''),
          score,
          pageNumbers: [item.page_number].filter(Boolean),
          documentSection: item.section || '',
          confidenceScore: score,
          snippet: extractedContent
            ? extractedContent.substring(0, 300)
            : pageImage
              ? 'Visual content - AI will extract text from page image'
              : '',
          document: {} as Document,
          visualContent: pageImage,
          extractedText: extractedContent,
        };
      });

      return { results, total: results.length, query, processingTime };
    } catch (error) {
      console.error(`[Colivara Chat] Search failed for session ${sessionId}:`, error);
      return { results: [], total: 0, query, processingTime: 0 };
    }
  }

  /**
   * Delete a specific temp chat document from the temp collection.
   */
  async deleteTempChatDocument(documentName: string): Promise<boolean> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      if (typeof this.client.deleteDocument !== 'function') {
        console.warn('Colivara client does not have a deleteDocument method');
        return false;
      }

      await this.client.deleteDocument({
        document_name: documentName,
        collection_name: this.tempCollection,
      });

      // Also remove from the image cache
      tempImageCache.delete(documentName);

      console.log(`[Colivara Chat] Deleted temp document: ${documentName}`);
      return true;
    } catch (error) {
      console.error(`[Colivara Chat] Failed to delete temp document ${documentName}:`, error);
      return false;
    }
  }

  /**
   * Cleanup expired temporary chat documents (older than 24 hours).
   * This is a maintenance method that should be called periodically.
   */
  async cleanupExpiredTempDocuments(): Promise<number> {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      // List all documents in the temp collection
      if (typeof (this.client as any).listDocuments !== 'function') {
        console.warn('[Colivara Chat] Client does not support listDocuments — attempting search-based cleanup');
        // Fallback: try to delete the entire temp collection and recreate it
        try {
          if (typeof this.client.deleteCollection === 'function') {
            await this.client.deleteCollection({ collection_name: this.tempCollection });
            console.log('[Colivara Chat] Deleted temp collection for cleanup');
            await this.ensureTempCollection();
            return -1; // Indicate full cleanup
          }
        } catch (deleteError) {
          console.error('[Colivara Chat] Failed to delete temp collection:', deleteError);
        }
        return 0;
      }

      const docs = await (this.client as any).listDocuments({
        collection_name: this.tempCollection,
      });

      let deletedCount = 0;
      const now = new Date();

      for (const doc of docs?.documents || docs || []) {
        const expiresAt = doc.metadata?.expires_at;
        if (expiresAt && new Date(expiresAt) < now) {
          const docName = doc.name || doc.document_name;
          if (docName) {
            await this.deleteTempChatDocument(docName);
            deletedCount++;
          }
        }
      }

      console.log(`[Colivara Chat] Cleaned up ${deletedCount} expired temp documents`);
      return deletedCount;
    } catch (error) {
      console.error('[Colivara Chat] Cleanup failed:', error);
      return 0;
    }
  }
}

export default ColivaraService;