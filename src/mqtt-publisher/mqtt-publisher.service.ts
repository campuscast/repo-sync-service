import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as mqtt from 'mqtt';

@Injectable()
export class MqttPublisherService implements OnModuleDestroy {
  private readonly logger = new Logger(MqttPublisherService.name);
  private client: mqtt.MqttClient;

  constructor() {
    const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
    this.client = mqtt.connect(brokerUrl);
    this.client.on('connect', () => this.logger.log('Connected to MQTT broker'));
    this.client.on('error', (err) => this.logger.error('MQTT error', err.message));
  }

  async publishRelease(zoneId: string, groupId: string, releasePayload: any): Promise<void> {
    const topic = `zones/${zoneId}/groups/${groupId}/releases`;
    this.client.publish(topic, JSON.stringify(releasePayload), { qos: 1 });
    this.logger.log(`Published release to ${topic}`);
  }

  async publishUpdate(zoneId: string, groupId: string, updatePayload: any): Promise<void> {
    const topic = `zones/${zoneId}/groups/${groupId}/updates`;
    this.client.publish(topic, JSON.stringify(updatePayload), { qos: 0 });
  }

  async onModuleDestroy(): Promise<void> {
    this.client.end();
  }
}
