import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class DedupService {
  private readonly redis: Redis;
  private readonly windowSeconds: number;

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    this.windowSeconds = parseInt(process.env.DEDUP_WINDOW_SECONDS || '3600', 10);
  }

  async isDuplicate(operationId: string): Promise<boolean> {
    const key = `dedup:${operationId}`;
    const exists = await this.redis.exists(key);
    if (exists) return true;
    await this.redis.set(key, '1', 'EX', this.windowSeconds);
    return false;
  }
}
