import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly redis: Redis;
  private readonly maxOpsPerMinute: number;

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    this.maxOpsPerMinute = parseInt(process.env.MAX_OPS_PER_MINUTE || '60', 10);
  }

  async check(clientId: string): Promise<boolean> {
    const key = `rl:sync:${clientId}`;
    const now = Date.now();
    const window = 60_000;

    const pipe = this.redis.pipeline();
    pipe.zremrangebyscore(key, 0, now - window);
    pipe.zadd(key, now.toString(), now.toString());
    pipe.zcard(key);
    pipe.expire(key, 60);
    const results = await pipe.exec();

    const count = (results?.[2]?.[1] as number) || 0;
    if (count > this.maxOpsPerMinute) {
      this.logger.warn(`Rate limit exceeded for client=${clientId} count=${count}`);
      return false;
    }
    return true;
  }
}
