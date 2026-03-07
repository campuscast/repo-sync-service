import { Module } from '@nestjs/common';
import { MetricsModule } from '@campuscast/shared-libs';
import { ConfigModule } from '@nestjs/config';
import { GatewayModule } from './gateway/gateway.module';
import { IngestorModule } from './ingestor/ingestor.module';
import { DistributorModule } from './distributor/distributor.module';
import { MqttPublisherModule } from './mqtt-publisher/mqtt-publisher.module';
import { HealthController } from './common/health.controller';
import { appConfig, redisConfig, mqttConfig, validate } from './config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, redisConfig, mqttConfig],
      validate,
    }),
    GatewayModule,
    IngestorModule,
    DistributorModule,
    MqttPublisherModule,
      MetricsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
