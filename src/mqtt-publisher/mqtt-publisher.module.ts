import { Module } from '@nestjs/common';
import { MqttPublisherService } from './mqtt-publisher.service';
import { MqttPublisherController } from './mqtt-publisher.controller';
@Module({
  controllers: [MqttPublisherController],
  providers: [MqttPublisherService],
  exports: [MqttPublisherService],
})
export class MqttPublisherModule {}
