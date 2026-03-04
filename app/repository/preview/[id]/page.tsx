'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Navbar } from '@/components/navbar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Download, Eye, FileText, RotateCcw, X, TrendingUp, Lightbulb, Target, AlertTriangle, CheckCircle2, Zap } from 'lucide-react';
import { ClientOnly } from '@/components/client-only-wrapper';
import { useToast } from '@/hooks/use-toast';
import { Document } from '@/lib/api/types';
import AuthService from '@/lib/services/auth-service';
import { ExternalLink, Loader2 } from 'lucide-react';
import DocViewer, { DocViewerRenderers } from 'react-doc-viewer';

export default function DocumentPreviewPage() {
  const { id } = useParams();
  const router = useRouter();
  const { user, isAuthenticated, isLoading } = useAuth();
  const { toast } = useToast();
  const [document, setDocument] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [qproAnalysis, setQproAnalysis] = useState<any>(null);
  const [loadingQpro, setLoadingQpro] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [authenticatedPreviewUrl, setAuthenticatedPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push('/');
    }
  }, [isAuthenticated, isLoading, router]);

  useEffect(() => {
    const fetchDocumentPreview = async () => {
      if (!id || Array.isArray(id) || !isAuthenticated || isLoading || !user) {
        return;
      }

      // Validate that the document ID is in proper CUID format before making the API call
      // We'll make this more flexible to handle both database IDs and Colivara IDs
      const isValidId = typeof id === 'string' && id.trim() !== '' && id !== 'undefined' && !id.includes('undefined') && !id.includes('.pdf') && !id.includes('.');
      if (!isValidId) {
        setError('Invalid document ID format. Please check the URL and try again. Document ID should be an identifier, not a filename.');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        // Get the JWT token from auth context
        const token = await AuthService.getAccessToken();
        if (!token) {
          throw new Error('No authentication token found');
        }

        const response = await fetch(`/api/documents/${id}/preview`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          }
        });

        if (!response.ok) {
          // Handle different response statuses appropriately
          if (response.status === 404) {
            throw new Error('Document not found. The requested document may have been deleted or the ID is incorrect.');
          } else if (response.status === 400) {
            throw new Error('Invalid document ID format. Please check the URL and try again.');
          } else if (response.status === 403) {
            throw new Error('Access denied. You do not have permission to view this document.');
          } else {
            const errorData = await response.json();
            throw new Error(errorData.error || `Failed to fetch document: ${response.status} ${response.statusText}`);
          }
        }

        const data = await response.json();
        console.log('Document data received:', data);
        console.log('Preview URL:', data.previewUrl);
        console.log('File URL:', data.fileUrl);
        console.log('File Type:', data.fileType);
        console.log('File Name:', data.fileName);
        setDocument(data);
        setPdfUrl(data.previewUrl);
        setAuthenticatedPreviewUrl(data.previewUrl);
        
        // Fetch QPRO analysis if it exists
        fetchQproAnalysis(data.id);
      } catch (err) {
        console.error('Error fetching document preview:', err);
        const errorMessage = err instanceof Error ? err.message : 'Failed to load document preview. Please try again later.';
        setError(errorMessage);
        toast({
          title: 'Error',
          description: errorMessage,
          variant: 'destructive',
        });
      } finally {
        setLoading(false);
      }
    };

    fetchDocumentPreview();
  }, [id, isAuthenticated, isLoading, user]);

  const fetchQproAnalysis = async (documentId: string) => {
    try {
      setLoadingQpro(true);
      const token = await AuthService.getAccessToken();
      if (!token) return;

      const response = await fetch(`/api/qpro/by-document/${documentId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.analysis) {
          setQproAnalysis(data.analysis);
        }
      }
    } catch (err) {
      console.error('Error fetching QPRO analysis:', err);
      // Silently fail - it's okay if no QPRO analysis exists
    } finally {
      setLoadingQpro(false);
    }
  };

  const handleDownload = async () => {
    if (!document) return;

    setIsDownloading(true);
    try {
      // Create a temporary link and trigger download using the direct download endpoint
      // The API endpoint will handle the redirect to the actual file
      const directDownloadUrl = `/api/documents/${document.id}/download-direct?token=${await AuthService.getAccessToken()}`;
      const link = globalThis.document.createElement('a');
      link.href = directDownloadUrl;
      link.download = document.fileName || `document-${document.id}`;
      globalThis.document.body.appendChild(link);
      link.click();
      globalThis.document.body.removeChild(link);
    } catch (error) {
      console.error('Download error:', error);
      toast({
        title: 'Download Error',
        description: error instanceof Error ? error.message : 'Failed to download document. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsDownloading(false);
    }
  };

  const handleBack = () => {
    router.push('/repository');
  };

  // Show loading state while authentication is being resolved
  if (isLoading || (!isAuthenticated && !user)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
          <p className="text-lg text-muted-foreground">Loading document preview...</p>
        </div>
      </div>
    );
  }

  // Redirect if not authenticated
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
          <p className="text-lg text-muted-foreground">Redirecting to login...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
          <p className="text-lg text-muted-foreground">Loading user data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <ClientOnly>
        <div className="min-h-screen bg-background">
          <Navbar />
          <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <Card>
              <CardHeader>
                <CardTitle>Document Preview Error</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-destructive">{error}</p>
                <Button onClick={handleBack} className="mt-4">
                  <X className="w-4 h-4 mr-2" />
                  Back to Repository
                </Button>
              </CardContent>
            </Card>
          </main>
        </div>
      </ClientOnly>
    );
  }

 if (loading) {
    return (
      <ClientOnly>
        <div className="min-h-screen bg-background">
          <Navbar />
          <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <div className="flex justify-center items-center h-[70vh]">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
            </div>
          </main>
        </div>
      </ClientOnly>
    );
  }

  if (!document || !pdfUrl) {
    return (
      <ClientOnly>
        <div className="min-h-screen bg-background">
          <Navbar />
          <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <Card>
              <CardHeader>
                <CardTitle>Document Not Found</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">The requested document could not be found or is not accessible.</p>
                <Button onClick={handleBack} className="mt-4">
                  <X className="w-4 h-4 mr-2" />
                  Back to Repository
                </Button>
              </CardContent>
            </Card>
          </main>
        </div>
      </ClientOnly>
    );
  }

  // Helper function to determine the appropriate preview component based on file type
  const getFilePreviewComponent = () => {
    if (!document?.fileUrl && !pdfUrl) {
      return (
        <div className="flex items-center justify-center h-full bg-gray-50">
          <div className="text-center p-8">
            <FileText className="w-16 h-16 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600">No preview URL available</p>
          </div>
        </div>
      );
    }

    // Use the authenticated preview URL
    const previewUrl = authenticatedPreviewUrl || pdfUrl || document?.fileUrl;
    console.log('Rendering preview with URL:', previewUrl);
    console.log('Document fileName:', document?.fileName);
    console.log('Document fileType:', document?.fileType);

    // Get file extension
    const fileExt = document?.fileName?.split('.').pop()?.toLowerCase() || '';
    console.log('File extension:', fileExt);

    if (viewerError) {
      return (
        <div className="flex items-center justify-center h-full bg-gray-50">
          <div className="text-center p-8">
            <AlertTriangle className="w-16 h-16 text-red-400 mx-auto mb-4" />
            <p className="text-red-600 font-medium mb-2">Preview Error</p>
            <p className="text-gray-600 text-sm">{viewerError}</p>
            <Button 
              onClick={handleDownload} 
              variant="outline" 
              className="mt-4"
            >
              <Download className="w-4 h-4 mr-2" />
              Download File Instead
            </Button>
          </div>
        </div>
      );
    }

    // Use iframe for better compatibility with most file types
    // Browsers have built-in PDF, image, and text viewers
    if (['pdf', 'txt', 'jpg', 'jpeg', 'png', 'gif'].includes(fileExt)) {
      return (
        <div className="relative w-full bg-white" style={{ height: 'calc(100vh - 220px)', minHeight: '500px' }}>
          <iframe
            src={previewUrl}
            className="w-full h-full border-0"
            title={document?.title || 'Document Preview'}
            onError={(e) => {
              console.error('Iframe error:', e);
              setViewerError('Unable to load file preview. Please try downloading the file.');
            }}
          />
        </div>
      );
    }

    // For Office documents (doc, docx, xls, xlsx, ppt, pptx), use DocViewer
    const docs = [
      {
        uri: previewUrl,
        fileName: document?.fileName || document?.title || 'document',
        fileType: document?.fileType,
      },
    ];

    return (
      <div className="relative w-full bg-white" style={{ height: 'calc(100vh - 220px)', minHeight: '500px' }}>
        <DocViewer
          documents={docs}
          pluginRenderers={DocViewerRenderers}
          config={{
            header: {
              disableHeader: false,
              disableFileName: false,
              retainURLParams: false,
            },
            csvDelimiter: ',',
            pdfZoom: {
              defaultZoom: 1.0,
              zoomJump: 0.2,
            },
            pdfVerticalScrollByDefault: true,
          }}
          style={{ 
            height: '100%',
            width: '100%'
          }}
          theme={{
            primary: '#2B4385',
            secondary: '#ffffff',
            tertiary: '#f3f4f6',
            textPrimary: '#000000',
            textSecondary: '#5b5b5b',
            textTertiary: '#00000099',
            disableThemeScrollbar: false,
          }}
        />
      </div>
    );
  };

  return (
    <ClientOnly>
      <div className="min-h-screen bg-background flex flex-col">
        <Navbar />
        <div className="flex flex-col flex-1">
          {/* Document Info Header */}
          <div className="bg-muted/20 border-b p-4">
            <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex-1 min-w-0">
                <h1 className="text-xl md:text-2xl font-bold truncate">{document.title}</h1>
                <div className="flex flex-wrap items-center gap-2 mt-1 text-sm text-muted-foreground">
                  <span>By {document.uploadedBy}</span>
                  <span>•</span>
                  <span>{new Date(document.uploadedAt).toLocaleDateString()}</span>
                  {document.category && document.category !== "Other files" && (
                    <>
                      <span>•</span>
                      <span>{document.category}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
            
            <div className="max-w-7xl mx-auto mt-3 flex flex-wrap gap-2">
              {document.tags?.map((tag, index) => (
                <Badge key={index} variant="outline" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
          
          {/* Preview Controls */}
          <div className="border-b p-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleBack}
              >
                <X className="w-4 h-4 mr-2" />
                Close
              </Button>
              {isDownloading ? (
                <Button variant="outline" size="sm" disabled>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary mr-2"></div>
                  Downloading...
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownload}
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download
                </Button>
              )}
              {qproAnalysis && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => router.push(`/qpro/analysis/${qproAnalysis.id}`)}
                >
                  <Eye className="w-4 h-4 mr-2" />
                  View Analysis
                </Button>
              )}
            </div>
            <div className="text-sm text-muted-foreground">
              {document.fileName}
            </div>
          </div>
          
          {/* File Preview */}
          {getFilePreviewComponent()}
        </div>
      </div>
    </ClientOnly>
  );
}
