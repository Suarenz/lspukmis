import prisma from '@/lib/prisma';
import { Document } from '@/lib/api/types';
import ColivaraService from './colivara-service';

const colivaraService = new ColivaraService();

class EnhancedDocumentService {
  /**
   * Get all documents with optional filtering and pagination
   * Enhanced with unit, year, quarter filtering capabilities
   */
  async getDocuments(
    page: number = 1,
    limit: number = 10,
    category?: string,
    search?: string,
    userId?: string,
    sort?: string,
    order: 'asc' | 'desc' = 'desc',
    unitId?: string, // NEW: Filter by unit
    year?: number, // NEW: Filter by reporting year
    quarter?: number // NEW: Filter by reporting quarter
  ): Promise<{ documents: Document[]; total: number }> {
    const skip = (page - 1) * limit;
    
    // Build where clause based on permissions and filters
    const whereClause: any = {
      status: 'ACTIVE', // Only show active documents
    };

    // Add category filter if provided
    if (category && category !== 'all') {
      whereClause.category = category;
    }

    // Add unit filter if provided
    if (unitId) {
      whereClause.unitId = unitId; // Using the new field name that was renamed from departmentId
    }

    // Add year filter if provided
    if (year) {
      whereClause.year = year;
    }

    // Add quarter filter if provided
    if (quarter) {
      whereClause.quarter = quarter;
    }

    // Add search filter if provided
    if (search) {
      const searchCondition = {
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { tags: { array_contains: [search] } }, // Updated for JSON field
        ]
      };
      
      // If we already have conditions (like category or unit), wrap everything in AND
      if (Object.keys(whereClause).length > 1) { // More than just status
        whereClause.AND = whereClause.AND || [];
        whereClause.AND.push(searchCondition);
      } else {
        // If no other conditions exist, just add the search condition
        Object.assign(whereClause, searchCondition);
      }
    }

    // If user is not admin, only show documents they have access to
    if (userId) {
      // First, try to find the user by the provided userId (which might be the database ID)
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      // In the new system, we only use the database ID
      // If not found by database ID, we just continue with the assumption that the user doesn't have access
      // The permission checks later will handle access control

      if (user && user.role !== 'ADMIN' && user.role !== 'FACULTY') {
        // For non-admin and non-faculty users, we need to check document permissions
        // This is a simplified approach - in a real system, you'd have more complex permission logic
        const permissionCondition = {
          OR: [
            { uploadedById: user.id }, // Allow access to user's own documents (using db ID)
            { permissions: { some: { userId: user.id, permission: { in: ['READ', 'WRITE', 'ADMIN'] } } } }, // Documents with explicit permissions
          ]
        };

        // If we already have conditions in whereClause, wrap everything in AND
        if (Object.keys(whereClause).length > 1) { // More than just status
          whereClause.AND = whereClause.AND || [];
          whereClause.AND.push(permissionCondition);
        } else {
          // If no other conditions exist, just add the permission condition
          Object.assign(whereClause, permissionCondition);
        }
      }
    }

    try {
      const [documents, total] = await Promise.all([
        prisma.document.findMany({
          where: whereClause,
          skip,
          take: limit,
          orderBy: sort ? { [sort]: order } : { uploadedAt: 'desc' },
          include: {
            uploadedByUser: true,
            documentUnit: true,
          }
        }),
        prisma.document.count({ where: whereClause }),
      ]);

      return {
        documents: documents.map((doc: any) => ({
          ...doc,
          tags: Array.isArray(doc.tags) ? doc.tags as string[] : [],
          unitId: doc.unitId ?? undefined,
          blobName: doc.blobName ?? undefined, // Azure Blob Storage blob name (UUID.ext)
          year: doc.year ?? undefined,
          quarter: doc.quarter ?? undefined,
          isQproDocument: doc.isQproDocument ?? false,
          versionNotes: doc.versionNotes ?? undefined, // Convert null to undefined
          uploadedBy: doc.uploadedByUser?.name || doc.uploadedBy,
          status: doc.status as 'ACTIVE' | 'ARCHIVED' | 'PENDING_REVIEW', // Ensure proper type
          unit: doc.documentUnit ? {
            id: doc.documentUnit.id,
            name: doc.documentUnit.name,
            code: doc.documentUnit.code,
            description: doc.documentUnit.description || undefined, // Convert null to undefined
            createdAt: doc.documentUnit.createdAt,
            updatedAt: doc.documentUnit.updatedAt,
          } : undefined,
          uploadedAt: new Date(doc.uploadedAt),
          createdAt: new Date(doc.createdAt),
          updatedAt: new Date(doc.updatedAt),
          // Colivara fields
          colivaraDocumentId: doc.colivaraDocumentId ?? undefined,
          colivaraProcessingStatus: doc.colivaraProcessingStatus as 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' ?? undefined,
          colivaraProcessedAt: doc.colivaraProcessedAt ? new Date(doc.colivaraProcessedAt) : undefined,
          colivaraChecksum: doc.colivaraChecksum ?? undefined,
        })),
        total,
      };
    } catch (error) {
      console.error('Database connection error in getDocuments:', error);
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Get a specific document by ID
   * Enhanced with unit access controls
   */
  async getDocumentById(id: string, userId?: string): Promise<Document | null> {
    try {
      const document = await prisma.document.findUnique({
        where: { id },
        include: {
          uploadedByUser: true,
          documentUnit: true,
        }
      });

      if (!document) {
        return null;
      }

      // Check if user has access to the document
      if (userId) {
        // First, try to find the user by the provided userId (which might be the database ID)
        const user = await prisma.user.findUnique({
          where: { id: userId },
        });

        // In the new system, we only use the database ID
        // If not found by database ID, we just continue with the assumption that the user doesn't have access
        // The permission checks later will handle access control

        if (user && user.role !== 'ADMIN' && user.role !== 'FACULTY') {
          // Check if user has explicit permission for this document
          const permission = await prisma.documentPermission.findFirst({
            where: {
              documentId: id,
              userId: user.id, // Use the database user ID
              permission: { in: ['READ', 'WRITE', 'ADMIN'] }, // User needs at least READ permission
            },
          });

          // Allow access if user has explicit READ/WRITE/ADMIN permission OR if user uploaded the document
          if (!permission && document.uploadedById !== user.id) {
            return null; // User doesn't have access
          }
        }
      }

      return {
        id: document.id,
        title: document.title,
        description: document.description,
        category: document.category,
        tags: Array.isArray(document.tags) ? document.tags as string[] : [],
        uploadedBy: document.uploadedByUser?.name || document.uploadedBy,
        uploadedById: document.uploadedById,
        uploadedAt: new Date(document.uploadedAt),
        fileUrl: document.fileUrl,
        blobName: document.blobName ?? undefined, // Azure Blob Storage blob name (UUID.ext)
        fileName: document.fileName,
        fileType: document.fileType,
        fileSize: document.fileSize,
        downloadsCount: document.downloadsCount || 0,
        viewsCount: document.viewsCount || 0,
        version: document.version || 1,
        versionNotes: document.versionNotes || undefined, // Convert null to undefined
        status: document.status as 'ACTIVE' | 'ARCHIVED' | 'PENDING_REVIEW', // Ensure proper type
        createdAt: new Date(document.createdAt),
        updatedAt: new Date(document.updatedAt),
        unitId: document.unitId || undefined, // Convert null to undefined
        year: document.year ?? undefined,
        quarter: document.quarter ?? undefined,
        isQproDocument: document.isQproDocument ?? false,
        unit: document.documentUnit ? {
          id: document.documentUnit.id,
          name: document.documentUnit.name,
          code: document.documentUnit.code || "", // Provide empty string as fallback since Unit type requires string
          description: document.documentUnit.description || undefined, // Convert null to undefined
          createdAt: document.documentUnit.createdAt,
          updatedAt: document.documentUnit.updatedAt,
        } : undefined,
        // Colivara fields
        colivaraDocumentId: document.colivaraDocumentId ?? undefined,
        colivaraProcessingStatus: document.colivaraProcessingStatus as 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' ?? undefined,
        colivaraProcessedAt: document.colivaraProcessedAt ? new Date(document.colivaraProcessedAt) : undefined,
        colivaraChecksum: document.colivaraChecksum ?? undefined,
      };
    } catch (error) {
      console.error('Database connection error in getDocumentById:', error);
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Create a new document
   * Enhanced with unit assignment and QPRO support (year, quarter)
   */
  async createDocument(
    title: string,
    description: string,
    category: string,
    tags: string[],
    uploadedBy: string,
    fileUrl: string,
    fileName: string,
    fileType: string,
    fileSize: number,
    userId: string,
    unitId?: string, // NEW: Unit assignment
    base64Content?: string, // NEW: Base64 content for Colivara processing
    blobName?: string, // NEW: Azure Blob Storage blob name
    options?: {
      year?: number; // Reporting year for QPRO documents (2025-2029)
      quarter?: number; // Reporting quarter for QPRO documents (1-4)
      isQproDocument?: boolean; // Flag for QPRO documents
    }
  ): Promise<Document> {
    try {
      console.log('Creating document in database...', {
        title,
        description,
        category,
        tags,
        uploadedBy,
        fileUrl,
        fileName,
        fileType,
        fileSize,
        userId
      });
      
      // First, check if userId is defined
      if (!userId) {
        console.error('No userId provided to createDocument function');
        throw new Error('User ID is required to upload documents');
      }

      console.log('Attempting to find user with ID:', userId);
      
      // First, try to find user by the provided userId (which might be the database ID)
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      // In the new system, we only use the database ID
      // If not found by database ID, we return null
      if (!user) {
        console.error('User not found with provided ID:', userId);
        throw new Error('Only admins and faculty can upload documents');
      }
      
      console.log('User lookup result:', { user: !!user, role: user?.role, id: user?.id });

      if (!user || !['ADMIN', 'FACULTY'].includes(user.role)) {
        console.error('User does not have required role to upload documents:', user?.role);
        throw new Error('Only admins and faculty can upload documents');
      }

      const document = await prisma.document.create({
        data: {
          title,
          description: description || "", // Ensure description is not null
          category: category || "Other files", // Ensure category is not null
          tags: tags || [], // Ensure tags is always an array, even if undefined
          uploadedBy: user.name,
          uploadedById: user.id, // Use the database user ID, not the Supabase auth ID
          fileUrl,
          blobName: blobName || undefined, // NEW: Store blob name if provided
          fileName,
          fileType,
          fileSize,
          unitId: unitId || null, // NEW: Assign unitId if provided
          year: options?.year || null, // NEW: Reporting year for QPRO documents
          quarter: options?.quarter || null, // NEW: Reporting quarter for QPRO documents
          isQproDocument: options?.isQproDocument || false, // NEW: Flag for QPRO documents
          status: 'ACTIVE',
          colivaraProcessingStatus: 'PENDING', // Set initial processing status to PENDING
        },
      });
      
      console.log('Document created:', document.id);

      // Grant the uploader full permissions
      await prisma.documentPermission.create({
        data: {
          documentId: document.id,
          userId: user.id, // Use the database user ID for permissions
          permission: 'ADMIN',
        },
      });
      
      console.log('Document permissions granted');

      // Get the updated document to ensure we have the latest unitId value after creation
      const finalDocument = await prisma.document.findUnique({
        where: { id: document.id },
        include: {
          uploadedByUser: true,
          documentUnit: true,
        }
      });
      
      if (!finalDocument) {
        throw new Error(`Document with id ${document.id} not found after creation`);
      }

      // Trigger Colivara processing asynchronously without blocking document creation
      // SKIP for QPRO documents as they handle indexing in their own upload route
      if (!options?.isQproDocument) {
        try {
          colivaraService.processNewDocument(finalDocument as Document, fileUrl, base64Content);
        } catch (processingError) {
          console.error(`Error triggering Colivara processing for document ${document.id}:`, processingError);
          // Don't throw error as we don't want to fail the document creation due to processing issues
        }
      } else {
        console.log(`[EnhancedDocumentService] Skipping background Colivara processing for QPRO document ${document.id} - handled by upload route`);
      }
      
      return {
        id: finalDocument.id,
        title: finalDocument.title,
        description: finalDocument.description,
        category: finalDocument.category,
        tags: Array.isArray(finalDocument.tags) ? finalDocument.tags as string[] : [],
        uploadedBy: finalDocument.uploadedByUser?.name || finalDocument.uploadedBy,
        uploadedById: finalDocument.uploadedById,
        uploadedAt: new Date(finalDocument.uploadedAt),
        fileUrl: finalDocument.fileUrl,
        blobName: finalDocument.blobName ?? undefined, // Azure Blob Storage blob name (UUID.ext)
        fileName: finalDocument.fileName,
        fileType: finalDocument.fileType,
        fileSize: finalDocument.fileSize,
        downloadsCount: finalDocument.downloadsCount || 0,
        viewsCount: finalDocument.viewsCount || 0,
        version: finalDocument.version || 1,
        versionNotes: finalDocument.versionNotes ?? undefined, // Convert null to undefined
        status: finalDocument.status as 'ACTIVE' | 'ARCHIVED' | 'PENDING_REVIEW', // Ensure proper type
        createdAt: new Date(finalDocument.createdAt),
        updatedAt: new Date(finalDocument.updatedAt),
        unitId: finalDocument.unitId ?? undefined,
        year: finalDocument.year ?? undefined,
        quarter: finalDocument.quarter ?? undefined,
        isQproDocument: finalDocument.isQproDocument ?? false,
        unit: finalDocument.documentUnit ? {
          id: finalDocument.documentUnit.id,
          name: finalDocument.documentUnit.name,
          code: finalDocument.documentUnit.code || "", // Provide empty string as fallback since Unit type requires string
          description: finalDocument.documentUnit.description || undefined, // Convert null to undefined
          createdAt: finalDocument.documentUnit.createdAt,
          updatedAt: finalDocument.documentUnit.updatedAt,
        } : undefined,
        // Colivara fields
        colivaraDocumentId: finalDocument.colivaraDocumentId ?? undefined,
        colivaraProcessingStatus: finalDocument.colivaraProcessingStatus as 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' ?? undefined,
        colivaraProcessedAt: finalDocument.colivaraProcessedAt ? new Date(finalDocument.colivaraProcessedAt) : undefined,
        colivaraChecksum: finalDocument.colivaraChecksum ?? undefined,
      };
    } catch (error) {
      console.error('Database connection error in createDocument:', error);
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Update a document
   * Enhanced with unit assignment
   */
  async updateDocument(
    id: string,
    title?: string,
    description?: string,
    category?: string,
    tags?: string[],
    unitId?: string, // NEW: Unit assignment
    userId?: string,
    fileUrl?: string, // NEW: File URL for Colivara reprocessing
    base64Content?: string // NEW: Base64 content for Colivara processing
  ): Promise<Document | null> {
    try {
      const document = await prisma.document.findUnique({
        where: { id },
      });

      if (!document) {
        return null;
      }

      // Check if user has permission to update the document
      let permission = null;
      let user = null;

      if (userId) {
        // First, try to find the user by the provided userId (which might be the database ID)
        user = await prisma.user.findUnique({
          where: { id: userId },
        });

        // In the new system, we only use the database ID
        // If not found by database ID, we just continue with the assumption that the user doesn't have access
        // The permission checks later will handle access control

        if (user) {
          permission = await prisma.documentPermission.findFirst({
            where: {
              documentId: id,
              userId: user.id, // Use the database user ID
              permission: { in: ['WRITE', 'ADMIN'] },
            },
          });
        }
      }

      if (userId && !permission && user?.role !== 'ADMIN' && document.uploadedById !== user?.id) {
        throw new Error('User does not have permission to update this document');
      }

      // Update document fields that Prisma client recognizes
      const updatedDocument = await prisma.document.update({
        where: { id },
        data: {
          ...(title && { title }),
          ...(description !== undefined && { description: description || "" }),
          ...(category !== undefined && { category: category || "Other files" }),
          ...(tags !== undefined && { tags: tags || [] }),
          ...(unitId !== undefined && { unitId: unitId }), // Include unitId in the update if provided
          updatedAt: new Date(),
        },
        include: {
          uploadedByUser: true,
          documentUnit: true,
        }
      });

      // Get the updated document
      const finalDocument = updatedDocument;
      
      if (!finalDocument) {
        throw new Error(`Document with id ${id} not found after update`);
      }

      // Check if file URL has changed to determine if we need to reprocess with Colivara
      // In this implementation, we pass fileUrl as an optional parameter to determine if reprocessing is needed
      if (fileUrl) {
        try {
          colivaraService.handleDocumentUpdate(id, finalDocument as Document, fileUrl, base64Content);
        } catch (processingError) {
          console.error(`Error triggering Colivara reprocessing for document ${id}:`, processingError);
          // Don't throw error as we don't want to fail the document update due to processing issues
        }
      }
      
      return {
        id: finalDocument.id,
        title: finalDocument.title,
        description: finalDocument.description,
        category: finalDocument.category,
        tags: Array.isArray(finalDocument.tags) ? finalDocument.tags as string[] : [],
        uploadedBy: finalDocument.uploadedByUser?.name || finalDocument.uploadedBy,
        uploadedById: finalDocument.uploadedById,
        uploadedAt: new Date(finalDocument.uploadedAt),
        fileUrl: finalDocument.fileUrl,
        fileName: finalDocument.fileName,
        fileType: finalDocument.fileType,
        fileSize: finalDocument.fileSize,
        downloadsCount: finalDocument.downloadsCount || 0,
        viewsCount: finalDocument.viewsCount || 0,
        version: finalDocument.version || 1,
        versionNotes: finalDocument.versionNotes ?? undefined, // Convert null to undefined
        status: finalDocument.status as 'ACTIVE' | 'ARCHIVED' | 'PENDING_REVIEW', // Ensure proper type
        createdAt: new Date(finalDocument.createdAt),
        updatedAt: new Date(finalDocument.updatedAt),
        unitId: finalDocument.unitId ?? undefined,
        unit: finalDocument.documentUnit ? {
          id: finalDocument.documentUnit.id,
          name: finalDocument.documentUnit.name,
          code: finalDocument.documentUnit.code || "", // Provide empty string as fallback since Unit type requires string
          description: finalDocument.documentUnit.description || undefined, // Convert null to undefined
          createdAt: finalDocument.documentUnit.createdAt,
          updatedAt: finalDocument.documentUnit.updatedAt,
        } : undefined,
        // Colivara fields
        colivaraDocumentId: finalDocument.colivaraDocumentId ?? undefined,
        colivaraProcessingStatus: finalDocument.colivaraProcessingStatus as 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' ?? undefined,
        colivaraProcessedAt: finalDocument.colivaraProcessedAt ? new Date(finalDocument.colivaraProcessedAt) : undefined,
        colivaraChecksum: finalDocument.colivaraChecksum ?? undefined,
      };
    } catch (error) {
      console.error('Database connection error in updateDocument:', error);
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Get documents by unit
   */
  async getDocumentsByUnit(
    unitId: string,
    page: number = 1,
    limit: number = 10,
    userId?: string
  ): Promise<{ documents: Document[]; total: number }> {
    return this.getDocuments(page, limit, undefined, undefined, userId, undefined, 'desc', unitId);
  }

  /**
   * Get documents by unit that were uploaded by admin users only
   */
  async getAdminDocumentsByUnit(
    unitId: string,
    page: number = 1,
    limit: number = 10,
    userId?: string
  ): Promise<{ documents: Document[]; total: number }> {
    const skip = (page - 1) * limit;
    
    // Build where clause based on permissions and filters
    const whereClause: any = {
      status: 'ACTIVE', // Only show active documents
      unitId: unitId, // Filter by unit
    };

    // If user is not admin, only show documents they have access to
    if (userId) {
      // First, try to find the user by the provided userId (which might be the database ID)
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      // In the new system, we only use the database ID
      // If not found by database ID, we just continue with the assumption that the user doesn't have access
      // The permission checks later will handle access control

      if (user && user.role === 'ADMIN') {
        // Admins can see all documents in the unit regardless of who uploaded them
        // No additional filtering needed for admins
      } else if (user && user.role !== 'FACULTY') {
        // For non-admin and non-faculty users, we need to check document permissions
        const permissionCondition = {
          OR: [
            { uploadedById: user.id }, // Allow access to user's own documents (using db ID)
            { permissions: { some: { userId: user.id, permission: { in: ['READ', 'WRITE', 'ADMIN'] } } } }, // Documents with explicit permissions
          ]
        };

        // If we already have conditions in whereClause, wrap everything in AND
        if (Object.keys(whereClause).length > 1) { // More than just status
          whereClause.AND = whereClause.AND || [];
          whereClause.AND.push(permissionCondition);
        } else {
          // If no other conditions exist, just add the permission condition
          Object.assign(whereClause, permissionCondition);
        }
      }
    }

    try {
      const [documents, total] = await Promise.all([
        prisma.document.findMany({
          where: whereClause,
          skip,
          take: limit,
          orderBy: { uploadedAt: 'desc' },
          include: {
            uploadedByUser: true,
            documentUnit: true,
          }
        }),
        prisma.document.count({ where: whereClause }),
      ]);

      return {
        documents: documents.map((doc: any) => ({
          ...doc,
          tags: Array.isArray(doc.tags) ? doc.tags as string[] : [],
          unitId: doc.unitId ?? undefined,
          versionNotes: doc.versionNotes ?? undefined, // Convert null to undefined
          uploadedBy: doc.uploadedByUser?.name || doc.uploadedBy,
          status: doc.status as 'ACTIVE' | 'ARCHIVED' | 'PENDING_REVIEW', // Ensure proper type
          unit: doc.documentUnit ? {
            id: doc.documentUnit.id,
            name: doc.documentUnit.name,
            code: doc.documentUnit.code || "", // Provide empty string as fallback since Unit type requires string
            description: doc.documentUnit.description || undefined, // Convert null to undefined
            createdAt: doc.documentUnit.createdAt,
            updatedAt: doc.documentUnit.updatedAt,
          } : undefined,
          uploadedAt: new Date(doc.uploadedAt),
          createdAt: new Date(doc.createdAt),
          updatedAt: new Date(doc.updatedAt),
          // Colivara fields
          colivaraDocumentId: doc.colivaraDocumentId ?? undefined,
          colivaraProcessingStatus: doc.colivaraProcessingStatus as 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' ?? undefined,
          colivaraProcessedAt: doc.colivaraProcessedAt ? new Date(doc.colivaraProcessedAt) : undefined,
          colivaraChecksum: doc.colivaraChecksum ?? undefined,
        })),
        total,
      };
    } catch (error) {
      console.error('Database connection error in getAdminDocumentsByUnit:', error);
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Get user's unit permissions
   */
  async getUserUnitPermissions(userId: string, unitId: string): Promise<any | null> {
    // This method is actually part of the unit permission service, not document service
    // Placeholder implementation - this should be moved to the unit permission service
    return null;
  }

  /**
   * Search documents with unit filters
   */
  async searchDocuments(
    query: string,
    unitId?: string,
    category?: string,
    tags?: string[],
    userId?: string,
    page: number = 1,
    limit: number = 10
  ): Promise<{ documents: Document[]; total: number }> {
    return this.getDocuments(page, limit, category, query, userId, undefined, 'desc', unitId);
  }
}

export default new EnhancedDocumentService();