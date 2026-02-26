import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/middleware/auth-middleware';
import ColivaraService from '@/lib/services/colivara-service';

const colivaraService = new ColivaraService();

/**
 * POST /api/search/chat-upload
 * Upload a temporary file for the chat-with-file feature.
 * The file is indexed in a SEPARATE Colivara temp collection and never touches the main index.
 */
export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const authResult = await requireAuth(request);
    if ('status' in authResult) return authResult;
    const { user } = authResult;

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const sessionId = formData.get('sessionId') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (!sessionId) {
      return NextResponse.json({ error: 'No sessionId provided' }, { status: 400 });
    }

    // Validate file type (PDF, DOCX, images)
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'image/png',
      'image/jpeg',
      'image/webp',
    ];

    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        { error: 'Unsupported file type. Please upload PDF, DOCX, or image files.' },
        { status: 400 },
      );
    }

    // Max 25MB for chat uploads
    const MAX_SIZE = 25 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: 'File too large. Maximum size is 25MB.' },
        { status: 400 },
      );
    }

    // Convert file to base64
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Content = buffer.toString('base64');

    // Upload to temp Colivara collection (SEPARATE from main index)
    const documentName = await colivaraService.uploadTempChatDocument(
      sessionId,
      file.name,
      base64Content,
    );

    console.log(`[Chat Upload] User ${user.id} uploaded temp file: ${file.name} (session: ${sessionId})`);

    return NextResponse.json({
      success: true,
      documentName,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      sessionId,
    });
  } catch (error) {
    console.error('[Chat Upload] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to upload file' },
      { status: 500 },
    );
  }
}
