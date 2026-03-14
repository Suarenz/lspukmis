'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useRouter } from 'next/navigation';
import { FileText, Check, X, Clock, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import AuthService from '@/lib/services/auth-service';
import { Navbar } from '@/components/navbar';
import { ClientOnly } from '@/components/client-only-wrapper';

export default function RequestsPage() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const { toast } = useToast();
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isLoading) {
      if (!isAuthenticated) {
        router.push('/');
      } else if (user?.role === 'STUDENT') {
        router.push('/repository');
      } else {
        fetchRequests();
      }
    }
  }, [isLoading, isAuthenticated, user, router]);

  const fetchRequests = async () => {
    try {
      const token = await AuthService.getAccessToken();
      const response = await fetch('/api/document-requests', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        setRequests(data);
      }
    } catch (error) {
      console.error('Error fetching requests:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (id: string, action: 'approve' | 'reject') => {
    try {
      const token = await AuthService.getAccessToken();
      const response = await fetch(`/api/document-requests/${id}/${action}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.ok) {
        toast({
          title: "Success",
          description: `Request ${action}d successfully.`,
        });
        fetchRequests(); // refresh
      } else {
        const error = await response.json();
        toast({
          title: "Error",
          description: error.error || `Failed to ${action} request`,
          variant: "destructive"
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "An unexpected error occurred.",
        variant: "destructive"
      });
    }
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
                      <th className="p-4">Action/Token</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((request) => (
                      <tr key={request.id} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="p-4">
                          <div className="flex items-center">
                            <FileText className="w-5 h-5 text-gray-400 mr-3" />
                            <span className="font-medium text-gray-900 line-clamp-1">{request.document.title}</span>
                          </div>
                        </td>
                        {user?.role === 'ADMIN' && (
                          <td className="p-4 text-sm text-gray-600">
                            {request.user.name || request.user.email}
                          </td>
                        )}
                        <td className="p-4 text-sm text-gray-600 max-w-xs truncate">
                          {request.reason}
                        </td>
                        <td className="p-4 text-sm text-gray-500">
                          {new Date(request.createdAt).toLocaleDateString()}
                        </td>
                        <td className="p-4">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border
                            ${request.status === 'APPROVED' ? 'bg-green-50 text-green-700 border-green-200' :
                              request.status === 'REJECTED' ? 'bg-red-50 text-red-700 border-red-200' :
                              'bg-yellow-50 text-yellow-700 border-yellow-200'}`}>
                            {request.status === 'PENDING' && <Clock className="w-3 h-3 mr-1" />}
                            {request.status === 'APPROVED' && <Check className="w-3 h-3 mr-1" />}
                            {request.status === 'REJECTED' && <X className="w-3 h-3 mr-1" />}
                            {request.status}
                          </span>
                        </td>
                        <td className="p-4">
                          {user?.role === 'ADMIN' && request.status === 'PENDING' ? (
                            <div className="flex gap-2">
                              <Button size="sm" variant="outline" className="text-green-600 hover:text-green-700" onClick={() => handleAction(request.id, 'approve')}>
                                Approve
                              </Button>
                              <Button size="sm" variant="outline" className="text-red-600 hover:text-red-700" onClick={() => handleAction(request.id, 'reject')}>
                                Reject
                              </Button>
                            </div>
                          ) : (user?.role !== 'ADMIN' && request.status === 'APPROVED' && request.token) ? (
                            <div className="flex flex-col gap-1">
                              <div className="text-xs text-mono bg-gray-100 p-1 rounded font-mono truncate w-32" title={request.token}>
                                {request.token}
                              </div>
                              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-blue-600" onClick={() => router.push(`/api/documents/${request.document.id}/download-direct?token=${request.token}`)}>
                                <ExternalLink className="w-3 h-3 mr-1" /> Download
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
      </div>
    </ClientOnly>
  );
}
