import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import prisma from '@/lib/prisma';

/**
 * GET /api/documents/catalog
 *
 * Returns metadata-only representations of ALL active documents so that
 * FACULTY/PERSONNEL/EXTERNAL users can discover documents they don't yet have
 * access to and submit a request. File URLs and blob names are intentionally
 * excluded from the response.
 *
 * Query params:
 *   page       – page number (default 1)
 *   limit      – results per page (max 50, default 20)
 *   search     – full-text filter on title / description / tags
 *   category   – exact category match (or omit / "all" for no filter)
 *   unitId     – filter by unit
 *   ids        – comma-separated document IDs for a targeted batch lookup
 *
 * Response shape per document:
 *   { id, title, description, category, tags, fileName, fileType, fileSize,
 *     uploadedAt, uploadedBy, unitId, unit, year, quarter, isQproDocument,
 *     hasAccess, hasPendingRequest }
 *
 * Roles allowed: ADMIN, FACULTY, PERSONNEL, EXTERNAL
 * STUDENTs are blocked (403).
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;
    const { user } = authResult;

    if (user.role === 'STUDENT') {
      return NextResponse.json({ error: 'Not authorized to browse the document catalog' }, { status: 403 });
    }

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
    const skip = (page - 1) * limit;
    const search = url.searchParams.get('search') || '';
    const category = url.searchParams.get('category') || '';
    const unitId = url.searchParams.get('unitId') || '';
    const idsParam = url.searchParams.get('ids') || '';

    // Build where clause
    const whereClause: any = { status: 'ACTIVE' };

    if (category && category !== 'all') {
      whereClause.category = category;
    }
    if (unitId) {
      whereClause.unitId = unitId;
    }
    if (idsParam) {
      const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) {
        whereClause.id = { in: ids };
      }
    }
    if (search) {
      whereClause.AND = [
        {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
            { tags: { array_contains: [search] } },
          ],
        },
      ];
    }

    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { uploadedAt: 'desc' },
        select: {
          id: true,
          title: true,
          description: true,
          category: true,
          tags: true,
          fileName: true,
          fileType: true,
          fileSize: true,
          uploadedAt: true,
          uploadedById: true,
          unitId: true,
          year: true,
          quarter: true,
          isQproDocument: true,
          uploadedByUser: { select: { name: true } },
          documentUnit: { select: { id: true, name: true, code: true } },
          // Check if the current user has an explicit permission record
          permissions: {
            where: { userId: user.id },
            select: { permission: true },
          },
          // Check if the user already has a PENDING request
          requests: {
            where: { userId: user.id, status: 'PENDING' },
            select: { id: true },
          },
        },
      }),
      // Skip COUNT query for targeted ID lookups (unnecessary overhead)
      idsParam
        ? Promise.resolve(null)
        : prisma.document.count({ where: whereClause }),
    ]);

    const catalogDocs = documents.map((doc: any) => {
      const hasExplicitPermission = doc.permissions.length > 0;
      const hasAccess =
        user.role === 'ADMIN' ||
        doc.uploadedById === user.id ||
        ((user.role === 'FACULTY' || user.role === 'PERSONNEL') &&
          doc.unitId &&
          doc.unitId === user.unitId) ||
        hasExplicitPermission;

      return {
        id: doc.id,
        title: doc.title,
        description: doc.description,
        category: doc.category,
        tags: Array.isArray(doc.tags) ? doc.tags : [],
        fileName: doc.fileName,
        fileType: doc.fileType,
        fileSize: doc.fileSize,
        uploadedAt: doc.uploadedAt,
        uploadedBy: doc.uploadedByUser?.name ?? 'Unknown',
        unitId: doc.unitId ?? null,
        unit: doc.documentUnit
          ? { id: doc.documentUnit.id, name: doc.documentUnit.name, code: doc.documentUnit.code }
          : null,
        year: doc.year ?? null,
        quarter: doc.quarter ?? null,
        isQproDocument: doc.isQproDocument ?? false,
        hasAccess,
        hasPendingRequest: doc.requests.length > 0,
      };
    });

    const resolvedTotal = total ?? catalogDocs.length;

    return NextResponse.json({
      documents: catalogDocs,
      total: resolvedTotal,
      page,
      totalPages: Math.ceil(resolvedTotal / limit),
    });
  } catch (error) {
    console.error('[catalog] Error fetching document catalog:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
