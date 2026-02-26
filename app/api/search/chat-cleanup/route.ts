import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import ColivaraService from '@/lib/services/colivara-service';

const colivaraService = new ColivaraService();

/**
 * POST /api/search/chat-cleanup
 * Cleanup expired temporary chat documents from the Colivara temp collection.
 * Can be called manually or by a cron job.
 * Also supports deleting a specific session's document.
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;
    const { user } = authResult;

    const body = await request.json().catch(() => ({}));
    const { documentName, sessionId } = body;

    // If a specific document name is provided, delete just that one
    if (documentName && typeof documentName === 'string') {
      console.log(`[Chat Cleanup] User ${user.id} deleting temp document: ${documentName}`);
      const success = await colivaraService.deleteTempChatDocument(documentName);
      return NextResponse.json({
        success,
        message: success ? 'Temporary document deleted' : 'Failed to delete temporary document',
        deletedDocument: documentName,
      });
    }

    // Otherwise, clean up all expired temp documents (admin or own session)
    console.log(`[Chat Cleanup] User ${user.id} triggering temp document cleanup`);
    const deletedCount = await colivaraService.cleanupExpiredTempDocuments();

    return NextResponse.json({
      success: true,
      message: `Cleanup completed. ${deletedCount === -1 ? 'Full collection reset' : `${deletedCount} expired documents deleted`}`,
      deletedCount,
    });
  } catch (error) {
    console.error('[Chat Cleanup] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Cleanup failed' },
      { status: 500 },
    );
  }
}
