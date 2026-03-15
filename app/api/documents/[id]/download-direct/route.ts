import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import documentService from '@/lib/services/document-service';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import fileStorageService from '@/lib/services/file-storage-service';
import jwtService from '@/lib/services/jwt-service';
import prisma from '@/lib/prisma';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Extract token from query parameter
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return NextResponse.json(
        { error: 'Authentication token required' },
        { status: 401 }
      );
    }

    let userId: string | undefined;
    let document: any;
    let bypassAccessCheck = false;

    // First try JWT token
    const decoded = await jwtService.verifyToken(token).catch(() => null);
    
    if (decoded && decoded.userId) {
      userId = decoded.userId;
      // Get document using the document service to check permissions
      document = await documentService.getDocumentById(id, userId);
    } else {
      // Try DocumentRequest access token
      const docRequest = await prisma.documentRequest.findFirst({
        where: {
          token: token,
          documentId: id,
          status: 'APPROVED'
        },
        include: { document: true }
      });
      
      if (docRequest) {
        // Check token expiry
        if (docRequest.tokenExpiresAt && docRequest.tokenExpiresAt < new Date()) {
          return NextResponse.json(
            { error: 'Access token has expired. Please request access again.' },
            { status: 410 }
          );
        }
        userId = docRequest.userId;
        document = docRequest.document;
        bypassAccessCheck = true;
      }
    }

    if (!userId) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      );
    }

    if (!document) {
      return NextResponse.json(
        { error: 'Document not found or access denied' },
        { status: 404 }
      );
    }

    // Record the download (requires userId)
    await documentService.recordDownload(document.id, userId);

    // Use blobName if available (stored for QPRO and repository uploads), otherwise extract from URL
    let blobName = document.blobName;
    
    if (!blobName) {
      // Fallback: Extract the blob path from the stored URL
      // URL format: https://account.blob.core.windows.net/container/path/to/blob
      // We need to extract path/to/blob (everything after /container/)
      const urlWithoutParams = document.fileUrl.split('?')[0];
      const urlParts = urlWithoutParams.split('/'); // ['https:', '', 'account.blob.core.windows.net', 'container', 'path', 'to', 'blob']
      
      // Find container name (after the domain)
      const containerIndex = urlParts.findIndex((part: string, idx: number) => idx >= 3 && part && !part.includes('.'));
      
      if (containerIndex !== -1 && containerIndex < urlParts.length - 1) {
        // Everything after the container name is the blob path
        // Decode URL-encoded characters (e.g., %20 -> space)
        blobName = decodeURIComponent(urlParts.slice(containerIndex + 1).join('/'));
      }
    }
    
    console.log('Download attempt:', {
      documentId: id,
      extractedBlobName: blobName,
      storedUrl: document.fileUrl,
    });

    if (!blobName) {
      console.error('Failed to determine blob name for download:', document.fileUrl);
      return NextResponse.json(
        { error: 'Invalid file URL - could not determine blob name' },
        { status: 500 }
      );
    }

    try {
      // Determine the correct container based on document type
      const containerName = document.isQproDocument || document.category === 'QPRO' 
        ? 'qpro-files' 
        : 'repository-files';
      
      // Get the file URL from Azure Storage using the fileStorageService
      const fileUrl = await fileStorageService.getFileUrl(blobName, containerName);
      
      // Fetch the file from the signed URL
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }
      
      // Get the file content
      const blob = await response.blob();
      
      // Create a response with proper download headers
      return new NextResponse(blob, {
        headers: {
          'Content-Type': document.fileType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(document.fileName)}"`,
          'Content-Length': blob.size.toString(),
        },
      });
    } catch (azureError) {
      console.error('Azure Storage error:', {
        blobName,
        error: azureError instanceof Error ? azureError.message : azureError,
        documentFileUrl: document.fileUrl
      });
      return NextResponse.json(
        { error: 'Failed to generate download URL from storage' },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Error in direct download:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}