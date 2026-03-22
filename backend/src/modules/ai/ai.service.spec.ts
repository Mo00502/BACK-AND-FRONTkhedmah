import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { AiService } from './ai.service';
import { PrismaService } from '../../prisma/prisma.service';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = {
  service: { findMany: jest.fn() },
  providerProfile: { findMany: jest.fn() },
  escrow: { findMany: jest.fn() },
};

const mockCache = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
};

const makeConfig = (apiKey?: string) => ({
  get: jest.fn().mockReturnValue(apiKey),
  getOrThrow: jest.fn(),
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function buildService(apiKey?: string) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AiService,
      { provide: PrismaService, useValue: mockPrisma },
      { provide: ConfigService, useValue: makeConfig(apiKey) },
      { provide: CACHE_MANAGER, useValue: mockCache },
    ],
  }).compile();

  return module.get<AiService>(AiService);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('AiService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.service.findMany.mockResolvedValue([
      { id: 'svc-1', nameAr: 'كهرباء', category: { nameAr: 'كهرباء' } },
      { id: 'svc-2', nameAr: 'سباكة', category: { nameAr: 'سباكة' } },
    ]);
    mockPrisma.providerProfile.findMany.mockResolvedValue([]);
    mockPrisma.escrow.findMany.mockResolvedValue([]);
  });

  // ── recommendServices — no API key (rule-based fallback) ─────────────────

  describe('recommendServices — no API key', () => {
    it('returns rule-based fallback immediately without calling Claude', async () => {
      const service = await buildService(undefined);
      const result = await service.recommendServices({ query: 'أحتاج سباك' });

      expect(mockedAxios.post).not.toHaveBeenCalled();
      expect(result).toHaveProperty('detectedCategory');
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('detects سباكة category via rule-based matching', async () => {
      const service = await buildService(undefined);
      const result = await service.recommendServices({ query: 'عندي تسريب مياه في الحمام' });

      expect(result.detectedCategory).toBe('سباكة');
    });

    it('detects كهرباء category', async () => {
      const service = await buildService(undefined);
      const result = await service.recommendServices({ query: 'انقطعت الكهرباء في المطبخ' });

      expect(result.detectedCategory).toBe('كهرباء');
    });

    it('defaults to صيانة عامة for unknown query', async () => {
      const service = await buildService(undefined);
      const result = await service.recommendServices({ query: 'أحتاج مساعدة' });

      expect(result.detectedCategory).toBe('صيانة عامة');
    });
  });

  // ── recommendServices — cache hit ────────────────────────────────────────

  describe('recommendServices — cache hit', () => {
    it('returns cached result without calling Prisma or Claude', async () => {
      const cachedResult = { detectedCategory: 'تنظيف', confidence: 0.9 };
      mockCache.get.mockResolvedValueOnce(cachedResult);

      const service = await buildService('sk-ant-test');
      const result = await service.recommendServices({ query: 'تنظيف' });

      expect(result).toBe(cachedResult);
      expect(mockPrisma.service.findMany).not.toHaveBeenCalled();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  // ── recommendServices — API key present ──────────────────────────────────

  describe('recommendServices — API key present', () => {
    it('calls Claude API and caches result', async () => {
      const aiResponse = {
        detectedCategory: 'سباكة',
        confidence: 0.95,
        recommendedServices: [],
        recommendedProviders: [],
        suggestedQuery: 'سباك',
        tips: [],
      };
      mockedAxios.post.mockResolvedValue({
        data: { content: [{ text: JSON.stringify(aiResponse) }] },
      });

      const service = await buildService('sk-ant-real-key');
      const result = await service.recommendServices({ query: 'أحتاج سباك' });

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
        expect.any(Object),
      );
      expect(result.detectedCategory).toBe('سباكة');
      expect(mockCache.set).toHaveBeenCalled();
    });

    it('strips markdown code fences from Claude response', async () => {
      const aiResponse = { detectedCategory: 'كهرباء', confidence: 0.9 };
      mockedAxios.post.mockResolvedValue({
        data: { content: [{ text: '```json\n' + JSON.stringify(aiResponse) + '\n```' }] },
      });

      const service = await buildService('sk-ant-real-key');
      const result = await service.recommendServices({ query: 'كهرباء' });

      expect(result.detectedCategory).toBe('كهرباء');
    });

    it('returns fallback when Claude returns invalid JSON', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { content: [{ text: 'not valid json at all' }] },
      });

      const service = await buildService('sk-ant-real-key');
      const result = await service.recommendServices({ query: 'كهرباء' });

      // Should still return the fallback object (not throw)
      expect(result).toBeDefined();
      expect(result).toHaveProperty('detectedCategory');
    });

    it('returns fallback when Claude API call fails (network error)', async () => {
      mockedAxios.post.mockRejectedValue(new Error('ECONNREFUSED'));

      const service = await buildService('sk-ant-real-key');
      const result = await service.recommendServices({ query: 'سباكة' });

      expect(result).toHaveProperty('detectedCategory');
      // Fallback confidence is 0.6
      expect(result.confidence).toBe(0.6);
    });
  });

  // ── estimateQuote ────────────────────────────────────────────────────────

  describe('estimateQuote', () => {
    it('returns fallback when no API key', async () => {
      const service = await buildService(undefined);
      const result = await service.estimateQuote({
        serviceCategory: 'سباكة',
        description: 'إصلاح حنفية',
      });

      expect(result.currency).toBe('SAR');
      expect(typeof result.estimatedMin).toBe('number');
      expect(typeof result.estimatedMax).toBe('number');
    });

    it('incorporates historical escrow data into prompt', async () => {
      mockPrisma.escrow.findMany.mockResolvedValue([
        { amount: 200 },
        { amount: 300 },
        { amount: 400 },
      ]);
      mockedAxios.post.mockResolvedValue({
        data: {
          content: [
            {
              text: JSON.stringify({
                estimatedMin: 200,
                estimatedMax: 400,
                estimatedAvg: 300,
                currency: 'SAR',
                confidence: 'high',
                factors: [],
                tips: [],
                basedOnSamples: 3,
              }),
            },
          ],
        },
      });

      const service = await buildService('sk-ant-real-key');
      await service.estimateQuote({ serviceCategory: 'سباكة', description: 'حنفية' });

      const postCall = mockedAxios.post.mock.calls[0] as any[];
      const userPrompt = (postCall[1] as any).messages[0].content;
      expect(userPrompt).toContain('300'); // avg included in prompt
      expect(userPrompt).toContain('3'); // sample count
    });
  });

  // ── answerFaq ────────────────────────────────────────────────────────────

  describe('answerFaq', () => {
    it('returns fallback with needsHumanSupport=true when no API key', async () => {
      const service = await buildService(undefined);
      const result = await service.answerFaq({ question: 'كيف يعمل نظام الدفع؟' });

      expect(result.needsHumanSupport).toBe(true);
      expect(typeof result.answer).toBe('string');
    });

    it('caches FAQ responses', async () => {
      const cached = {
        answer: 'الدفع آمن',
        category: 'دفع',
        relatedLinks: [],
        needsHumanSupport: false,
      };
      mockCache.get.mockResolvedValueOnce(cached);

      const service = await buildService('sk-ant-real-key');
      const result = await service.answerFaq({ question: 'الدفع؟' });

      expect(result).toBe(cached);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  // ── categorizeRequest ────────────────────────────────────────────────────

  describe('categorizeRequest', () => {
    it('returns rule-based category when no API key', async () => {
      const service = await buildService(undefined);
      const result = await service.categorizeRequest({ description: 'أحتاج نجار لإصلاح الباب' });

      expect(result.primaryCategory).toBe('نجارة');
    });

    it('detects urgency flag from description keywords', async () => {
      const service = await buildService(undefined);
      const result = await service.categorizeRequest({ description: 'طارئ — تسريب مياه' });

      expect(result.urgencyDetected).toBe(true);
    });

    it('sets suggestedTitle to first 60 chars of description', async () => {
      const service = await buildService(undefined);
      const longDesc = 'أحتاج سباكاً لإصلاح حنفية المطبخ المكسورة التي تسرب مياهاً منذ أمس';
      const result = await service.categorizeRequest({ description: longDesc });

      expect(result.suggestedTitle.length).toBeLessThanOrEqual(60);
    });

    it('caches categorization results', async () => {
      const service = await buildService('sk-ant-real-key');

      const aiResponse = {
        primaryCategory: 'سباكة',
        secondaryCategory: null,
        confidence: 0.95,
        keywords: ['سباك'],
        urgencyDetected: false,
        suggestedTitle: 'سباكة',
      };
      mockedAxios.post.mockResolvedValue({
        data: { content: [{ text: JSON.stringify(aiResponse) }] },
      });

      await service.categorizeRequest({ description: 'سباك' });
      expect(mockCache.set).toHaveBeenCalled();
    });
  });
});
