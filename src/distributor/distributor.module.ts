import { Module } from '@nestjs/common';
import { DistributorService } from './distributor.service';
@Module({ providers: [DistributorService], exports: [DistributorService] })
export class DistributorModule {}
