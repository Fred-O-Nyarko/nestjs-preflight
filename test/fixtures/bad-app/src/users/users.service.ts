import { Injectable, Scope, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable({ scope: Scope.REQUEST })
export class UsersService {
  constructor(@Inject(REQUEST) private req: any) {}
  async avatar(url: string) {
    const res = await fetch(url);
    return res.arrayBuffer();
  }
}
