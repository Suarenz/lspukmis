"use client";

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import AuthService from '@/lib/services/auth-service';

import { useAuth } from "@/lib/auth-context"
import { isAdmin, type UserRole } from "@/lib/utils/rbac"
import { Navbar } from "@/components/navbar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import type { Document, Unit } from "@/lib/api/types"
import { Download, Eye, FileText, Filter, Upload, SearchIcon, EyeIcon, Trash2, CheckCircle, XCircle, Building2, ChevronLeft, ChevronRight, MoreVertical, FileSpreadsheet, FileImage, File, LayoutGrid, List, Lock, Globe } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import Image from "next/image"
import { ClientOnly } from "@/components/client-only-wrapper"
import { useToast } from "@/hooks/use-toast"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { UnitSidebar } from "@/components/unit-sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const isImageFile = (fileName: string) => {
    const ext = fileName?.split('.').pop()?.toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext || '');
};

const SecureThumbnail = ({ doc, className }: { doc: Document; className?: string }) => {
  const [imgUrl, setImgUrl] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string;
    
    const fetchImage = async () => {
      try {
        const token = await AuthService.getAccessToken();
        const response = await fetch(`/api/documents/${doc.id}/view-proxy`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        
        if (response.ok) {
          const blob = await response.blob();
          objectUrl = URL.createObjectURL(blob);
          setImgUrl(objectUrl);
        } else {
          setImgUrl(doc.fileUrl || null); // fallback
        }
      } catch (error) {
        console.error("Error fetching thumbnail:", error);
        setImgUrl(doc.fileUrl || null);
      }
    };

    fetchImage();

    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [doc.id, doc.fileUrl]);

  if (!imgUrl) {
    return <div className={`bg-gray-100 animate-pulse ${className}`} />;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imgUrl}
      alt={doc.title || 'Thumbnail'}
      className={className}
      onError={(e) => {
        (e.target as HTMLImageElement).src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" fill="%23eee"><rect width="100" height="100"/></svg>';
      }}
    />
  );
};

export default function RepositoryPage() {
  const { toast } = useToast()
  const { user, isAuthenticated, isLoading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams();
  const [documents, setDocuments] = useState<Document[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [categoryFilter, setCategoryFilter] = useState<string>("all") // Define categoryFilter state
  const [unitFilter, setUnitFilter] = useState<string | null>(null) // NEW: Unit filter
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [showSuccessModal, setShowSuccessModal] = useState(false)
  const [uploadSuccessMessage, setUploadSuccessMessage] = useState<string | null>(null);
  const [deletionSuccessMessage, setDeletionSuccessMessage] = useState<string | null>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null); // Track which document is being deleted
  const [documentToDelete, setDocumentToDelete] = useState<Document | null>(null); // Track document for deletion confirmation
 const [downloadingDocId, setDownloadingDocId] = useState<string | null>(null);
  const [units, setUnits] = useState<Unit[]>([]); // NEW: Units for unit filtering
 const [sidebarOpen, setSidebarOpen] = useState(true);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [pendingRequestDoc, setPendingRequestDoc] = useState<Document | null>(null);
  const [showRequestDialog, setShowRequestDialog] = useState(false);
  const [requestReason, setRequestReason] = useState("");
  const [submittingRequest, setSubmittingRequest] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalDocs, setTotalDocs] = useState(0);
  const canUpload = user?.role === "ADMIN" || user?.role === "FACULTY" || user?.role === "PERSONNEL"
  
  // Reset upload progress when modal is closed
  useEffect(() => {
    if (!showUploadModal) {
      setUploadProgress(0);
      setUploading(false);
      setUploadError(null);
      setUploadSuccessMessage(null);
    }
  }, [showUploadModal]);

  useEffect(() => {
    // Only redirect if user is explicitly not authenticated and loading is complete
    if (!isLoading && !isAuthenticated && user === null) {
      router.push("/");
    }
  }, [isAuthenticated, isLoading, user, router])

  // Track page visibility to handle when user returns from minimized state
  // Fetch units on initial load
  useEffect(() => {
    const fetchUnits = async () => {
      try {
        // First, verify that we have a valid authentication state
        if (!isAuthenticated || !user) {
          // If not authenticated, just return to prevent further execution
          return;
        }
        
        // Then try to get the access token
        const token = await AuthService.getAccessToken();
        if (!token) {
          // If no token is available despite being authenticated, log out the user
          await AuthService.logout();
          router.push('/');
          return;
        }
        
        const response = await fetch(`/api/units`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          }
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Failed to fetch units: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        setUnits(data.units || []);
        // Clear any previous error related to units
        if (error?.includes('Failed to load units')) {
          setError(null);
        }
        
        // Set default unit filter to user's unit if available
        if (user?.unitId) {
          setUnitFilter(user.unitId);
        }
      } catch (err) {
        console.error('Error fetching units:', err);
        // Set a fallback empty units array to prevent further errors
        setUnits([]);
        // Optionally show an error to the user
        setError(err instanceof Error ? err.message : 'Failed to load units. Some functionality may be limited.');
      }
    };
    
    if (isAuthenticated && user) {
      fetchUnits();
    }
  }, [isAuthenticated, user, router, isLoading]);

  // Update unit filter from URL params
  useEffect(() => {
    const unitFromUrl = searchParams.get('unit');
    if (unitFromUrl) {
      setUnitFilter(unitFromUrl);
    } else {
      setUnitFilter(null); // Show all units when no param
    }
  }, [searchParams]);

  // Effect to handle page visibility changes
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        // When user returns to the page, check if it's been more than 5 minutes since last check
        // If it has been more than 5 minutes, revalidate the auth state and refresh documents
        const lastChecked = AuthService.getLastAuthCheck();
        const now = Date.now();
        
        // Only re-validate if more than 5 minutes have passed
        if (!lastChecked || (now - lastChecked) > 5 * 60 * 1000) {
          console.log('Page became visible, revalidating authentication and refreshing documents');
          
          try {
            // First, verify that we have a valid authentication state
            if (!isAuthenticated || !user) {
              // If not authenticated, just return to prevent further execution
              return;
            }
            
            // Then try to get a fresh access token to ensure authentication is still valid
            const token = await AuthService.getAccessToken();
            if (token) {
              // If we have a valid token, fetch documents in the background without showing loading state
              console.log('Valid token found, fetching documents in background');
              
              // Use the access token from the auth context
              const queryParams = new URLSearchParams();
              if (searchQuery) queryParams.append('search', searchQuery);
              if (categoryFilter && categoryFilter !== 'all') queryParams.append('category', categoryFilter);
              if (unitFilter) queryParams.append('unit', unitFilter);
              
              const response = await fetch(`/api/documents?${queryParams.toString()}`, {
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json',
                }
              });
            
              if (!response.ok) {
                // Check if the error response is JSON
                let errorData: { error?: string } = {};
                try {
                  errorData = await response.json();
                } catch (parseError) {
                  // If response is not JSON, create a generic error
                  errorData = { error: `HTTP error! status: ${response.status}` };
                }
                
                // If we get a 401 (unauthorized) error, the token might have expired
                if (response.status === 401) {
                  console.error('Authentication token expired, redirecting to login');
                  // Redirect to login page since token is no longer valid
                  router.push('/');
                  return;
                }
                
                throw new Error(errorData.error || `Failed to fetch documents: ${response.status} ${response.statusText}`);
              }
              
              const data = await response.json();
              setDocuments(data.documents || []);
              setError(null);
              
              // Update last check timestamp
              AuthService.setLastAuthCheck(now);
            } else {
              // If no token is available despite being authenticated, log out the user
              await AuthService.logout();
              router.push('/');
            }
          } catch (error) {
            console.error('Error during visibility change auth check:', error);
            // Don't show error to user when returning from minimized state, just log it
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [searchQuery, categoryFilter, unitFilter, router]);

   const fetchDocuments = async (page = 1) => {
     // Double-check authentication state before fetching
     if (!isAuthenticated || !user) {
       // Don't redirect here, just return to prevent further execution
       return;
     }

     try {
       // Only set loading to true if documents haven't been loaded yet
       // This prevents showing loading screen when returning from minimized state
       if (documents.length === 0) {
         setLoading(true);
       }

       // First, verify that we have a valid authentication state
       if (!isAuthenticated || !user) {
         // If not authenticated, just return to prevent further execution
         return;
       }

       // Then try to get the access token
       const token = await AuthService.getAccessToken();
       if (!token) {
         // If no token is available despite being authenticated, log out the user
         await AuthService.logout();
         router.push('/');
         return;
       }

       // Build query parameters properly
       const queryParams = new URLSearchParams();
       if (searchQuery) queryParams.append('search', searchQuery);
       if (categoryFilter && categoryFilter !== 'all') queryParams.append('category', categoryFilter);
       if (unitFilter) queryParams.append('unit', unitFilter);
       queryParams.append('page', String(page));
       queryParams.append('limit', '20');

       const response = await fetch(`/api/documents?${queryParams.toString()}`, {
         headers: {
           'Authorization': `Bearer ${token}`,
           'Content-Type': 'application/json',
         }
       });

       if (!response.ok) {
         // Check if the error response is JSON
         let errorData: { error?: string } = {};
         try {
           errorData = await response.json();
         } catch (parseError) {
           // If response is not JSON, create a generic error
           errorData = { error: `HTTP error! status: ${response.status}` };
         }

         // If we get a 401 (unauthorized) error, the token might have expired
         if (response.status === 401) {
           console.error('Authentication token expired, redirecting to login');
           // Redirect to login page since token is no longer valid
           router.push('/');
           return;
         }

         throw new Error(errorData.error || `Failed to fetch documents: ${response.status} ${response.statusText}`);
       }

       const data = await response.json();
       setDocuments(data.documents || []);
       setCurrentPage(data.page || page);
       setTotalPages(data.totalPages || 1);
       setTotalDocs(data.total || 0);
       setError(null);
     } catch (err) {
       console.error('Error fetching documents:', err);
       const errorMessage = err instanceof Error ? err.message : 'Failed to load documents. Please try again later.';
       setError(errorMessage);
       // Still set loading to false even on error to prevent being stuck in loading state
       setLoading(false);
       return; // Return early on error to prevent setting loading to false again in finally
     }

     // Set loading to false after successful fetch
     setLoading(false);
   };

  // Initial fetch of documents
  useEffect(() => {
    // Only fetch documents when we're sure the user is authenticated and loaded
    if (isAuthenticated && !isLoading && user) {
      fetchDocuments();
    }
  }, [isAuthenticated, isLoading, user, searchQuery, categoryFilter, unitFilter]); // Include filters in dependency array

  // Show loading state only during initial authentication check, not when returning from minimized state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4 overflow-hidden">
            <Image
              src="/LSPULogo.png"
              alt="LSPU Logo"
              width={64}
              height={64}
              className="object-contain animate-spin"
            />
          </div>
          <p className="text-lg text-muted-foreground">Loading repository...</p>
        </div>
      </div>
    );
  }

  // Redirect if not authenticated after initial check
  if (!isAuthenticated && !isLoading && user === null) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4 overflow-hidden">
            <Image
              src="/LSPULogo.png"
              alt="LSPU Logo"
              width={64}
              height={64}
              className="object-contain animate-spin"
            />
          </div>
          <p className="text-lg text-muted-foreground">Redirecting to login...</p>
        </div>
      </div>
    );
  }

  // Don't render if user is null but authentication is loaded
  if (!user && !isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4 overflow-hidden">
            <Image
              src="/LSPULogo.png"
              alt="LSPU Logo"
              width={64}
              height={64}
              className="object-contain animate-spin"
            />
          </div>
          <p className="text-lg text-muted-foreground">Loading user data...</p>
        </div>
      </div>
    );
  }

  const categories = ["all", "Other files", "QPRO"]; // Using standard categories
  
  // NEW: Use all units since there's no status property
  const activeUnits = units;

  const submitAccessRequest = async () => {
    if (!pendingRequestDoc) return;
    if (!requestReason.trim()) {
      toast({ title: 'Error', description: 'Please provide a reason for requesting access.', variant: 'destructive' });
      return;
    }
    setSubmittingRequest(true);
    try {
      const token = await AuthService.getAccessToken();
      const res = await fetch('/api/document-requests', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ documentId: pendingRequestDoc.id, type: 'VIEW', reason: requestReason })
      });
      if (res.ok) {
        toast({ title: 'Success', description: `Access request for "${pendingRequestDoc.title}" submitted successfully.` });
        setShowRequestDialog(false);
        setRequestReason("");
        setPendingRequestDoc(null);
      } else {
        const error = await res.json();
        toast({ title: 'Error', description: error.error || 'Failed to submit request.', variant: 'destructive' });
      }
    } catch (err) {
      console.error(err);
      toast({ title: 'Error', description: 'Failed to submit request.', variant: 'destructive' });
    } finally {
      setSubmittingRequest(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B"
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
    return (bytes / (1024 * 1024)).toFixed(1) + " MB"
  }

  // Helper to convert filename to Title Case
  const toTitleCase = (str: string) => {
    // Remove file extension first
    const nameWithoutExt = str.replace(/\.[^/.]+$/, "");
    // Replace underscores and hyphens with spaces, then convert to title case
    return nameWithoutExt
      .replace(/[-_]/g, " ")
      .split(" ")
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  };

  // Helper to get file icon based on extension
  const getFileIcon = (fileName: string) => {
    const ext = fileName?.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'pdf':
        return { icon: FileText, color: '#EF4444', bgColor: 'rgba(239, 68, 68, 0.1)' };
      case 'doc':
      case 'docx':
        return { icon: FileText, color: '#2B4385', bgColor: 'rgba(43, 67, 133, 0.1)' };
      case 'xls':
      case 'xlsx':
        return { icon: FileSpreadsheet, color: '#2E8B57', bgColor: 'rgba(46, 139, 87, 0.1)' };
      case 'jpg':
      case 'jpeg':
      case 'png':
      case 'gif':
        return { icon: FileImage, color: '#C04E3A', bgColor: 'rgba(192, 78, 58, 0.1)' };
      default:
        return { icon: File, color: '#6B7280', bgColor: 'rgba(107, 114, 128, 0.1)' };
    }
  };

  return (
    <ClientOnly>
      <div className="min-h-screen bg-background">
        <Navbar />
        <div className="flex">
          {/* Unit Sidebar */}
          {sidebarOpen && isAdmin(user?.role as UserRole) && (
            <div className="w-64 border-r bg-muted/10 hidden lg:block">
              <UnitSidebar
                units={activeUnits}
                currentUnit={unitFilter}
                onUnitSelect={(unitId) => {
                  // Navigate to the repository page with unit filter
                  if (unitId) {
                    router.push(`/repository?unit=${unitId}`);
                  } else {
                    router.push('/repository');
                  }
                }}
                userRole={user?.role || ''}
                userUnit={user?.unitId || null}
                canUpload={canUpload}
                onUploadClick={() => setShowUploadModal(true)}
              />
            </div>
          )}
          
          {/* Main Content */}
          <main className="flex-1 lg:ml-0">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
              {/* Header */}
              <div className="mb-4 animate-fade-in">
                {/* Breadcrumb */}
                <div className="text-sm border-b pb-2 text-gray-500 mb-4 font-medium flex items-center gap-2">
                  <span className="cursor-pointer hover:text-[#2B4385] transition-colors" onClick={() => router.push('/repository')}>Repository</span>
                  {unitFilter && (
                    <>
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                      <span className="cursor-pointer hover:text-[#2B4385] transition-colors" onClick={() => router.push('/repository')}>Units</span>
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                      <span className="text-[#2B4385] font-semibold">{activeUnits.find(u => u.id === unitFilter)?.name || ''}</span>
                    </>
                  )}
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div className="flex items-center gap-2">
                    {isAdmin(user?.role as UserRole) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="lg:hidden"
                        onClick={() => setSidebarOpen(!sidebarOpen)}
                      >
                        {sidebarOpen ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                      </Button>
                    )}
                    <div>
                      <h1 className="text-3xl md:text-4xl font-bold mb-2" style={{ color: '#2B4385' }}>Knowledge Repository</h1>
                      <p className="text-gray-500">Browse and access institutional knowledge resources</p>
                    </div>
                  </div>
                  {user?.role !== 'STUDENT' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-[#2B4385] border-[#2B4385] hover:bg-[#2B4385] hover:text-white shrink-0"
                      onClick={() => router.push('/repository/browse')}
                    >
                      <Globe className="w-4 h-4 mr-2" />
                      Browse All Documents
                    </Button>
                  )}
                </div>
              </div>

              {/* Search and Filters - Unified Control Center */}
              <div className="mb-6 animate-fade-in flex flex-col gap-4">
                <div className="flex gap-4 items-center">
                  <div className="flex-1 relative">
                    <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <Input
                      placeholder="Search documents or keywords..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10 h-11 border-gray-200 focus:border-blue-500 focus:ring-blue-500 shadow-sm"
                      style={{ borderRadius: '8px' }}
                    />
                  </div>
                  {/* View Mode Toggles */}
                  <div className="flex items-center border rounded-lg overflow-hidden bg-white shadow-sm shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setViewMode('list')}
                      className={`rounded-none h-11 w-11 ${viewMode === 'list' ? 'bg-muted' : ''}`}
                    >
                      <List className="h-5 w-5" />
                    </Button>
                    <div className="w-px h-6 bg-border mx-0" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setViewMode('grid')}
                      className={`rounded-none h-11 w-11 ${viewMode === 'grid' ? 'bg-muted' : ''}`}
                    >
                      <LayoutGrid className="h-5 w-5" />
                    </Button>
                  </div>
                </div>
                
                {/* Filter Chips */}
                <div className="flex flex-wrap gap-2 items-center text-sm">
                  <span className="text-gray-500 font-medium mr-1">Filters:</span>
                  <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                    <SelectTrigger className="h-8 rounded-full bg-white border-dashed text-xs w-auto px-3 py-1 shadow-sm gap-2">
                      <Filter className="w-3 h-3 text-gray-500" />
                      <SelectValue placeholder="Category" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((category) => (
                        <SelectItem key={category} value={category}>
                          {category === "all" ? "All Categories" : category}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {(user?.role === 'FACULTY' || user?.role === 'PERSONNEL' || isAdmin(user?.role as UserRole)) && (
                    <Select
                      value={unitFilter || "all"}
                      onValueChange={(value) => setUnitFilter(value === "all" ? null : value)}
                    >
                      <SelectTrigger className="h-8 rounded-full bg-white border-dashed text-xs w-auto px-3 py-1 shadow-sm gap-2">
                        <Building2 className="w-3 h-3 text-gray-500" />
                        <SelectValue placeholder="All Units" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Units</SelectItem>
                        {activeUnits.map((dept) => (
                          <SelectItem key={dept.id} value={dept.id}>
                            {dept.code} - {dept.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>
              
              {/* Documents Display */}
              {viewMode === 'list' && documents.length > 0 && (
                <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-6">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                      <thead className="bg-gray-50/50 text-gray-500 border-b border-gray-100">
                        <tr>
                          <th className="px-6 py-4 font-medium">Name</th>
                          <th className="px-6 py-4 font-medium hidden md:table-cell">Date Uploaded</th>
                          <th className="px-6 py-4 font-medium hidden lg:table-cell">Uploaded By</th>
                          <th className="px-6 py-4 font-medium">Size</th>
                          <th className="px-6 py-4 font-medium text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {documents.map((doc, index) => {
                          const { icon: FileIcon, color: iconColor, bgColor: iconBgColor } = getFileIcon(doc.fileName || doc.title);
                          const canDelete = user && (user.role === 'ADMIN' || doc.uploadedById === user.id);
                          const hasAccess = user && (
                            user.role === 'ADMIN' ||
                            doc.uploadedById === user.id ||
                            user.unitId === doc.unitId ||
                            doc.hasExplicitPermission === true
                          );

                          return (
                            <tr
                              key={doc.id}
                              className="hover:bg-gray-50/50 transition-colors group cursor-pointer"
                              onClick={() => {
                                if (!hasAccess) {
                                  toast({ title: 'Access Denied', description: 'Please request access to view this document.' });
                                  return;
                                }
                                if (doc.id && doc.id !== 'undefined' && !doc.id.includes('undefined')) {
                                  router.push(`/repository/preview/${doc.id}`);
                                }
                              }}
                            >
                              <td className="px-6 py-4">
                                <div className="flex items-center gap-3">
                                  {isImageFile(doc.fileName || doc.title) && doc.fileUrl ? (
                                    <SecureThumbnail doc={doc} className="w-10 h-10 min-w-10 rounded-lg object-cover border border-gray-100 shrink-0" />
                                  ) : (
                                    <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: iconBgColor }}>
                                      <FileIcon className="w-5 h-5" style={{ color: iconColor }} />
                                    </div>
                                  )}
                                  <div>
                                    <div className="font-medium text-gray-900 line-clamp-1">{toTitleCase(doc.title)}</div>
                                    <div className="text-xs text-gray-500 line-clamp-1 lg:hidden mt-0.5">{doc.uploadedBy}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-4 hidden md:table-cell text-gray-500">
                                {doc.createdAt ? new Date(doc.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "-"}
                              </td>
                              <td className="px-6 py-4 hidden lg:table-cell text-gray-500">
                                {doc.uploadedBy}
                              </td>
                              <td className="px-6 py-4 text-gray-500 whitespace-nowrap">
                                {formatFileSize(doc.fileSize)}
                              </td>
                              <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400 hover:text-gray-600">
                                      <MoreVertical className="w-4 h-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    {!hasAccess ? (
                                      <DropdownMenuItem onClick={(e) => {
                                        e.stopPropagation();
                                        setPendingRequestDoc(doc);
                                        setShowRequestDialog(true);
                                      }}>
                                        <Lock className="w-4 h-4 mr-2" />
                                        Request Access
                                      </DropdownMenuItem>
                                    ) : (
                                      <>
                                        <DropdownMenuItem onClick={async (e) => {
                                          e.stopPropagation();
                                          setDownloadingDocId(doc.id);
                                      try {
                                        if (!isAuthenticated || !user) return;
                                        const downloadToken = await AuthService.getAccessToken();
                                        if (!downloadToken) {
                                          await AuthService.logout();
                                          router.push('/');
                                          return;
                                        }
                                        const directDownloadUrl = `/api/documents/${doc.id}/download-direct?token=${downloadToken}`;
                                        const link = document.createElement('a');
                                        link.href = directDownloadUrl;
                                        link.download = doc.fileName || `document-${doc.id}`;
                                        document.body.appendChild(link);
                                        link.click();
                                        document.body.removeChild(link);
                                      } catch (error) {
                                        console.error('Download error:', error);
                                        alert(error instanceof Error ? error.message : 'Failed to download document.');
                                      } finally {
                                        setDownloadingDocId(null);
                                      }
                                    }}>
                                      {downloadingDocId === doc.id ? (
                                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-900 mr-2"></div>
                                      ) : (
                                        <Download className="w-4 h-4 mr-2" />
                                      )}
                                      Download
                                    </DropdownMenuItem>
                                    
                                    <DropdownMenuItem onClick={(e) => {
                                      e.stopPropagation();
                                      router.push(`/repository/preview/${doc.id}`);
                                    }}>
                                      <EyeIcon className="w-4 h-4 mr-2" />
                                      Preview
                                    </DropdownMenuItem>
                                    
                                    {doc.isQproDocument && (
                                      <DropdownMenuItem onClick={async (e) => {
                                        e.stopPropagation();
                                        try {
                                          const token = await AuthService.getAccessToken();
                                          if (!token) {
                                            await AuthService.logout();
                                            router.push('/');
                                            return;
                                          }
                                          const response = await fetch(`/api/qpro/by-document/${doc.id}`, {
                                            headers: {
                                              'Authorization': `Bearer ${token}`,
                                              'Content-Type': 'application/json',
                                            }
                                          });
                                          if (response.ok) {
                                            const data = await response.json();
                                            if (data.analysis) {
                                              router.push(`/qpro/analysis/${data.analysis.id}`);
                                            } else {
                                              toast({
                                                title: "No Analysis Found",
                                                description: "This QPRO document hasn't been analyzed yet.",
                                                variant: "default",
                                              });
                                            }
                                          } else {
                                            toast({
                                              title: "No Analysis Found",
                                              description: "This QPRO document hasn't been analyzed yet.",
                                              variant: "default",
                                            });
                                          }
                                        } catch (error) {
                                          console.error('Error fetching QPRO analysis:', error);
                                          toast({
                                            title: "Error",
                                            description: "Failed to fetch QPRO analysis.",
                                            variant: "destructive",
                                          });
                                        }
                                      }}>
                                        <FileText className="w-4 h-4 mr-2" />
                                        View QPRO Analysis
                                      </DropdownMenuItem>
                                    )}
                                    
                                    {canDelete && (
                                      <DropdownMenuItem
                                        className="text-red-600 focus:text-red-600 focus:bg-red-50"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setDocumentToDelete(doc);
                                        }}
                                        disabled={deletingDocId === doc.id}
                                      >
                                        <Trash2 className="w-4 h-4 mr-2" />
                                        {deletingDocId === doc.id ? 'Deleting...' : 'Delete'}
                                      </DropdownMenuItem>
                                    )}
                                    </>
                                    )}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              
              {viewMode === 'grid' && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {documents.map((doc, index) => {
                  const { icon: FileIcon, color: iconColor, bgColor: iconBgColor } = getFileIcon(doc.fileName || doc.title);
                  const canDelete = user && (user.role === 'ADMIN' || doc.uploadedById === user.id);
                  const hasAccess = user && (
                    user.role === 'ADMIN' ||
                    doc.uploadedById === user.id ||
                    user.unitId === doc.unitId ||
                    doc.hasExplicitPermission === true
                  );

                  return (
                    <div
                      key={doc.id}
                      className="animate-fade-in bg-white rounded-xl overflow-hidden transition-all duration-200 hover:border-gray-300 group flex flex-col cursor-pointer border border-transparent"
                      style={{
                        animationDelay: `${index * 0.05}s`,
                        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                        border: '1px solid #e5e7eb',
                      }}
                      onClick={() => {
                        if (!hasAccess) {
                          toast({ title: 'Access Denied', description: 'Please request access to view this document.' });
                          return;
                        }
                        if (doc.id && doc.id !== 'undefined' && !doc.id.includes('undefined')) {
                          router.push(`/repository/preview/${doc.id}`);
                        } else {
                          toast({
                            title: "Error",
                            description: "Cannot preview this document.",
                            variant: "destructive",
                          });
                        }
                      }}
                    >
                      {/* Card Header */}
                      <div className="p-4 flex-1 flex flex-col relative">
                        <div className="absolute top-4 right-4 z-10" onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400 hover:text-gray-600 bg-white/50 backdrop-blur-sm rounded-full">
                                <MoreVertical className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {!hasAccess ? (
                                <DropdownMenuItem onClick={async (e) => {
                                  e.stopPropagation();
                                  setPendingRequestDoc(doc);
                                  setShowRequestDialog(true);
                                }}>
                                  <Lock className="w-4 h-4 mr-2 text-yellow-500" />
                                  Request Access
                                </DropdownMenuItem>
                              ) : (
                                <>
                                  <DropdownMenuItem onClick={async (e) => {
                                    e.stopPropagation();
                                    setDownloadingDocId(doc.id);
                                    try {
                                      if (!isAuthenticated || !user) return;
                                  const downloadToken = await AuthService.getAccessToken();
                                  if (!downloadToken) {
                                    await AuthService.logout();
                                    router.push('/');
                                    return;
                                  }
                                  const directDownloadUrl = `/api/documents/${doc.id}/download-direct?token=${downloadToken}`;
                                  const link = document.createElement('a');
                                  link.href = directDownloadUrl;
                                  link.download = doc.fileName || `document-${doc.id}`;
                                  document.body.appendChild(link);
                                  link.click();
                                  document.body.removeChild(link);
                                } catch (error) {
                                  console.error('Download error:', error);
                                  alert(error instanceof Error ? error.message : 'Failed to download document.');
                                } finally {
                                  setDownloadingDocId(null);
                                }
                              }}>
                                {downloadingDocId === doc.id ? (
                                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-900 mr-2"></div>
                                ) : (
                                  <Download className="w-4 h-4 mr-2" />
                                )}
                                Download
                              </DropdownMenuItem>
                              {doc.isQproDocument && (
                                <DropdownMenuItem
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    try {
                                      const token = await AuthService.getAccessToken();
                                      if (!token) {
                                        await AuthService.logout();
                                        router.push('/');
                                        return;
                                      }
                                      const response = await fetch(`/api/qpro/by-document/${doc.id}`, {
                                        headers: {
                                          'Authorization': `Bearer ${token}`,
                                          'Content-Type': 'application/json',
                                        }
                                      });
                                      if (response.ok) {
                                        const data = await response.json();
                                        if (data.analysis) {
                                          router.push(`/qpro/analysis/${data.analysis.id}`);
                                        } else {
                                          toast({
                                            title: "No Analysis Found",
                                            description: "This QPRO document hasn't been analyzed yet.",
                                            variant: "default",
                                          });
                                        }
                                      } else {
                                        toast({
                                          title: "No Analysis Found",
                                          description: "This QPRO document hasn't been analyzed yet.",
                                          variant: "default",
                                        });
                                      }
                                    } catch (error) {
                                      console.error('Error fetching QPRO analysis:', error);
                                      toast({
                                        title: "Error",
                                        description: "Failed to fetch QPRO analysis.",
                                        variant: "destructive",
                                      });
                                    }
                                  }}
                                >
                                  <FileText className="w-4 h-4 mr-2" />
                                  View QPRO Analysis
                                </DropdownMenuItem>
                              )}
                              {canDelete && (
                                <DropdownMenuItem
                                  className="text-red-600 focus:text-red-600 focus:bg-red-50"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setDocumentToDelete(doc);
                                  }}
                                  disabled={deletingDocId === doc.id}
                                >
                                  <Trash2 className="w-4 h-4 mr-2" />
                                  {deletingDocId === doc.id ? 'Deleting...' : 'Delete'}
                                </DropdownMenuItem>
                              )}
                              </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        
                        <div className="flex items-start gap-4 mb-4 mt-2">
                          {isImageFile(doc.fileName || doc.title) && doc.fileUrl ? (
                            <SecureThumbnail doc={doc} className="w-12 h-12 min-w-12 rounded-lg object-cover border border-gray-100 shrink-0" />
                          ) : (
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: iconBgColor }}>
                              <FileIcon className="w-6 h-6" style={{ color: iconColor }} />
                            </div>
                          )}
                          <div className="flex-1 min-w-0 pr-6">
                            <h4 className="text-[16px] font-semibold text-gray-900 line-clamp-2 mb-1">{toTitleCase(doc.title)}</h4>
                            <p className="text-xs text-gray-500 mb-2">{doc.createdAt ? new Date(doc.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "-"} • {formatFileSize(doc.fileSize)}</p>
                          </div>
                        </div>
                        
                        <p className="text-sm text-gray-500 line-clamp-2 mb-4 flex-1">{doc.description}</p>
                        
                        <div className="flex flex-wrap gap-2 mb-4">
                          {!unitFilter && doc.unit && (
                            <span 
                              className="px-2.5 py-1 text-[11px] font-medium rounded-full"
                              style={{ backgroundColor: 'rgba(43, 67, 133, 0.1)', color: '#2B4385' }}
                            >
                              {doc.unit.code || doc.unit.name}
                            </span>
                          )}
                          
                        </div>
                        
                        <div className="pt-3 border-t border-gray-100 mt-auto flex justify-between items-center text-xs text-gray-400">
                          <span>{doc.uploadedBy}</span>
                          <div className="flex items-center gap-3">
                            <span className="flex items-center gap-1"><Download className="w-3 h-3" /> {doc.downloadsCount}</span>
                            <span className="flex items-center gap-1"><Eye className="w-3 h-3" /> {doc.viewsCount}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              )}

              {/* Pagination Controls */}
              {totalPages > 1 && documents.length > 0 && (
                <div className="flex items-center justify-between mt-4 mb-2 px-2">
                  <p className="text-sm text-gray-500">
                    Page {currentPage} of {totalPages} — {totalDocs} document{totalDocs !== 1 ? 's' : ''}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => fetchDocuments(currentPage - 1)}
                      disabled={currentPage <= 1 || loading}
                    >
                      <ChevronLeft className="w-4 h-4" /> Prev
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => fetchDocuments(currentPage + 1)}
                      disabled={currentPage >= totalPages || loading}
                    >
                      Next <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}

              {/* Empty State */}
              {documents.length === 0 && !loading && (
                <div className="animate-fade-in bg-white rounded-xl p-12 text-center" style={{ boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)', borderRadius: '12px' }}>
                  <div className="w-20 h-20 mx-auto mb-6 rounded-full flex items-center justify-center" style={{ backgroundColor: 'rgba(43, 67, 133, 0.1)' }}>
                    <FileText className="w-10 h-10" style={{ color: '#2B4385' }} />
                  </div>
                  <h3 className="text-xl font-semibold text-gray-900 mb-2">No Documents Found</h3>
                  <p className="text-gray-500 mb-6 max-w-md mx-auto">
                    We couldn't find any documents matching your search criteria. Try adjusting your filters or search terms.
                  </p>
                  <div className="flex gap-3 justify-center">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSearchQuery('');
                        setCategoryFilter('all');
                        setUnitFilter(null);
                      }}
                      style={{ borderRadius: '8px' }}
                    >
                      Clear Filters
                    </Button>
                    {canUpload && (
                      <Button
                        onClick={() => setShowUploadModal(true)}
                        style={{ backgroundColor: '#2B4385', color: 'white', borderRadius: '8px' }}
                      >
                        <Upload className="w-4 h-4 mr-2" />
                        Upload Document
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </main>
        </div>
        
        {/* Upload Document Modal */}
        {showUploadModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
            <div className="bg-background rounded-lg max-w-md w-full p-6">
              <h3 className="text-lg font-semibold mb-4">Upload Document</h3>
              
              {uploadError && (
               <div className="mb-4 p-3 bg-destructive/20 text-destructive rounded-md flex items-center gap-2">
                 <XCircle className="w-5 h-5" />
                 {uploadError}
               </div>
             )}
             
             {uploading && (
               <div className="mb-4">
                 <div className="w-full bg-gray-200 rounded-full h-2.5">
                   <div
                     className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                     style={{ width: `${uploadProgress}%` }}
                   ></div>
                 </div>
               </div>
             )}
             
             {uploadSuccessMessage && (
               <div className="mb-4 p-3 bg-green-100 text-green-800 rounded-md flex items-center gap-2 animate-fade-in">
                 <CheckCircle className="w-5 h-5" />
                 {uploadSuccessMessage}
               </div>
             )}
              
              <form onSubmit={async (e) => {
                e.preventDefault();
                
                // Check if running on client side
                if (typeof window === 'undefined') {
                  setUploadError('Upload can only be initiated from the browser');
                  return;
                }
                
                setUploading(true);
                setUploadProgress(0);
                setUploadError(null);
                setUploadSuccessMessage(null); // Clear any previous success message
                
                try {
                  const formData = new FormData(e.currentTarget);
                  const file = formData.get('file') as File;
                  
                  if (!file || file.size === 0) {
                    throw new Error('Please select a file to upload');
                  }
                  
                  // First, verify that we have a valid authentication state
                  if (!isAuthenticated || !user) {
                    // If not authenticated, just return to prevent further execution
                    return;
                  }
                  
                  // Then try to get the access token
                  const token = await AuthService.getAccessToken();
                  if (!token) {
                    // If no token is available despite being authenticated, log out the user
                    await AuthService.logout();
                    router.push('/');
                    return;
                  }
                  
                  // Create a new FormData object for the API request
                  const apiFormData = new FormData();
                  apiFormData.append('title', formData.get('title') as string);
                  apiFormData.append('description', formData.get('description') as string);
                  apiFormData.append('file', file);
                  const unitId = formData.get('unitId') as string;
                  if (unitId) {
                    apiFormData.append('unitId', unitId);
                  }
                  
                  // Create the request with progress tracking
                  const xhr = new XMLHttpRequest();
                  
                  return new Promise<void>((resolve, reject) => {
                    // Set up all event listeners BEFORE opening the request
                    xhr.upload.addEventListener('progress', (event) => {
                      if (event.lengthComputable) {
                        const progress = Math.floor((event.loaded / event.total) * 100); // Use floor to ensure we get an integer value
                        setUploadProgress(progress);
                        console.log(`Upload progress: ${progress}% (${event.loaded} / ${event.total} bytes)`); // Debug log
                      } else {
                        console.log('Upload progress: Length not computable'); // Debug log for when length is not computable
                      }
                    });
                    
                    // Add debug logging for other events
                    xhr.addEventListener('loadstart', () => {
                      console.log('Upload loadstart event fired');
                    });
                    
                    xhr.addEventListener('loadend', () => {
                      console.log('Upload loadend event fired');
                    });
                    
                    xhr.upload.addEventListener('loadstart', () => {
                      console.log('Upload upload loadstart event fired');
                    });
                    
                    xhr.upload.addEventListener('loadend', () => {
                      console.log('Upload upload loadend event fired');
                    });
                    
                    // Add error handling for progress events
                    xhr.upload.addEventListener('error', (event) => {
                      console.error('Upload error event fired:', event);
                    });
                    
                    xhr.upload.addEventListener('abort', (event) => {
                      console.log('Upload abort event fired:', event);
                    });
                    
                    // Add additional event listeners for debugging
                    xhr.addEventListener('readystatechange', () => {
                      console.log(`Ready state changed: ${xhr.readyState}`);
                    });
                    
                    xhr.addEventListener('load', () => {
                      if (xhr.status >= 200 && xhr.status < 300) {
                        // Refresh the document list
                        // Use the same token for the refresh call to avoid auth issues
                        // Build query parameters properly
                        const queryParams = new URLSearchParams();
                        if (searchQuery) queryParams.append('search', searchQuery);
                        if (categoryFilter && categoryFilter !== 'all') queryParams.append('category', categoryFilter);
                        
                        fetch(`/api/documents?${queryParams.toString()}`, {
                          headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                          }
                        })
                        .then(refreshResponse => refreshResponse.json())
                        .then(data => {
                          setDocuments(data.documents || []);
                          setShowUploadModal(false);
                          // Show success message to the user
                          setUploadSuccessMessage("Document uploaded successfully!");
                          // Clear the success message after 3 seconds
                          setTimeout(() => {
                            setUploadSuccessMessage(null);
                          }, 3000);
                          // Show success modal with OK button
                          setShowSuccessModal(true);
                          // Add a small delay to ensure UI updates properly
                          setTimeout(() => {
                            // Optionally trigger a full page refresh or a more comprehensive data reload
                          }, 100);
                          resolve();
                        })
                        .catch(error => {
                          console.error('Failed to refresh documents:', error);
                          setShowUploadModal(false);
                          // Still resolve so the user knows the upload was successful
                          // Even if the document list refresh failed, the upload itself was successful
                          setUploadSuccessMessage("Document uploaded successfully, but there was an issue refreshing the document list.");
                          // Clear the success message after 5 seconds
                          setTimeout(() => {
                            setUploadSuccessMessage(null);
                          }, 500);
                          // Show success modal with OK button even when refresh fails
                          setShowSuccessModal(true);
                          resolve();
                        });
                      } else {
                        // Try to parse error response
                        let errorData: { error?: string } = {};
                        try {
                          errorData = JSON.parse(xhr.responseText);
                        } catch {
                          // If response is not JSON, use status text
                          errorData = { error: `Upload failed: ${xhr.status} - ${xhr.statusText || 'Unknown error'}` };
                        }
                        const errorMessage = errorData.error || `Upload failed: ${xhr.status} ${xhr.statusText}`;
                        setUploadError(errorMessage);
                        setUploading(false);
                        setUploadSuccessMessage(null); // Clear any success message on error
                        console.error('Upload error details:', {
                          status: xhr.status,
                          statusText: xhr.statusText,
                          responseText: xhr.responseText,
                          error: errorMessage
                        });
                        reject(new Error(errorMessage));
                      }
                    });
                    
                    xhr.addEventListener('error', () => {
                      setUploadError('Network error occurred during upload');
                      setUploading(false);
                      setUploadSuccessMessage(null); // Clear any success message on error
                      reject(new Error('Network error occurred during upload'));
                    });
                    
                    xhr.addEventListener('abort', () => {
                      setUploadError('Upload was cancelled');
                      setUploading(false);
                      setUploadSuccessMessage(null); // Clear any success message on error
                      reject(new Error('Upload was cancelled'));
                    });
                    
                    // Open the request after setting up all event listeners
                    xhr.open('POST', '/api/documents');
                    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
                    // Don't set Content-Type header when sending FormData - let browser set it with proper boundary
                    
                    xhr.send(apiFormData);
                  });
                } catch (error) {
                  console.error('Upload error:', error);
                  setUploadError(error instanceof Error ? error.message : 'Failed to upload document');
                  setUploading(false);
                  setUploadSuccessMessage(null); // Clear any success message on error
                }
              }}>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Title *</label>
                    <Input
                      name="title"
                      required
                      placeholder="Document title"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium mb-1">Description</label>
                    <textarea
                      name="description"
                      className="w-full min-h-20 p-2 border border-input rounded-md bg-background"
                      placeholder="Document description (optional)"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium mb-1">File *</label>
                    <Input
                      type="file"
                      name="file"
                      required
                      accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.jpg,.jpeg,.png"
                    />
                  </div>
                  
                  {user?.role === 'ADMIN' ? (
                    <div>
                      <label className="block text-sm font-medium mb-1">Unit (Optional)</label>
                      <select
                        name="unitId"
                        className="w-full p-2 border-input rounded-md bg-background"
                        defaultValue=""
                      >
                        <option value="">Select a unit (or leave blank for unassigned)</option>
                        {units.map((unit) => (
                          <option key={unit.id} value={unit.id}>
                            {unit.code} - {unit.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <>
                      {user?.unitId && (
                        <input type="hidden" name="unitId" value={user.unitId} />
                      )}
                    </>
                  )}
                </div>
                
                <div className="flex gap-2 mt-6">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setShowUploadModal(false);
                      setUploading(false);
                      setUploadProgress(0);
                      setUploadError(null);
                      setUploadSuccessMessage(null);
                      setShowSuccessModal(false);
                    }}
                    disabled={uploading}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={uploading}
                  >
                    {uploading ? 'Uploading...' : 'Upload'}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}
        
        {/* Success Modal */}
        <Dialog open={showSuccessModal} onOpenChange={setShowSuccessModal}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Upload Successful!</DialogTitle>
              <DialogDescription>
                Your document has been uploaded successfully to the repository.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4 flex justify-center">
              <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/200/svg" className="h-10 w-10 text-green-600" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => {
                setShowSuccessModal(false);
                setUploadProgress(0);
                setUploading(false);
                setUploadSuccessMessage(null);
              }}>OK</Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <AlertDialog open={!!documentToDelete} onOpenChange={(open) => !open && setDocumentToDelete(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Are you sure?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete <span className="font-semibold">&quot;{documentToDelete?.title}&quot;</span>. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={!!deletingDocId}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={!!deletingDocId}
                className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
                onClick={async (e) => {
                  e.preventDefault();
                  if (!documentToDelete) return;
                  
                  setDeletingDocId(documentToDelete.id);
                  try {
                    if (!isAuthenticated || !user) return;
                    const token = await AuthService.getAccessToken();
                    if (!token) {
                      await AuthService.logout();
                      router.push('/');
                      return;
                    }
                    const response = await fetch(`/api/documents/${documentToDelete.id}`, {
                      method: 'DELETE',
                      headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                      }
                    });
                    if (response.ok) {
                      setDeletionSuccessMessage(`Document deleted successfully!`);
                      setTimeout(() => setDeletionSuccessMessage(null), 3000);
                      setDocumentToDelete(null);
                      fetchDocuments();
                    } else {
                      const errorData = await response.json();
                      toast({
                        title: response.status === 403 ? "Access Denied" : "Error",
                        description: errorData.error || 'Failed to delete document',
                        variant: "destructive",
                      });
                    }
                  } catch (error) {
                    toast({
                      title: "Error",
                      description: 'Failed to delete document',
                      variant: "destructive",
                    });
                  } finally {
                    setDeletingDocId(null);
                  }
                }}
              >
                {deletingDocId ? 'Deleting...' : 'Delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog open={showRequestDialog} onOpenChange={setShowRequestDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Request Access to Document</DialogTitle>
              <DialogDescription>
                Please provide a reason for requesting access to <strong>{pendingRequestDoc?.title}</strong>. This request will be reviewed by an administrator.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <label htmlFor="reason" className="block text-sm font-medium mb-2">Reason for access:</label>
              <textarea
                id="reason"
                className="w-full min-h-[100px] p-3 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-[#2B4385]/20 focus:border-[#2B4385]/50 transition-all resize-none"
                placeholder="Briefly explain why you need access to this document..."
                value={requestReason}
                onChange={(e) => setRequestReason(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowRequestDialog(false);
                  setRequestReason("");
                  setPendingRequestDoc(null);
                }}
                disabled={submittingRequest}
              >
                Cancel
              </Button>
              <Button
                onClick={submitAccessRequest}
                disabled={!requestReason.trim() || submittingRequest}
                style={{ backgroundColor: '#2B4385', color: 'white' }}
              >
                {submittingRequest ? "Submitting..." : "Submit Request"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

      </div>
    </ClientOnly>
  )
}



