"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/lib/auth-context"
import { Navbar } from "@/components/navbar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { SearchIcon, FileText, TrendingUp, Eye } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import Image from "next/image"
import AuthService from '@/lib/services/auth-service';
import { Document } from '@/lib/api/types';
import SuperMapper from '@/lib/utils/super-mapper';
import QwenResponseDisplay from '@/components/qwen-response-display';
import { cleanDocumentTitle } from '@/lib/utils/document-utils';
import ChatSearchInput, { type AttachedFile } from '@/components/chat-search-input';

// Generate a unique session ID for this browser tab
function generateSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

export default function SearchPage() {
  const { user, isAuthenticated, isLoading } = useAuth()
  const router = useRouter()
  const [searchQuery, setSearchQuery] = useState("")
  const [hasPerformedSearch, setHasPerformedSearch] = useState(false)
  const [searchResults, setSearchResults] = useState<{
    documents: Document[]
  }>({
    documents: [],
  })
  const [generatedResponse, setGeneratedResponse] = useState<string | null>(null);
  const [generationType, setGenerationType] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<any[]>([]);
  const [relevantDocumentUrl, setRelevantDocumentUrl] = useState<string | undefined>(undefined);
  const [noRelevantDocuments, setNoRelevantDocuments] = useState<boolean>(false);

  // Chat-with-file state
  const [attachedFile, setAttachedFile] = useState<AttachedFile | null>(null);
  const [sessionId] = useState(() => generateSessionId());
  const [chatDocumentName, setChatDocumentName] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/");
    }
  }, [isAuthenticated, isLoading, router])

  // Cleanup temp document when file is removed or component unmounts
  const cleanupTempDocument = useCallback(async (docName: string) => {
    try {
      const token = await AuthService.getAccessToken();
      if (!token) return;
      await fetch('/api/search/chat-cleanup', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ documentName: docName }),
      });
    } catch (err) {
      console.error('[Search] Failed to cleanup temp document:', err);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (chatDocumentName) {
        cleanupTempDocument(chatDocumentName);
      }
    };
  }, [chatDocumentName, cleanupTempDocument]);

  // Handle file attachment — upload to temp Colivara collection
  const handleFileAttach = useCallback(async (file: File) => {
    setAttachedFile({ file, uploading: true });
    setChatDocumentName(null);

    try {
      const token = await AuthService.getAccessToken();
      if (!token) throw new Error('No authentication token');

      const formData = new FormData();
      formData.append('file', file);
      formData.append('sessionId', sessionId);

      const response = await fetch('/api/search/chat-upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Upload failed (${response.status})`);
      }

      const data = await response.json();
      setAttachedFile({ file, documentName: data.documentName, uploading: false });
      setChatDocumentName(data.documentName);

      // Clear previous search results when new file is attached
      setSearchResults({ documents: [] });
      setGeneratedResponse(null);
      setSources([]);
      setHasPerformedSearch(false);
      setNoRelevantDocuments(false);
    } catch (err) {
      console.error('[Search] File upload error:', err);
      setAttachedFile({
        file,
        uploading: false,
        error: err instanceof Error ? err.message : 'Upload failed',
      });
    }
  }, [sessionId]);

  // Handle file removal
  const handleFileRemove = useCallback(() => {
    if (chatDocumentName) {
      cleanupTempDocument(chatDocumentName);
    }
    setAttachedFile(null);
    setChatDocumentName(null);
    // Clear chat-specific results
    setSearchResults({ documents: [] });
    setGeneratedResponse(null);
    setSources([]);
    setHasPerformedSearch(false);
    setNoRelevantDocuments(false);
  }, [chatDocumentName, cleanupTempDocument]);

  // Perform search — routes to either global search or chat-with-file query
  const performSearch = useCallback(async (query: string) => {
    if (!query.trim()) return;

    setSearchQuery(query);
    setHasPerformedSearch(true);
    setLoading(true);
    setIsGenerating(true);

    try {
      const token = await AuthService.getAccessToken();
      if (!token) throw new Error('No authentication token found');

      let data: any;

      if (chatDocumentName && attachedFile?.documentName) {
        // ====== CHAT-WITH-FILE MODE ======
        // Query ONLY the attached temp document via the separate chat-query API
        const response = await fetch('/api/search/chat-query', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query,
            sessionId,
            documentName: chatDocumentName,
          }),
        });

        if (!response.ok) {
          if (response.status === 401) {
            await AuthService.logout();
            return;
          }
          throw new Error(`Chat query failed (${response.status})`);
        }

        data = await response.json();

        // Map chat results
        if (data.generatedResponse) {
          setGeneratedResponse(data.generatedResponse);
          setGenerationType(data.generationType || 'chat-with-file');
          setSources(data.sources || []);
          setNoRelevantDocuments(data.noRelevantDocuments || false);
          setRelevantDocumentUrl(undefined);
        } else {
          setGeneratedResponse(null);
          setSources([]);
          setNoRelevantDocuments(data.noRelevantDocuments || false);
        }
        setSearchResults({ documents: [] }); // No document cards in chat mode
      } else {
        // ====== GLOBAL SEARCH MODE ======
        // Same as before — queries the main Colivara collection
        const queryParams = new URLSearchParams();
        queryParams.append('query', query);
        queryParams.append('useSemantic', 'true');
        queryParams.append('generate', 'true');
        queryParams.append('generationType', 'text-only');

        const response = await fetch(`/api/search?${queryParams.toString()}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          if (response.status === 500) {
            console.error('Search API internal server error:', response.status);
            setSearchResults({ documents: [] });
            return;
          } else if (response.status === 401) {
            await AuthService.logout();
            return;
          } else if (response.status === 403) {
            setSearchResults({ documents: [] });
            return;
          } else {
            throw new Error(`Failed to fetch documents: ${response.status}`);
          }
        }

        data = await response.json();

        const documents = data.results.map((result: any) => result.document || result);

        if (data.generatedResponse) {
          setGeneratedResponse(data.generatedResponse);
          setGenerationType(data.generationType || 'semantic');
          setSources(data.sources || []);
          setRelevantDocumentUrl(data.relevantDocumentUrl || undefined);
          setNoRelevantDocuments(data.noRelevantDocuments || false);
        } else {
          setGeneratedResponse(null);
          setSources([]);
          setRelevantDocumentUrl(undefined);
          setNoRelevantDocuments(false);
        }

        setSearchResults({ documents: documents || [] });
      }
    } catch (error) {
      console.error('Search error:', error);
      setSearchResults({ documents: [] });
      setGeneratedResponse(null);
      setSources([]);
      setRelevantDocumentUrl(undefined);
      setNoRelevantDocuments(false);
    } finally {
      setLoading(false);
      setIsGenerating(false);
    }
  }, [chatDocumentName, attachedFile, sessionId]);

  // Suggestion pills
  const suggestions = attachedFile?.documentName
    ? [
        'Summarize the main points',
        'Extract key data and statistics',
        'Generate a quiz from this document',
      ]
    : [
        'Summarize the latest institutional memo',
        'Find forms for faculty leave',
        'What are the strategic goals of LSPU?',
      ];

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4 overflow-hidden rounded-full bg-white shadow-sm border border-gray-100">
            <Image
              src="/LSPULogo.png"
              alt="LSPU Logo"
              width={64}
              height={64}
              className="object-contain animate-spin"
            />
          </div>
          <p className="text-lg text-muted-foreground">Loading search...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  const isFileMode = !!attachedFile?.documentName;

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header — dynamically changes when a file is attached */}
        <div className="mb-8 animate-fade-in text-center">
          <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-2">AI-Powered Search</h1>
          <p className="text-muted-foreground">
            {isFileMode
              ? 'Ask questions based on your attached file'
              : 'Find documents and resources across the system'}
          </p>
        </div>

        {/* Enhanced Search Bar with Chat-with-File support */}
        <div className="mb-8 animate-fade-in max-w-4xl mx-auto">
          <ChatSearchInput
            query={searchQuery}
            onQueryChange={setSearchQuery}
            onSubmit={performSearch}
            onFileAttach={handleFileAttach}
            onFileRemove={handleFileRemove}
            attachedFile={attachedFile}
            isLoading={loading || isGenerating}
          />

          {/* Suggestion pills — shown when no search has been done yet */}
          {!hasPerformedSearch && (
            <div className="mt-4 flex flex-wrap items-center gap-2 justify-center">
              <span className="text-sm text-muted-foreground">Try asking:</span>
              {suggestions.map((suggestion, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setSearchQuery(suggestion);
                    performSearch(suggestion);
                  }}
                  className="inline-flex items-center rounded-full border border-border bg-card px-3.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Search Results */}
        {searchQuery && hasPerformedSearch && (
          <div className="animate-fade-in">
            <div className="mb-6">
              <h2 className="text-xl font-semibold">
                {loading ? 'Searching...' : (
                  generatedResponse && sources && sources.length > 0 
                    ? `Answer generated from ${sources.length} source ${sources.length === 1 ? 'document' : 'documents'}`
                    : isFileMode && generatedResponse
                      ? 'Answer from your attached file'
                      : `${searchResults.documents.length} ${searchResults.documents.length === 1 ? "result" : "results"} found for "${searchQuery}"`
                )}
              </h2>
              {generatedResponse && sources && sources.length > 0 && !isFileMode && (
                <p className="text-sm text-muted-foreground mt-1">
                  Query: &quot;{searchQuery}&quot;
                </p>
              )}
            </div>

            {/* Display generated response if available */}
            <QwenResponseDisplay
              generatedResponse={generatedResponse || ''}
              generationType={generationType}
              sources={isFileMode ? [] : sources}
              relevantDocumentUrl={relevantDocumentUrl}
              isLoading={isGenerating}
              noRelevantDocuments={noRelevantDocuments}
            />

            {/* Only show the documents tab if we're not generating and don't have a generated response */}
            {!generatedResponse && !isGenerating && !isFileMode ? (
              searchResults.documents.length > 0 && (
                <Tabs defaultValue="documents" className="w-full">
                  <TabsList className="mb-6">
                    <TabsTrigger value="documents">Documents</TabsTrigger>
                  </TabsList>

                  <TabsContent value="documents" className="space-y-4">
                    {loading ? (
                      <div className="flex justify-center py-8">
                        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
                      </div>
                    ) : (
                      searchResults.documents.map((doc, index) => {
                        const enhancedResult = Array.isArray(searchResults.documents) && searchResults.documents.length > 0 && 'documentId' in searchResults.documents[0];
                        const enhancedDoc = enhancedResult ? (searchResults as any).documents[index] : null;
                        
                        const getDocumentUrl = () => {
                          const resultWithUrl = doc as any;
                          if (resultWithUrl.isQproDocument && resultWithUrl.qproAnalysisId) {
                            return `/qpro/analysis/${resultWithUrl.qproAnalysisId}`;
                          }
                          if (enhancedDoc?.isQproDocument && enhancedDoc?.qproAnalysisId) {
                            return `/qpro/analysis/${enhancedDoc.qproAnalysisId}`;
                          }
                          if (resultWithUrl.documentUrl && resultWithUrl.documentUrl !== `/repository/preview/undefined` && !resultWithUrl.documentUrl.includes('/repository/preview/undefined')) {
                            return resultWithUrl.documentUrl;
                          }
                          if (enhancedDoc?.documentUrl && enhancedDoc.documentUrl !== `/repository/preview/undefined` && !enhancedDoc.documentUrl.includes('/repository/preview/undefined')) {
                            return enhancedDoc.documentUrl;
                          }
                          if (enhancedDoc?.originalDocumentId) {
                            return `/repository/preview/${enhancedDoc.originalDocumentId}`;
                          }
                          if (doc.colivaraDocumentId) {
                            return `/repository/preview/${doc.colivaraDocumentId}`;
                          }
                          return `/repository/preview/${doc.id}`;
                        };
                        
                        return (
                          <Card key={`${doc.id}-${index}`} className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => {
                            const url = getDocumentUrl();
                            console.log('[Search] Navigating to:', url, {
                              docId: doc.id,
                              isQpro: (doc as any).isQproDocument || enhancedDoc?.isQproDocument,
                              qproAnalysisId: (doc as any).qproAnalysisId || enhancedDoc?.qproAnalysisId,
                              documentUrl: (doc as any).documentUrl || enhancedDoc?.documentUrl,
                            });
                            router.push(url);
                          }}>
                            <CardHeader>
                              <div className="flex items-start gap-3">
                                <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center shrink-0">
                                  <FileText className="w-5 h-5 text-primary" />
                                  </div>
                                <div className="flex-1">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="flex items-center gap-2">
                                      <CardTitle className="text-lg">{cleanDocumentTitle(SuperMapper.getFieldValue(doc, 'title') || (doc as any).title || ((doc as any).document && SuperMapper.getFieldValue((doc as any).document, 'title')) || (doc as any).originalName || "Untitled Document")}</CardTitle>
                                      {((doc as any).isQproDocument || enhancedDoc?.isQproDocument) && (
                                        <Badge variant="default" className="bg-blue-600 hover:bg-blue-700">QPRO</Badge>
                                      )}
                                    </div>
                                    <Badge variant="secondary">{SuperMapper.getFieldValue(doc, 'category') || (doc as any).category || (doc as any).type || "Other files"}</Badge>
                                  </div>
                                  
                                  {/* Evidence Section */}
                                  <div className="mt-3 p-3 bg-muted/50 rounded-lg border-l-4 border-primary/30">
                                    <div className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                                      <TrendingUp className="w-3 h-3" />
                                      Evidence from document:
                                    </div>
                                    {(() => {
                                      const evidenceFromApi = (typeof window !== 'undefined' && window.__SEARCH_EVIDENCE__) ? window.__SEARCH_EVIDENCE__ : undefined;
                                      const evidence = evidenceFromApi || enhancedDoc?.evidence || (doc as any).evidence || enhancedDoc?.snippet || (doc as any).snippet || enhancedDoc?.extractedText || (doc as any).extractedText || (doc as any).content || doc.description || (doc as any).document?.description;
                                      const isMeaningfulText = evidence && 
                                        evidence.trim().length > 20 && 
                                        !evidence.toLowerCase().includes('visual content') && 
                                        !evidence.toLowerCase().includes('visual document') && 
                                        !evidence.toLowerCase().includes('ai will extract') &&
                                        !evidence.toLowerCase().includes('click to preview');
                                      if (isMeaningfulText) {
                                        const displayText = evidence.length > 300 ? evidence.substring(0, 300) + '...' : evidence;
                                        return (
                                          <CardDescription className="mt-1 text-sm italic leading-relaxed">
                                            &quot;{displayText}&quot;
                                          </CardDescription>
                                        );
                                      } else {
                                        const docDescription = doc.description || (doc as any).document?.description;
                                        if (docDescription && docDescription.trim().length > 10) {
                                          return (
                                            <CardDescription className="mt-1 text-sm italic leading-relaxed">
                                              &quot;{docDescription.substring(0, 200)}{docDescription.length > 200 ? '...' : ''}&quot;
                                            </CardDescription>
                                          );
                                        }
                                        return (
                                          <CardDescription className="mt-1 text-sm text-muted-foreground">
                                            Document matched your search query. Click to view full content.
                                          </CardDescription>
                                        );
                                      }
                                    })()}
                                  </div>
                                  
                                  <div className="flex flex-wrap gap-1 mt-2">
                                    {(doc.tags || (doc as any).keywords || []).map((tag: string, tagIndex: number) => (
                                      <Badge key={tagIndex} variant="outline" className="text-xs">
                                        {tag}
                                      </Badge>
                                    ))}
                                  </div>
                                  <div className="mt-2 flex items-center gap-3">
                                    {(enhancedDoc?.confidenceScore || (doc as any).confidenceScore || (doc as any).score) ? (
                                      <div className="inline-flex items-center gap-1 bg-primary/10 px-2 py-1 rounded-md">
                                        <span className="text-xs font-medium text-primary">
                                          Relevance: {(((enhancedDoc?.confidenceScore || (doc as any).confidenceScore || (doc as any).score) || 0.85) * 100).toFixed(0)}%
                                        </span>
                                      </div>
                                    ) : null}
                                    {(enhancedDoc?.pageNumbers?.length > 0 || (doc as any).pageNumbers?.length > 0) && (
                                      <span className="text-xs text-muted-foreground">Pages: {(enhancedDoc?.pageNumbers || (doc as any).pageNumbers).join(', ')}</span>
                                    )}
                                  </div>
                                  <div className="mt-3 flex justify-end">
                                    <Button variant="outline" size="sm" onClick={(e) => {
                                      e.stopPropagation();
                                      router.push(getDocumentUrl());
                                    }}>
                                      <Eye className="w-4 h-4 mr-1" />
                                      {((doc as any).isQproDocument || enhancedDoc?.isQproDocument) ? 'View Analysis' : 'Preview'}
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            </CardHeader>
                          </Card>
                        );
                      })
                    )}
                  </TabsContent>
                </Tabs>
              )
            ) : null}

            {!loading && searchResults.documents.length === 0 && !generatedResponse && !isGenerating && (
              <Card>
                <CardContent className="py-12 text-center">
                  <SearchIcon className="w-12 h-12 mx-auto mb-4" style={{ color: 'gray' }} />
                  <h3 className="text-lg font-semibold mb-2">No results found</h3>
                  <p className="text-muted-foreground">
                    {isFileMode
                      ? 'Try rephrasing your question about the attached document'
                      : 'Try different keywords or browse the repository'}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Empty State */}
        {!searchQuery && !hasPerformedSearch && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 animate-fade-in">
          </div>
        )}
      </main>
    </div>
  )
}

