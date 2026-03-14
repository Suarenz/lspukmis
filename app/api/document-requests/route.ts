import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';
import { DocumentRequestStatus } from '@prisma/client';

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    
    if ('status' in authResult) {
      return authResult;
    }

    const { user } = authResult;

    // Admin can see all requests
    // Other users can see their own requests
    const where = user.role === 'ADMIN' ? {} : { userId: user.id };

    const requests = await prisma.documentRequest.findMany({
      where,
      include: {
        document: {
          select: {
            id: true,
            title: true,
            fileName: true,
            fileType: true,
          }
        },
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return NextResponse.json(requests);
  } catch (error) {
    console.error('Error fetching document requests:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    
    if ('status' in authResult) {
      return authResult;
    }

    const { user } = authResult;

    if (user.role === 'STUDENT') {
      return NextResponse.json({ error: 'Students cannot request document access' }, { status: 403 });
    }

    const body = await request.json();
    const { documentId, reason } = body;

    if (!documentId || !reason) {
      return NextResponse.json({ error: 'Document ID and reason are required' }, { status: 400 });
    }

    // Check if the document exists
    const document = await prisma.document.findUnique({
      where: { id: documentId }
    });

    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Check for existing pending request
    const existingRequest = await prisma.documentRequest.findFirst({
      where: {
        documentId,
        userId: user.id,
        status: 'PENDING'
      }
    });

    if (existingRequest) {
      return NextResponse.json({ error: 'You already have a pending request for this document' }, { status: 400 });
    }

    // Create the request
    const docRequest = await prisma.documentRequest.create({
      data: {
        documentId,
        userId: user.id,
        reason,
        status: 'PENDING',
        type: 'DOWNLOAD'
      }
    });

    return NextResponse.json(docRequest, { status: 201 });
  } catch (error) {
    console.error('Error creating document request:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
