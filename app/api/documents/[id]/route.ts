import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import documentService from '@/lib/services/document-service';
import { requireAuth } from '@/lib/middleware/auth-middleware';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Verify authentication
    const authResult = await requireAuth(request);
    if ('status' in authResult) { // Check if it's a NextResponse (error case)
      return authResult;
    }
    
    const { user } = authResult;
    const userId = user.id;

    // Get document using the document service
    const document = await documentService.getDocumentById(id, userId);

    if (!document) {
      return NextResponse.json(
        { error: 'Document not found or access denied' },
        { status: 404 }
      );
    }

    return NextResponse.json(document);
 } catch (error) {
    console.error('Error fetching document:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Verify authentication and check role
    const authResult = await requireAuth(request, ['ADMIN', 'FACULTY', 'PERSONNEL']);
    if ('status' in authResult) { // Check if it's a NextResponse (error case)
      return authResult;
    }
    
    const { user } = authResult;

    const userId = user.id;
    const userRole = user.role;

    // Parse request body
    const body = await request.json();
    const { title, description, category, tags, unitId, fileUrl } = body; // NEW: Include fileUrl for Colivara reprocessing

    // Update the document in the database
    const updatedDocument = await documentService.updateDocument(
      id,
      title,
      description,
      category,
      tags,
      unitId, // NEW: Pass unitId to updateDocument
      userId,
      fileUrl // NEW: Pass fileUrl for Colivara reprocessing
    );

    if (!updatedDocument) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(updatedDocument);
  } catch (error) {
    console.error('Error updating document:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Verify authentication
    const authResult = await requireAuth(request);
    if ('status' in authResult) { // Check if it's a NextResponse (error case)
      return authResult;
    }
    
    const { user } = authResult;

    const userId = user.id;

    // Check if user has required permissions to delete the document
    // User can delete if they are an admin/faculty OR if they are the document owner
    const document = await documentService.getDocumentById(id);
    if (!document) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 404 }
      );
    }

    const hasPermission = user.role === 'ADMIN' || user.role === 'FACULTY' || user.role === 'PERSONNEL' || document.uploadedById === userId;
    if (!hasPermission) {
      return NextResponse.json(
        { error: 'User does not have permission to delete this document' },
        { status: 403 }
      );
    }

    // Delete the document (this will delete both database record and file)
    const success = await documentService.deleteDocument(id, userId);

    if (!success) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ message: 'Document and associated file deleted successfully' });
  } catch (error) {
    console.error('Error deleting document:', error);
    // If it's a specific error from document service, return that message
    if (error instanceof Error) {
      if (error.message.includes('permission')) {
        return NextResponse.json(
          { error: error.message },
          { status: 403 }
        );
      } else if (error.message.includes('not found')) {
        return NextResponse.json(
          { error: error.message },
          { status: 404 }
        );
      }
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}