import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import ColivaraService from '@/lib/services/colivara-service';
import QwenGenerationService from '@/lib/services/qwen-generation-service';

const colivaraService = new ColivaraService();

// Lazy initialization to avoid build-time errors
let qwenService: QwenGenerationService | null = null;
function getQwenService() {
  if (!qwenService && process.env.QWEN_API_KEY) {
    qwenService = new QwenGenerationService({
      model: process.env.QWEN_MODEL || 'qwen/qwen-2.5-vl-72b-instruct',
    });
  }
  return qwenService;
}

/**
 * POST /api/search/chat-query
 * Ask a question about an attached (temporary) file.
 * Searches ONLY the temp Colivara collection for the given session/document,
 * then passes results to Qwen for AI generation.
 * This NEVER touches the main lspu-kmis-documents collection.
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;
    const { user } = authResult;

    const body = await request.json();
    const { query, sessionId, documentName } = body;

    if (!query || typeof query !== 'string') {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    if (!sessionId || typeof sessionId !== 'string') {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    if (!documentName || typeof documentName !== 'string') {
      return NextResponse.json({ error: 'documentName is required' }, { status: 400 });
    }

    console.log(`[Chat Query] User ${user.id} querying temp document: ${documentName} (session: ${sessionId})`);

    // Search ONLY the temp collection for this session's document
    const searchResults = await colivaraService.searchTempChatDocument(
      query,
      sessionId,
      documentName,
    );

    // Generate AI response using Qwen
    let generatedResponse: string | null = null;
    let sources: Array<{ title: string; documentId: string; confidence: number }> = [];
    let noRelevantDocuments = false;

    const qwen = getQwenService();
    if (qwen && searchResults.results.length > 0) {
      try {
        const insights = await qwen.generateInsights(query, searchResults.results, user.id);
        generatedResponse = insights.summary;
        sources = insights.sources || [];
        noRelevantDocuments = insights.noRelevantDocuments || false;
      } catch (genError) {
        console.error('[Chat Query] Qwen generation error:', genError);
        // Return search results without AI generation
        generatedResponse = null;
      }
    } else if (!qwen && searchResults.results.length > 0) {
      console.error('[Chat Query] Qwen service not configured (missing QWEN_API_KEY). Cannot generate AI response.');
      generatedResponse = 'AI generation service is not configured. Please contact your administrator.';
    } else if (searchResults.results.length === 0) {
      noRelevantDocuments = true;
      generatedResponse = 'No relevant content found in the attached document for your query. Please try rephrasing your question.';
    }

    return NextResponse.json({
      query,
      sessionId,
      documentName,
      results: searchResults.results,
      total: searchResults.total,
      processingTime: searchResults.processingTime,
      generatedResponse,
      generationType: 'chat-with-file',
      sources,
      noRelevantDocuments,
    });
  } catch (error) {
    console.error('[Chat Query] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to process query' },
      { status: 500 },
    );
  }
}
