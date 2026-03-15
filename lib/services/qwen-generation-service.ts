import OpenAI from 'openai';
import ConfigService from './config-service';
import MonitoringService from './monitoring-service';

// Define the SearchResult interface to match what's expected
interface SearchResult {
  id?: string; // Database ID (primary)
  documentId: string; // Fallback document ID
 title: string;
 content: string;
 score: number;
 pageNumbers: number[];
  documentSection?: string;
  confidenceScore?: number;
  snippet: string;
  document: any; // Replace with actual Document type if available
  visualContent?: string; // Base64 encoded visual content
  extractedText?: string; // Extracted text content
  screenshots?: string[]; // Array of screenshot base64 strings
  mimeType?: string; // MIME type for the screenshots (e.g., 'image/jpeg', 'image/png')
}

interface QwenConfig {
  apiKey: string;
  model?: string;
 baseURL?: string; // For Qwen API endpoint
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
  };
}

interface GenerationOptions {
  textOnly?: boolean;
  maxResults?: number;
  customPrompt?: string;
}

// Phrases that indicate the AI couldn't find relevant information in the documents
const NO_INFORMATION_INDICATORS = [
  'does not contain',
  'no information',
  'not found',
  'no relevant',
  'cannot find',
  'unable to find',
  'not mentioned',
  'no data',
  'no mention',
  'don\'t have',
  'do not have',
  'doesn\'t contain',
  'not present',
  'not available',
  'could not find',
  'couldn\'t find',
  'no details',
  'no specific',
  'not specifically',
];

/**
 * Check if an AI response indicates that no relevant information was found
 * @param response The AI-generated response text
 * @returns true if the response indicates no information was found
 */
function isNoInformationResponse(response: string): boolean {
  if (!response || typeof response !== 'string') return false;
  const lowerResponse = response.toLowerCase();

  // Check if the response starts with or contains common "no info" patterns
  return NO_INFORMATION_INDICATORS.some(indicator => lowerResponse.includes(indicator));
}

/**
 * Strip chain-of-thought <think>...</think> blocks that Qwen3 models emit
 * before their actual response, preventing tag leakage into the UI and
 * broken JSON.parse calls.
 */
function stripThinkTags(text: string): string {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

class QwenGenerationService {
  private openai: OpenAI;
  private config: QwenConfig;
  private configService: ConfigService;
  private monitoringService: MonitoringService;

  constructor(config?: Partial<QwenConfig>) {
    const apiKey = process.env.QWEN_API_KEY || config?.apiKey || '';
    if (!apiKey) {
      throw new Error('Qwen API key is required for Qwen Generation Service');
    }

    this.config = {
      apiKey,
      model: config?.model || process.env.QWEN_MODEL || 'qwen/qwen3.5-flash-02-23',
      baseURL: config?.baseURL || process.env.QWEN_BASE_URL || 'https://openrouter.ai/api/v1',
      generationConfig: config?.generationConfig || {
        temperature: 0.2,
        maxOutputTokens: parseInt(process.env.QWEN_MAX_TOKENS || '2048', 10),
        topP: 0.95,
        topK: 40,
      },
    };

    // Enforce a safe cap for gpt-4o-mini / 4o models to avoid excessive outputs
    try {
      const GPT4O_MINI_MAX_OUTPUT = 4096;
      if (this.config.model && this.config.model.includes('4o')) {
        this.config.generationConfig = this.config.generationConfig || {};
        this.config.generationConfig.maxOutputTokens = Math.min(this.config.generationConfig.maxOutputTokens || GPT4O_MINI_MAX_OUTPUT, GPT4O_MINI_MAX_OUTPUT);
      }
    } catch (e) {
      // ignore errors here - defensive programming
    }

    this.openai = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
    });

    this.configService = ConfigService.getInstance();
    this.monitoringService = MonitoringService.getInstance();
  }

  /** Returns true when the configured model supports vision/image inputs. */
  private isVisionModel(): boolean {
    return !!(this.config.model && (
      this.config.model.includes('vl') ||
      this.config.model.includes('vision') ||
      this.config.model.includes('106') ||
      this.config.model.includes('1106-preview') ||
      this.config.model.includes('4-turbo') ||
      this.config.model.includes('4o') ||
      this.config.model.includes('qwen3') // qwen3.x models (e.g. qwen3.5-flash) support vision natively
    ));
  }

  /**
   * Generate a response based on search results and user query
   * @param query User's search query
   * @param searchResults Results from Colivara semantic search
   * @param options Generation options
   * @param userId User identifier for rate limiting
   */
 async generateResponse(
    query: string,
    searchResults: SearchResult[],
    options: GenerationOptions = {},
    userId?: string
 ): Promise<string> {
    const startTime = Date.now();
    try {
      // Use user ID for rate limiting, fallback to a general identifier if not provided
      const identifier = userId || 'anonymous';
      
      // Check if request is allowed based on rate limiting
      if (!this.configService.isRequestAllowed(identifier)) {
        const remainingRequests = this.configService.getRemainingRequests(identifier);
        const resetTime = this.configService.getResetTime(identifier);
        const resetTimeFormatted = new Date(resetTime).toLocaleTimeString();
        
        const error = new Error(
          `Rate limit exceeded. You can make ${remainingRequests} more requests after ${resetTimeFormatted}.`
        );
        
        // Track the failed request
        this.monitoringService.trackGeneration(
          userId || 'unknown',
          query,
          Date.now() - startTime,
          false,
          error.message,
          this.config.model
        );
        
        throw error;
      }

      // Limit the number of results to process
      const maxResults = options.maxResults || 6;
      const limitedResults = searchResults.slice(0, maxResults);

      if (limitedResults.length === 0) {
        const response = "I couldn't find any relevant documents to answer your query. Please try a different search term.";
        
        // Track the successful request with no results
        this.monitoringService.trackGeneration(
          userId || 'unknown',
          query,
          Date.now() - startTime,
          true,
          undefined,
          this.config.model
        );
        
        return response;
      }

      // Check if the query is asking for comprehensive information (like lists of faculty/trainings)
      const isComprehensiveQuery = query.toLowerCase().includes('list') ||
                                   query.toLowerCase().includes('all') ||
                                   query.toLowerCase().includes('every') ||
                                   query.toLowerCase().includes('faculty') ||
                                   query.toLowerCase().includes('training') ||
                                   query.toLowerCase().includes('seminar') ||
                                   query.toLowerCase().includes('attended') ||
                                   query.toLowerCase().includes('presentation') ||
                                   query.toLowerCase().includes('research') ||
                                   (query.toLowerCase().includes('what') && query.toLowerCase().includes('training')) ||
                                   (query.toLowerCase().includes('what') && query.toLowerCase().includes('seminar')) ||
                                   (query.toLowerCase().includes('which') && query.toLowerCase().includes('training')) ||
                                   (query.toLowerCase().includes('which') && query.toLowerCase().includes('seminar'));
      
      // For comprehensive queries, ensure we use more results
      const resultsForGeneration = isComprehensiveQuery ?
        searchResults.slice(0, 6) : // Use up to 6 results for comprehensive queries
        limitedResults; // Use the limited results for specific queries
      
      // Prepare the content for the model based on options
      // Check if any results have visual content to determine if we should use multimodal processing
      const hasVisualContent = resultsForGeneration.some(result => result.visualContent || (result.screenshots && result.screenshots.length > 0));
      
      // Also check if the model supports image inputs
      const isImageSupported = this.isVisionModel();
      
      let result: string;
      if (options.textOnly || !hasVisualContent || !isImageSupported) {
        result = await this.generateTextOnlyResponse(query, resultsForGeneration, options);
      } else {
        result = await this.generateMultimodalResponse(query, resultsForGeneration, options);
      }
      
      // Track the successful request
      this.monitoringService.trackGeneration(
        userId || 'unknown',
        query,
        Date.now() - startTime,
        true,
        undefined,
        this.config.model
      );
      
      return result;
    } catch (error) {
      console.error('Error generating response with Qwen:', error);
      
      // Track the failed request
      this.monitoringService.trackGeneration(
        userId || 'unknown',
        query,
        Date.now() - startTime,
        false,
        error instanceof Error ? error.message : 'Unknown error',
        this.config.model
      );
      
      throw error;
    }
  }

  /**
   * Generate a text-only response using search results
   */
 private async generateTextOnlyResponse(
    query: string,
    searchResults: SearchResult[],
    options: GenerationOptions
  ): Promise<string> {
    // Format the search results into a context string
    const context = searchResults
      .map((result, index) => {
        const content = result.content || result.snippet || '';
        const title = result.title || 'Untitled Document';
        const pageNumbers = result.pageNumbers?.length ? ` (pages: ${result.pageNumbers.join(', ')})` : '';
        const score = result.confidenceScore ? ` (relevance: ${(result.confidenceScore * 100).toFixed(1)}%)` : '';
        const hasVisuals = result.screenshots && result.screenshots.length > 0;
        
        let resultText = `Document ${index + 1}: ${title}${pageNumbers}${score}\n`;
        
        if (hasVisuals) {
          resultText += `[VISUAL DATA: This document contains ${result.screenshots!.length} image(s). Read any tables, numbers, or text visually present in the images.]\n`;
        }
        
        resultText += `Content: ${content}\n`;
        
        return resultText;
      })
      .join('\n---\n');

    // Check if the query is asking for comprehensive information (like lists of faculty/trainings)
    const isComprehensiveQuery = query.toLowerCase().includes('list') ||
                                 query.toLowerCase().includes('all') ||
                                 query.toLowerCase().includes('every') ||
                                 query.toLowerCase().includes('faculty') ||
                                 query.toLowerCase().includes('training') ||
                                 query.toLowerCase().includes('seminar') ||
                                 query.toLowerCase().includes('attended') ||
                                 query.toLowerCase().includes('presentation') ||
                                 query.toLowerCase().includes('research') ||
                                 (query.toLowerCase().includes('what') && query.toLowerCase().includes('training')) ||
                                 (query.toLowerCase().includes('what') && query.toLowerCase().includes('seminar')) ||
                                 (query.toLowerCase().includes('which') && query.toLowerCase().includes('training')) ||
                                 (query.toLowerCase().includes('which') && query.toLowerCase().includes('seminar'));

    // Create the prompt with specific instructions for comprehensive queries
    const prompt = options.customPrompt || `Role: You are an expert data extraction assistant.

Instructions:
1. Answer the user's question using ONLY the provided Context below.
2. If the user asks for a list (titles, names, dates, research, etc.), you MUST extract them and format them as a bulleted list.
3. NEGATIVE CONSTRAINT: Never answer with "The information is provided in the document" or "listed in the provided documents". You MUST extract the actual content.
4. If the data is in a table within the context, parse the rows to find the specific answer.
5. If the answer is not in the context, state "I do not have that information in the provided documents."
6. When citing information, include a reference like [1], [2], etc. that corresponds to the Document number.

${isComprehensiveQuery ? `### SPECIAL INSTRUCTION FOR COMPREHENSIVE QUERIES:
When the user asks for a list of items (such as faculty and their trainings/seminars, research titles, etc.):
- You MUST provide ALL the information found in the documents
- Do not summarize or abbreviate
- If multiple documents contain relevant information, combine and present ALL the data
- Use bullet points or structured lists to make the information easy to read
- CRITICAL: Actually provide the complete list content, never just say "Here is the list..." without the items
- READ EVERY DOCUMENT CAREFULLY and extract ALL relevant information
- Continue reading through all documents to collect all relevant information

` : ''}Context:
${context}

User Query: ${query}

Provide a direct, specific answer with the actual extracted data. Include citation references [1], [2], etc. to indicate which document(s) the information came from.`;

    // Generate content using the model
    const completion = await this.openai.chat.completions.create({
      model: this.config.model!,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: this.config.generationConfig?.temperature,
      max_tokens: this.config.generationConfig?.maxOutputTokens,
      top_p: this.config.generationConfig?.topP,
    });

    return stripThinkTags(completion.choices[0].message.content || '');
 }

  /**
   * Generate a multimodal response using search results that may include visual content
   */
  private async generateMultimodalResponse(
    query: string,
    searchResults: SearchResult[],
    options: GenerationOptions
  ): Promise<string> {
    // Check if the model supports image inputs by checking the model name
    const isImageSupported = this.isVisionModel();

    // If image input is not supported by this model, fall back to text-only
    if (!isImageSupported) {
      console.log(`Model ${this.config.model} does not support image input, falling back to text-only generation`);
      return await this.generateTextOnlyResponse(query, searchResults, options);
    }

    // Check if the query is asking for comprehensive information (like lists of faculty/trainings)
    const isComprehensiveQuery = query.toLowerCase().includes('list') ||
                                query.toLowerCase().includes('all') ||
                                query.toLowerCase().includes('every') ||
                                query.toLowerCase().includes('faculty') ||
                                query.toLowerCase().includes('training') ||
                                query.toLowerCase().includes('seminar') ||
                                query.toLowerCase().includes('attended') ||
                                query.toLowerCase().includes('presentation') ||
                                query.toLowerCase().includes('research') ||
                                (query.toLowerCase().includes('what') && query.toLowerCase().includes('training')) ||
                                (query.toLowerCase().includes('what') && query.toLowerCase().includes('seminar')) ||
                                (query.toLowerCase().includes('which') && query.toLowerCase().includes('training')) ||
                                (query.toLowerCase().includes('which') && query.toLowerCase().includes('seminar'));

    // Format the search results into a context string with visual content
    const multimodalContent: Array<any> = [];
    
    multimodalContent.push({
      type: 'text',
      text: `
Role: You are an expert data extraction assistant.

Instructions:
1. Answer the user's question using ONLY the provided document images and context below.
2. If the user asks for a list (titles, names, dates, research, etc.), you MUST extract them and format them as a bulleted list.
3. NEGATIVE CONSTRAINT: Never answer with "The information is provided in the document" or "listed in the provided documents". You MUST extract the actual content.
4. If the data is in a table within the context, parse the rows to find the specific answer.
5. If the answer is not in the context, state "I do not have that information in the provided documents."
6. When citing information, include a reference like [1], [2], etc. that corresponds to the Document number.

### DATA EXTRACTION RULES:
1. **Read the Visuals:** The documents may contain tables, lists, or spreadsheets. Scan them carefully row-by-row.
2. **Be Thorough:** If the user asks for a list (e.g., "all faculty", "research titles"), extract EVERY item you see in the document images. Do not summarize.
3. **OCR Handling:** If text is slightly blurry, use your best judgment to correct obvious spelling errors.

### OUTPUT FORMATTING:
If the data involves multiple items (like names and trainings, or research titles), you must use a **Bulleted List** format:

* Item 1 [1]
* Item 2 [1]
* Item 3 [2]

If the answer is simple text, use a natural paragraph with citation references.

${isComprehensiveQuery ? `### SPECIAL INSTRUCTION FOR COMPREHENSIVE QUERIES:
When the user asks for a list of items (such as faculty and their trainings/seminars, research titles, etc.):
- You MUST provide ALL the information found in the documents
- Do not summarize or abbreviate
- If multiple documents contain relevant information, combine and present ALL the data
- Use bullet points or structured lists to make the information easy to read
- CRITICAL: Actually provide the complete list content, never just say "Here is the list..." without the items
- READ EVERY DOCUMENT CAREFULLY and extract ALL relevant information
- Include citation references [1], [2], etc. for each item

` : ''}-------------------------------------------------------
`
    });

    // Process each result to provide to the model
    for (const result of searchResults.slice(0, 6)) {
      
      const hasVisuals = result.screenshots && result.screenshots.length > 0;
      const hasText = result.extractedText && result.extractedText.trim().length > 0;

      // Divider
      multimodalContent.push({
        type: 'text',
        text: `\n\n=== Document: "${result.title}" ===\n`
      });

      // 1. Provide the Visuals (Universal for PDF, PNG, Excel, etc.)
      if (hasVisuals && result.screenshots) {
        for (const screenshot of result.screenshots) {
            
        // MAGIC FIX: Detect Type from the string signature
        // Colivara converts PDFs to PNG screenshots, so we must detect 'iVBOR'
        let realMimeType = 'image/jpeg';
        if (typeof screenshot === 'string') {
            if (screenshot.startsWith('iVBOR')) {
                realMimeType = 'image/png'; // <--- This is the key fix for your PDFs
            } else if (screenshot.startsWith('/9j/')) {
                realMimeType = 'image/jpeg';
            } else if (screenshot.startsWith('iVBO')) {
                realMimeType = 'image/png';
            }
        }

        console.log(`Sending to Qwen as: ${realMimeType}`); // Debug log

        // Convert base64 image to data URL format
        const dataUrl = `data:${realMimeType};base64,${screenshot}`;
        
        multimodalContent.push({
          type: 'image_url',
          image_url: {
            url: dataUrl
          }
        });
        }
        // Prompt for Visuals
        multimodalContent.push({
          type: 'text',
          text: `\n[VISUAL CONTENT: The above image contains the document content. Extract relevant information to answer: "${query}"]\n`
        });
      }

      // 2. Provide the Text (Universal for PDF, Word, etc.)
      if (hasText) {
        multimodalContent.push({
          type: 'text',
          text: `\n[TEXT CONTENT: ${result.extractedText}]\n`
        });
      } else {
        // 3. Handle "Visual Only" Files (Scans/Images)
        multimodalContent.push({
          type: 'text',
          text: `\n[NO TEXT EXTRACTED: Focus on visual content to answer: "${query}"]\n`
        });
      }
    }

    // Add final instruction to ensure the model responds directly to the query
    multimodalContent.push({
      type: 'text',
      text: `\n\n${isComprehensiveQuery ? `### REMINDER FOR COMPREHENSIVE QUERIES:\n- Extract ALL items, names, titles, or data requested\n- Use bullet points for lists\n- Include citation references [1], [2], etc.\n- Never just say "the information is in the documents" - actually extract it\n\n` : ''}Based on the above documents, provide a clear, direct answer to this query: "${query}"\n\nREMEMBER:\n- Answer with the ACTUAL extracted data, not a reference to where it can be found\n- Include citation references like [1], [2] to indicate which document the information came from\n- If the documents don't contain the answer, state: "I do not have that information in the provided documents."`
    });

    try {
      // Generate content using the model
      const completion = await this.openai.chat.completions.create({
        model: this.config.model!,
        messages: [
          {
            role: 'user',
            content: multimodalContent
          }
        ],
        temperature: this.config.generationConfig?.temperature,
        max_tokens: this.config.generationConfig?.maxOutputTokens,
        top_p: this.config.generationConfig?.topP,
      });

      return stripThinkTags(completion.choices[0].message.content || '');
    } catch (error: any) {
      // If image input fails, fall back to text-only processing
      if (error.status === 404 && error.message.includes('image input')) {
        console.log('Image input not supported by model, falling back to text-only generation');
        return await this.generateTextOnlyResponse(query, searchResults, options);
      }
      throw error;
    }
 }

  /**
   * Generate insights from search results
   * @param query User's search query
   * @param searchResults Results from Colivara semantic search
   * @param userId User identifier for rate limiting
   */
 async generateInsights(
    query: string,
    searchResults: SearchResult[],
    userId?: string
  ): Promise<{
    summary: string;
    keyPoints: string[];
    sources: Array<{ title: string; documentId: string; confidence: number }>;
    noRelevantDocuments?: boolean; // Flag to indicate if the documents don't contain relevant information
 }> {
    const startTime = Date.now();
    try {
      // Use user ID for rate limiting, fallback to a general identifier if not provided
      const identifier = userId || 'anonymous';
      
      // Check if request is allowed based on rate limiting
      if (!this.configService.isRequestAllowed(identifier)) {
        const remainingRequests = this.configService.getRemainingRequests(identifier);
        const resetTime = this.configService.getResetTime(identifier);
        const resetTimeFormatted = new Date(resetTime).toLocaleTimeString();
        
        const error = new Error(
          `Rate limit exceeded. You can make ${remainingRequests} more requests after ${resetTimeFormatted}.`
        );
        
        // Track the failed request
        this.monitoringService.trackGeneration(
          userId || 'unknown',
          query,
          Date.now() - startTime,
          false,
          error.message,
          this.config.model
        );
        
        throw error;
      }

      const maxResults = 6;
      const limitedResults = searchResults.slice(0, maxResults);

      if (limitedResults.length === 0) {
        const result = {
          summary: "No relevant documents found to generate insights.",
          keyPoints: [],
          sources: [],
        };
        
        // Track the successful request with no results
        this.monitoringService.trackGeneration(
          userId || 'unknown',
          query,
          Date.now() - startTime,
          true,
          undefined,
          this.config.model
        );
        
        return result;
      }

      // Format the search results into a context string with visual content for insights
      const multimodalContent: Array<any> = [];
      
      multimodalContent.push({
        type: 'text',
        text: `
You are an intelligent document assistant that extracts and presents information accurately from institutional documents.
Your goal is to provide comprehensive, well-formatted answers based ONLY on the provided document content (text and images).

### CRITICAL INSTRUCTIONS:
1. **READ EVERYTHING:** You MUST thoroughly examine ALL images and text provided. Look at every visible element in the images.
2. **Visual Content Priority:** If an image is provided, extract ALL visible text, numbers, tables, and data from it - this is your PRIMARY source.
3. **Relevance Check:** If the provided documents DO NOT contain information relevant to the user's query, you MUST say so clearly. Start your response with "The provided document(s) do not contain information about [topic]."
4. **Accuracy First:** Only use information that is explicitly present in the documents. Never make assumptions or add external knowledge.
5. **Be Comprehensive:** Extract ALL relevant information. If asked for a list, include every item you find.
6. **Quote Evidence:** When possible, include direct quotes or specific data points from the documents.
7. **Handle OCR Errors:** If text is slightly unclear, use context to make reasonable corrections (e.g., "M@rk" → "Mark").

### WHEN DOCUMENTS DON'T MATCH THE QUERY:
If the documents provided are not relevant to the user's question (e.g., user asks about "graduation data" but document is about "OJT contracts"), you MUST:
- Clearly state: "The provided document does not contain information about [what user asked for]."
- Briefly describe what the document IS about (so the user knows what was searched).
- Do NOT try to make up an answer or stretch irrelevant information to fit the query.

### OUTPUT FORMATTING RULES:

**For Quantitative Questions (numbers, statistics, counts):**
- Start with the direct answer in bold: **[Answer]**
- Follow with supporting evidence: "According to [document name], [relevant quote/context]."
- Example: **There are 45 graduates in BS Information Technology.** This data is from the "2024 Graduates Report" which shows...

**For List-Based Questions (names, trainings, events):**
Use a structured bullet list format:
* **Category/Name**
  - Item 1 with details
  - Item 2 with details
  - Item 3 with details

**For Descriptive Questions:**
- Write clear, natural paragraphs
- Start with the main answer
- Support with specific details from the documents

**For Complex Data (tables, charts):**
- Extract systematically row-by-row or column-by-column
- Preserve numerical accuracy
- Indicate if any cells are unclear or empty

### RESPONSE STRUCTURE:
1. **Direct Answer** - Lead with the specific answer to the question (or state that info is not found)
2. **Evidence** - Cite the source document and relevant details
3. **Context** (if helpful) - Add brief clarifying information

### IMPORTANT: 
If the document contains images, you MUST describe what you see in them and extract ALL visible information.
Do NOT say "no information provided" if images are present - read them carefully.

Now analyze the documents below to answer this query: "${query}"
-------------------------------------------------------
`
      });
      
      // Process each result
      for (const result of limitedResults) {
        // Consolidate visual content sources
        const allVisuals: string[] = [];
        if (result.screenshots && Array.isArray(result.screenshots)) {
          allVisuals.push(...result.screenshots);
        }
        if (result.visualContent && typeof result.visualContent === 'string') {
          allVisuals.push(result.visualContent);
        }

        const hasVisuals = allVisuals.length > 0;
        const hasText = result.extractedText && result.extractedText.trim().length > 0;
        const title = result.title || 'Untitled Document';
        const confidence = result.confidenceScore || 0;
        
        console.log(`📄 Processing document "${title}" for Qwen:`, {
          hasVisuals,
          visualCount: allVisuals.length,
          hasText,
          textLength: result.extractedText?.length || 0,
          confidence
        });
        
        // Add document header
        multimodalContent.push({
          type: 'text',
          text: `\n\n=== Document: "${title}" (relevance: ${(confidence * 100).toFixed(1)}%) ===\n`
        });

        // 1. Provide the Visuals (Universal for PDF, PNG, Excel, etc.)
        if (hasVisuals) {
          for (const screenshot of allVisuals) {
              
          // MAGIC FIX: Detect Type from the string signature
          let realMimeType = 'image/jpeg';
          if (typeof screenshot === 'string') {
              if (screenshot.startsWith('iVBOR')) {
                  realMimeType = 'image/png';
              } else if (screenshot.startsWith('/9j/')) {
                  realMimeType = 'image/jpeg';
              } else if (screenshot.startsWith('iVBO')) {
                  realMimeType = 'image/png';
              }
          }

          console.log(`Sending to Qwen as: ${realMimeType}, Length: ${screenshot.length} chars`); // Debug log

          // Convert base64 image to data URL format
          const dataUrl = `data:${realMimeType};base64,${screenshot}`;
          
          multimodalContent.push({
            type: 'image_url',
            image_url: {
              url: dataUrl
            }
          });
          }
          // Prompt for Visuals
          multimodalContent.push({
            type: 'text',
            text: `\n[VISUAL CONTENT: The above image contains document information. Read EVERY visible element carefully and extract ALL data relevant to: "${query}"]\n`
          });
          multimodalContent.push({
            type: 'text',
            text: `\n[VISUAL CONTENT: The above image contains document information. Extract data relevant to: "${query}"]\n`
          });
        }

        // 2. Provide the Text (Universal for PDF, Word, etc.)
        if (hasText) {
          multimodalContent.push({
            type: 'text',
            text: `\n[TEXT CONTENT: ${result.extractedText}]\n`
          });
        } else {
          // 3. Handle "Visual Only" Files (Scans/Images)
          multimodalContent.push({
            type: 'text',
            text: `\n[NO TEXT EXTRACTED: Focus on visual content to answer: "${query}"]\n`
          });
        }
      }

      // Check if the query is asking for comprehensive information (like lists of faculty/trainings)
      const isComprehensiveQuery = query.toLowerCase().includes('list') ||
                                  query.toLowerCase().includes('all') ||
                                  query.toLowerCase().includes('every') ||
                                  query.toLowerCase().includes('faculty') ||
                                  query.toLowerCase().includes('training') ||
                                  query.toLowerCase().includes('seminar') ||
                                  query.toLowerCase().includes('attended') ||
                                  query.toLowerCase().includes('presentation') ||
                                  query.toLowerCase().includes('research') ||
                                  (query.toLowerCase().includes('what') && query.toLowerCase().includes('training')) ||
                                  (query.toLowerCase().includes('what') && query.toLowerCase().includes('seminar')) ||
                                  (query.toLowerCase().includes('which') && query.toLowerCase().includes('training')) ||
                                  (query.toLowerCase().includes('which') && query.toLowerCase().includes('seminar'));

      // Add special instruction for comprehensive queries
      multimodalContent.push({
        type: 'text',
        text: `\n\n${isComprehensiveQuery ? `### SPECIAL INSTRUCTION FOR COMPREHENSIVE QUERIES: When the user asks for a list of items (such as faculty and their trainings/seminars), you MUST provide ALL the information found in the documents. Do not summarize or abbreviate. If multiple documents contain relevant information, combine and present ALL the data from all documents. Use a clear format like bullet points or structured lists to make the information easy to read. CRITICAL: If you state that you are providing a list, you MUST actually provide the complete list content. Do not just say "Here is the list..." without providing the actual items in the list. READ EVERY DOCUMENT CAREFULLY and extract ALL relevant information BEFORE forming your response. Do not stop at the first few items you find - continue reading through all documents to ensure you have collected all relevant information.` : ''}\n\nBased on the above documents, provide a clear, direct answer to "${query}". Format your response as JSON with the following structure: { "summary": "Direct answer to the user's query based on document content", "keyPoints": ["Concise points that directly address the query", "Relevant information from documents"], "sources": [ { "title": "Document title", "documentId": "Document ID if available", "confidence": "Confidence score between 0 and 1" } ] }`
      });

      const prompt = `Based on the following documents, please provide a summary, key points, sources, and direct evidence (quoted passage or excerpt) that supports your answer for the query: ${query}

Documents:
[MULTIMODAL CONTENT PROVIDED IN THE REQUEST]

Please format your response as JSON with the following structure:
{
 "summary": "Direct answer to the user's query based on document content",
 "keyPoints": ["Concise points that directly address the query", "Relevant information from documents"],
 "sources": [
   {
     "title": "Document title",
     "documentId": "Document ID if available",
     "confidence": "Confidence score between 0 and 1"
   }
 ],
 "evidence": "Direct quote or passage from the document that supports the answer (required, do not leave blank)"
}`;

      // Check if the model supports image inputs by checking the model name
      const isImageSupported = this.isVisionModel();
      
      // If image input is not supported by this model, fall back to text-only
      if (!isImageSupported) {
        console.log(`Model ${this.config.model} does not support image input, falling back to text-only generation for insights`);
        // Use text-only processing by calling generateTextOnlyResponse and formatting appropriately
        const textResponse = await this.generateTextOnlyResponse(query, limitedResults, {});
        // Return a structured response similar to what the JSON format would provide
        const fallbackResult = {
          summary: textResponse,
          keyPoints: textResponse.split('\n').map(l => l.trim()).filter(l => l.length > 0).slice(0, 5),
          sources: limitedResults.map(result => ({
            title: result.title || 'Untitled Document',
            documentId: result.id || result.documentId || '',
            confidence: result.confidenceScore || 0
          }))
        };
        
        // Track the successful request with fallback
        this.monitoringService.trackGeneration(
          userId || 'unknown',
          query,
          Date.now() - startTime,
          true,
          'Fallback to text-only due to image input not supported',
          this.config.model
        );
        
        return fallbackResult;
      }

      // Log summary of what we're sending to Qwen
      const imageCount = multimodalContent.filter(c => c.type === 'image_url').length;
      const textCount = multimodalContent.filter(c => c.type === 'text').length;
      console.log(`🤖 Sending to Qwen: ${imageCount} images, ${textCount} text blocks for query "${query}"`);

      let completion;
      try {
        completion = await this.openai.chat.completions.create({
          model: this.config.model!,
          messages: [
            {
              role: 'user',
              content: multimodalContent
            }
          ],
          temperature: this.config.generationConfig?.temperature,
          max_tokens: this.config.generationConfig?.maxOutputTokens,
          top_p: this.config.generationConfig?.topP,
          response_format: { type: "json_object" }
        });
      } catch (error: any) {
        // If image input fails, fall back to text-only processing
        if (error.status === 404 && error.message.includes('image input')) {
          console.log('Image input not supported by model, falling back to text-only generation for insights');
          // Use text-only processing by calling generateTextOnlyResponse and formatting appropriately
          const textResponse = await this.generateTextOnlyResponse(query, limitedResults, {});
          // Return a structured response similar to what the JSON format would provide
          const fallbackResult = {
            summary: textResponse,
            keyPoints: textResponse.split('\n').map(l => l.trim()).filter(l => l.length > 0).slice(0, 5),
            sources: limitedResults.map(result => ({
              title: result.title || 'Untitled Document',
              documentId: result.id || result.documentId || '',
              confidence: result.confidenceScore || 0
            }))
          };
          
          // Track the successful request with fallback
          this.monitoringService.trackGeneration(
            userId || 'unknown',
            query,
            Date.now() - startTime,
            true,
            'Fallback to text-only due to image input error',
            this.config.model
          );
          
          return fallbackResult;
        }
        throw error;
      }

      const rawText = completion.choices[0].message.content || '';
      const text = stripThinkTags(rawText);

      // Parse the JSON response
      try {
        const parsed = JSON.parse(text);
        // Check if the AI response indicates no relevant information was found
        const noRelevantDocuments = isNoInformationResponse(parsed.summary || '');
        if (noRelevantDocuments) {
          console.log(`🔍 AI detected no relevant information in documents for query: "${query}"`);
        }
        // Track the successful request
        this.monitoringService.trackGeneration(
          userId || 'unknown',
          query,
          Date.now() - startTime,
          true,
          undefined,
          this.config.model
        );
        // Return parsed response, including evidence field
        return { ...parsed, noRelevantDocuments };
      } catch (parseError) {
        console.error('Error parsing Qwen JSON response:', parseError);
        // Check if the raw text indicates no relevant information
        const noRelevantDocuments = isNoInformationResponse(text);
        // Fallback: return a basic structure - use full text, don't truncate
        const fallbackResult = {
          summary: text, // Return full response text without truncation
          keyPoints: [text.substring(0, 500)],
          sources: limitedResults.map(result => ({
            title: result.title || 'Untitled Document',
            documentId: result.id || result.documentId || '',
            confidence: result.confidenceScore || 0
          })),
          evidence: '', // Fallback: no evidence available
          noRelevantDocuments
        };
        // Track the successful request with fallback
        this.monitoringService.trackGeneration(
          userId || 'unknown',
          query,
          Date.now() - startTime,
          true,
          'Fallback due to JSON parsing error',
          this.config.model
        );
        return fallbackResult;
      }
    } catch (error) {
      console.error('Error generating insights with Qwen:', error);
      
      // Track the failed request
      this.monitoringService.trackGeneration(
        userId || 'unknown',
        query,
        Date.now() - startTime,
        false,
        error instanceof Error ? error.message : 'Unknown error',
        this.config.model
      );
      
      throw error;
    }
  }

 /**
   * Check if the service is properly initialized and API key is valid
   */
  async healthCheck(): Promise<boolean> {
    const startTime = Date.now();
    try {
      // Try to get model information as a basic health check
      const completion = await this.openai.chat.completions.create({
        model: this.config.model!,
        messages: [
          {
            role: 'user',
            content: 'Hello'
          }
        ],
        temperature: 0,
        max_tokens: 5,
      });
      
      // Track the successful health check
      this.monitoringService.logMetric({
        endpoint: 'qwen-health-check',
        responseTime: Date.now() - startTime,
        success: true,
        model: this.config.model
      });
      
      return true;
    } catch (error) {
      console.error('Qwen service health check failed:', error);
      
      // Track the failed health check
      this.monitoringService.logMetric({
        endpoint: 'qwen-health-check',
        responseTime: Date.now() - startTime,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        model: this.config.model
      });
      
      return false;
    }
  }
}

export default QwenGenerationService;