// lib/api/types.ts

export interface Document {
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  uploadedBy: string;
  uploadedById: string;
  uploadedAt: Date;
  fileUrl: string;
  blobName?: string; // Azure Blob Storage blob name (UUID.ext)
  fileName: string;
  fileType: string;
  fileSize: number;
  downloadsCount: number;
  viewsCount: number;
  version: number;
  versionNotes?: string;
  status: 'ACTIVE' | 'ARCHIVED' | 'PENDING_REVIEW';
  createdAt: Date;
  updatedAt: Date;
  unitId?: string;  // NEW: Unit association
  unit?: Unit; // NEW: Unit information
  year?: number; // Reporting year (2025-2029) for QPRO documents
  quarter?: number; // Reporting quarter (1-4) for QPRO documents
  isQproDocument?: boolean; // Flag for QPRO documents
  hasExplicitPermission?: boolean; // true if user has an explicit DocumentPermission record
  // Colivara-specific fields
  colivaraDocumentId?: string;
  colivaraProcessingStatus?: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  colivaraProcessedAt?: Date;
  colivaraChecksum?: string;
}

export interface DocumentPermission {
  id: string;
  documentId: string;
  userId: string;
  permission: 'READ' | 'WRITE' | 'ADMIN';
  createdAt: Date;
}

export interface DocumentComment {
  id: string;
  documentId: string;
  userId: string;
  content: string;
  parentCommentId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'FACULTY' | 'PERSONNEL' | 'STUDENT' | 'EXTERNAL';
  unit?: string;
  unitId?: string;  // NEW: Unit association
  avatar?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Unit {
  id: string;
  name: string;
  code: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Metadata-only document returned by the public catalog endpoint.
 *  Never exposes fileUrl or blobName. */
export interface CatalogDocument {
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  fileName: string;
  fileType: string;
  fileSize: number;
  uploadedAt: Date;
  uploadedBy: string;
  unitId: string | null;
  unit: { id: string; name: string; code: string } | null;
  year: number | null;
  quarter: number | null;
  isQproDocument: boolean;
  /** True if the current user already has access (own doc, same unit, or explicit permission). */
  hasAccess: boolean;
  /** True if the current user has a PENDING request for this document. */
  hasPendingRequest: boolean;
}
