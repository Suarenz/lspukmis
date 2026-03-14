import prisma from '@/lib/prisma';
import { AnalyticsData, Activity } from '@/lib/types';

class AnalyticsService {
  /**
   * Get analytics data from the database
   * @param userId - Optional user ID to filter data based on permissions
   * @param userRole - Optional user role to determine access level
   */
  async getAnalytics(userId?: string, userRole?: string): Promise<AnalyticsData> {
   try {
     let totalDocuments: number;
     let totalUsers: number;
     let totalDownloads: number;
     let totalViews: number;
     let recentDocuments: any[];
     let popularDocuments: any[];
     let categoryDistribution: { category: string; count: number }[];
      
      // For non-admin/faculty users, limit the data they can access
      if (userId && userRole && userRole !== 'ADMIN' && userRole !== 'FACULTY') {
        // Get user's documents count and limited analytics
        totalDocuments = await prisma.document.count({
          where: {
            status: 'ACTIVE',
            uploadedById: userId // Only user's own documents
          }
        });

        // For non-admin users, we'll limit user count visibility
        totalUsers = 0; // Don't show total users count to non-admins

        // Get download count for user's documents only
        totalDownloads = await prisma.documentDownload.count({
          where: {
            document: {
              uploadedById: userId
            }
          }
        });

        // Get view count for user's documents only
        totalViews = await prisma.documentView.count({
          where: {
            document: {
              uploadedById: userId
            }
          }
        });

        // Get recent activity for user's documents only
        recentDocuments = await prisma.document.findMany({
          where: {
            status: 'ACTIVE',
            uploadedById: userId
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            uploadedByUser: true
          }
        });

        // Get popular documents from user's documents only
        popularDocuments = await prisma.document.findMany({
          where: {
            status: 'ACTIVE',
            uploadedById: userId
          },
          orderBy: { downloadsCount: 'desc' },
          take: 5,
          select: {
            id: true,
            title: true,
            description: true,
            category: true,
            tags: true,
            uploadedBy: true,
            uploadedById: true,
            uploadedAt: true,
            fileUrl: true,
            fileType: true,
            fileSize: true,
            downloadsCount: true,
            viewsCount: true,
            version: true,
          }
        });
      } else {
        // For admin/faculty, get full analytics
        totalDocuments = await prisma.document.count({
          where: { status: 'ACTIVE' }
        });

        totalUsers = await prisma.user.count();

        totalDownloads = await prisma.documentDownload.count();

        totalViews = await prisma.documentView.count();

        // Get recent activity (last 10 activities) - we'll get document uploads for now
        recentDocuments = await prisma.document.findMany({
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            uploadedByUser: true
          }
        });

        // Get popular documents (top 5 by download count)
        popularDocuments = await prisma.document.findMany({
          where: { status: 'ACTIVE' },
          orderBy: { downloadsCount: 'desc' },
          take: 5,
          select: {
            id: true,
            title: true,
            description: true,
            category: true,
            tags: true,
            uploadedBy: true,
            uploadedById: true,
            uploadedAt: true,
            fileUrl: true,
            fileType: true,
            fileSize: true,
            downloadsCount: true,
            viewsCount: true,
            version: true,
          }
        });
      }

      // Format recent activity
      const recentActivity: Activity[] = recentDocuments.map((doc, index) => ({
        id: `${index + 1}`,
        type: "upload",
        user: doc.uploadedBy,
        description: `Uploaded "${doc.title}"`,
        timestamp: new Date(doc.createdAt)
      }));

      // Convert to the expected format for the frontend
      const formattedPopularDocuments = popularDocuments.map(doc => ({
        id: doc.id,
        title: doc.title,
        description: doc.description,
        category: doc.category,
        tags: doc.tags as string[],
        uploadedBy: doc.uploadedBy,
        uploadedById: doc.uploadedById,
        uploadedAt: new Date(doc.uploadedAt),
        fileUrl: doc.fileUrl,
        fileType: doc.fileType,
        fileSize: doc.fileSize,
        downloads: doc.downloadsCount || 0,
        views: doc.viewsCount || 0,
        version: doc.version,
      fileName: doc.fileName || doc.title || "Unknown",
      }));

      // Get category distribution using a safer approach
      // Only show to admin/faculty users
      if (userId && userRole && userRole !== 'ADMIN' && userRole !== 'FACULTY') {
        categoryDistribution = []; // Don't show category distribution to non-admins
      } else {
        try {
          const rawResult = await prisma.$queryRaw<Array<{
            category: string;
            count: bigint;
          }>>`
            SELECT
              category,
              COUNT(*) as count
            FROM documents
            WHERE status = 'ACTIVE'
            GROUP BY category
            ORDER BY count DESC
          `;
          
          categoryDistribution = rawResult.map(cat => ({
            category: cat.category,
            count: Number(cat.count)
          }));
        } catch (error) {
          console.error('Error fetching category distribution:', error);
          // Return empty array if query fails
          categoryDistribution = [];
        }
      }

      return {
        totalDocuments,
        totalUsers,
        totalDownloads,
        totalViews,
        recentActivity,
        popularDocuments: formattedPopularDocuments,
        categoryDistribution
      };
    } catch (error) {
      console.error('Error in getAnalytics:', error);
      
      // Return default values in case of error
      return {
        totalDocuments: 0,
        totalUsers: 0,
        totalDownloads: 0,
        totalViews: 0,
        recentActivity: [],
        popularDocuments: [],
        categoryDistribution: []
      };
    }
 }
}

export default new AnalyticsService();