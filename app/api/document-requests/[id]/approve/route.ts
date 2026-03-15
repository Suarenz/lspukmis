import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';
import crypto from 'crypto';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authResult = await requireAuth(request);
    
    if ('status' in authResult) {
      return authResult;
    }

    const { user } = authResult;

    if (user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Only admins can approve requests' }, { status: 403 });
    }

    const { id } = await params;

    const documentRequest = await prisma.documentRequest.findUnique({
      where: { id }
    });

    if (!documentRequest) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    if (documentRequest.status !== 'PENDING') {
      return NextResponse.json({ error: `Request is already ${documentRequest.status}` }, { status: 400 });
    }

    // Open requests (no documentId) must go through the fulfill endpoint,
    // which lets the admin attach a document before approving.
    if (!documentRequest.documentId) {
      return NextResponse.json(
        {
          error:
            'This is an open request with no document attached. Use "Fulfill & Approve" to upload or link a document first.',
        },
        { status: 400 },
      );
    }

    // Generate a secure access token
    const token = crypto.randomBytes(32).toString('hex');
    const tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const updatedRequest = await prisma.documentRequest.update({
      where: { id },
      data: {
        status: 'APPROVED',
        token,
        tokenExpiresAt,
      }
    });

    // Grant standard view/download access via DocumentPermission.
    await prisma.documentPermission.upsert({
      where: {
        documentId_userId: {
          documentId: documentRequest.documentId,
          userId: documentRequest.userId,
        },
      },
      create: {
        documentId: documentRequest.documentId,
        userId: documentRequest.userId,
        permission: 'READ',
      },
      update: {},
    });

    // Notify the requester their request was approved
    try {
      const doc = await prisma.document.findUnique({
        where: { id: documentRequest.documentId },
        select: { title: true },
      });
      await prisma.notification.create({
        data: {
          userId: documentRequest.userId,
          type: 'REQUEST_APPROVED',
          message: `Your access request for "${doc?.title ?? 'a document'}" has been approved. You can now download it from the Requests page.`,
          relatedId: documentRequest.id,
        },
      });
    } catch (notifError) {
      console.error('Failed to create approval notification:', notifError);
    }

    return NextResponse.json(updatedRequest);
  } catch (error) {
    console.error('Error approving document request:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
