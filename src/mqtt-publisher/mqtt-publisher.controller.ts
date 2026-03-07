import { Controller, Post, Body } from '@nestjs/common';
import { MqttPublisherService } from './mqtt-publisher.service';

@Controller('mqtt')
export class MqttPublisherController {
  constructor(private readonly publisher: MqttPublisherService) {}

  @Post('publish-release')
  async publishRelease(@Body() body: {
    zone_id: string;
    group_id: string;
    release_id: string;
    manifest_hash: string;
  }) {
    await this.publisher.publishRelease(body.zone_id, body.group_id, {
      release_id: body.release_id,
      manifest_hash: body.manifest_hash,
      published_at: new Date().toISOString(),
    });
    return { published: true };
  }

  @Post('publish-config')
  async publishConfig(@Body() body: {
    zone_id: string;
    group_id: string;
    config: any;
  }) {
    await this.publisher.publishUpdate(body.zone_id, body.group_id, {
      type: 'config_update',
      config: body.config,
      updated_at: new Date().toISOString(),
    });
    return { published: true };
  }
}
