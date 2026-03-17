import { Module } from '@nestjs/common';
import { SyncGateway } from './sync.gateway';
import { IngestorModule } from '../ingestor/ingestor.module';
import { DistributorModule } from '../distributor/distributor.module';

@Module({
  imports: [IngestorModule, DistributorModule],
  providers: [SyncGateway],
})
export class GatewayModule {}
