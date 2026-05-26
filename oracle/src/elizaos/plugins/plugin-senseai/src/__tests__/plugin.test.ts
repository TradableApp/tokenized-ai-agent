import { describe, expect, it, beforeEach, beforeAll, afterAll, spyOn } from 'bun:test';
import senseaiPlugin, { RateLimitService } from '../index';
import {
  type IAgentRuntime,
  logger,
} from '@elizaos/core';
import {
  createMockRuntime,
  createTestMemory,
  createTestState,
} from './test-utils';

beforeAll(() => {
  spyOn(logger, 'info');
  spyOn(logger, 'error');
  spyOn(logger, 'warn');
  spyOn(logger, 'debug');
});

afterAll(() => {});

describe('SenseAI Plugin Configuration', () => {
  it('should have correct plugin metadata', () => {
    expect(senseaiPlugin.name).toBe('senseai');
    expect(senseaiPlugin.description).toBeDefined();
    expect(senseaiPlugin.description!.length).toBeGreaterThan(0);
    expect(senseaiPlugin.priority).toBe(100);
  });

  it('should export correct actions', () => {
    expect(senseaiPlugin.actions).toBeDefined();
    expect(senseaiPlugin.actions!.length).toBe(5);
    const actionNames = senseaiPlugin.actions!.map((a) => a.name);
    expect(actionNames).toContain('ANALYZE_FINANCIAL_IMAGE');
    expect(actionNames).toContain('HANDLE_MENU_CALLBACK');
    expect(actionNames).toContain('LAUNCH_SENSEAI_APP');
    expect(actionNames).toContain('INFORM_RATE_LIMIT_EXCEEDED');
    expect(actionNames).toContain('SHOW_QUICK_ACTIONS_MENU');
  });

  it('should export correct providers', () => {
    expect(senseaiPlugin.providers).toBeDefined();
    expect(senseaiPlugin.providers!.length).toBe(2);
  });

  it('should export correct services', () => {
    expect(senseaiPlugin.services).toBeDefined();
    expect(senseaiPlugin.services!.length).toBe(1);
    expect(senseaiPlugin.services![0]).toBe(RateLimitService);
  });

  it('should export correct evaluators', () => {
    expect(senseaiPlugin.evaluators).toBeDefined();
    expect(senseaiPlugin.evaluators!.length).toBe(1);
  });

  it('should have an init function', () => {
    expect(senseaiPlugin.init).toBeDefined();
    expect(typeof senseaiPlugin.init).toBe('function');
  });
});

describe('RateLimitService', () => {
  let runtime: IAgentRuntime;
  let service: RateLimitService;

  beforeEach(async () => {
    runtime = createMockRuntime();
    service = await RateLimitService.start(runtime);
  });

  it('should have correct service type', () => {
    expect(RateLimitService.serviceType).toBe('rate_limit');
  });

  it('should have correct capability description', () => {
    expect(service.capabilityDescription).toBe('Manages rate limits for Telegram users');
  });

  it('should grant access to new telegram users', async () => {
    const hasAccess = await service.hasAccess('user-123', 'telegram');
    expect(hasAccess).toBe(true);
  });

  it('should always grant access for non-telegram platforms', async () => {
    const hasAccess = await service.hasAccess('user-123', 'discord');
    expect(hasAccess).toBe(true);
  });

  it('should decrement usage count on telegram', async () => {
    await service.decrement('user-123', 'telegram');
    const remaining = await service.getRemainingDetails('user-123');
    expect(remaining).toBe(49);
  });

  it('should not decrement for non-telegram platforms', async () => {
    await service.decrement('user-123', 'discord');
    const remaining = await service.getRemainingDetails('user-123');
    expect(remaining).toBe(50);
  });

  it('should deny access after free limit is reached', async () => {
    for (let i = 0; i < 50; i++) {
      await service.decrement('user-456', 'telegram');
    }
    const hasAccess = await service.hasAccess('user-456', 'telegram');
    expect(hasAccess).toBe(false);
  });

  it('should return 0 remaining after limit reached', async () => {
    for (let i = 0; i < 50; i++) {
      await service.decrement('user-456', 'telegram');
    }
    const remaining = await service.getRemainingDetails('user-456');
    expect(remaining).toBe(0);
  });

  it('should return full limit for unknown users', async () => {
    const remaining = await service.getRemainingDetails('unknown-user');
    expect(remaining).toBe(50);
  });

  it('should stop without errors', async () => {
    await expect(service.stop()).resolves.toBeUndefined();
  });
});
