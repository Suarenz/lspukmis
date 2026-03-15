import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;
    const { user } = authResult;

    if (user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Only admins can revoke access' }, { status: 403 });
    }

    const { id } = await params;

    const documentRequest = await prisma.documentRequest.findUnique({
      where: { id },
    });

    if (!documentRequest) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    if (documentRequest.status !== 'APPROVED') {
      return NextResponse.json({ error: 'Only approved requests can be revoked' }, { status: 400 });
    }

    // Remove the permission and revoke the request atomically
    const [updatedRequest] = await prisma.$transaction([
      prisma.documentRequest.update({
        where: { id },
        data: { status: 'REVOKED', token: null, tokenExpiresAt: null },
      }),
      prisma.documentPermission.deleteMany({
        where: {
          documentId: documentRequest.documentId,
          userId: documentRequest.userId,
        },
      }),
    ]);

    // Notify the requester their access was revoked
    try {
      const doc = await prisma.document.findUnique({
        where: { id: documentRequest.documentId },
        select: { title: true },
      });
      await prisma.notification.create({
        data: {
          userId: documentRequest.userId,
          type: 'ACCESS_REVOKED',
          message: `Your access to "${doc?.title ?? 'a document'}" has been revoked by an administrator.`,
          relatedId: documentRequest.id,
        },
      });
    } catch (notifError) {
      console.error('Failed to create revocation notification:', notifError);
    }

    return NextResponse.json(updatedRequest);
  } catch (error) {
    console.error('Error revoking document request:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
