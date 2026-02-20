import { Module } from '@nestjs/common';
import { MqttPublisherService } from './mqtt-publisher.service';
@Module({ providers: [MqttPublisherService], exports: [MqttPublisherService] })
export class MqttPublisherModule {}
