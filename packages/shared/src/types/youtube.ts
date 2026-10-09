export interface YouTubeVideoItem {
  id: string;
  title: string;
  url: string; // e.g. "https://www.youtube.com/watch?v=VIDEO_ID"
  channelTitle: string;
  channelId?: string;
  publishedAt?: string;
  description?: string;
  duration?: string;
  viewCount?: number;
  relevanceReason?: string;
}

export interface YouTubeTranscriptSegment {
  startMs: number;
  durationMs: number;
  timestamp: string; // formatted e.g. "[02:15]"
  text: string;
}

export type EntityRole =
  | 'product'
  | 'brand'
  | 'model'
  | 'manufacturer'
  | 'retailer'
  | 'creator'
  | 'sponsor'
  | 'measured_subject';

export interface ProductEntity {
  name: string;
  brand?: string;
  model?: string;
  manufacturer?: string;
  role: EntityRole;
  confidence: number;
}

export interface TestMeasurement {
  metric: string; // e.g. "Battery Life", "Geekbench Single-Core", "Peak Brightness"
  value: string; // e.g. "6h 45m screen-on time", "2140", "1750 nits"
  testCondition?: string; // e.g. "120Hz, 50% brightness, continuous video streaming"
  subject: string; // e.g. "Galaxy S24 Ultra"
  sourceTimestamp?: string; // e.g. "[08:32]"
  isCreatorClaim: boolean;
  isIndependentlyVerified: boolean;
}

export interface YouTubeVideoAnalysis {
  videoId: string;
  videoTitle: string;
  channelTitle: string;
  videoUrl: string;
  hasTranscript: boolean;
  transcriptSource: 'official_timed_captions' | 'user_audio_multimodal' | 'metadata_only' | 'none';
  summary: string;
  productsIdentified: ProductEntity[];
  measurements: TestMeasurement[];
  sponsor?: {
    name: string;
    disclosed: boolean;
  };
  creatorOpinion: string[];
  keyTimestamps: Array<{
    timestamp: string;
    topic: string;
    summary: string;
  }>;
  limitations: string[];
  error?: string;
}

export interface YouTubeComparisonPoint {
  topic: string;
  claims: Array<{
    sourceVideoId: string;
    sourceTitle: string;
    sourceChannel: string;
    timestamp?: string;
    product: string;
    claimOrResult: string;
    isOpinion: boolean;
  }>;
  consensus?: string;
  conflicts?: string;
}

export interface YouTubeComparisonReport {
  researchQuestion: string;
  videosConsulted: Array<{
    title: string;
    channel: string;
    url: string;
    publishedAt?: string;
  }>;
  productsCompared: string[];
  comparisonPoints: YouTubeComparisonPoint[];
  keyAgreements: string[];
  keyDisagreements: string[];
  measurementsSummary: TestMeasurement[];
  uncertainties: string[];
  recommendation: string;
  formattedReport: string;
}
