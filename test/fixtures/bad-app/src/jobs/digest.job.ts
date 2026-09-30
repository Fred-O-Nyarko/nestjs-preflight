import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class DigestJob {
  @Cron('0 * * * *')
  async sendDigest() {
    // sends emails
  }
}
