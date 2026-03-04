"use client";

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import AuthService from '@/lib/services/auth-service';

import { useAuth } from "@/lib/auth-context"
import { Navbar } from "@/components/navbar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import type { Document, Unit } from "@/lib/api/types"
import { Download, Eye, FileText, Filter, Upload, SearchIcon, EyeIcon, Trash2, CheckCircle, XCircle, Building2, ChevronLeft, ChevronRight, MoreVertical, FileSpreadsheet, FileImage, File } from "lucide-react"
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
  
// Determine if user can upload (roles are uppercase as per database enum)
  const canUpload = user?.role === "ADMIN" || user?.role === "FACULTY"
  
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

   const fetchDocuments = async () => {
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
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4 overflow-hidden rounded-full bg-white shadow-sm border border-gray-100">
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
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4 overflow-hidden rounded-full bg-white shadow-sm border border-gray-100">
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
          <div className="w-16 h-16 flex items-center justify-center mx-auto mb-4 overflow-hidden rounded-full bg-white shadow-sm border border-gray-100">
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

  const categories = ["all", "Other files", "Research", "Academic", "Policy", "Extension", "Teaching"]; // Using standard categories
  
  // NEW: Use all units since there's no status property
  const activeUnits = units;

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
          {sidebarOpen && (
            <div className="w-64 border-r bg-muted/10 hidden lg:block">
              <UnitSidebar
                units={activeUnits}
                currentUnit={unitFilter}
                onUnitSelect={(unitId) => {
                  // Navigate to the unit page instead of just filtering
                  if (unitId) {
                    router.push(`/units/${unitId}`);
                  } else {
                    router.push('/repository');
                  }
                }}
                userRole={user?.role || ''}
                userUnit={user?.unitId || null}
              />
            </div>
          )}
          
          {/* Main Content */}
          <main className="flex-1 lg:ml-0">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
              {/* Header */}
              <div className="mb-8 animate-fade-in">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="lg:hidden"
                      onClick={() => setSidebarOpen(!sidebarOpen)}
                    >
                      {sidebarOpen ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                    </Button>
                    <div>
                      <h1 className="text-3xl md:text-4xl font-bold mb-2" style={{ color: '#2B4385' }}>Knowledge Repository</h1>
                      <p className="text-gray-500">Browse and access institutional knowledge resources</p>
                    </div>
                  </div>
                  {isAuthenticated && user && canUpload && (
                   <Button
                     className="gap-2 shadow-sm"
                     style={{ backgroundColor: '#2B4385', color: 'white' }}
                     onClick={() => setShowUploadModal(true)}
                   >
                     <Upload className="w-4 h-4" />
                     Upload Document
                   </Button>
                 )}
                </div>
              </div>
              
              {/* Search and Filters - Unified Control Center */}
              <div className="mb-6 animate-fade-in p-4 bg-white rounded-xl shadow-sm" style={{ boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)' }}>
                <div className="flex flex-col md:flex-row gap-4">
                  <div className="flex-1 relative">
                    <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <Input
                      placeholder="Search documents or keywords..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10 h-11 border-gray-200 focus:border-blue-500 focus:ring-blue-500"
                      style={{ borderRadius: '8px' }}
                    />
                  </div>
                  <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                    <SelectTrigger className="w-full md:w-48 h-11" style={{ backgroundColor: '#F9FAFB', borderRadius: '8px' }}>
                      <Filter className="w-4 h-4 mr-2 text-gray-500" />
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
                  <Select
                    value={unitFilter || "all"}
                    onValueChange={(value) => setUnitFilter(value === "all" ? null : value)}
                  >
                    <SelectTrigger className="w-full md:w-48 h-11" style={{ backgroundColor: '#F9FAFB', borderRadius: '8px' }}>
                      <Building2 className="w-4 h-4 mr-2 text-gray-500" />
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
                </div>
              </div>
              
              {/* Documents Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {documents.map((doc, index) => {
                  const { icon: FileIcon, color: iconColor, bgColor: iconBgColor } = getFileIcon(doc.fileName || doc.title);
                  const canDelete = user && (user.role === 'ADMIN' || doc.uploadedById === user.id);
                  
                  return (
                    <div
                      key={doc.id}
                      className="animate-fade-in bg-white rounded-xl overflow-hidden transition-all duration-300 hover:shadow-xl group flex flex-col"
                      style={{ 
                        animationDelay: `${index * 0.05}s`,
                        boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)',
                        borderRadius: '12px',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'translateY(-4px)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'translateY(0)';
                      }}
                    >
                      {/* Card Header */}
                      <div className="p-4 pb-0 flex-1 flex flex-col">
                        <div className="flex items-start justify-between gap-2 mb-3">
                          <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: iconBgColor }}>
                            <FileIcon className="w-6 h-6" style={{ color: iconColor }} />
                          </div>
                          {(canDelete || doc.isQproDocument) && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <MoreVertical className="w-4 h-4 text-gray-500" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
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
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                        
                        {/* Title and Description */}
                        <h4 className="text-lg font-semibold text-gray-900 line-clamp-2 mb-1 min-h-[3.5rem]">{toTitleCase(doc.title)}</h4>
                        <p className="text-sm text-gray-500 line-clamp-2 mb-3 min-h-[2.5rem]">{doc.description}</p>
                        
                        {/* Metadata */}
                        <p className="text-xs text-gray-400 mb-3">
                          Uploaded by {doc.uploadedBy} • {formatFileSize(doc.fileSize)}
                        </p>
                      
                        {/* Pill Tags */}
                        <div className="flex flex-wrap gap-2 mb-4 min-h-[2rem]">
                          {!unitFilter && doc.unit && (
                            <span 
                              className="px-3 py-1 text-xs font-medium rounded-full"
                              style={{ backgroundColor: 'rgba(43, 67, 133, 0.1)', color: '#2B4385' }}
                            >
                              {doc.unit.code || doc.unit.name}
                            </span>
                          )}
                          {doc.category && doc.category !== "Other files" && (
                            <span 
                              className="px-3 py-1 text-xs font-medium rounded-full"
                              style={{ backgroundColor: '#F3F4F6', color: '#6B7280' }}
                            >
                              {doc.category}
                            </span>
                          )}
                        </div>
                      </div>
                      
                      {/* Card Footer */}
                      <div className="px-4 pb-4 mt-auto">
                        <div className="flex items-center gap-3 text-sm text-gray-500 mb-4">
                          <div className="flex items-center gap-1">
                            <Download className="w-4 h-4" />
                            <span>{doc.downloadsCount}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Eye className="w-4 h-4" />
                            <span>{doc.viewsCount}</span>
                          </div>
                          <span className="ml-auto text-xs">v{doc.version}</span>
                        </div>
                        
                        {/* Action Buttons */}
                        <div className="flex gap-2">
                          {downloadingDocId === doc.id ? (
                            <Button 
                              className="flex-1 gap-2" 
                              size="sm" 
                              disabled
                              style={{ backgroundColor: '#2B4385', color: 'white', borderRadius: '8px' }}
                            >
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                              Downloading...
                            </Button>
                          ) : (
                            <Button
                              className="flex-1 gap-2"
                              size="sm"
                              style={{ backgroundColor: '#2B4385', color: 'white', borderRadius: '8px' }}
                                onClick={async (e) => {
                                  e.stopPropagation();
                                setDownloadingDocId(doc.id);
                                try {
                                  if (typeof window === 'undefined') {
                                    throw new Error('Download can only be initiated from the browser');
                                  }
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
                              }}
                            >
                              <Download className="w-4 h-4" />
                              Download
                            </Button>
                          )}
                          <Button
                            className="gap-2"
                            size="sm"
                            variant="ghost"
                            style={{ color: '#2B4385', borderRadius: '8px' }}
                            onClick={(e) => {
                              e.stopPropagation();
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
                            <EyeIcon className="w-4 h-4" />
                            Preview
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              
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
      </div>
    </ClientOnly>
  )
}

