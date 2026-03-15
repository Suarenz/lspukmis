import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';

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
      return NextResponse.json({ error: 'Only admins can reject requests' }, { status: 403 });
    }

    const { id } = await params;

    let rejectionReason: string | undefined;
    try {
      const body = await request.json();
      rejectionReason = body?.reason?.trim() || undefined;
    } catch {
      // reason is optional, ignore parse errors
    }

    const documentRequest = await prisma.documentRequest.findUnique({
      where: { id }
    });

    if (!documentRequest) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    if (documentRequest.status !== 'PENDING') {
      return NextResponse.json({ error: `Request is already ${documentRequest.status}` }, { status: 400 });
    }

    const updatedRequest = await prisma.documentRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        ...(rejectionReason && { rejectionReason }),
      }
    });

    // Notify the requester their request was rejected
    try {
      const doc = await prisma.document.findUnique({
        where: { id: documentRequest.documentId },
        select: { title: true },
      });
      const reasonSuffix = rejectionReason ? ` Reason: ${rejectionReason}` : '';
      await prisma.notification.create({
        data: {
          userId: documentRequest.userId,
          type: 'REQUEST_REJECTED',
          message: `Your access request for "${doc?.title ?? 'a document'}" was rejected.${reasonSuffix}`,
          relatedId: documentRequest.id,
        },
      });
    } catch (notifError) {
      console.error('Failed to create rejection notification:', notifError);
    }

    return NextResponse.json(updatedRequest);
  } catch (error) {
    console.error('Error rejecting document request:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
