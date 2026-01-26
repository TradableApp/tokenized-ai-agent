import { Service, IAgentRuntime, elizaLogger } from "@elizaos/core";

// Interface for user usage data
interface UserUsage {
  count: number;
  lastSeen: number;
}

/**
 * Manages API usage and rate limits for non-authenticated platforms like Telegram.
 * This service is managed as a singleton by the ElizaOS runtime.
 */
export class RateLimitService extends Service {
  static override serviceType = "rate_limit";
  override capabilityDescription = "Manages rate limits for Telegram users";

  private usage: Map<string, UserUsage> = new Map();
  private readonly FREE_LIMIT = 50; // Allow 5 free messages
  private readonly RESET_WINDOW = 24 * 60 * 60 * 1000; // 24 hours

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  async initialize(): Promise<void> {
    elizaLogger.info("Rate Limit Service Initialized.");
    // In a production TEE with persistent storage, you would load 'this.usage' here from the database.
  }

  static override async start(
    runtime: IAgentRuntime
  ): Promise<RateLimitService> {
    const service = new RateLimitService(runtime);
    await service.initialize();

    return service;
  }

  override async stop(): Promise<void> {
    elizaLogger.info("Rate Limit Service Stopped.");
    // In production, you would persist 'this.usage' here to the database.
  }

  /**
   * Checks if a user has access without decrementing their count.
   * This is called by the accessProvider to decide on a course of action.
   */
  async hasAccess(userId: string, platform: string): Promise<boolean> {
    if (platform !== "telegram") return true;

    const now = Date.now();
    const user = this.usage.get(userId) || { count: 0, lastSeen: now };
    elizaLogger.info(
      `[RateLimitService] hasAccess for userId: ${userId}, current usage:`,
      JSON.stringify(user)
    );

    if (now - user.lastSeen > this.RESET_WINDOW) {
      return true; // Window has reset, they have access again.
    }

    return user.count < this.FREE_LIMIT;
  }

  /**
   * Decrements a user's message count after a message has been successfully processed.
   * This ensures users are only "charged" for successful interactions.
   */
  async decrement(userId: string, platform: string): Promise<void> {
    if (platform !== "telegram") return;

    const now = Date.now();
    const user = this.usage.get(userId) || { count: 0, lastSeen: now };
    elizaLogger.info(
      `[RateLimitService] decrement for userId: ${userId}, current usage:`,
      JSON.stringify(user)
    );

    // Reset window if necessary
    if (now - user.lastSeen > this.RESET_WINDOW) {
      user.count = 0;
    }

    user.count++;
    user.lastSeen = now;
    this.usage.set(userId, user);

    elizaLogger.info(
      `[RateLimitService] User ${userId} usage updated to ${user.count}/${this.FREE_LIMIT}`
    );
  }

  /**
   * Gets the number of remaining free messages for a user.
   */
  async getRemainingDetails(userId: string): Promise<number> {
    const user = this.usage.get(userId);
    elizaLogger.info(
      `[RateLimitService] getRemainingDetails for userId: ${userId}, current usage:`,
      JSON.stringify(user)
    );

    if (!user || Date.now() - user.lastSeen > this.RESET_WINDOW) {
      return this.FREE_LIMIT;
    }

    return Math.max(0, this.FREE_LIMIT - user.count);
  }
}
