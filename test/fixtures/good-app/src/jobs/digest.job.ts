import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnOneInstance } from '@nestjs/locks';

@Injectable()
export class DigestJob {
  @Cron('0 * * * *')
  @OnOneInstance({ key: 'digest' })
  async sendDigest() {}
}
