import prisma from '@/lib/prisma';
import { Document, DocumentPermission, DocumentComment, User } from '@/lib/api/types';
import fileStorageService from './file-storage-service';
import ColivaraService from './colivara-service';

// Create a singleton instance of the Colivara service
const colivaraService = new ColivaraService();

class DocumentService {
  /**
   * Helper method to find a user by database ID only
   */
  private async findUserById(userId: string): Promise<User | null> {
    // Find user by the provided userId (database ID)
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return null;
    }

    // Transform the Prisma user to match the API type
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as 'ADMIN' | 'FACULTY' | 'STUDENT' | 'EXTERNAL',
      unitId: user.unitId || undefined, // Convert null to undefined
      avatar: user.avatar || undefined, // Convert null to undefined
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /**
   * Get all documents with optional filtering and pagination
   */
  async getDocuments(
    page: number = 1,
    limit: number = 10,
    category?: string,
    search?: string,
    userId?: string,
    sort?: string,
    order: 'asc' | 'desc' = 'desc',
    unitId?: string  // NEW: Unit filter
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
      whereClause.unitId = unitId;
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
      const user = await this.findUserById(userId);

      if (user && user.role !== 'ADMIN') {
        let permissionCondition;
        
        if (user.role === 'FACULTY' || user.role === 'PERSONNEL') {
          permissionCondition = {
            OR: [
              { uploadedById: user.id },
              { unitId: user.unitId || 'NO_UNIT' },
              { permissions: { some: { userId: user.id, permission: { in: ['READ', 'WRITE', 'ADMIN'] } } } }
            ]
          };
        } else {
          permissionCondition = {
            OR: [
              { uploadedById: user.id }, 
              { permissions: { some: { userId: user.id, permission: { in: ['READ', 'WRITE', 'ADMIN'] } } } } 
            ]
          };
        }

        // If we already have conditions in whereClause, wrap everything in AND
        if (Object.keys(whereClause).length > 1 || whereClause.AND) {
          whereClause.AND = whereClause.AND || [];
          whereClause.AND.push(permissionCondition);
        } else {
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
          tags: Array.isArray(doc.tags) ? doc.tags as string[] : (typeof doc.tags === 'object' && doc.tags !== null ? Object.values(doc.tags) : []),
          unitId: doc.unitId ?? undefined,
          blobName: doc.blobName ?? undefined, // Azure Blob Storage blob name (UUID.ext)
          versionNotes: doc.versionNotes ?? undefined,
          downloadsCount: doc.downloadsCount ?? 0,
          viewsCount: doc.viewsCount ?? 0,
          uploadedBy: doc.uploadedByUser?.name || doc.uploadedBy,
          unit: doc.documentUnit || undefined,
          uploadedAt: new Date(doc.uploadedAt),
          createdAt: new Date(doc.createdAt),
          updatedAt: new Date(doc.updatedAt),
        })),
        total,
      };
    } catch (error) {
      console.error('Database connection error in getDocuments:', error);
      // Check if this is an authentication error
      if (error instanceof Error &&
          (error.message.includes('Authentication failed') ||
           error.message.includes('password') ||
           error.message.includes('credentials'))) {
        throw new Error('Database authentication failed. Please check your database credentials.');
      }
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Get a specific document by ID
   */
  async getDocumentById(id: string, userId?: string): Promise<Document | null> {
    try {
      // Validate the document ID format before querying the database
      if (!id || typeof id !== 'string' || id.trim() === '' || id.includes('undefined') || id.includes('.pdf') || id.includes('.')) {
        console.warn('Invalid document ID format received in getDocumentById:', id);
        return null;
      }

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
        const user = await this.findUserById(userId);

          // For STUDENT or EXTERNAL roles
          if (user && user.role !== 'ADMIN' && user.role !== 'FACULTY' && user.role !== 'PERSONNEL') {
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
          // For FACULTY and PERSONNEL roles
          else if (user && (user.role === 'FACULTY' || user.role === 'PERSONNEL')) {
            // They can view documents uploaded by them OR belonging to their unit
            if (document.uploadedById !== user.id && document.unitId !== user.unitId) {
              // Also allow if they have an explicit permission (e.g., from an approved document request)
              const permission = await prisma.documentPermission.findFirst({
                where: {
                  documentId: id,
                  userId: user.id,
                  permission: { in: ['READ', 'WRITE', 'ADMIN'] },
                },
              });
              if (!permission) {
                return null; // No unit match, not the uploader, and no explicit permission
              }
            }
          }
        }

        return {
        ...document,
        tags: Array.isArray(document.tags) ?
          (document.tags as any[]).map(tag => String(tag)) :
          (typeof document.tags === 'object' && document.tags !== null ?
            Object.values(document.tags).map(tag => String(tag)) : []),
        year: document.year ?? undefined,
        quarter: document.quarter ?? undefined,
        unitId: document.unitId || undefined, // Convert null to undefined
        blobName: document.blobName ?? undefined, // Azure Blob Storage blob name (UUID.ext)
        versionNotes: document.versionNotes || undefined, // Convert null to undefined
        downloadsCount: document.downloadsCount || 0, // Convert null to 0
        viewsCount: document.viewsCount || 0, // Convert null to 0
        uploadedBy: document.uploadedByUser?.name || document.uploadedBy,
        status: document.status as 'ACTIVE' | 'ARCHIVED' | 'PENDING_REVIEW',
        unit: document.documentUnit && document.documentUnit.code ? {
          id: document.documentUnit.id,
          name: document.documentUnit.name,
          code: document.documentUnit.code,
          description: document.documentUnit.description || undefined, // Convert null to undefined
          createdAt: document.documentUnit.createdAt,
          updatedAt: document.documentUnit.updatedAt,
        } : undefined,
        uploadedAt: new Date(document.uploadedAt),
        createdAt: new Date(document.createdAt),
        updatedAt: new Date(document.updatedAt),
        colivaraDocumentId: document.colivaraDocumentId ?? undefined,
        colivaraProcessingStatus: document.colivaraProcessingStatus as 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' ?? undefined,
        colivaraProcessedAt: document.colivaraProcessedAt ? new Date(document.colivaraProcessedAt) : undefined,
        colivaraChecksum: document.colivaraChecksum ?? undefined,
      };
    } catch (error) {
      console.error('Database connection error in getDocumentById:', error);
      // Check if this is an authentication error
      if (error instanceof Error &&
          (error.message.includes('Authentication failed') ||
           error.message.includes('password') ||
           error.message.includes('credentials'))) {
        throw new Error('Database authentication failed. Please check your database credentials.');
      }
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Create a new document
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
    unitId?: string  // NEW: Unit assignment
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
      
      const user = await this.findUserById(userId);
      
      console.log('User lookup result:', { user: !!user, role: user?.role });

      if (!user || !['ADMIN', 'FACULTY'].includes(user.role)) {
        throw new Error('Only admins and faculty can upload documents');
      }

      const document = await prisma.document.create({
        data: {
          title,
          description,
          category,
          tags: tags || [], // Ensure tags is always an array, even if undefined
          uploadedBy: user.name,
          uploadedById: user.id, // Use the database user ID, not the Supabase auth ID
          fileUrl,
          fileName,
          fileType,
          fileSize,
          unitId: unitId || undefined, // Use provided unitId or undefined
          status: 'ACTIVE',
        },
        include: {
          uploadedByUser: true,
          documentUnit: true,
        }
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
      
      return {
        id: document.id,
        title: document.title,
        description: document.description,
        category: document.category,
        tags: Array.isArray(document.tags) ?
          (document.tags as any[]).map(tag => String(tag)) :
          (typeof document.tags === 'object' && document.tags !== null ?
            Object.values(document.tags).map(tag => String(tag)) : []),
        uploadedBy: document.uploadedByUser?.name || document.uploadedBy,
        uploadedById: document.uploadedById,
        uploadedAt: new Date(document.uploadedAt),
        fileUrl: document.fileUrl,
        fileName: document.fileName,
        fileType: document.fileType,
        fileSize: document.fileSize,
        downloadsCount: document.downloadsCount || 0, // Convert null to 0
        viewsCount: document.viewsCount || 0, // Convert null to 0
        version: document.version || 1,
        versionNotes: document.versionNotes || undefined, // Convert null to undefined
        status: document.status as 'ACTIVE' | 'ARCHIVED' | 'PENDING_REVIEW',
        createdAt: new Date(document.createdAt),
        updatedAt: new Date(document.updatedAt),
        unitId: document.unitId || undefined, // Convert null to undefined
        unit: document.documentUnit && document.documentUnit.code ? {
          id: document.documentUnit.id,
          name: document.documentUnit.name,
          code: document.documentUnit.code,
          description: document.documentUnit.description || undefined, // Convert null to undefined
          createdAt: document.documentUnit.createdAt,
          updatedAt: document.documentUnit.updatedAt,
        } : undefined,
        colivaraDocumentId: document.colivaraDocumentId ?? undefined,
        colivaraProcessingStatus: document.colivaraProcessingStatus as 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' ?? undefined,
        colivaraProcessedAt: document.colivaraProcessedAt ? new Date(document.colivaraProcessedAt) : undefined,
        colivaraChecksum: document.colivaraChecksum ?? undefined,
      };
    } catch (error) {
      console.error('Database connection error in createDocument:', error);
      // Check if this is an authentication error
      if (error instanceof Error &&
          (error.message.includes('Authentication failed') ||
           error.message.includes('password') ||
           error.message.includes('credentials'))) {
        throw new Error('Database authentication failed. Please check your database credentials.');
      }
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Update a document
   */
  async updateDocument(
    id: string,
    title?: string,
    description?: string,
    category?: string,
    tags?: string[],
    unitId?: string, // NEW: Unit assignment
    userId?: string,
    fileUrl?: string // NEW: File URL for Colivara reprocessing
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
        user = await this.findUserById(userId);

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
          ...(description && { description }),
          ...(category && { category }),
          ...(tags !== undefined && { tags: tags || [] }),
          ...(unitId !== undefined && { unitId }),
          updatedAt: new Date(),
        },
        include: {
          uploadedByUser: true,
          documentUnit: true,
        }
      });

      return {
        id: updatedDocument.id,
        title: updatedDocument.title,
        description: updatedDocument.description,
        category: updatedDocument.category,
        tags: Array.isArray(updatedDocument.tags) ?
          (updatedDocument.tags as any[]).map(tag => String(tag)) :
          (typeof updatedDocument.tags === 'object' && updatedDocument.tags !== null ?
            Object.values(updatedDocument.tags).map(tag => String(tag)) : []),
        uploadedBy: updatedDocument.uploadedByUser?.name || updatedDocument.uploadedBy,
        uploadedById: updatedDocument.uploadedById,
        uploadedAt: new Date(updatedDocument.uploadedAt),
        fileUrl: updatedDocument.fileUrl,
        fileName: updatedDocument.fileName,
        fileType: updatedDocument.fileType,
        fileSize: updatedDocument.fileSize,
        downloadsCount: updatedDocument.downloadsCount || 0, // Convert null to 0
        viewsCount: updatedDocument.viewsCount || 0, // Convert null to 0
        version: updatedDocument.version || 1,
        versionNotes: updatedDocument.versionNotes || undefined, // Convert null to undefined
        status: updatedDocument.status as 'ACTIVE' | 'ARCHIVED' | 'PENDING_REVIEW',
        createdAt: new Date(updatedDocument.createdAt),
        updatedAt: new Date(updatedDocument.updatedAt),
        unitId: updatedDocument.unitId || undefined, // Convert null to undefined
        unit: updatedDocument.documentUnit && updatedDocument.documentUnit.code ? {
          id: updatedDocument.documentUnit.id,
          name: updatedDocument.documentUnit.name,
          code: updatedDocument.documentUnit.code,
          description: updatedDocument.documentUnit.description || undefined, // Convert null to undefined
          createdAt: updatedDocument.documentUnit.createdAt,
          updatedAt: updatedDocument.documentUnit.updatedAt,
        } : undefined,
        colivaraDocumentId: updatedDocument.colivaraDocumentId ?? undefined,
        colivaraProcessingStatus: updatedDocument.colivaraProcessingStatus as 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' ?? undefined,
        colivaraProcessedAt: updatedDocument.colivaraProcessedAt ? new Date(updatedDocument.colivaraProcessedAt) : undefined,
        colivaraChecksum: updatedDocument.colivaraChecksum ?? undefined,
      };
    } catch (error) {
      console.error('Database connection error in updateDocument:', error);
      // Check if this is an authentication error
      if (error instanceof Error &&
          (error.message.includes('Authentication failed') ||
           error.message.includes('password') ||
           error.message.includes('credentials'))) {
        throw new Error('Database authentication failed. Please check your database credentials.');
      }
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Delete a document
   */
  async deleteDocument(id: string, userId: string): Promise<boolean> {
    try {
      const document = await prisma.document.findUnique({
        where: { id },
        include: {
          permissions: true, // Include related permissions
          comments: true,    // Include related comments
          downloads: true,   // Include related downloads
          views: true,       // Include related views
        }
      });
  
      if (!document) {
        return false;
      }
  
      const user = await this.findUserById(userId);
  
      if (!user) {
        throw new Error('User not found');
      }
  
      // Check if user has permission to delete the document
      const permission = await prisma.documentPermission.findFirst({
        where: {
          documentId: id,
          userId: user.id, // Use the database user ID
          permission: 'ADMIN',
        },
      });
  
      if (!permission && user.role !== 'ADMIN' && document.uploadedById !== user.id) {
        throw new Error('User does not have permission to delete this document');
      }
  
      // QPRO CLEANUP: Before deleting, capture KPIContribution records for accurate deduction
      // This solves the "memory loss" problem - we know exactly what this document contributed
      const kpiContributions = await prisma.kPIContribution.findMany({
        where: { document_id: id },
        select: {
          id: true,
          kra_id: true,
          initiative_id: true,
          value: true,
          year: true,
          quarter: true,
          target_type: true,
        }
      });

      // Also get aggregation activities for legacy cleanup (in case contributions don't exist)
      const qproAnalysis = await prisma.qPROAnalysis.findFirst({
        where: { documentId: id },
        select: {
          id: true,
          year: true,
          quarter: true,
          unitId: true,
          aggregationActivities: {
            where: { isApproved: true },
            select: {
              initiative_id: true,
              reported: true,
              aggregation_id: true,
            }
          }
        }
      });

      // Track which KRAggregations need recalculation (from KPIContributions - preferred)
      const contributionsByKpi = new Map<string, { kraId: string; initiativeId: string; value: number; year: number; quarter: number }>();
      for (const contrib of kpiContributions) {
        const key = `${contrib.kra_id}|${contrib.initiative_id}|${contrib.year}|${contrib.quarter}`;
        contributionsByKpi.set(key, {
          kraId: contrib.kra_id,
          initiativeId: contrib.initiative_id,
          value: contrib.value,
          year: contrib.year,
          quarter: contrib.quarter,
        });
      }

      // Fallback: Track from aggregation activities if no contributions exist
      const affectedAggregations: { aggregationId: string; initiativeId: string; reportedValue: number }[] = [];
      if (kpiContributions.length === 0 && qproAnalysis?.aggregationActivities) {
        for (const activity of qproAnalysis.aggregationActivities) {
          if (activity.aggregation_id && activity.reported !== null) {
            affectedAggregations.push({
              aggregationId: activity.aggregation_id,
              initiativeId: activity.initiative_id,
              reportedValue: activity.reported,
            });
          }
        }
      }

      console.log(`[Document Delete] Found ${kpiContributions.length} KPIContributions to deduct, ${affectedAggregations.length} legacy aggregation activities`);

      // Delete related records first (due to foreign key constraints)
      await prisma.documentComment.deleteMany({
        where: { documentId: id },
      });
      
      await prisma.documentDownload.deleteMany({
        where: { documentId: id },
      });
      
      await prisma.documentView.deleteMany({
        where: { documentId: id },
      });
      
      await prisma.documentPermission.deleteMany({
        where: { documentId: id },
      });
      
      // Delete Colivara indexes if they exist
      await prisma.colivaraIndex.deleteMany({
        where: { documentId: id },
      });

      // Delete the file from storage before removing the database record
      try {
        const fileName = document.fileUrl.split('/').pop(); // Extract filename from URL
        if (fileName) {
          const fileDeleted = await fileStorageService.deleteFile(fileName);
          if (!fileDeleted) {
            console.warn(`Failed to delete file ${fileName} from storage, but continuing with database deletion`);
          }
        } else {
          console.warn(`Could not extract filename from URL: ${document.fileUrl}`);
        }
      } catch (fileError) {
        console.error('Error deleting file from storage:', fileError);
        // Continue with database deletion even if file deletion fails to avoid orphaned records
      }
  
      // Delete from Colivara index if it exists
      try {
        // Initialize the service if needed (in case it hasn't been initialized)
        if (!colivaraService['isInitialized']) {
          await colivaraService.initialize();
        }
        await colivaraService.deleteFromIndex(id);
      } catch (colivaraError) {
        console.error(`Failed to delete document ${id} from Colivara index:`, colivaraError);
        // Continue with deletion even if Colivara deletion fails
      }
      
      // Delete the document from the database (cascades to QPROAnalysis, AggregationActivity, and KPIContribution)
      await prisma.document.delete({
        where: { id },
      });

      // QPRO CLEANUP: Deduct contributions from KRAggregation records after deletion
      // Use KPIContributions (preferred - accurate per-document stamped values)
      if (contributionsByKpi.size > 0) {
        console.log(`[Document Delete] Deducting ${contributionsByKpi.size} KPI contributions from aggregations`);
        
        for (const [, contrib] of contributionsByKpi) {
          try {
            // Find the KRAggregation for this KPI
            const aggregation = await prisma.kRAggregation.findFirst({
              where: {
                year: contrib.year,
                quarter: contrib.quarter,
                kra_id: contrib.kraId,
                initiative_id: contrib.initiativeId,
              },
            });

            if (!aggregation) {
              console.log(`[Document Delete] No KRAggregation found for ${contrib.kraId}/${contrib.initiativeId}`);
              continue;
            }

            // Deduct the exact contribution value
            const newTotal = Math.max(0, (aggregation.total_reported ?? 0) - contrib.value);
            const newCount = Math.max(0, aggregation.submission_count - 1);
            
            if (newCount === 0) {
              // No more contributions - delete the KRAggregation record
              await prisma.kRAggregation.delete({
                where: { id: aggregation.id },
              });
              console.log(`[Document Delete] Deleted empty KRAggregation: ${aggregation.id}`);
            } else {
              // Recalculate achievement with the deducted total
              const targetValue = aggregation.target_value?.toNumber() ?? 1;
              const newAchievement = targetValue > 0 ? (newTotal / targetValue) * 100 : 0;
              
              await prisma.kRAggregation.update({
                where: { id: aggregation.id },
                data: {
                  total_reported: newTotal,
                  submission_count: newCount,
                  achievement_percent: Math.min(newAchievement, 100),
                  last_updated: new Date(),
                }
              });
              console.log(`[Document Delete] Deducted ${contrib.value} from KRAggregation ${aggregation.id}: new total=${newTotal}`);
            }
          } catch (deductError) {
            console.error(`[Document Delete] Error deducting contribution for ${contrib.initiativeId}:`, deductError);
          }
        }
      } 
      // Fallback: Legacy recalculation for documents without KPIContributions
      else if (affectedAggregations.length > 0) {
        console.log(`[Document Delete] Legacy recalculating ${affectedAggregations.length} affected KRAggregation records`);
        
        for (const affected of affectedAggregations) {
          try {
            // Get remaining approved activities for this aggregation
            const remainingActivities = await prisma.aggregationActivity.findMany({
              where: {
                aggregation_id: affected.aggregationId,
                isApproved: true,
              },
              select: {
                reported: true,
              }
            });

            if (remainingActivities.length === 0) {
              // No more activities - delete the KRAggregation record
              await prisma.kRAggregation.delete({
                where: { id: affected.aggregationId },
              });
              console.log(`[Document Delete] Deleted orphaned KRAggregation: ${affected.aggregationId}`);
            } else {
              // Recalculate totals from remaining activities
              const newTotal = remainingActivities.reduce((sum, a) => sum + (a.reported ?? 0), 0);
              const newCount = remainingActivities.length;
              
              // Get target for achievement calculation
              const aggregation = await prisma.kRAggregation.findUnique({
                where: { id: affected.aggregationId },
                select: { target_value: true }
              });
              
              const targetValue = aggregation?.target_value?.toNumber() ?? 1;
              const newAchievement = targetValue > 0 ? (newTotal / targetValue) * 100 : 0;
              
              await prisma.kRAggregation.update({
                where: { id: affected.aggregationId },
                data: {
                  total_reported: newTotal,
                  submission_count: newCount,
                  achievement_percent: Math.min(newAchievement, 100),
                  last_updated: new Date(),
                }
              });
              console.log(`[Document Delete] Updated KRAggregation ${affected.aggregationId}: total=${newTotal}, count=${newCount}`);
            }
          } catch (recalcError) {
            console.error(`[Document Delete] Error recalculating KRAggregation ${affected.aggregationId}:`, recalcError);
            // Continue with other aggregations even if one fails
          }
        }
      }
  
      return true;
    } catch (error) {
      console.error('Database connection error in deleteDocument:', error);
      // Check if this is an authentication error
      if (error instanceof Error &&
          (error.message.includes('Authentication failed') ||
           error.message.includes('password') ||
           error.message.includes('credentials'))) {
        throw new Error('Database authentication failed. Please check your database credentials.');
      }
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Get document permissions
   */
  async getDocumentPermissions(documentId: string, userId: string): Promise<DocumentPermission[]> {
    try {
      const user = await this.findUserById(userId);
  
      if (!user) {
        throw new Error('User not found');
      }
  
      // Check if user has admin permission for the document
      const adminPermission = await prisma.documentPermission.findFirst({
        where: {
          documentId,
          userId: user.id, // Use the database user ID
          permission: 'ADMIN',
        },
      });
  
      if (!adminPermission && user.role !== 'ADMIN') {
        throw new Error('User does not have permission to view document permissions');
      }
  
      const permissions = await prisma.documentPermission.findMany({
        where: { documentId },
      });
  
      return permissions.map((perm: any) => ({
        ...perm,
        permission: perm.permission as 'READ' | 'WRITE' | 'ADMIN',
        createdAt: new Date(perm.createdAt),
      }));
    } catch (error) {
      console.error('Database connection error in getDocumentPermissions:', error);
      // Check if this is an authentication error
      if (error instanceof Error &&
          (error.message.includes('Authentication failed') ||
           error.message.includes('password') ||
           error.message.includes('credentials'))) {
        throw new Error('Database authentication failed. Please check your database credentials.');
      }
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Add or update document permission
   */
  async setDocumentPermission(
    documentId: string,
    userId: string,
    targetUserId: string,
    permission: 'READ' | 'WRITE' | 'ADMIN'
  ): Promise<DocumentPermission> {
    try {
      // Find the requesting user
      const user = await this.findUserById(userId);
  
      if (!user) {
        throw new Error('Requesting user not found');
      }
  
      // Check if the requesting user has admin permission for the document
      const adminPermission = await prisma.documentPermission.findFirst({
        where: {
          documentId,
          userId: user.id, // Use the database user ID
          permission: 'ADMIN',
        },
      });
  
      if (!adminPermission && user.role !== 'ADMIN') {
        throw new Error('User does not have permission to manage document permissions');
      }
  
      // Find the target user
      const targetUser = await this.findUserById(targetUserId);
  
      if (!targetUser) {
        throw new Error('Target user does not exist');
      }
  
      // Create or update the permission
      const permissionRecord = await prisma.documentPermission.upsert({
        where: {
          documentId_userId: {
            documentId,
            userId: targetUser.id, // Use the target user's database ID
          },
        },
        update: {
          permission,
        },
        create: {
          documentId,
          userId: targetUser.id, // Use the target user's database ID
          permission,
        },
      });
  
      return {
        ...permissionRecord,
        permission: permissionRecord.permission as 'READ' | 'WRITE' | 'ADMIN',
        createdAt: new Date(permissionRecord.createdAt),
      };
    } catch (error) {
      console.error('Database connection error in setDocumentPermission:', error);
      // Check if this is an authentication error
      if (error instanceof Error &&
          (error.message.includes('Authentication failed') ||
           error.message.includes('password') ||
           error.message.includes('credentials'))) {
        throw new Error('Database authentication failed. Please check your database credentials.');
      }
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Remove document permission
   */
  async removeDocumentPermission(
    documentId: string,
    userId: string,
    targetUserId: string
  ): Promise<boolean> {
    try {
      // Find the requesting user
      const requestingUser = await this.findUserById(userId);

      if (!requestingUser) {
        throw new Error('Requesting user not found');
      }

      // Check if the requesting user has admin permission for the document
      const adminPermission = await prisma.documentPermission.findFirst({
        where: {
          documentId,
          userId: requestingUser.id, // Use the database user ID
          permission: 'ADMIN',
        },
      });

      if (!adminPermission && requestingUser.role !== 'ADMIN') {
        throw new Error('User does not have permission to manage document permissions');
      }

      // Find the target user
      const targetUser = await this.findUserById(targetUserId);

      if (!targetUser) {
        throw new Error('Target user does not exist');
      }

      await prisma.documentPermission.delete({
        where: {
          documentId_userId: {
            documentId,
            userId: targetUser.id, // Use the target user's database ID
          },
        },
      });

      return true;
    } catch (error) {
      console.error('Database connection error in removeDocumentPermission:', error);
      // Check if this is an authentication error
      if (error instanceof Error &&
          (error.message.includes('Authentication failed') ||
           error.message.includes('password') ||
           error.message.includes('credentials'))) {
        throw new Error('Database authentication failed. Please check your database credentials.');
      }
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Record document download
   */
  async recordDownload(documentId: string, userId: string): Promise<void> {
    try {
      const user = await this.findUserById(userId);

      if (!user) {
        throw new Error('User not found');
      }

      await prisma.documentDownload.create({
        data: {
          documentId,
          userId: user.id, // Use the database user ID
        },
      });

      // Increment download count
      await prisma.document.update({
        where: { id: documentId },
        data: {
          downloadsCount: {
            increment: 1,
          },
        },
      });
    } catch (error) {
      console.error('Database connection error in recordDownload:', error);
      // Check if this is an authentication error
      if (error instanceof Error &&
          (error.message.includes('Authentication failed') ||
           error.message.includes('password') ||
           error.message.includes('credentials'))) {
        throw new Error('Database authentication failed. Please check your database credentials.');
      }
      throw error; // Re-throw to be handled by the calling function
    }
 }

  /**
   * Record document view
   */
  async recordView(documentId: string, userId: string): Promise<void> {
    try {
      const user = await this.findUserById(userId);

      if (!user) {
        throw new Error('User not found');
      }

      // Check if user has already viewed the document recently to avoid inflating stats
      const recentView = await prisma.documentView.findFirst({
        where: {
          documentId,
          userId: user.id, // Use the database user ID
          viewedAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Within last 24 hours
          },
        },
      });

      if (!recentView) {
        await prisma.documentView.create({
          data: {
            documentId,
            userId: user.id, // Use the database user ID
          },
        });

        // Increment view count
        await prisma.document.update({
          where: { id: documentId },
          data: {
            viewsCount: {
              increment: 1,
            },
          },
        });
      }
    } catch (error) {
      console.error('Database connection error in recordView:', error);
      // Check if this is an authentication error
      if (error instanceof Error &&
          (error.message.includes('Authentication failed') ||
           error.message.includes('password') ||
           error.message.includes('credentials'))) {
        throw new Error('Database authentication failed. Please check your database credentials.');
      }
      throw error; // Re-throw to be handled by the calling function
    }
 }

  /**
   * Get document comments
   */
  async getDocumentComments(
    documentId: string,
    page: number = 1,
    limit: number = 10
  ): Promise<{ comments: DocumentComment[]; total: number }> {
    try {
      const skip = (page - 1) * limit;

      const [comments, total] = await Promise.all([
        prisma.documentComment.findMany({
          where: { documentId },
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            user: true,
          }
        }),
        prisma.documentComment.count({ where: { documentId } }),
      ]);

      return {
        comments: comments.map((comment: any) => ({
          ...comment,
          parentCommentId: comment.parentCommentId ?? undefined, // Convert null to undefined
          createdAt: new Date(comment.createdAt),
          updatedAt: new Date(comment.updatedAt),
        })),
        total,
      };
    } catch (error) {
      console.error('Database connection error in getDocumentComments:', error);
      // Check if this is an authentication error
      if (error instanceof Error &&
          (error.message.includes('Authentication failed') ||
           error.message.includes('password') ||
           error.message.includes('credentials'))) {
        throw new Error('Database authentication failed. Please check your database credentials.');
      }
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Add comment to document
   */
  async addDocumentComment(
    documentId: string,
    userId: string,
    content: string,
    parentCommentId?: string
  ): Promise<DocumentComment> {
    try {
      // Check if document exists
      const document = await prisma.document.findUnique({
        where: { id: documentId },
      });

      if (!document) {
        throw new Error('Document not found');
      }

      // Find the user
      const user = await this.findUserById(userId);

      if (!user) {
        throw new Error('User not found');
      }

      // Check if user has permission to comment (must have read access)
      // Allow admins and faculty to comment on any document
      if (user.role !== 'ADMIN' && user.role !== 'FACULTY' && user.role !== 'PERSONNEL') {
        const permission = await prisma.documentPermission.findFirst({
          where: {
            documentId,
            userId: user.id, // Use the database user ID
            permission: { in: ['READ', 'WRITE', 'ADMIN'] }, // User needs at least READ permission to comment
          },
        });

        if (!permission && document.uploadedById !== user.id) {
          throw new Error('User does not have permission to comment on this document');
        }
      }

      if (parentCommentId) {
        // Verify the parent comment exists and belongs to the same document
        const parentComment = await prisma.documentComment.findUnique({
          where: { id: parentCommentId },
        });

        if (!parentComment || parentComment.documentId !== documentId) {
          throw new Error('Invalid parent comment');
        }
      }

      const comment = await prisma.documentComment.create({
        data: {
          documentId,
          userId: user.id, // Use the database user ID
          content,
          parentCommentId,
        },
      });

      return {
        ...comment,
        parentCommentId: comment.parentCommentId ?? undefined, // Convert null to undefined
        createdAt: new Date(comment.createdAt),
        updatedAt: new Date(comment.updatedAt),
      };
    } catch (error) {
      console.error('Database connection error in addDocumentComment:', error);
      // Check if this is an authentication error
      if (error instanceof Error &&
          (error.message.includes('Authentication failed') ||
           error.message.includes('password') ||
           error.message.includes('credentials'))) {
        throw new Error('Database authentication failed. Please check your database credentials.');
      }
      throw error; // Re-throw to be handled by the calling function
    }
  }

  /**
   * Get a document by its Colivara document ID
   */
  async getDocumentByColivaraId(colivaraDocumentId: string, userId?: string): Promise<Document | null> {
    try {
      // Validate the colivara document ID format before querying the database
      if (!colivaraDocumentId || typeof colivaraDocumentId !== 'string' || colivaraDocumentId.trim() === '' || colivaraDocumentId.includes('undefined') || colivaraDocumentId.includes('.pdf') || colivaraDocumentId.includes('.')) {
        console.warn('Invalid colivara document ID format received in getDocumentByColivaraId:', colivaraDocumentId);
        return null;
      }

      // Find the document that has this colivaraDocumentId
      const dbDocument = await prisma.document.findFirst({
        where: {
          colivaraDocumentId: colivaraDocumentId
        },
        include: {
          uploadedByUser: true,
          documentUnit: true,
        }
      });

      if (!dbDocument) {
        return null;
      }

      // Check if user has access to the document - reuse the same access logic as getDocumentById
      if (userId) {
        const user = await this.findUserById(userId);

        if (user && user.role !== 'ADMIN' && user.role !== 'FACULTY' && user.role !== 'PERSONNEL') {
          // Check if user has explicit permission for this document
          const permission = await prisma.documentPermission.findFirst({
            where: {
              documentId: dbDocument.id,  // Use the database document ID for permission check
              userId: user.id, // Use the database user ID
              permission: { in: ['READ', 'WRITE', 'ADMIN'] }, // User needs at least READ permission
            },
          });

          // Allow access if user has explicit READ/WRITE/ADMIN permission OR if user uploaded the document
          if (!permission && dbDocument.uploadedById !== user.id) {
            return null; // User doesn't have access
          }
        }
      }

      // Return the document in the expected format
      return {
        id: dbDocument.id,
        title: dbDocument.title,
        description: dbDocument.description,
        category: dbDocument.category,
        tags: Array.isArray(dbDocument.tags) ?
          (dbDocument.tags as any[]).map(tag => String(tag)) :
          (typeof dbDocument.tags === 'object' && dbDocument.tags !== null ?
            Object.values(dbDocument.tags).map(tag => String(tag)) : []),
        uploadedBy: dbDocument.uploadedByUser?.name || dbDocument.uploadedBy,
        uploadedById: dbDocument.uploadedById,
        uploadedAt: new Date(dbDocument.uploadedAt),
        fileUrl: dbDocument.fileUrl,
        blobName: dbDocument.blobName ?? undefined, // Azure Blob Storage blob name (UUID.ext)
        fileName: dbDocument.fileName,
        fileType: dbDocument.fileType,
        fileSize: dbDocument.fileSize,
        downloadsCount: dbDocument.downloadsCount || 0, // Convert null to 0
        viewsCount: dbDocument.viewsCount || 0, // Convert null to 0
        version: dbDocument.version || 1,
        versionNotes: dbDocument.versionNotes || undefined, // Convert null to undefined
        status: dbDocument.status as 'ACTIVE' | 'ARCHIVED' | 'PENDING_REVIEW',
        createdAt: new Date(dbDocument.createdAt),
        updatedAt: new Date(dbDocument.updatedAt),
        unitId: dbDocument.unitId || undefined, // Convert null to undefined
        unit: dbDocument.documentUnit ? {
          id: dbDocument.documentUnit.id,
          name: dbDocument.documentUnit.name,
          code: dbDocument.documentUnit.code || "", // Provide empty string as fallback since Unit type requires string
          description: dbDocument.documentUnit.description || undefined, // Convert null to undefined
          createdAt: dbDocument.documentUnit.createdAt,
          updatedAt: dbDocument.documentUnit.updatedAt,
        } : undefined,
        colivaraDocumentId: dbDocument.colivaraDocumentId ?? undefined,
        colivaraProcessingStatus: dbDocument.colivaraProcessingStatus as 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' ?? undefined,
        colivaraProcessedAt: dbDocument.colivaraProcessedAt ? new Date(dbDocument.colivaraProcessedAt) : undefined,
        colivaraChecksum: dbDocument.colivaraChecksum ?? undefined,
      };
    } catch (error) {
      console.error('Database connection error in getDocumentByColivaraId:', error);
      // Check if this is an authentication error
      if (error instanceof Error &&
          (error.message.includes('Authentication failed') ||
           error.message.includes('password') ||
           error.message.includes('credentials'))) {
        throw new Error('Database authentication failed. Please check your database credentials.');
      }
      throw error; // Re-throw to be handled by the calling function
    }
  }
}

export default new DocumentService();
