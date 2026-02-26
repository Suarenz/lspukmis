/**
 * Super Mapper - A utility to handle document field mapping across different data sources
 * This solution addresses the need to look for document data under various possible field names
 */

interface DocumentFieldMapping {
  // Title-related fields
 title?: string;
  document_title?: string;
  originalName?: string;
  name?: string;
  
  // Description-related fields
  description?: string;
  content?: string;
  text?: string;
  summary?: string;
  
  // File-related fields
  fileName?: string;
  file_name?: string;
  originalFileName?: string;
  original_file_name?: string;
  fileUrl?: string;
  file_url?: string;
  
  // Other common fields
  id?: string;
  documentId?: string;
  document_id?: string;
  category?: string;
  tags?: string[];
  uploadedBy?: string;
  uploaded_by?: string;
  uploadedAt?: string | Date;
 uploaded_at?: string | Date;
  fileType?: string;
  file_type?: string;
  fileSize?: number;
  file_size?: number;
}

/**
 * Generic function to extract a value from an object trying multiple possible field names
 */
function extractValue<T>(obj: any, possibleFieldNames: string[]): T | undefined {
  for (const field of possibleFieldNames) {
    if (obj && obj[field] !== undefined && obj[field] !== null) {
      return obj[field];
    }
  }
 return undefined;
}

/**
 * Super Mapper class to handle document field mapping
 */
class SuperMapper {
  /**
   * Maps document data from various sources to a consistent format
   * Tries multiple possible field names for each property
   */
  static mapDocumentData(rawData: any): DocumentFieldMapping {
    if (!rawData) {
      return {};
    }

    return {
      // Title mapping - try various possible field names for document title
      title: extractValue<string>(rawData, [
        'title', 'document_title', 'originalName', 'name', 
        'fileName', 'file_name', 'documentName', 'document_name'
      ]),
      
      // Description mapping
      description: extractValue<string>(rawData, [
        'description', 'content', 'text', 'summary', 
        'desc', 'body', 'details'
      ]),
      
      // File name mapping
      fileName: extractValue<string>(rawData, [
        'fileName', 'file_name', 'originalFileName', 
        'original_file_name', 'filename', 'name'
      ]),
      
      // File URL mapping
      fileUrl: extractValue<string>(rawData, [
        'fileUrl', 'file_url', 'url', 'documentUrl', 
        'document_url', 'source', 'path'
      ]),
      
      // ID mapping
      id: extractValue<string>(rawData, [
        'id', 'documentId', 'document_id', 'docId', 
        'doc_id', '_id', 'identifier'
      ]),
      
      // Category mapping
      category: extractValue<string>(rawData, [
        'category', 'category_name', 'type', 'documentType', 
        'document_type', 'classification'
      ]),
      
      // Tags mapping
      tags: extractValue<string[]>(rawData, [
        'tags', 'tag_list', 'tagList', 'keywords', 
        'keyword_list', 'keywordList'
      ]),
      
      // Uploaded by mapping
      uploadedBy: extractValue<string>(rawData, [
        'uploadedBy', 'uploaded_by', 'uploadedByUser', 
        'uploaded_by_user', 'author', 'creator', 'uploader'
      ]),
      
      // Upload date mapping
      uploadedAt: extractValue<Date | string>(rawData, [
        'uploadedAt', 'uploaded_at', 'uploadDate', 
        'upload_date', 'createdAt', 'created_at', 'date'
      ]),
      
      // File type mapping
      fileType: extractValue<string>(rawData, [
        'fileType', 'file_type', 'mimeType', 
        'mime_type', 'type', 'extension'
      ]),
      
      // File size mapping
      fileSize: extractValue<number>(rawData, [
        'fileSize', 'file_size', 'size', 
        'fileSizeBytes', 'file_size_bytes'
      ]),
    };
 }

  /**
   * Gets a specific field value trying multiple possible names
   */
  static getFieldValue(obj: any, fieldPath: string | string[]): any {
    if (!obj) return undefined;
    
    // If fieldPath is a string, split it by dots to handle nested properties
    const fields = Array.isArray(fieldPath) ? fieldPath : fieldPath.split('.');
    
    // If we have a single field name, try multiple possible variants
    if (fields.length === 1) {
      const fieldName = fields[0];
      
      // Define possible variations for common field names
      const possibleNames: Record<string, string[]> = {
        title: ['title', 'document_title', 'originalName', 'name', 'fileName', 'file_name', 'documentName'],
        description: ['description', 'content', 'text', 'summary', 'desc', 'body'],
        fileName: ['fileName', 'file_name', 'originalFileName', 'original_file_name', 'filename'],
        fileUrl: ['fileUrl', 'file_url', 'url', 'documentUrl', 'document_url', 'source'],
        id: ['id', 'documentId', 'document_id', 'docId', 'doc_id', '_id'],
        category: ['category', 'category_name', 'type', 'documentType', 'document_type'],
        tags: ['tags', 'tag_list', 'tagList', 'keywords', 'keyword_list', 'keywordList'],
        uploadedBy: ['uploadedBy', 'uploaded_by', 'uploadedByUser', 'uploaded_by_user', 'author', 'creator'],
        uploadedAt: ['uploadedAt', 'uploaded_at', 'uploadDate', 'upload_date', 'createdAt', 'created_at'],
        fileType: ['fileType', 'file_type', 'mimeType', 'mime_type', 'type', 'extension'],
        fileSize: ['fileSize', 'file_size', 'size', 'fileSizeBytes', 'file_size_bytes'],
      };
      
      const possibleFieldNames = possibleNames[fieldName] || [fieldName];
      return extractValue(obj, possibleFieldNames);
    }
    
    // For nested properties, try to access the path directly first
    let result = obj;
    for (const field of fields) {
      if (result && result[field] !== undefined) {
        result = result[field];
      } else {
        result = undefined;
        break;
      }
    }
    
    if (result !== undefined) {
      return result;
    }
    
    // If direct access fails, try common variations of the first field
    const firstField = fields[0];
    const remainingPath = fields.slice(1).join('.');
    
    const possibleNames: Record<string, string[]> = {
      metadata: ['metadata', 'meta', 'data', 'info', 'document_metadata'],
      document: ['document', 'doc', 'result', 'item', 'data', 'record'],
    };
    
    const possibleFieldNames = possibleNames[firstField] || [firstField];
    
    for (const possibleName of possibleFieldNames) {
      const nestedObj = obj[possibleName];
      if (nestedObj) {
        // Recursively call for the remaining path
        const nestedResult = this.getFieldValue(nestedObj, remainingPath);
        if (nestedResult !== undefined) {
          return nestedResult;
        }
      }
    }
    
    return undefined;
 }

  /**
   * Creates a mapped document object with standardized field names
   */
  static createStandardDocument(rawData: any): any {
    const mappedData = this.mapDocumentData(rawData);
    
    // Create a standard document object using the mapped values
    // Only apply defaults if no value was found from any of the possible field names
    return {
      ...rawData, // Include original data to preserve existing properties
      id: mappedData.id || rawData.id || rawData.documentId || (rawData.document ? rawData.document.id : undefined),
      title: mappedData.title || rawData.title || rawData.originalName || rawData.name || 'Untitled Document',
      description: mappedData.description || rawData.description || rawData.content || rawData.text || rawData.summary || '',
      fileName: mappedData.fileName || rawData.fileName || rawData.originalFileName || rawData.name || 'unknown.pdf',
      fileUrl: mappedData.fileUrl || rawData.fileUrl || rawData.url || rawData.documentUrl || rawData.source,
      category: mappedData.category || rawData.category || rawData.type || rawData.documentType || 'Other files',
      tags: mappedData.tags || rawData.tags || rawData.keywords || [],
      uploadedBy: mappedData.uploadedBy || rawData.uploadedBy || rawData.author || rawData.creator || rawData.uploader || 'Unknown',
      uploadedAt: mappedData.uploadedAt ? new Date(mappedData.uploadedAt as string) :
                  rawData.uploadedAt ? new Date(rawData.uploadedAt) :
                  rawData.uploadDate ? new Date(rawData.uploadDate) :
                  rawData.createdAt ? new Date(rawData.createdAt) :
                  new Date(),
      fileType: mappedData.fileType || rawData.fileType || rawData.mimeType || rawData.type || 'unknown',
      fileSize: mappedData.fileSize || rawData.fileSize || rawData.size || 0,
    };
  }
}

export default SuperMapper;