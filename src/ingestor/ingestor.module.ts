import { Module } from '@nestjs/common';
import { IngestorService } from './ingestor.service';
import { SchemaValidatorService } from '../schema-validator/schema-validator.service';
import { DedupService } from '../dedup/dedup.service';
import { RateLimiterService } from '../rate-limiter/rate-limiter.service';
@Module({
  providers: [IngestorService, SchemaValidatorService, DedupService, RateLimiterService],
  exports: [IngestorService],
})
export class IngestorModule {}
