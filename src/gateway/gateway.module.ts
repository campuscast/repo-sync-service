import { Module } from '@nestjs/common';
import { SyncGateway } from './sync.gateway';
import { IngestorModule } from '../ingestor/ingestor.module';
@Module({
  imports: [IngestorModule],
  providers: [SyncGateway],
})
export class GatewayModule {}
