'use client';

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useRouter } from 'next/navigation';
import {
  FileText,
  Check,
  X,
  Clock,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  ShieldOff,
  Upload,
  MessageSquare,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import AuthService from '@/lib/services/auth-service';
import { Navbar } from '@/components/navbar';
import { ClientOnly } from '@/components/client-only-wrapper';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

export default function RequestsPage() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const { toast } = useToast();
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // ── Reject dialog ────────────────────────────────────────────────────────
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectTargetId, setRejectTargetId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // ── New Request dialog (requestor) ───────────────────────────────────────
  const [newRequestDialogOpen, setNewRequestDialogOpen] = useState(false);
  const [newRequestDescription, setNewRequestDescription] = useState('');
  const [newRequestReason, setNewRequestReason] = useState('');
  const [submittingNewRequest, setSubmittingNewRequest] = useState(false);

  // ── Fulfill & Approve dialog (admin) ────────────────────────────────────
  const [fulfillDialogOpen, setFulfillDialogOpen] = useState(false);
  const [fulfillTargetId, setFulfillTargetId] = useState<string | null>(null);
  const [fulfillTargetDescription, setFulfillTargetDescription] = useState('');
  const [fulfillMode, setFulfillMode] = useState<'upload' | 'existing'>('upload');
  const [fulfillFile, setFulfillFile] = useState<File | null>(null);
  const [fulfillTitle, setFulfillTitle] = useState('');
  const [fulfillExistingId, setFulfillExistingId] = useState('');
  const [fulfillAdminNote, setFulfillAdminNote] = useState('');
  const [submittingFulfill, setSubmittingFulfill] = useState(false);
  // ── Document selector for "Link Existing" mode ──────────────────────────
  const [fulfillDocSearch, setFulfillDocSearch] = useState('');
  const [fulfillDocList, setFulfillDocList] = useState<{ id: string; title: string; category: string }[]>([]);
  const [fulfillDocLoading, setFulfillDocLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isLoading) {
      if (!isAuthenticated) {
        router.push('/');
      } else if (user?.role === 'STUDENT') {
        router.push('/repository');
      } else {
        fetchRequests(1);
      }
    }
  }, [isLoading, isAuthenticated, user, router]);

  const fetchRequests = async (targetPage = page) => {
    try {
      const token = await AuthService.getAccessToken();
      const response = await fetch(`/api/document-requests?page=${targetPage}&limit=20`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        setRequests(data.requests);
        setTotalPages(data.totalPages);
        setPage(data.page);
      }
    } catch (error) {
      console.error('Error fetching requests:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchFulfillDocs = async (search = '') => {
    setFulfillDocLoading(true);
    try {
      const token = await AuthService.getAccessToken();
      const res = await fetch(
        `/api/documents/catalog?limit=20&search=${encodeURIComponent(search)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.ok) {
        const data = await res.json();
        setFulfillDocList(data.documents);
      }
    } catch { /* silent */ } finally {
      setFulfillDocLoading(false);
    }
  };

  useEffect(() => {
    if (fulfillMode === 'existing') fetchFulfillDocs(fulfillDocSearch);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fulfillMode]);

  // Approve a targeted (existing document) request directly
  const handleAction = async (id: string, action: 'approve' | 'reject', reason?: string) => {
    try {
      const token = await AuthService.getAccessToken();
      const response = await fetch(`/api/document-requests/${id}/${action}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: action === 'reject' ? JSON.stringify({ reason: reason || '' }) : undefined,
      });
      if (response.ok) {
        toast({ title: 'Success', description: `Request ${action}d successfully.` });
        fetchRequests(page);
      } else {
        const error = await response.json();
        toast({ title: 'Error', description: error.error || `Failed to ${action} request`, variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: 'An unexpected error occurred.', variant: 'destructive' });
    }
  };

  const handleCancel = async (id: string) => {
    try {
      const token = await AuthService.getAccessToken();
      const response = await fetch(`/api/document-requests/${id}/cancel`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (response.ok) {
        toast({ title: 'Cancelled', description: 'Your request has been cancelled.' });
        fetchRequests(page);
      } else {
        const error = await response.json();
        toast({ title: 'Error', description: error.error || 'Failed to cancel request', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: 'An unexpected error occurred.', variant: 'destructive' });
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      const token = await AuthService.getAccessToken();
      const response = await fetch(`/api/document-requests/${id}/revoke`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (response.ok) {
        toast({ title: 'Revoked', description: 'Access has been revoked successfully.' });
        fetchRequests(page);
      } else {
        const error = await response.json();
        toast({ title: 'Error', description: error.error || 'Failed to revoke access', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: 'An unexpected error occurred.', variant: 'destructive' });
    }
  };

  // Submit a new open request (requestor)
  const submitNewRequest = async () => {
    if (!newRequestDescription.trim()) {
      toast({ title: 'Error', description: 'Please describe the document you need.', variant: 'destructive' });
      return;
    }
    if (!newRequestReason.trim()) {
      toast({ title: 'Error', description: 'Please provide a reason for the request.', variant: 'destructive' });
      return;
    }
    setSubmittingNewRequest(true);
    try {
      const token = await AuthService.getAccessToken();
      const response = await fetch('/api/document-requests', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          description: newRequestDescription,
          reason: newRequestReason,
        }),
      });
      if (response.ok) {
        toast({ title: 'Request Submitted', description: 'Your request has been sent to administrators for review.' });
        setNewRequestDialogOpen(false);
        setNewRequestDescription('');
        setNewRequestReason('');
        fetchRequests(1);
      } else {
        const err = await response.json();
        toast({ title: 'Error', description: err.error || 'Failed to submit request.', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: 'An unexpected error occurred.', variant: 'destructive' });
    } finally {
      setSubmittingNewRequest(false);
    }
  };

  // Fulfill & approve an open request (admin)
  const handleFulfill = async () => {
    if (fulfillMode === 'upload') {
      if (!fulfillFile) {
        toast({ title: 'Error', description: 'Please select a file to upload.', variant: 'destructive' });
        return;
      }
      if (!fulfillTitle.trim()) {
        toast({ title: 'Error', description: 'Please enter a title for the document.', variant: 'destructive' });
        return;
      }
    } else {
      if (!fulfillExistingId.trim()) {
        toast({ title: 'Error', description: 'Please select a document from the list.', variant: 'destructive' });
        return;
      }
    }

    setSubmittingFulfill(true);
    try {
      const token = await AuthService.getAccessToken();
      const formData = new FormData();

      if (fulfillMode === 'upload' && fulfillFile) {
        formData.append('file', fulfillFile);
        formData.append('title', fulfillTitle.trim());
      } else {
        formData.append('existingDocumentId', fulfillExistingId.trim());
      }

      if (fulfillAdminNote.trim()) {
        formData.append('adminNote', fulfillAdminNote.trim());
      }

      const response = await fetch(`/api/document-requests/${fulfillTargetId}/fulfill`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });

      if (response.ok) {
        toast({ title: 'Fulfilled', description: 'Request fulfilled and approved. The requester has been notified.' });
        resetFulfillDialog();
        fetchRequests(page);
      } else {
        const err = await response.json();
        toast({ title: 'Error', description: err.error || 'Failed to fulfill request.', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: 'An unexpected error occurred.', variant: 'destructive' });
    } finally {
      setSubmittingFulfill(false);
    }
  };

  const openFulfillDialog = (request: any) => {
    setFulfillTargetId(request.id);
    setFulfillTargetDescription(request.description || '');
    setFulfillMode('upload');
    setFulfillFile(null);
    setFulfillTitle(request.description?.slice(0, 80) || '');
    setFulfillExistingId('');
    setFulfillAdminNote('');
    setFulfillDocSearch('');
    setFulfillDocList([]);
    setFulfillDialogOpen(true);
  };

  const resetFulfillDialog = () => {
    setFulfillDialogOpen(false);
    setFulfillTargetId(null);
    setFulfillTargetDescription('');
    setFulfillFile(null);
    setFulfillTitle('');
    setFulfillExistingId('');
    setFulfillAdminNote('');
    setFulfillDocSearch('');
    setFulfillDocList([]);
  };

  if (isLoading || loading) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    </div>
  );

  return (
    <ClientOnly>
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <Navbar />
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 mt-16 text-gray-900">
          <div className="flex justify-between items-center mb-8">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Document Requests</h1>
              <p className="mt-2 text-gray-600">
                {user?.role === 'ADMIN'
                  ? 'Manage document access requests from faculty and personnel.'
                  : 'Track the status of your document access requests.'}
              </p>
            </div>
            {user?.role !== 'ADMIN' && (
              <Button
                onClick={() => setNewRequestDialogOpen(true)}
                style={{ backgroundColor: '#2B4385', color: 'white' }}
              >
                + New Request
              </Button>
            )}
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            {requests.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                No document requests found.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200 text-sm font-medium text-gray-500">
                      <th className="p-4">Document</th>
                      {user?.role === 'ADMIN' && <th className="p-4">Requested By</th>}
                      <th className="p-4">Reason</th>
                      <th className="p-4">Date</th>
                      <th className="p-4">Status</th>
                      <th className="p-4">Action / Token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((request) => (
                      <tr key={request.id} className="border-b border-gray-100 hover:bg-gray-50">
                        {/* Document / Description column */}
                        <td className="p-4">
                          <div className="flex items-center">
                            <FileText className="w-5 h-5 text-gray-400 mr-3 shrink-0" />
                            <div>
                              <span className="font-medium text-gray-900 line-clamp-1">
                                {request.document?.title ?? 'Open Request'}
                              </span>
                              {!request.document && request.documentType && (
                                <span className="inline-block text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded px-1.5 py-0.5 mt-0.5">
                                  {request.documentType}
                                </span>
                              )}
                              {!request.document && request.description && (
                                <p className="text-xs text-gray-500 line-clamp-2 mt-0.5">{request.description}</p>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* Requested by (admin only) */}
                        {user?.role === 'ADMIN' && (
                          <td className="p-4 text-sm text-gray-600">
                            {request.user.name || request.user.email}
                          </td>
                        )}

                        {/* Reason */}
                        <td className="p-4 text-sm text-gray-600 max-w-xs truncate">
                          {request.reason}
                        </td>

                        {/* Date */}
                        <td className="p-4 text-sm text-gray-500 whitespace-nowrap">
                          {new Date(request.createdAt).toLocaleDateString()}
                        </td>

                        {/* Status */}
                        <td className="p-4">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border
                            ${request.status === 'APPROVED' ? 'bg-green-50 text-green-700 border-green-200' :
                              request.status === 'REJECTED' ? 'bg-red-50 text-red-700 border-red-200' :
                              request.status === 'REVOKED' ? 'bg-gray-100 text-gray-500 border-gray-300' :
                              'bg-yellow-50 text-yellow-700 border-yellow-200'}`}>
                            {request.status === 'PENDING' && <Clock className="w-3 h-3 mr-1" />}
                            {request.status === 'APPROVED' && <Check className="w-3 h-3 mr-1" />}
                            {request.status === 'REJECTED' && <X className="w-3 h-3 mr-1" />}
                            {request.status === 'REVOKED' && <ShieldOff className="w-3 h-3 mr-1" />}
                            {request.status}
                          </span>
                          {/* Rejection reason shown to everyone */}
                          {request.status === 'REJECTED' && request.rejectionReason && (
                            <p className="text-xs text-red-500 mt-1 max-w-xs" title={request.rejectionReason}>
                              {request.rejectionReason.length > 60
                                ? request.rejectionReason.slice(0, 60) + '…'
                                : request.rejectionReason}
                            </p>
                          )}
                          {/* Admin note shown to requestor on approved/fulfilled requests */}
                          {user?.role !== 'ADMIN' && request.status === 'APPROVED' && request.adminNote && (
                            <div className="flex items-start gap-1 mt-1">
                              <MessageSquare className="w-3 h-3 text-blue-400 mt-0.5 shrink-0" />
                              <p className="text-xs text-blue-600 max-w-xs" title={request.adminNote}>
                                {request.adminNote.length > 80
                                  ? request.adminNote.slice(0, 80) + '…'
                                  : request.adminNote}
                              </p>
                            </div>
                          )}
                        </td>

                        {/* Action / Token column */}
                        <td className="p-4">
                          {user?.role === 'ADMIN' && request.status === 'PENDING' ? (
                            <div className="flex gap-2 flex-wrap">
                              {/* Open requests (no document) get "Fulfill & Approve" */}
                              {!request.document ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                                  onClick={() => openFulfillDialog(request)}
                                >
                                  <Upload className="w-3 h-3 mr-1" />
                                  Fulfill &amp; Approve
                                </Button>
                              ) : (
                                // Targeted requests get direct "Approve"
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-green-600 hover:text-green-700"
                                  onClick={() => handleAction(request.id, 'approve')}
                                >
                                  Approve
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-red-600 hover:text-red-700"
                                onClick={() => {
                                  setRejectTargetId(request.id);
                                  setRejectReason('');
                                  setRejectDialogOpen(true);
                                }}
                              >
                                Reject
                              </Button>
                            </div>
                          ) : (user?.role !== 'ADMIN' && request.status === 'PENDING') ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-gray-500 hover:text-red-600"
                              onClick={() => handleCancel(request.id)}
                            >
                              <X className="w-3 h-3 mr-1" /> Cancel
                            </Button>
                          ) : (user?.role !== 'ADMIN' && request.status === 'APPROVED' && request.token && request.document) ? (
                            <div className="flex flex-col gap-1">
                              <a
                                href={`/api/documents/${request.document.id}/download-direct?token=${request.token}`}
                                download
                                className="inline-flex items-center text-xs text-blue-600 hover:text-blue-800 px-2 py-1 rounded hover:bg-blue-50 transition-colors"
                              >
                                <ExternalLink className="w-3 h-3 mr-1" /> Download
                              </a>
                            </div>
                          ) : (user?.role === 'ADMIN' && request.status === 'APPROVED') ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-orange-600 hover:text-orange-700"
                              onClick={() => handleRevoke(request.id)}
                            >
                              <ShieldOff className="w-3 h-3 mr-1" /> Revoke
                            </Button>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
                <p className="text-sm text-gray-500">Page {page} of {totalPages}</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => fetchRequests(page - 1)} disabled={page <= 1}>
                    <ChevronLeft className="w-4 h-4" /> Prev
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => fetchRequests(page + 1)} disabled={page >= totalPages}>
                    Next <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* ── New Open Request Dialog (requestor) ───────────────────────────── */}
          <Dialog open={newRequestDialogOpen} onOpenChange={setNewRequestDialogOpen}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Request a Document</DialogTitle>
              </DialogHeader>
              <div className="py-2 space-y-4">
                {/* Description */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Document description <span className="text-red-500">*</span>
                  </label>
                  <Textarea
                    placeholder="Describe the specific document you're looking for (e.g. 'Faculty leave form for AY 2025-2026')"
                    value={newRequestDescription}
                    onChange={(e) => setNewRequestDescription(e.target.value)}
                    rows={3}
                    className="w-full"
                  />
                </div>

                {/* Reason */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason for request <span className="text-red-500">*</span>
                  </label>
                  <Textarea
                    placeholder="Why do you need this document?"
                    value={newRequestReason}
                    onChange={(e) => setNewRequestReason(e.target.value)}
                    rows={2}
                    className="w-full"
                  />
                </div>
              </div>
              <DialogFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setNewRequestDialogOpen(false);
                    setNewRequestDescription('');
                    setNewRequestReason('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={
                    !newRequestDescription.trim() ||
                    !newRequestReason.trim() ||
                    submittingNewRequest
                  }
                  onClick={submitNewRequest}
                  style={{ backgroundColor: '#2B4385', color: 'white' }}
                >
                  {submittingNewRequest ? 'Submitting…' : 'Submit Request'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* ── Reject with reason dialog ─────────────────────────────────────── */}
          <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Reject Request</DialogTitle>
              </DialogHeader>
              <div className="py-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Reason (optional)
                </label>
                <Textarea
                  placeholder="Provide a reason for rejection so the requester knows how to proceed…"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={3}
                  className="w-full"
                />
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (rejectTargetId) {
                      handleAction(rejectTargetId, 'reject', rejectReason);
                      setRejectDialogOpen(false);
                      setRejectTargetId(null);
                    }
                  }}
                >
                  Confirm Reject
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* ── Fulfill & Approve dialog (admin) ──────────────────────────────── */}
          <Dialog open={fulfillDialogOpen} onOpenChange={(open) => { if (!open) resetFulfillDialog(); }}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Fulfill &amp; Approve Request</DialogTitle>
              </DialogHeader>

              {/* Request context summary */}
              {fulfillTargetDescription && (
                <div className="text-sm text-gray-600 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                  <span className="font-medium text-blue-800">Requested document:</span>{' '}
                  {fulfillTargetDescription}
                </div>
              )}

              {/* Mode toggle */}
              <div className="flex gap-2 mt-1">
                <button
                  type="button"
                  onClick={() => setFulfillMode('upload')}
                  className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium border transition-colors ${
                    fulfillMode === 'upload'
                      ? 'bg-[#2B4385] text-white border-[#2B4385]'
                      : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <Upload className="w-3.5 h-3.5 inline mr-1.5" />
                  Upload New File
                </button>
                <button
                  type="button"
                  onClick={() => setFulfillMode('existing')}
                  className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium border transition-colors ${
                    fulfillMode === 'existing'
                      ? 'bg-[#2B4385] text-white border-[#2B4385]'
                      : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5 inline mr-1.5" />
                  Link Existing Document
                </button>
              </div>

              <div className="space-y-4 py-1">
                {fulfillMode === 'upload' ? (
                  <>
                    {/* File picker */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        File <span className="text-red-500">*</span>
                      </label>
                      <div
                        className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center cursor-pointer hover:border-[#2B4385] transition-colors"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        {fulfillFile ? (
                          <div className="flex items-center justify-center gap-2 text-sm text-gray-700">
                            <FileText className="w-4 h-4 text-[#2B4385]" />
                            <span className="font-medium truncate max-w-xs">{fulfillFile.name}</span>
                            <span className="text-gray-400">({(fulfillFile.size / 1024).toFixed(1)} KB)</span>
                          </div>
                        ) : (
                          <div className="text-sm text-gray-500">
                            <Upload className="w-6 h-6 mx-auto mb-1 text-gray-400" />
                            Click to select a file (PDF, DOCX, etc.)
                          </div>
                        )}
                      </div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        className="hidden"
                        accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.jpg,.jpeg,.png"
                        onChange={(e) => {
                          const f = e.target.files?.[0] ?? null;
                          setFulfillFile(f);
                          if (f && !fulfillTitle) {
                            // Pre-fill title from filename (strip extension)
                            setFulfillTitle(f.name.replace(/\.[^.]+$/, ''));
                          }
                        }}
                      />
                    </div>

                    {/* Document title */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Document title <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2B4385]"
                        placeholder="Enter a descriptive title for this document"
                        value={fulfillTitle}
                        onChange={(e) => setFulfillTitle(e.target.value)}
                      />
                    </div>
                  </>
                ) : (
                  /* Link existing document — searchable selector */
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Select Document <span className="text-red-500">*</span>
                    </label>
                    <div className="relative mb-2">
                      <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-gray-400 pointer-events-none" />
                      <input
                        type="text"
                        className="w-full border border-gray-300 rounded-md pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#2B4385]"
                        placeholder="Search documents by title…"
                        value={fulfillDocSearch}
                        onChange={(e) => {
                          setFulfillDocSearch(e.target.value);
                          fetchFulfillDocs(e.target.value);
                        }}
                      />
                    </div>
                    <div className="border border-gray-200 rounded-md overflow-y-auto max-h-48">
                      {fulfillDocLoading ? (
                        <div className="p-3 text-sm text-gray-400 text-center">Loading…</div>
                      ) : fulfillDocList.length === 0 ? (
                        <div className="p-3 text-sm text-gray-400 text-center">No documents found.</div>
                      ) : (
                        fulfillDocList.map((doc) => (
                          <button
                            key={doc.id}
                            type="button"
                            onClick={() => setFulfillExistingId(doc.id)}
                            className={`w-full text-left px-3 py-2 text-sm border-b last:border-b-0 transition-colors ${
                              fulfillExistingId === doc.id
                                ? 'bg-[#2B4385] text-white'
                                : 'hover:bg-gray-50 text-gray-800'
                            }`}
                          >
                            <div className="font-medium truncate">{doc.title}</div>
                            <div className={`text-xs ${fulfillExistingId === doc.id ? 'text-blue-200' : 'text-gray-400'}`}>
                              {doc.category}
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                    {fulfillExistingId && (
                      <p className="text-xs text-green-600 mt-1 flex items-center gap-1">
                        <Check className="w-3 h-3" /> Document selected
                      </p>
                    )}
                  </div>
                )}

                {/* Admin note (always visible) */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Note to requester <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <Textarea
                    placeholder="Add any instructions or context for the requester (e.g. 'Valid for 7 days. Contact HR for renewal.')"
                    value={fulfillAdminNote}
                    onChange={(e) => setFulfillAdminNote(e.target.value)}
                    rows={2}
                    className="w-full"
                  />
                </div>
              </div>

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={resetFulfillDialog} disabled={submittingFulfill}>
                  Cancel
                </Button>
                <Button
                  disabled={submittingFulfill}
                  onClick={handleFulfill}
                  style={{ backgroundColor: '#2B4385', color: 'white' }}
                >
                  {submittingFulfill ? 'Processing…' : 'Fulfill & Approve'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </main>
      </div>
    </ClientOnly>
  );
}
