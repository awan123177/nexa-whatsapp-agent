import { z } from 'zod';
import { BaseTool, ToolExecutionContext, ToolResult } from '@nexa/shared';
import { YouTubeService } from './youtube-service.js';

export function createYouTubeTools(service: YouTubeService = new YouTubeService()): BaseTool[] {
  // 1. YouTube Search Tool
  const searchTool: BaseTool = {
    name: 'youtube_search',
    description: 'Searches YouTube intelligently for videos, in-depth reviews, teardowns, benchmark tests, tutorials, or company presentations. Returns real video links, channels, publication dates, and relevance explanations.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      query: z.string().describe('Search query for YouTube videos (e.g. "Galaxy S24 Ultra battery test", "Blender beginner tutorial", "Dell XPS 14 review")'),
      maxResults: z.number().min(1).max(10).optional().describe('Maximum number of videos to return (default 5)'),
      focusArea: z.string().optional().describe('Specific focus area such as "battery", "camera", "thermals", "comparison", "tutorial"'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { query: string; maxResults?: number; focusArea?: string }, context: ToolExecutionContext): Promise<ToolResult> => {
      try {
        const videos = await service.searchVideos(args.query, {
          maxResults: args.maxResults,
          focusArea: args.focusArea,
          signal: context.abortSignal,
        });

        return {
          success: true,
          data: {
            query: args.query,
            totalFound: videos.length,
            videos,
            instructions: 'Use youtube_get_transcript or youtube_analyze_video to inspect accessible content before drawing conclusions.',
          },
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message || 'YouTube search failed',
          userFacingMessage: 'Unable to search YouTube videos at this moment.',
        };
      }
    },
  };

  // 2. YouTube Get Transcript Tool
  const transcriptTool: BaseTool = {
    name: 'youtube_get_transcript',
    description: 'Retrieves the official accessible captions and timed transcript for a YouTube video. Does not fabricate dialogue if captions are disabled or unavailable.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      videoIdOrUrl: z.string().describe('YouTube video URL or 11-character video ID'),
      language: z.string().optional().describe('Preferred caption language code (default "en")'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { videoIdOrUrl: string; language?: string }, _context: ToolExecutionContext): Promise<ToolResult> => {
      try {
        const result = await service.getVideoTranscript(args.videoIdOrUrl);

        if (result.segments.length === 0) {
          return {
            success: false,
            error: result.error || 'No transcript available',
            data: {
              hasTranscript: false,
              source: result.source,
              message: result.error || 'Captions are disabled or unavailable for this video.',
            },
            userFacingMessage: 'No accessible transcript was found for this YouTube video.',
          };
        }

        return {
          success: true,
          data: {
            videoId: service.extractVideoId(args.videoIdOrUrl),
            segmentCount: result.segments.length,
            segments: result.segments.slice(0, 50), // first 50 segments
            fullTextSnippet: result.fullText.slice(0, 2000),
            source: result.source,
          },
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message || 'Transcript retrieval failed',
        };
      }
    },
  };

  // 3. YouTube Analyze Video Tool
  const analyzeTool: BaseTool = {
    name: 'youtube_analyze_video',
    description: 'Deeply analyzes accessible content of a YouTube video: identifies products, models, manufacturers, creators, sponsors, and extracts measured test results with timestamps.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      videoIdOrUrl: z.string().describe('YouTube video URL or 11-character video ID to inspect'),
      focusTopic: z.string().optional().describe('Specific metric or question (e.g. "battery life", "display brightness", "Geekbench score")'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { videoIdOrUrl: string; focusTopic?: string }, _context: ToolExecutionContext): Promise<ToolResult> => {
      try {
        const analysis = await service.analyzeVideoContent({
          videoIdOrUrl: args.videoIdOrUrl,
          focusTopic: args.focusTopic,
        });

        return {
          success: true,
          data: analysis,
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message || 'Video analysis failed',
        };
      }
    },
  };

  // 4. YouTube Compare Reviews Tool
  const compareTool: BaseTool = {
    name: 'youtube_compare_reviews',
    description: 'Compares 2 or more YouTube reviews or test videos. Highlights points of agreement, conflicting measurements, test conditions, disclosed sponsorships, and grounded conclusions.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      videoIdsOrUrls: z.array(z.string()).min(1).describe('List of YouTube video URLs or video IDs to compare'),
      researchQuestion: z.string().describe('Core comparison question (e.g. "Compare battery life and thermals between S24 Ultra and iPhone 15 Pro Max")'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { videoIdsOrUrls: string[]; researchQuestion: string }, _context: ToolExecutionContext): Promise<ToolResult> => {
      try {
        const report = await service.compareVideos({
          videoIdsOrUrls: args.videoIdsOrUrls,
          researchQuestion: args.researchQuestion,
        });

        return {
          success: true,
          data: report,
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message || 'Video comparison failed',
        };
      }
    },
  };

  // 5. YouTube Research Report Tool
  const reportTool: BaseTool = {
    name: 'youtube_research_report',
    description: 'Generates a structured YouTube research report for complex inquiries, citing verified sources, timestamps, products, test conditions, and final recommendations.',
    riskLevel: 'read_only',
    parametersSchema: z.object({
      topic: z.string().describe('The research topic or question to investigate'),
      videoIdsOrUrls: z.array(z.string()).optional().describe('Optional specific video URLs or IDs to include'),
      specificQuestions: z.array(z.string()).optional().describe('Specific sub-questions to answer'),
    }),
    requiresApproval: () => ({ required: false }),
    execute: async (args: { topic: string; videoIdsOrUrls?: string[]; specificQuestions?: string[] }, context: ToolExecutionContext): Promise<ToolResult> => {
      try {
        let videoIds = args.videoIdsOrUrls || [];
        if (videoIds.length === 0) {
          const searchHits = await service.searchVideos(args.topic, { maxResults: 3, signal: context.abortSignal });
          videoIds = searchHits.map((v) => v.id);
        }

        if (videoIds.length === 0) {
          return {
            success: false,
            error: `No relevant YouTube videos found for topic "${args.topic}"`,
          };
        }

        const report = await service.compareVideos({
          videoIdsOrUrls: videoIds,
          researchQuestion: args.topic,
        });

        return {
          success: true,
          data: {
            reportMarkdown: report.formattedReport,
            summary: report.recommendation,
            sourcesCount: report.videosConsulted.length,
          },
        };
      } catch (err: any) {
        return {
          success: false,
          error: err.message || 'Failed to generate YouTube research report',
        };
      }
    },
  };

  return [searchTool, transcriptTool, analyzeTool, compareTool, reportTool];
}
