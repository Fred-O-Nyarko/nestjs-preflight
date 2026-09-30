import { Injectable } from '@nestjs/common';
import { Resilience, Signal } from '@nestjs/resilience';

@Injectable()
export class UsersService {
  @Resilience('avatars')
  async avatar(url: string, @Signal() signal: AbortSignal) {
    const res = await fetch(url, { signal });
    return res.arrayBuffer();
  }
}
