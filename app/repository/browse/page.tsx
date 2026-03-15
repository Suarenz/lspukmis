'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Navbar } from '@/components/navbar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { ClientOnly } from '@/components/client-only-wrapper';
import { useToast } from '@/hooks/use-toast';
import AuthService from '@/lib/services/auth-service';
import type { CatalogDocument, Unit } from '@/lib/api/types';
import {
  Lock,
  Unlock,
  Clock,
  SearchIcon,
  FileText,
  FileSpreadsheet,
  FileImage,
  File,
  Building2,
  Filter,
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
} from 'lucide-react';

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getFileIcon(fileName: string) {
  const ext = fileName?.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf':
      return { color: '#EF4444', bg: 'rgba(239,68,68,0.1)', Icon: FileText };
    case 'doc':
    case 'docx':
      return { color: '#2B4385', bg: 'rgba(43,67,133,0.1)', Icon: FileText };
    case 'xls':
    case 'xlsx':
      return { color: '#2E8B57', bg: 'rgba(46,139,87,0.1)', Icon: FileSpreadsheet };
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
      return { color: '#C04E3A', bg: 'rgba(192,78,58,0.1)', Icon: FileImage };
    default:
      return { color: '#6B7280', bg: 'rgba(107,114,128,0.1)', Icon: File };
  }
}

// ────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────

export default function BrowseAllPage() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  // Catalog state
  const [documents, setDocuments] = useState<CatalogDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [fetching, setFetching] = useState(false);

  // Filters
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [unitId, setUnitId] = useState('all');
  const [units, setUnits] = useState<Unit[]>([]);

  // Request dialog
  const [requestDoc, setRequestDoc] = useState<CatalogDocument | null>(null);
  const [requestReason, setRequestReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // ── Auth guard ──────────────────────────────────────────
  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.push('/');
    if (!isLoading && isAuthenticated && user?.role === 'STUDENT') router.push('/repository');
  }, [isLoading, isAuthenticated, user, router]);

  // ── Fetch units (for filter) ────────────────────────────
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    (async () => {
      try {
        const token = await AuthService.getAccessToken();
        if (!token) return;
        const res = await fetch('/api/units', { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const data = await res.json();
          setUnits(data.units || []);
        }
      } catch {
        // non-critical
      }
    })();
  }, [isAuthenticated, user]);

  // ── Fetch catalog ───────────────────────────────────────
  const fetchCatalog = useCallback(
    async (targetPage: number) => {
      if (!isAuthenticated || !user) return;
      setFetching(true);
      try {
        const token = await AuthService.getAccessToken();
        if (!token) return;
        const params = new URLSearchParams();
        params.set('page', String(targetPage));
        params.set('limit', '20');
        if (search) params.set('search', search);
        if (category !== 'all') params.set('category', category);
        if (unitId !== 'all') params.set('unitId', unitId);

        const res = await fetch(`/api/documents/catalog?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          if (res.status === 401) { await AuthService.logout(); router.push('/'); return; }
          throw new Error(`Failed to fetch catalog (${res.status})`);
        }

        const data = await res.json();
        setDocuments(data.documents || []);
        setTotal(data.total || 0);
        setPage(data.page || 1);
        setTotalPages(data.totalPages || 1);
      } catch (err) {
        console.error('[BrowsePage] fetchCatalog error:', err);
        toast({ title: 'Error', description: 'Could not load document catalog.', variant: 'destructive' });
      } finally {
        setFetching(false);
      }
    },
    [isAuthenticated, user, search, category, unitId, router, toast],
  );

  // Trigger fetch when filters or page change
  useEffect(() => {
    if (isAuthenticated && user) fetchCatalog(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user, search, category, unitId]);

  // ── Submit access request ───────────────────────────────
  const handleRequestSubmit = async () => {
    if (!requestDoc) return;
    if (!requestReason.trim()) {
      toast({ title: 'Required', description: 'Please explain why you need this document.', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const token = await AuthService.getAccessToken();
      const res = await fetch('/api/document-requests', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: requestDoc.id, reason: requestReason, type: 'DOWNLOAD' }),
      });
      if (res.ok) {
        toast({ title: 'Request submitted', description: `Your access request for "${requestDoc.title}" has been sent to the admin.` });
        // Optimistically mark the doc as pending
        setDocuments((prev) =>
          prev.map((d) => (d.id === requestDoc.id ? { ...d, hasPendingRequest: true } : d)),
        );
        setRequestDoc(null);
        setRequestReason('');
      } else {
        const err = await res.json();
        toast({ title: 'Error', description: err.error || 'Failed to submit request.', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: 'An unexpected error occurred.', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  // ── Loading skeleton ────────────────────────────────────
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <ClientOnly>
      <div className="min-h-screen bg-gray-50">
        <Navbar />

        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 mt-16">
          {/* Header */}
          <div className="mb-6">
            <button
              onClick={() => router.push('/repository')}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-[#2B4385] mb-3 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to My Documents
            </button>
            <h1 className="text-3xl font-bold" style={{ color: '#2B4385' }}>Browse All Documents</h1>
            <p className="text-gray-500 mt-1">
              Discover documents across all units. Request access to download documents you need.
            </p>
          </div>

          {/* Filters */}
          <div className="mb-6 flex flex-col gap-4">
            <div className="flex-1 relative">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder="Search by title, description, or keyword..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10 h-11 border-gray-200 focus:border-blue-500 shadow-sm"
                style={{ borderRadius: '8px' }}
              />
            </div>
            <div className="flex flex-wrap gap-2 items-center text-sm">
              <span className="text-gray-500 font-medium mr-1">Filters:</span>

              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="h-8 rounded-full bg-white border-dashed text-xs w-auto px-3 shadow-sm gap-2">
                  <Filter className="w-3 h-3 text-gray-500" />
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  <SelectItem value="Other files">Other files</SelectItem>
                  <SelectItem value="QPRO">QPRO</SelectItem>
                </SelectContent>
              </Select>

              <Select value={unitId} onValueChange={setUnitId}>
                <SelectTrigger className="h-8 rounded-full bg-white border-dashed text-xs w-auto px-3 shadow-sm gap-2">
                  <Building2 className="w-3 h-3 text-gray-500" />
                  <SelectValue placeholder="All Units" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Units</SelectItem>
                  {units.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.code} — {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {total > 0 && (
                <span className="text-gray-400 text-xs ml-auto">
                  {total} document{total !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>

          {/* Document table */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-6">
            {fetching ? (
              <div className="py-16 flex justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            ) : documents.length === 0 ? (
              <div className="py-16 text-center text-gray-400">
                <FileText className="w-12 h-12 mx-auto mb-3 opacity-40" />
                <p className="font-medium">No documents found</p>
                <p className="text-sm mt-1">Try adjusting your filters or search term</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-gray-50/50 text-gray-500 border-b border-gray-100">
                    <tr>
                      <th className="px-6 py-4 font-medium">Document</th>
                      <th className="px-6 py-4 font-medium hidden md:table-cell">Unit</th>
                      <th className="px-6 py-4 font-medium hidden sm:table-cell">Category</th>
                      <th className="px-6 py-4 font-medium hidden lg:table-cell">Date</th>
                      <th className="px-6 py-4 font-medium hidden lg:table-cell">Size</th>
                      <th className="px-6 py-4 font-medium text-right">Access</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {documents.map((doc) => {
                      const { color, bg, Icon } = getFileIcon(doc.fileName);
                      return (
                        <tr key={doc.id} className="hover:bg-gray-50/50 transition-colors">
                          {/* Name */}
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div
                                className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                                style={{ backgroundColor: bg }}
                              >
                                <Icon className="w-4 h-4" style={{ color }} />
                              </div>
                              <div className="min-w-0">
                                <p className="font-medium text-gray-900 truncate max-w-xs" title={doc.title}>
                                  {doc.title}
                                </p>
                                {doc.description && (
                                  <p className="text-xs text-gray-400 truncate max-w-xs mt-0.5" title={doc.description}>
                                    {doc.description}
                                  </p>
                                )}
                                {doc.tags && doc.tags.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {doc.tags.slice(0, 3).map((tag) => (
                                      <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
                                        {tag}
                                      </Badge>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>

                          {/* Unit */}
                          <td className="px-6 py-4 hidden md:table-cell">
                            {doc.unit ? (
                              <span className="inline-flex items-center gap-1 text-xs text-gray-600">
                                <Building2 className="w-3 h-3 text-gray-400" />
                                {doc.unit.name}
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </td>

                          {/* Category */}
                          <td className="px-6 py-4 hidden sm:table-cell">
                            <Badge variant="secondary" className="text-xs">
                              {doc.category || 'Other files'}
                            </Badge>
                          </td>

                          {/* Date */}
                          <td className="px-6 py-4 text-xs text-gray-500 hidden lg:table-cell whitespace-nowrap">
                            {new Date(doc.uploadedAt).toLocaleDateString()}
                          </td>

                          {/* Size */}
                          <td className="px-6 py-4 text-xs text-gray-500 hidden lg:table-cell">
                            {formatFileSize(doc.fileSize)}
                          </td>

                          {/* Access action */}
                          <td className="px-6 py-4 text-right">
                            {doc.hasAccess ? (
                              <div className="flex items-center justify-end gap-2">
                                <span className="inline-flex items-center gap-1 text-xs text-green-600">
                                  <Unlock className="w-3.5 h-3.5" /> Access granted
                                </span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => router.push(`/repository/preview/${doc.id}`)}
                                >
                                  View
                                </Button>
                              </div>
                            ) : doc.hasPendingRequest ? (
                              <span className="inline-flex items-center gap-1 text-xs text-yellow-600">
                                <Clock className="w-3.5 h-3.5" /> Pending review
                              </span>
                            ) : (
                              <div className="flex items-center justify-end gap-2">
                                <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                                  <Lock className="w-3.5 h-3.5" /> Restricted
                                </span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-[#2B4385] border-[#2B4385] hover:bg-[#2B4385] hover:text-white"
                                  onClick={() => { setRequestDoc(doc); setRequestReason(''); }}
                                >
                                  Request Access
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-6 py-3 border-t border-gray-100">
                <p className="text-sm text-gray-500">
                  Page {page} of {totalPages} &mdash; {total} document{total !== 1 ? 's' : ''}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => fetchCatalog(page - 1)}
                    disabled={page <= 1 || fetching}
                  >
                    <ChevronLeft className="w-4 h-4" /> Prev
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => fetchCatalog(page + 1)}
                    disabled={page >= totalPages || fetching}
                  >
                    Next <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* ── Request Access Dialog ── */}
      <Dialog open={!!requestDoc} onOpenChange={(open) => { if (!open) { setRequestDoc(null); setRequestReason(''); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Request Access</DialogTitle>
            <DialogDescription>
              You are requesting access to{' '}
              <span className="font-semibold text-gray-900">"{requestDoc?.title}"</span>.
              The admin will review your request and notify you.
            </DialogDescription>
          </DialogHeader>

          <div className="py-2 space-y-3">
            {requestDoc?.unit && (
              <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2">
                <Building2 className="w-4 h-4 text-gray-400 shrink-0" />
                <span>Unit: <span className="font-medium">{requestDoc.unit.name}</span></span>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reason for requesting access <span className="text-red-500">*</span>
              </label>
              <Textarea
                placeholder="Explain why you need access to this document..."
                value={requestReason}
                onChange={(e) => setRequestReason(e.target.value)}
                rows={4}
                className="w-full"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setRequestDoc(null); setRequestReason(''); }} disabled={submitting}>
              Cancel
            </Button>
            <Button
              style={{ backgroundColor: '#2B4385' }}
              onClick={handleRequestSubmit}
              disabled={submitting || !requestReason.trim()}
            >
              {submitting ? 'Submitting...' : 'Submit Request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ClientOnly>
  );
}
