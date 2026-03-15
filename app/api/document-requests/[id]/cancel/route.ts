import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;
    const { user } = authResult;

    const { id } = await params;

    const documentRequest = await prisma.documentRequest.findUnique({
      where: { id },
    });

    if (!documentRequest) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    if (documentRequest.userId !== user.id) {
      return NextResponse.json({ error: 'You can only cancel your own requests' }, { status: 403 });
    }

    if (documentRequest.status !== 'PENDING') {
      return NextResponse.json({ error: 'Only pending requests can be cancelled' }, { status: 400 });
    }

    await prisma.documentRequest.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error cancelling document request:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
