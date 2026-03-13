'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Navbar } from '@/components/navbar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Download, Eye, FileText, RotateCcw, X, ZoomIn, ZoomOut, Maximize, AlertTriangle, CheckCircle2, Zap, FileJson, FileCode, FileSpreadsheet, FileArchive, Printer } from 'lucide-react';
import { ClientOnly } from '@/components/client-only-wrapper';
import { useToast } from '@/hooks/use-toast';
import { Document } from '@/lib/types';
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
  const [zoomLevel, setZoomLevel] = useState(1);

  const handleZoomIn = () => setZoomLevel(prev => Math.min(prev + 0.2, 3));
  const handleZoomOut = () => setZoomLevel(prev => Math.max(prev - 0.2, 0.2));
  const handleResetZoom = () => setZoomLevel(1);
  const handlePrint = () => {
    const previewUrl = authenticatedPreviewUrl || pdfUrl || document?.fileUrl;
    if (previewUrl) {
      const printWindow = window.open(previewUrl, '_blank');
      if (printWindow) {
        printWindow.print();
      }
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

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
    // Use the authenticated preview URL
    const previewUrl = authenticatedPreviewUrl || pdfUrl || document?.fileUrl;
    
    // Get file extension
    const fileExt = document?.fileName?.split('.').pop()?.toLowerCase() || '';

    if (!previewUrl) {
      return (
        <div className="grow bg-[#333639] relative flex items-center justify-center overflow-auto p-12 w-full h-full">
          <div className="text-center max-w-md">
            <div className="bg-white/10 p-6 rounded-full inline-block mb-6 backdrop-blur-sm">
              <FileArchive className="w-20 h-20 text-gray-400 mx-auto" />
            </div>
            <h3 className="text-2xl font-semibold text-white mb-3">No preview available</h3>
            <p className="text-gray-400 mb-8 leading-relaxed">
              This file type cannot be previewed in the browser. You can download the file to view it on your device.
            </p>
            <Button 
              onClick={handleDownload} 
              className="bg-white text-gray-900 hover:bg-gray-100 px-8 py-6 rounded-xl font-bold shadow-xl transition-all hover:scale-105"
            >
              <Download className="w-5 h-5 mr-3" />
              Download to View
            </Button>
          </div>
        </div>
      );
    }

    if (viewerError) {
      return (
        <div className="grow bg-[#333639] relative flex items-center justify-center overflow-auto p-12 w-full h-full">
          <div className="text-center max-w-md">
            <div className="bg-red-500/10 p-6 rounded-full inline-block mb-6 backdrop-blur-sm">
              <AlertTriangle className="w-20 h-20 text-red-500 mx-auto" />
            </div>
            <h3 className="text-2xl font-semibold text-white mb-3">Preview Error</h3>
            <p className="text-gray-400 mb-8 leading-relaxed">{viewerError}</p>
            <Button 
              onClick={handleDownload} 
              className="bg-white text-gray-900 hover:bg-gray-100 px-8 py-6 rounded-xl font-bold shadow-xl transition-all hover:scale-105"
            >
              <Download className="w-5 h-5 mr-3" />
              Download File Instead
            </Button>
          </div>
        </div>
      );
    }

    // Use custom image viewer for images
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExt)) {
      return (
        <div className="grow bg-[#333639] relative flex items-center justify-center overflow-hidden w-full h-full">
          <div 
            className="w-full h-full overflow-auto custom-scrollbar flex items-center justify-center p-4 md:p-8"
            style={{ 
              scrollbarWidth: 'thin',
              scrollbarColor: '#4b5563 transparent'
            }}
          >
            <img
              src={previewUrl}
              alt={document?.title || 'Document Preview'}
              className="transition-transform duration-300 ease-out shadow-2xl rounded-sm object-contain"
              style={{
                maxWidth: zoomLevel === 1 ? '100%' : 'none',
                maxHeight: zoomLevel === 1 ? '100%' : 'none',
                transform: `scale(${zoomLevel})`,
              }}
              onError={() => {
                setViewerError('Unable to load image preview.');
              }}
            />
          </div>
        </div>
      );
    }

    // Use iframe for PDF and text
    if (['pdf', 'txt'].includes(fileExt)) {
      // Add #view=FitW&navpanes=0 for PDF to default fit width and hide side panes
      const enhancedPreviewUrl = fileExt === 'pdf' ? `${previewUrl}#view=FitW&navpanes=0&toolbar=1` : previewUrl;
      
      return (
        <div className="grow bg-[#333639] relative w-full h-full overflow-hidden flex flex-col">
          <iframe
            src={enhancedPreviewUrl}
            className="w-full h-full flex-1 border-none block"
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

    if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(fileExt)) {
      return (
        <div className="grow bg-white relative w-full h-full overflow-hidden flex flex-col flex-1 doc-viewer-wrapper" style={{ minHeight: '100%' }}>
          <DocViewer
            className="react-doc-viewer-container"
            documents={docs}
            pluginRenderers={DocViewerRenderers}
            config={{
              header: {
                disableHeader: true,
                disableFileName: true,
              },
            }}
            style={{ 
              height: '100%',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              flexGrow: 1
            }}
            theme={{
              primary: '#2B4385',
              secondary: '#ffffff',
              tertiary: '#f3f4f6',
              text_primary: '#000000',
              text_secondary: '#5b5b5b',
              text_tertiary: '#00000099',
              disableThemeScrollbar: false,
            }}
          />
        </div>
      );
    }

    // Default fallback for any other file type
    return (
      <div className="grow bg-[#323639] relative w-full h-full flex flex-1 items-center justify-center overflow-auto p-12">
        <div className="text-center max-w-md">
          <div className="bg-white/10 p-6 rounded-full inline-block mb-6 backdrop-blur-sm">
            <FileArchive className="w-20 h-20 text-gray-400 mx-auto" />
          </div>
          <h3 className="text-2xl font-semibold text-white mb-3">No preview available</h3>
          <p className="text-gray-400 mb-8 leading-relaxed">
            Preview is not supported for <b>.{fileExt}</b> files. You can download the file to view it on your device.
          </p>
          <Button 
            onClick={handleDownload} 
            className="bg-white text-gray-900 hover:bg-gray-100 px-8 py-6 rounded-xl font-bold shadow-xl transition-all hover:scale-105"
          >
            <Download className="w-5 h-5 mr-3" />
            Download File
          </Button>
        </div>
      </div>
    );
  };

  const getFileIcon = (ext: string) => {
    switch (ext.toLowerCase()) {
      case 'pdf': return <FileText className="w-6 h-6 text-red-500" />;
      case 'doc':
      case 'docx': return <FileText className="w-6 h-6 text-blue-500" />;
      case 'xls':
      case 'xlsx': return <FileSpreadsheet className="w-6 h-6 text-green-500" />;
      case 'zip':
      case 'rar':
      case '7z': return <FileArchive className="w-6 h-6 text-orange-500" />;
      case 'json': return <FileJson className="w-6 h-6 text-yellow-500" />;
      case 'js':
      case 'ts':
      case 'tsx':
      case 'py':
      case 'html': return <FileCode className="w-6 h-6 text-indigo-500" />;
      default: return <FileText className="w-6 h-6 text-gray-500" />;
    }
  };

  const fileExt = document?.fileName?.split('.').pop()?.toUpperCase() || document?.fileType?.toUpperCase() || 'FILE';
  const isImage = ['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP'].includes(fileExt.toUpperCase());

  const fileExtension = document?.fileName?.split('.').pop()?.toLowerCase() || '';
  const isPrintable = ['pdf', 'txt', 'png', 'jpg', 'jpeg'].includes(fileExtension);

  return (
    <ClientOnly>
      <div className="min-h-screen bg-background flex flex-col">
        <Navbar />
        <div className="flex-1 flex flex-col p-2 md:p-4 overflow-hidden h-[calc(100vh-64px)]">
          {/* Main Container - Card Style */}
          <div className="max-w-[1700px] w-full mx-auto flex-1 flex flex-col bg-card shadow-2xl rounded-2xl overflow-hidden border preview-card-container">
            
            {/* 1. MINIMAL HEADER */}
            <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-start bg-white card-header shrink-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-gray-50 rounded-lg">
                    {getFileIcon(fileExtension)}
                  </div>
                  <h2 className="text-xl font-bold text-gray-800 truncate mr-2">
                    {document.fileName}
                  </h2>
                  <Badge variant="outline" className="text-[10px] uppercase font-bold py-0 h-5 border-gray-200 text-gray-500">
                    {fileExt}
                  </Badge>
                </div>
                
                {/* Meta Info */}
                <div className="text-sm text-gray-500 mt-2 flex items-center gap-3 flex-wrap">
                  <span className="flex items-center gap-1.5 ring-1 ring-gray-100 px-2 py-0.5 rounded-md bg-gray-50/50">
                    By {document.uploadedBy}
                  </span>
                  <span className="text-gray-300">•</span>
                  <span>{new Date(document.uploadedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                  {document.fileSize > 0 && (
                    <>
                      <span className="text-gray-300">•</span>
                      <span>{formatFileSize(document.fileSize)}</span>
                    </>
                  )}
                  {document.tags?.length > 0 && (
                    <div className="flex items-center gap-1.5 ml-2">
                       {document.tags.slice(0, 3).map((tag, i) => (
                         <span key={i} className="text-[10px] bg-primary/5 text-primary px-2 py-0.5 rounded-full font-medium">#{tag}</span>
                       ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleBack}
                  className="rounded-full hover:bg-red-50 hover:text-red-500 transition-colors"
                >
                  <X className="w-5 h-5" />
                </Button>
              </div>
            </div>

            {/* 2. TOOLBAR & CONTROLS */}
            <div className="bg-white border-b border-gray-100 px-6 py-3 flex justify-between items-center shadow-sm z-10 card-toolbar shrink-0">
              <div className="flex gap-2">
                {/* Viewer controls (Images only) */}
                {isImage && (
                  <div className="flex items-center gap-1.5 bg-gray-100/50 p-1 rounded-xl ring-1 ring-gray-200">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:bg-white hover:shadow-sm rounded-lg"
                      onClick={handleZoomOut}
                      title="Zoom Out"
                    >
                      <ZoomOut className="w-4 h-4" />
                    </Button>
                    <div className="px-3 py-1 font-mono text-[10px] font-bold text-gray-600 bg-white rounded-md shadow-inner min-w-[50px] text-center">
                      {Math.round(zoomLevel * 100)}%
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:bg-white hover:shadow-sm rounded-lg"
                      onClick={handleZoomIn}
                      title="Zoom In"
                    >
                      <ZoomIn className="w-4 h-4" />
                    </Button>
                    <div className="w-px h-4 bg-gray-200 mx-1" />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:bg-white hover:shadow-sm rounded-lg"
                      onClick={handleResetZoom}
                      title="Fit to Width"
                    >
                      <Maximize className="w-4 h-4" />
                    </Button>
                  </div>
                )}

                {qproAnalysis && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-xl border-gray-200 hover:bg-primary/5 hover:text-primary transition-all shadow-sm font-semibold h-10 px-4"
                    onClick={() => router.push(`/qpro/analysis/${qproAnalysis.id}`)}
                  >
                    <Eye className="w-4 h-4 mr-2" />
                    View Analysis
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-2">
                {isPrintable && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handlePrint}
                    className="h-10 w-10 text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"
                    title="Print Document"
                  >
                    <Printer className="w-5 h-5" />
                  </Button>
                )}
                
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleDownload}
                  disabled={isDownloading}
                  className="bg-[#2B4385] hover:bg-[#1e2f5d] text-white px-6 py-2 rounded-xl h-10 font-bold flex items-center gap-2 transition-all shadow-lg active:scale-95"
                >
                  {isDownloading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  Download File
                </Button>
              </div>
            </div>
            
            {/* 3. DYNAMIC VIEWER AREA */}
            <div className="grow pdf-viewer-wrapper flex flex-col overflow-hidden bg-[#333639]">
              {getFilePreviewComponent()}
            </div>
          </div>
        </div>
      </div>
      
      <style jsx global>{`
        .preview-card-container {
          height: calc(100vh - 120px);
          max-height: 1600px;
          display: flex;
          flex-direction: column;
        }

        .pdf-viewer-wrapper {
          flex: 1 1 auto;
          display: flex;
          flex-direction: column;
        }

        .pdf-viewer-wrapper iframe, 
        .pdf-viewer-wrapper embed {
          width: 100%;
          height: 100%;
          border: none;
          display: block;
          flex: 1 1 auto;
        }
        
        /* Fix for React Doc Viewer height cutting off Office files */
        .doc-viewer-wrapper {
          display: flex !important;
          flex-direction: column !important;
          height: 100% !important;
          min-height: 100% !important;
          flex: 1 1 auto !important;
        }
        
        .react-doc-viewer-container {
          height: 100% !important;
          width: 100% !important;
          display: flex !important;
          flex-direction: column !important;
          flex: 1 1 auto !important;
        }
        
        #react-doc-viewer, 
        #react-doc-viewer > div,
        .react-doc-viewer-container > div,
        .react-doc-viewer-container iframe {
          height: 100% !important;
          width: 100% !important;
          flex: 1 1 auto !important;
        }

        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #333639;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #4b5563;
          border-radius: 10px;
          border: 2px solid #333639;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #6b7280;
        }
      `}</style>
    </ClientOnly>
  );
}
