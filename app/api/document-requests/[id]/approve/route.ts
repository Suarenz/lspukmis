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

    // Generate a secure access token
    const token = crypto.randomBytes(32).toString('hex');

    const updatedRequest = await prisma.documentRequest.update({
      where: { id },
      data: {
        status: 'APPROVED',
        token
      }
    });

    // Grant standard view/download access via DocumentPermission.
    const existingPermission = await prisma.documentPermission.findUnique({
      where: {
        documentId_userId: {
          documentId: documentRequest.documentId,
          userId: documentRequest.userId
        }
      }
    });

    if (!existingPermission) {
      await prisma.documentPermission.create({
        data: {
          documentId: documentRequest.documentId,
          userId: documentRequest.userId,
          permission: 'READ'
        }
      });
    }

    return NextResponse.json(updatedRequest);
  } catch (error) {
    console.error('Error approving document request:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
