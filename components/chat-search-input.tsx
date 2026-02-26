"use client"

import { useCallback, useRef, useState, useEffect, type DragEvent, type ChangeEvent } from "react"
import { Paperclip, Send, X, FileText, FileIcon, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

// File type helpers
function getFileIcon(fileType: string) {
  if (fileType === 'application/pdf') return '📄'
  if (fileType.includes('wordprocessingml') || fileType.includes('msword')) return '📝'
  if (fileType.startsWith('image/')) return '🖼️'
  return '📁'
}

function getFileExtension(fileName: string): string {
  return fileName.split('.').pop()?.toUpperCase() || 'FILE'
}

function truncateFileName(name: string, maxLen = 28): string {
  if (name.length <= maxLen) return name
  const ext = name.split('.').pop() || ''
  const baseName = name.slice(0, name.length - ext.length - 1)
  const truncated = baseName.slice(0, maxLen - ext.length - 4)
  return `${truncated}...${ext}`
}

export interface AttachedFile {
  file: File
  /** Name returned from the chat-upload API (Colivara document name) */
  documentName?: string
  uploading?: boolean
  error?: string
}

interface ChatSearchInputProps {
  /** Current query text */
  query: string
  onQueryChange: (query: string) => void
  /** Called when user submits a search (Enter or Send button) */
  onSubmit: (query: string) => void
  /** Called when a file is attached — parent should upload via API */
  onFileAttach: (file: File) => void
  /** Called when attached file is removed */
  onFileRemove: () => void
  /** Currently attached file info */
  attachedFile: AttachedFile | null
  /** Whether a search/query is in progress */
  isLoading?: boolean
  /** Whether the input is disabled */
  disabled?: boolean
}

const ALLOWED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'image/png',
  'image/jpeg',
  'image/webp',
]
const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25 MB

export default function ChatSearchInput({
  query,
  onQueryChange,
  onSubmit,
  onFileAttach,
  onFileRemove,
  attachedFile,
  isLoading = false,
  disabled = false,
}: ChatSearchInputProps) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounter = useRef(0)

  const hasFile = !!attachedFile && !attachedFile.error

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
    }
  }, [query])

  // ---- File validation ----
  const validateAndAttach = useCallback(
    (file: File) => {
      setFileError(null)
      if (!ALLOWED_TYPES.includes(file.type)) {
        setFileError('Unsupported file type. Please use PDF, DOCX, or image files.')
        return
      }
      if (file.size > MAX_FILE_SIZE) {
        setFileError('File too large. Maximum size is 25 MB.')
        return
      }
      onFileAttach(file)
    },
    [onFileAttach],
  )

  // ---- Drag & Drop ----
  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) {
      setIsDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      dragCounter.current = 0

      const files = e.dataTransfer.files
      if (files.length > 0) {
        validateAndAttach(files[0])
      }
    },
    [validateAndAttach],
  )

  // ---- File input ----
  const handleFileInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        validateAndAttach(files[0])
      }
      // Reset input so re-selecting same file works
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [validateAndAttach],
  )

  const handlePaperclipClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  // ---- Submit ----
  const handleSubmit = useCallback(() => {
    if (query.trim() && !isLoading && !disabled) {
      onSubmit(query.trim())
    }
  }, [query, isLoading, disabled, onSubmit])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit],
  )

  return (
    <div className="w-full">
      {/* Main Container */}
      <div
        className={cn(
          'relative rounded-xl border-2 bg-card transition-all duration-200',
          isDragOver
            ? 'border-dashed border-primary bg-primary/5 shadow-lg shadow-primary/10'
            : 'border-border hover:border-muted-foreground/40',
          isLoading && 'opacity-70 pointer-events-none',
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-primary/5 backdrop-blur-[1px]">
            <div className="flex flex-col items-center gap-2 text-primary">
              <Upload className="w-8 h-8 animate-bounce" />
              <span className="text-sm font-medium">Drop file here to attach</span>
            </div>
          </div>
        )}

        {/* File Chip */}
        {attachedFile && (
          <div className="px-4 pt-3 pb-0">
            <div
              className={cn(
                'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors',
                attachedFile.error
                  ? 'border-destructive/50 bg-destructive/10 text-destructive'
                  : attachedFile.uploading
                    ? 'border-primary/30 bg-primary/5 text-muted-foreground'
                    : 'border-primary/30 bg-primary/10 text-foreground',
              )}
            >
              <span className="text-base">{getFileIcon(attachedFile.file.type)}</span>
              <span className="font-medium max-w-[200px] truncate">
                {truncateFileName(attachedFile.file.name)}
              </span>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                {getFileExtension(attachedFile.file.name)}
              </Badge>
              {attachedFile.uploading && (
                <div className="w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              )}
              {attachedFile.error && (
                <span className="text-xs text-destructive">{attachedFile.error}</span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onFileRemove()
                  setFileError(null)
                }}
                className="ml-1 rounded-full p-0.5 hover:bg-muted transition-colors"
                aria-label="Remove attached file"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Textarea row */}
        <div className="flex items-end gap-2 px-3 py-2">
          {/* Paperclip / Attach button */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0 h-9 w-9 rounded-full text-muted-foreground hover:text-primary hover:bg-primary/10"
            onClick={handlePaperclipClick}
            disabled={disabled || isLoading || !!attachedFile?.uploading}
            aria-label="Attach a file"
          >
            <Paperclip className="w-5 h-5" />
          </Button>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.docx,.doc,.png,.jpg,.jpeg,.webp"
            onChange={handleFileInputChange}
          />

          {/* Auto-expanding textarea */}
          <Textarea
            ref={textareaRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              hasFile
                ? 'Ask a question about this document...'
                : 'Ask or search about institutional documents and files (English/Filipino)'
            }
            className="min-h-11 max-h-[200px] resize-none border-0 shadow-none focus-visible:ring-0 focus-visible:border-0 text-base py-2.5 px-1"
            disabled={disabled || isLoading}
            rows={1}
          />

          {/* Submit button */}
          <Button
            type="button"
            size="icon"
            className={cn(
              'shrink-0 h-9 w-9 rounded-full transition-all',
              query.trim()
                ? 'bg-primary hover:bg-primary/90 text-primary-foreground'
                : 'bg-muted text-muted-foreground',
            )}
            onClick={handleSubmit}
            disabled={!query.trim() || disabled || isLoading || !!attachedFile?.uploading}
            aria-label="Send search query"
          >
            {isLoading ? (
              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>

      {/* File error message (below the container) */}
      {fileError && (
        <p className="mt-2 text-sm text-destructive flex items-center gap-1">
          <X className="w-3.5 h-3.5" />
          {fileError}
        </p>
      )}
    </div>
  )
}
