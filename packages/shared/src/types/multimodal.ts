export type MultimodalMediaType = 'image' | 'video' | 'audio' | 'document' | 'unknown';

export interface MultimodalAnalysisRequest {
  mediaType: MultimodalMediaType;
  mimeType: string;
  dataBase64?: string;
  mediaUrl?: string;
  userPrompt?: string;
  fileName?: string;
  sizeBytes?: number;
}

export interface MultimodalAnalysisResult {
  success: boolean;
  mediaType: MultimodalMediaType;
  mimeType: string;
  extractedText?: string;
  description: string;
  summary?: string;
  entitiesFound?: string[];
  timestamps?: Array<{ timestamp: string; label: string }>;
  untrustedContentNotice?: string;
  error?: string;
}
