"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Eye, Loader2, FileText, FileSpreadsheet, FileImage, File, Pencil, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Document } from "@/lib/types";
import { useAuth } from "@/lib/auth-context";
import AuthService from "@/lib/services/auth-service";

// Helper to get file icon based on extension
const getFileIcon = (title: string) => {
  const ext = title.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'doc':
    case 'docx':
      return { icon: FileText, color: '#2B4385' };
    case 'xls':
    case 'xlsx':
      return { icon: FileSpreadsheet, color: '#2E8B57' };
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
      return { icon: FileImage, color: '#C04E3A' };
    case 'pdf':
      return { icon: FileText, color: '#EF4444' };
    default:
      return { icon: File, color: '#6B7280' };
  }
};

// Helper to get clean title without extension
const getCleanTitle = (title: string) => {
  const parts = title.split('.');
  if (parts.length > 1) {
    parts.pop(); // Remove extension
    return parts.join('.');
  }
  return title;
};

const DocumentCard = ({ doc, delay, isAdmin }: { doc: any; delay?: number; isAdmin?: boolean }) => {
  const style = delay !== undefined ? { animationDelay: `${delay}s` } : {};
  const { icon: FileIcon, color } = getFileIcon(doc.title);
  const cleanTitle = getCleanTitle(doc.title);
  
  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const token = await AuthService.getAccessToken();
      if (!token) return;
      window.open(`/api/documents/${doc.id}/download-direct?token=${token}`, '_blank');
    } catch (err) {
      console.error('Download error:', err);
    }
  };

  return (
    <Card
      key={doc.id}
      className="animate-fade-in hover:shadow-lg transition-shadow border-0 bg-white group"
      style={style}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-gray-50 shrink-0" style={{ color }}>
            <FileIcon className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <Link href={`/repository?doc=${doc.id}`}>
              <CardTitle 
                className="text-base line-clamp-1 text-gray-900 hover:text-[#2B4385] hover:underline decoration-[#2B4385]/30 underline-offset-2 transition-colors cursor-pointer" 
                title={doc.title}
              >
                {cleanTitle}
              </CardTitle>
            </Link>
            <CardDescription className="line-clamp-1 mt-0.5 text-gray-500">{doc.description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-center gap-3 text-sm text-gray-500">
          <div className="flex items-center gap-1" style={{minWidth: '40px'}}>
            <Download className="w-3.5 h-3.5" style={{color: '#2B4385'}} aria-hidden="true" />
            <span className="text-xs">{doc.downloadsCount || doc.downloads || 0}</span>
          </div>
          <div className="flex items-center gap-1" style={{minWidth: '40px'}}>
            <Eye className="w-3.5 h-3.5" style={{color: '#2E8B57'}} aria-hidden="true" />
            <span className="text-xs">{doc.viewsCount || doc.views || 0}</span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <span className="px-2 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: 'rgba(43, 67, 133, 0.1)', color: '#2B4385' }}>{doc.category}</span>
            
            {/* Inline action buttons */}
            <div className="flex items-center gap-0.5 ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={handleDownload}
                className="p-1.5 rounded-md hover:bg-gray-100 transition-colors"
                title="Download"
              >
                <Download className="w-3.5 h-3.5 text-gray-500 hover:text-[#2B4385]" />
              </button>
              <Link href={`/repository?doc=${doc.id}`}>
                <button
                  className="p-1.5 rounded-md hover:bg-gray-100 transition-colors"
                  title="View"
                >
                  <ExternalLink className="w-3.5 h-3.5 text-gray-500 hover:text-[#2E8B57]" />
                </button>
              </Link>
              {isAdmin && (
                <Link href={`/repository?doc=${doc.id}&edit=true`}>
                  <button
                    className="p-1.5 rounded-md hover:bg-gray-100 transition-colors"
                    title="Edit"
                  >
                    <Pencil className="w-3.5 h-3.5 text-gray-500 hover:text-[#C04E3A]" />
                  </button>
                </Link>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default function DocumentsSection() {
  const [recentDocuments, setRecentDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  useEffect(() => {
    const fetchRecentDocuments = async () => {
      try {
        // First, verify that we have a valid authentication state
        if (!user) {
          // If not authenticated, don't make the API call
          return;
        }

        // Get the access token to ensure it's still valid
        const token = await AuthService.getAccessToken();
        if (!token) {
          // If no token is available despite being authenticated, log out the user
          await AuthService.logout();
          return;
        }

        // Get recent documents from the API
        const response = await fetch(`/api/documents?page=1&limit=5&sort=uploadedAt&order=desc`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          }
        });

        if (response.ok) {
          const data = await response.json();
          setRecentDocuments(data.documents || []);
        } else if (response.status === 401) {
          // If we get a 401 (unauthorized) error, the token might have expired
          console.error('Authentication token expired, logging out user');
          // Log out the user since token is no longer valid
          await AuthService.logout();
        } else {
          console.error('Failed to fetch recent documents:', response.status);
          setRecentDocuments([]);
        }
      } catch (error) {
        console.error('Error fetching recent documents:', error);
        setRecentDocuments([]);
      } finally {
        setLoading(false);
      }
    };

    if (user) {
      fetchRecentDocuments();
    }
  }, [user]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin mb-4" style={{color: '#2B4385'}} />
        <p className="text-gray-500">Loading recent documents...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-gray-900">Recent Documents</h2>
        <Link href="/repository">
          <Button 
            variant="outline" 
            style={{ borderColor: '#2B4385', color: '#2B4385' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#2B4385';
              e.currentTarget.style.color = 'white';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
              e.currentTarget.style.color = '#2B4385';
            }}
          >
            View All
          </Button>
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-3">
        {recentDocuments.length > 0 ? (
          recentDocuments.map((doc, index) => (
            <DocumentCard key={doc.id} doc={doc} delay={index * 0.1} isAdmin={user?.role === 'ADMIN'} />
          ))
        ) : (
          <div className="text-center py-8 text-gray-500 bg-white rounded-xl">
            No recent documents available
          </div>
        )}
      </div>
    </div>
  );
}