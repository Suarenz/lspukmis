import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';
import fileStorageService from '@/lib/services/file-storage-service';
import crypto from 'crypto';

/**
 * POST /api/document-requests/[id]/fulfill
 *
 * Admin-only. Fulfills an open (undirected) document request by either:
 *   A) Uploading a new document file and linking it to the request, OR
 *   B) Linking an existing document from the repository.
 *
 * After linking the document, the request is automatically approved:
 *   - A 7-day access token is generated.
 *   - A READ DocumentPermission is upserted for the requester.
 *   - The requester receives a REQUEST_APPROVED notification with the admin note.
 *
 * Body: multipart/form-data
 *   file               File      (required if not using existingDocumentId)
 *   title              string    (required when uploading a file)
 *   category           string    (optional, default "General")
 *   existingDocumentId string    (required if not uploading a file)
 *   adminNote          string    (optional, shown to requester in notification)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;
    const { user } = authResult;

    if (user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Only admins can fulfill requests' }, { status: 403 });
    }

    const { id } = await params;

    const documentRequest = await prisma.documentRequest.findUnique({
      where: { id },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!documentRequest) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    if (documentRequest.status !== 'PENDING') {
      return NextResponse.json(
        { error: `Request is already ${documentRequest.status}` },
        { status: 400 },
      );
    }

    // ── Parse multipart form ─────────────────────────────────────────────────
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
    }

    const existingDocumentId = (formData.get('existingDocumentId') as string | null)?.trim() || null;
    const adminNote = (formData.get('adminNote') as string | null)?.trim() || null;
    const file = formData.get('file') as File | null;
    const rawTitle = (formData.get('title') as string | null)?.trim() || '';
    const rawCategory = (formData.get('category') as string | null)?.trim() || 'General';

    // ── Resolve target document ──────────────────────────────────────────────
    let targetDocumentId: string;

    if (existingDocumentId) {
      const existingDoc = await prisma.document.findUnique({
        where: { id: existingDocumentId },
        select: { id: true },
      });
      if (!existingDoc) {
        return NextResponse.json(
          { error: 'The selected document does not exist' },
          { status: 404 },
        );
      }
      targetDocumentId = existingDocumentId;
    } else if (file && file.size > 0) {
      if (!rawTitle) {
        return NextResponse.json(
          { error: 'Document title is required when uploading a file' },
          { status: 400 },
        );
      }

      // Upload to Azure Blob Storage
      const { url, blobName } = await fileStorageService.saveFile(file, file.name);

      // Create a Document record for the uploaded file
      const newDoc = await prisma.document.create({
        data: {
          title: rawTitle,
          description: documentRequest.description ?? rawTitle,
          category: rawCategory,
          tags: [],
          uploadedBy: user.name || user.email,
          uploadedById: user.id,
          fileUrl: url,
          blobName,
          fileName: file.name,
          fileType: file.type || 'application/octet-stream',
          fileSize: file.size,
          status: 'ACTIVE',
        },
      });

      targetDocumentId = newDoc.id;
    } else {
      return NextResponse.json(
        { error: 'Either an existing document ID or a file upload is required' },
        { status: 400 },
      );
    }

    // ── Generate access token ────────────────────────────────────────────────
    const token = crypto.randomBytes(32).toString('hex');
    const tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // ── Update request: link document + approve ──────────────────────────────
    const updatedRequest = await prisma.documentRequest.update({
      where: { id },
      data: {
        documentId: targetDocumentId,
        status: 'APPROVED',
        token,
        tokenExpiresAt,
        ...(adminNote !== null && { adminNote }),
      },
    });

    // ── Grant READ permission ────────────────────────────────────────────────
    await prisma.documentPermission.upsert({
      where: {
        documentId_userId: {
          documentId: targetDocumentId,
          userId: documentRequest.userId,
        },
      },
      create: {
        documentId: targetDocumentId,
        userId: documentRequest.userId,
        permission: 'READ',
      },
      update: {},
    });

    // ── Notify requester ─────────────────────────────────────────────────────
    try {
      const doc = await prisma.document.findUnique({
        where: { id: targetDocumentId },
        select: { title: true },
      });
      const noteSnippet = adminNote ? ` Note from admin: ${adminNote}` : '';
      await prisma.notification.create({
        data: {
          userId: documentRequest.userId,
          type: 'REQUEST_APPROVED',
          message: `Your document request has been fulfilled. "${doc?.title ?? 'The requested document'}" is now available for download from the Requests page.${noteSnippet}`,
          relatedId: documentRequest.id,
        },
      });
    } catch (notifError) {
      console.error('Failed to create fulfillment notification:', notifError);
    }

    return NextResponse.json(updatedRequest);
  } catch (error) {
    console.error('Error fulfilling document request:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
