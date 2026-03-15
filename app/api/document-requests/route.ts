import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;
    const { user } = authResult;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
    const skip = (page - 1) * limit;

    const where = user.role === 'ADMIN' ? {} : { userId: user.id };

    const [requests, total] = await Promise.all([
      prisma.documentRequest.findMany({
        where,
        include: {
          document: {
            select: { id: true, title: true, fileName: true, fileType: true },
          },
          user: {
            select: { id: true, email: true, name: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.documentRequest.count({ where }),
    ]);

    return NextResponse.json({
      requests,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Error fetching document requests:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;
    const { user } = authResult;

    if (user.role === 'STUDENT') {
      return NextResponse.json({ error: 'Students cannot request document access' }, { status: 403 });
    }

    const body = await request.json();
    const { documentId, reason, type, description, documentType } = body;

    // Must have either a documentId (targeted) or a description (open/undirected request)
    if (!documentId && !description) {
      return NextResponse.json(
        { error: 'Either a document ID or a description of the needed document is required' },
        { status: 400 },
      );
    }
    if (!reason) {
      return NextResponse.json({ error: 'A reason for the request is required' }, { status: 400 });
    }

    // ── Targeted request: verify document exists and no duplicate pending ──
    let document: { id: string; title: string } | null = null;

    if (documentId) {
      document = await prisma.document.findUnique({
        where: { id: documentId },
        select: { id: true, title: true },
      });

      if (!document) {
        return NextResponse.json({ error: 'Document not found' }, { status: 404 });
      }

      const existingRequest = await prisma.documentRequest.findFirst({
        where: { documentId, userId: user.id, status: 'PENDING' },
      });

      if (existingRequest) {
        return NextResponse.json(
          { error: 'You already have a pending request for this document' },
          { status: 400 },
        );
      }
    }

    // ── Create the request ──
    const docRequest = await prisma.documentRequest.create({
      data: {
        documentId: documentId || null,
        userId: user.id,
        reason,
        description: !documentId ? (description ?? null) : null,
        documentType: !documentId ? (documentType ?? null) : null,
        status: 'PENDING',
        type: type || (documentId ? 'DOWNLOAD' : 'OPEN'),
      },
    });

    // ── Notify all admins ──
    try {
      const admins = await prisma.user.findMany({
        where: { role: 'ADMIN' },
        select: { id: true },
      });
      if (admins.length > 0) {
        const message = document
          ? `New access request for "${document.title}" from ${user.name || user.email}.`
          : `New open document request from ${user.name || user.email}${documentType ? ` (${documentType})` : ''}: "${(description ?? '').slice(0, 120)}".`;

        await prisma.notification.createMany({
          data: admins.map((admin) => ({
            userId: admin.id,
            type: 'NEW_REQUEST',
            message,
            relatedId: docRequest.id,
          })),
        });
      }
    } catch (notifError) {
      console.error('Failed to create admin notifications:', notifError);
      // Non-critical: don't fail the request creation
    }

    return NextResponse.json(docRequest, { status: 201 });
  } catch (error) {
    console.error('Error creating document request:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
